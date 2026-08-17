// Pure, deterministic "Plan my week" scheduling engine.
//
// Given a workflow config, the week's busy intervals, candidate tasks and what
// is already scheduled, proposeBlocks() greedily places task blocks into free
// time to fill each category's remaining weekly quota. No I/O — every input is
// passed in and the output is a plain list of proposals, so it is heavily
// unit-testable and the API routes stay thin.
//
// Algorithm summary (documented decisions):
//  * Category order: categories that have at least one candidate with a HARD
//    deadline are processed first; within each group, by remaining quota
//    descending; ties broken by category name. (This is the "hard-deadline
//    categories first, then by remaining quota desc" option.)
//  * Task ranking within a category: deadline (hard > soft > aspirational >
//    none), then earliest due date, then energy (high first, so high-energy
//    work grabs the earlier/preferred — typically morning — slots), then
//    bestTime (morning > afternoon > evening), then title/id for stability.
//  * Slot search: for each task we build an ordered list of search windows.
//    Tier 1 is the category's PREFERRED windows (which may sit outside working
//    hours — e.g. Deep Work 21:00-23:00 — and override working hours by design),
//    ordered so windows matching the task's bestTime come first, then by date;
//    Tier 2 is the working-hours window on each working day. We first-fit the
//    earliest 15-minute-aligned slot of the category's target length that has
//    the required buffer on both sides against busy intervals AND proposals
//    already accepted in this run, and is >= now.
//  * If a category still has quota but no candidate task fits/remains, we emit a
//    task-less "reserved" block instead.
//
// Categories with no weeklyCount (e.g. a catch-all "General Todos") have no
// target to fill toward, so they emit no reserved blocks; instead they schedule
// one block per SELECTED candidate task, placed after all quota'd categories.

import { classifyBlockCategoryWithCatchAll, normalize, parseTargetLength, type CapacityQuota } from '@/lib/capacity';
import type { TaskQuota, WorkflowConfig } from '@/lib/workflow-config-storage';
import type { BestTime } from '@/types';
import type {
  CandidateTask,
  ProposeBlocksInput,
  ProposedBlock,
} from './types';

const MS_PER_MINUTE = 60 * 1000;

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export interface TimeOfDay {
  h: number;
  m: number;
}

export interface Window {
  date: Date; // local midnight of the day
  dateStr: string; // yyyy-MM-dd
  startMs: number;
  endMs: number;
  preferred: boolean;
  bestTimeMatch: boolean;
}

export interface BusyMs {
  start: number;
  end: number;
  // Break intervals (e.g. the daily lunch ritual) are still busy but split work
  // runs — they are excluded when merging busy time into continuous work runs.
  isBreak?: boolean;
}

// The continuous-work-run rule: busy runs of at most `maxMinutes`, each followed
// by at least `bufferMinutes` of free time. Gaps smaller than `bufferMinutes`
// bridge two busy stretches into one run.
export interface WorkRun {
  maxMinutes: number;
  bufferMinutes: number;
}

// A working day in the week, with its working-hours window bounds (absolute ms).
export interface WorkingDay {
  date: Date; // local midnight of the day
  dateStr: string; // yyyy-MM-dd
  whStartMs: number;
  whEndMs: number;
}

export function parseTimeOfDay(value: string): TimeOfDay | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 24 || m < 0 || m > 59) return null;
  return { h, m };
}

// "09:00-11:00" -> [{h,m},{h,m}]
export function parsePreferredWindow(value: string): [TimeOfDay, TimeOfDay] | null {
  const parts = value.split('-');
  if (parts.length !== 2) return null;
  const start = parseTimeOfDay(parts[0]);
  const end = parseTimeOfDay(parts[1]);
  if (!start || !end) return null;
  return [start, end];
}

export function localDateStr(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

export function timeStr(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Absolute ms for a time-of-day on a given local day.
function msAt(day: Date, time: TimeOfDay): number {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.h, time.m, 0, 0);
  return d.getTime();
}

const BEST_TIME_RANGES: Record<BestTime, [number, number]> = {
  morning: [5, 12],
  afternoon: [12, 17],
  evening: [17, 24],
};

function windowMatchesBestTime(startMs: number, bestTime?: BestTime): boolean {
  if (!bestTime) return false;
  const hour = new Date(startMs).getHours();
  const [lo, hi] = BEST_TIME_RANGES[bestTime];
  return hour >= lo && hour < hi;
}

const DEADLINE_RANK: Record<string, number> = { hard: 0, soft: 1, aspirational: 2 };
const ENERGY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const BEST_TIME_RANK: Record<string, number> = { morning: 0, afternoon: 1, evening: 2 };

export function taskSortKey(task: CandidateTask): Array<number | string> {
  return [
    task.isPriority ? 0 : 1,
    task.deadlineType ? DEADLINE_RANK[task.deadlineType] : 3,
    task.dueDate ?? '9999-12-31',
    task.energyLevel ? ENERGY_RANK[task.energyLevel] : 1,
    task.bestTime ? BEST_TIME_RANK[task.bestTime] : 1,
    task.title,
    task.gid ?? task.adhocId ?? '',
  ];
}

export function compareKeys(a: Array<number | string>, b: Array<number | string>): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// Is placing a work block [start, end] valid under the work-run rule?
//   (1) It must not overlap any busy interval (breaks included — a break is still
//       busy and can't be double-booked).
//   (2) The contiguous busy RUN it would join/create must be <= maxMinutes.
//       Runs are formed by merging only NON-break busy intervals (plus this
//       candidate), bridging any gap smaller than bufferMinutes; a break interval
//       is excluded from the merge, so a run interrupted by a break is two runs.
// Because a >= bufferMinutes gap splits runs, this simultaneously guarantees that
// a run already at/over maxMinutes leaves at least bufferMinutes of free time
// before the next block can be placed.
export function slotIsValid(start: number, end: number, busy: BusyMs[], workRun: WorkRun): boolean {
  // (1) No overlap with anything busy.
  for (const b of busy) {
    if (b.start < end && b.end > start) return false;
  }
  // (2) Run-length check: grow the run around the candidate across every non-break
  // busy interval within bufferMinutes, to a fixpoint (bridging can chain).
  const bufferMs = workRun.bufferMinutes * MS_PER_MINUTE;
  const maxMs = workRun.maxMinutes * MS_PER_MINUTE;
  const work = busy.filter(b => !b.isBreak);
  let runStart = start;
  let runEnd = end;
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of work) {
      // Connected when within bufferMinutes on both sides (gap < bufferMinutes,
      // or overlapping). A gap of exactly bufferMinutes does NOT connect.
      if (w.start < runEnd + bufferMs && w.end > runStart - bufferMs) {
        if (w.start < runStart) {
          runStart = w.start;
          changed = true;
        }
        if (w.end > runEnd) {
          runEnd = w.end;
          changed = true;
        }
      }
    }
  }
  return runEnd - runStart <= maxMs;
}

// Build the ordered list of working days in the week (>= today), each with its
// working-hours window bounds.
export function buildWorkingDays(
  weekStart: Date,
  now: Date,
  workingHours: { start: TimeOfDay; end: TimeOfDay },
  workingDayNames: Set<string>,
  excludeDates?: Set<string>
): WorkingDay[] {
  const days: WorkingDay[] = [];
  const todayStr = localDateStr(now);
  for (let i = 0; i < 7; i++) {
    const day = new Date(
      weekStart.getFullYear(),
      weekStart.getMonth(),
      weekStart.getDate() + i
    );
    const dateStr = localDateStr(day);
    if (dateStr < todayStr) continue; // past days in the week
    if (!workingDayNames.has(WEEKDAY_NAMES[day.getDay()])) continue;
    if (excludeDates?.has(dateStr)) continue; // out-of-office day — not a working day
    days.push({
      date: day,
      dateStr,
      whStartMs: msAt(day, workingHours.start),
      whEndMs: msAt(day, workingHours.end),
    });
  }
  return days;
}

// Build candidate search windows for a task (or reserved block when bestTime is
// undefined): preferred windows first (bestTime-matching first), then
// working-hours fallback windows. All ordered by date within each tier.
export function buildWindowsForTask(
  bestTime: BestTime | undefined,
  preferredWindows: Array<[TimeOfDay, TimeOfDay]>,
  workingDays: WorkingDay[]
): Window[] {
  const preferred: Window[] = [];
  for (const day of workingDays) {
    for (const [ws, we] of preferredWindows) {
      const startMs = msAt(day.date, ws);
      const endMs = msAt(day.date, we);
      if (endMs <= startMs) continue;
      preferred.push({
        date: day.date,
        dateStr: day.dateStr,
        startMs,
        endMs,
        preferred: true,
        bestTimeMatch: windowMatchesBestTime(startMs, bestTime),
      });
    }
  }
  // Within preferred tier: bestTime-matching windows first, then by date/start.
  preferred.sort((a, b) => {
    if (a.bestTimeMatch !== b.bestTimeMatch) return a.bestTimeMatch ? -1 : 1;
    return a.startMs - b.startMs;
  });

  const fallback: Window[] = workingDays.map(day => ({
    date: day.date,
    dateStr: day.dateStr,
    startMs: day.whStartMs,
    endMs: day.whEndMs,
    preferred: false,
    bestTimeMatch: false,
  }));
  fallback.sort((a, b) => a.startMs - b.startMs);

  return [...preferred, ...fallback];
}

// Candidate start positions for a block of `durationMs` within [lo, hi] (both
// inclusive as *start* bounds). A fixed step grid can miss the only valid offset
// in a gap when busy edges are off-grid (e.g. two long runs 15 minutes apart on
// an off-grid boundary — only a start at the exact buffered offset is valid). So
// rather than brute-stepping, we derive candidates from the busy edges: the
// feasibility of a start (overlap + work-run rule) only changes at the busy-edge
// boundaries `b.end`, `b.end + buffer`, `b.start - duration` and
// `b.start - duration - buffer`, plus the window start `lo`. Testing exactly
// those with slotIsValid finds the true earliest valid start at any minute.
function candidateStarts(
  lo: number,
  hi: number,
  durationMs: number,
  bufferMs: number,
  busy: BusyMs[]
): number[] {
  // Seed with both window bounds (`hi` matters for spare capacity's latest-valid
  // scan; `lo` is the earliest candidate placement's flush start).
  const starts = new Set<number>([lo, hi]);
  for (const b of busy) {
    for (const c of [b.end, b.end + bufferMs, b.start - durationMs, b.start - durationMs - bufferMs]) {
      if (c >= lo && c <= hi) starts.add(c);
    }
  }
  return [...starts].sort((a, z) => a - z);
}

// Find the earliest valid slot for a block of `duration` minutes across the
// given windows, respecting the work-run rule and the now-cutoff. The slot may
// start at any minute (edge-derived, not step-aligned) so a gap whose only
// run-rule-valid offset is off-grid is still used.
export function findSlot(
  windows: Window[],
  duration: number,
  workRun: WorkRun,
  busy: BusyMs[],
  nowMs: number,
  allowedDates?: Set<string>
): { startMs: number; endMs: number; dateStr: string; preferred: boolean } | null {
  const durationMs = duration * MS_PER_MINUTE;
  const bufferMs = workRun.bufferMinutes * MS_PER_MINUTE;

  for (const win of windows) {
    if (allowedDates && !allowedDates.has(win.dateStr)) continue;
    const lo = Math.max(win.startMs, nowMs);
    const hi = win.endMs - durationMs; // latest start that still fits the window
    if (hi < lo) continue;
    for (const start of candidateStarts(lo, hi, durationMs, bufferMs, busy)) {
      const end = start + durationMs;
      if (start >= nowMs && slotIsValid(start, end, busy, workRun)) {
        return { startMs: start, endMs: end, dateStr: win.dateStr, preferred: win.preferred };
      }
    }
  }
  return null;
}

// A found slot plus the duration actually placed (may be trimmed below the
// requested duration to fit) and whether it was trimmed.
export type FlexSlot = {
  slot: { startMs: number; endMs: number; dateStr: string; preferred: boolean };
  duration: number;
  trimmedMinutes: number;
};

// The single, shared "soft work-run rule" search. The 2h run cap is a PREFERENCE,
// not a hard wall: rather than refusing a block (and leaving a visible morning
// gap empty while the task falls to evening overflow), we try four tiers in order
// and take the first that lands, so well-spaced schedules still come out first:
//   (a) full duration, run rule satisfied;
//   (b) duration shortened by ONE 15-min step (never below 15 min), run rule
//       satisfied;
//   (c) full duration, run-length cap IGNORED (overlap prohibition always holds);
//   (d) shortened duration, cap ignored.
// `search(duration, workRun)` runs the actual slot search (plain findSlot, or the
// leveled/spread variant) for a given duration + run rule, so this composes with
// every placement pass. `canShrink` is false for rituals / prep (fixed sizes).
const FLEX_STEP_MINUTES = 15;
const MIN_FLEX_DURATION = 15;
export function findFlexibleSlot(
  search: (duration: number, workRun: WorkRun) => ReturnType<typeof findSlot>,
  duration: number,
  workRun: WorkRun,
  canShrink: boolean
): FlexSlot | null {
  const relaxed: WorkRun = { maxMinutes: Infinity, bufferMinutes: workRun.bufferMinutes };
  const shrunk = Math.max(MIN_FLEX_DURATION, duration - FLEX_STEP_MINUTES);
  const shrinkable = canShrink && shrunk < duration;
  const trim = duration - shrunk;

  // (a) full duration, strict run rule.
  let slot = search(duration, workRun);
  if (slot) return { slot, duration, trimmedMinutes: 0 };
  // (b) shrunk duration, strict run rule.
  if (shrinkable) {
    slot = search(shrunk, workRun);
    if (slot) return { slot, duration: shrunk, trimmedMinutes: trim };
  }
  // (c) full duration, cap ignored (overlap still prohibited).
  slot = search(duration, relaxed);
  if (slot) return { slot, duration, trimmedMinutes: 0 };
  // (d) shrunk duration, cap ignored.
  if (shrinkable) {
    slot = search(shrunk, relaxed);
    if (slot) return { slot, duration: shrunk, trimmedMinutes: trim };
  }
  return null;
}

// Whether a category is the deep-work category, compared with the
// whitespace-robust normalize so "Writing / Deep Work" and "Writing/Deep Work"
// are treated the same. Deep work owns the mornings.
export function isDeepWork(category: string): boolean {
  return normalize(category) === normalize('Writing/Deep Work');
}

// --- Deep-work morning flex ------------------------------------------------
// Deep work has first claim on the mornings. When its preferred morning window is
// PARTIALLY blocked (e.g. a real 08:30–10:00 meeting), the block must NOT abandon
// the morning — it should:
//   (i)  slide its start later, treating the morning as running to ~12:00 (not
//        just the literal 09:00–11:00 preference), then
//   (ii) if the full duration still fits nowhere in the morning, shorten in
//        15-min steps down to a 60-min floor to fill the largest free morning gap.
// Only when even a 60-min block won't fit the morning does the caller fall back to
// the normal window logic. Deterministic; scoped to the deep-work category.
export const DEEP_WORK_MORNING_END: TimeOfDay = { h: 12, m: 0 };
export const DEEP_WORK_MORNING_FLOOR_MINUTES = 60;

// The deep-work morning search windows: each configured preferred window that
// STARTS before noon, with its end extended to at least noon so a slid/shrunk
// block can still land in the morning. Empty when the category has no morning
// preferred window (the caller then just uses normal placement).
export function deepWorkMorningWindows(
  preferredWindows: Array<[TimeOfDay, TimeOfDay]>,
  workingDays: WorkingDay[]
): Window[] {
  const morningPrefs = preferredWindows.filter(([start]) => start.h < DEEP_WORK_MORNING_END.h);
  if (morningPrefs.length === 0) return [];
  const windows: Window[] = [];
  for (const day of workingDays) {
    for (const [start, end] of morningPrefs) {
      const startMs = msAt(day.date, start);
      // Extend the end to at least noon so a meeting-shortened morning still has
      // room for the block to slide/shrink into.
      const endMs = Math.max(msAt(day.date, end), msAt(day.date, DEEP_WORK_MORNING_END));
      if (endMs <= startMs) continue;
      windows.push({ date: day.date, dateStr: day.dateStr, startMs, endMs, preferred: true, bestTimeMatch: false });
    }
  }
  return windows.sort((a, b) => a.startMs - b.startMs);
}

// Place a deep-work block in the morning, preferring the LARGEST duration that
// fits: full duration first (strict run rule, then relaxed cap-ignored to abut a
// meeting), then shrunk in 15-min steps down to the 60-min floor (strict, then
// relaxed) to fill the largest free morning gap. `search(duration, workRun)` runs
// the slot search over the morning windows. Returns null when even a 60-min block
// won't fit, so the caller falls back to normal placement.
export function findDeepWorkMorningPlacement(
  search: (duration: number, workRun: WorkRun) => ReturnType<typeof findSlot>,
  duration: number,
  workRun: WorkRun
): FlexSlot | null {
  const relaxed: WorkRun = { maxMinutes: Infinity, bufferMinutes: workRun.bufferMinutes };
  const floor = Math.min(duration, DEEP_WORK_MORNING_FLOOR_MINUTES);
  for (let dur = duration; dur >= floor; dur -= FLEX_STEP_MINUTES) {
    for (const wr of [workRun, relaxed]) {
      const slot = search(dur, wr);
      if (slot) return { slot, duration: dur, trimmedMinutes: duration - dur };
    }
  }
  return null;
}

// Preferred-time search windows for a category: its explicit `preferredTimes` if
// configured; otherwise a default afternoon window (12:00 → working-hours end)
// for non-deep-work categories, so they try afternoons before falling back to
// mornings and leave early slots free for deep work. Deep work with no
// preferredTimes gets none (falls through to the working-hours tier, which
// starts in the morning). buildWindowsForTask drops any day whose window end <=
// start, so a day ending at/before 12:00 simply contributes no afternoon window.
// Day accounting + selection needed to resolve a category's effective block count.
export interface WeeklyCountContext {
  // Remaining working days in the plan window (past + out-of-office already
  // excluded). Drives the `daily` cadence.
  remainingWorkingDays: number;
  // Configured working days per week (denominator for OOO scaling).
  configuredWorkingDaysPerWeek: number;
  // Working days this week not lost to out-of-office (numerator for OOO scaling).
  availableWorkingDaysPerWeek: number;
  // Candidate tasks the engine received for the category (drives scaleToTasks).
  selectedTaskCount: number;
}

// The effective number of blocks to schedule for a category this plan, honouring
// the capabilities that OVERRIDE a fixed weeklyCount:
//   * `daily`        — one block per remaining working day (deep work leads every
//                      day); out-of-office days are already gone from the count.
//   * `scaleToTasks` — grouped categories whose block count scales with how many
//                      tasks were selected: min(maxBlocks, ceil(selected /
//                      tasksPerBlock)); ZERO selected tasks means ZERO blocks.
// A plain fixed weeklyCount is scaled DOWN proportionally when out-of-office days
// shrink the week: round(weeklyCount × available / configured), min 0 (e.g. a
// weekly-3 category on a 4-of-5-day week → round(3 × 4/5) = 2).
export function effectiveWeeklyCount(
  quota: Pick<TaskQuota, 'weeklyCount' | 'daily' | 'scaleToTasks'>,
  ctx: WeeklyCountContext
): number {
  if (quota.scaleToTasks) {
    if (ctx.selectedTaskCount <= 0) return 0;
    const { tasksPerBlock, maxBlocks } = quota.scaleToTasks;
    return Math.min(maxBlocks, Math.ceil(ctx.selectedTaskCount / tasksPerBlock));
  }
  if (quota.daily) return ctx.remainingWorkingDays;
  const base = quota.weeklyCount ?? 0;
  if (base <= 0) return 0;
  // No OOO (or misconfigured counts) → the quota is unchanged.
  if (ctx.availableWorkingDaysPerWeek >= ctx.configuredWorkingDaysPerWeek || ctx.configuredWorkingDaysPerWeek <= 0) {
    return base;
  }
  return Math.max(
    0,
    Math.round((base * ctx.availableWorkingDaysPerWeek) / ctx.configuredWorkingDaysPerWeek)
  );
}

export function preferredWindowsForCategory(
  config: WorkflowConfig,
  category: string,
  workingHoursEnd: TimeOfDay
): Array<[TimeOfDay, TimeOfDay]> {
  const windows = (config.taskQuotas[category]?.preferredTimes ?? [])
    .map(parsePreferredWindow)
    .filter((w): w is [TimeOfDay, TimeOfDay] => w !== null);
  if (windows.length === 0 && !isDeepWork(category)) {
    windows.push([{ h: 12, m: 0 }, workingHoursEnd]);
  }
  return windows;
}

// Resolve the scheduling config's working-hours/day settings into the derived
// values every planner (task engine, prep, replan) needs: parsed working-hours
// bounds, the working-day name set, the buffer minutes, and the ordered list of
// this week's working days (>= today) with their window bounds.
export interface WorkingWindow {
  workingHoursStart: TimeOfDay;
  workingHoursEnd: TimeOfDay;
  workingDayNames: Set<string>;
  workRun: WorkRun;
  workingDays: WorkingDay[];
  // Configured working days in a full week (size of workingDayNames), e.g. 5 for
  // Mon–Fri. The denominator when scaling weekly quotas for lost days.
  configuredWorkingDaysPerWeek: number;
  // Working days in THIS week that are not out-of-office (full week, independent
  // of the now-cutoff), e.g. 4 when one of five days is OOO. The numerator when
  // scaling weekly quotas.
  availableWorkingDaysPerWeek: number;
}

export function resolveWorkingWindow(
  scheduling: WorkflowConfig['scheduling'],
  weekStart: Date,
  now: Date,
  outOfOfficeDates: Set<string> = new Set()
): WorkingWindow {
  const workingHoursStart = parseTimeOfDay(scheduling.workingHours.start) ?? { h: 9, m: 0 };
  const workingHoursEnd = parseTimeOfDay(scheduling.workingHours.end) ?? { h: 17, m: 0 };
  const workingDayNames = new Set(
    scheduling.workingDays.map(d => d.charAt(0).toUpperCase() + d.slice(1).toLowerCase())
  );
  // Work-run rule, defaulted when a legacy config predates it.
  const workRun: WorkRun = {
    maxMinutes: scheduling.workRun?.maxMinutes ?? 120,
    bufferMinutes: scheduling.workRun?.bufferMinutes ?? 15,
  };
  // Out-of-office days are dropped from the working days entirely.
  const workingDays = buildWorkingDays(
    weekStart,
    now,
    { start: workingHoursStart, end: workingHoursEnd },
    workingDayNames,
    outOfOfficeDates
  );
  // Full-week day accounting for weekly-quota scaling (independent of `now`, so a
  // mid-week replan doesn't double-count against existing-scheduled subtraction).
  const configuredWorkingDaysPerWeek = workingDayNames.size;
  let availableWorkingDaysPerWeek = 0;
  for (let i = 0; i < 7; i++) {
    const day = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
    if (!workingDayNames.has(WEEKDAY_NAMES[day.getDay()])) continue;
    if (outOfOfficeDates.has(localDateStr(day))) continue;
    availableWorkingDaysPerWeek += 1;
  }
  return {
    workingHoursStart,
    workingHoursEnd,
    workingDayNames,
    workRun,
    workingDays,
    configuredWorkingDaysPerWeek,
    availableWorkingDaysPerWeek,
  };
}

// A working day must never START with meeting prep: deep work / todos / meetings
// come first. Prep-block placement (and prep re-slotting in replan) excludes the
// first N minutes of each working day from its candidate windows, so prep can
// only land later in the day (or the day before). Shared so prep.ts and
// replan.ts enforce the identical rule.
export const MORNING_PREP_EXCLUSION_MINUTES = 90;

// Raise each window's start to at least (its day's working-hours start +
// exclusionMinutes), dropping any window left with no room. Windows on a date not
// in `workingDays` are passed through unchanged.
export function excludeMorningWindows(
  windows: Window[],
  workingDays: WorkingDay[],
  exclusionMinutes: number
): Window[] {
  const earliestByDate = new Map(
    workingDays.map(d => [d.dateStr, d.whStartMs + exclusionMinutes * MS_PER_MINUTE])
  );
  const out: Window[] = [];
  for (const w of windows) {
    const earliest = earliestByDate.get(w.dateStr);
    const startMs = earliest !== undefined ? Math.max(w.startMs, earliest) : w.startMs;
    if (startMs < w.endMs) out.push({ ...w, startMs });
  }
  return out;
}

// --- Spare-capacity assessment ---------------------------------------------
//
// After a plan is proposed, we want to tell the user how much *usable* free work
// time is left in the remaining week. "Usable" means: inside working hours, on a
// working day, at/after now, in a free gap big enough to hold a real block
// (>= MIN_USABLE_GAP_MINUTES) — and respecting the work-run rule, so a gap that
// sits right after an already-maxed-out work run loses the leading buffer that
// must separate it from that run (and likewise a trailing buffer before a maxed
// run that follows the gap). Breaks (e.g. lunch) occupy time but are NOT work
// runs, so a gap adjacent to a break needs no buffer.

const MIN_USABLE_GAP_MINUTES = 30;

export interface SpareCapacity {
  totalMinutes: number;
  gapCount: number;
  largestGapMinutes: number;
  byDate: Array<{ date: string; freeMinutes: number }>;
}

// Merge ms-intervals into a minimal, start-sorted set. Two consecutive intervals
// coalesce when `shouldMerge(gapMs)` holds for the gap between them (negative gap
// = overlap). Callers supply the boundary rule: overlap/touch merging vs work-run
// bridging (gap strictly below the buffer).
function mergeIntervals(
  intervals: Array<{ start: number; end: number }>,
  shouldMerge: (gapMs: number) => boolean
): Array<{ start: number; end: number }> {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && shouldMerge(iv.start - last.end)) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

// Compute the usable spare capacity across the given working days, given the busy
// timeline (calendar busy + all accepted/proposed blocks) and the work-run rule.
// Pure and deterministic — every input is passed in.
// Usable minutes in a single free gap [gapStart, gapEnd], measured with the SAME
// RELAXED semantics placement can fall back to (run-length cap IGNORED, only the
// overlap prohibition applies). Since placement will, as a last resort, drop the
// ~2h run cap to fill a visible gap (see findFlexibleSlot), spare capacity must
// count that gap too — otherwise the review line would under-report free time the
// planner would actually use. We still probe with a real MIN_USABLE_GAP_MINUTES
// block so a sub-30-min sliver counts as zero. `busy` is the full, unclipped
// timeline so overlaps are computed exactly as in placement.
function usableGapMinutes(
  gapStart: number,
  gapEnd: number,
  busy: BusyMs[],
  workRun: WorkRun
): number {
  const blockMs = MIN_USABLE_GAP_MINUTES * MS_PER_MINUTE;
  const bufferMs = workRun.bufferMinutes * MS_PER_MINUTE;
  // Run-cap ignored: only overlap matters, matching placement's relaxed fallback.
  const relaxed: WorkRun = { maxMinutes: Infinity, bufferMinutes: workRun.bufferMinutes };
  const lo = gapStart;
  const hi = gapEnd - blockMs; // latest start that still fits the gap
  if (hi < lo) return 0;
  let firstValidStart: number | null = null;
  let lastValidEnd = 0;
  for (const start of candidateStarts(lo, hi, blockMs, bufferMs, busy)) {
    if (slotIsValid(start, start + blockMs, busy, relaxed)) {
      if (firstValidStart === null) firstValidStart = start;
      lastValidEnd = start + blockMs;
    }
  }
  if (firstValidStart === null) return 0;
  return Math.floor((lastValidEnd - firstValidStart) / MS_PER_MINUTE);
}

export function computeSpareCapacity(
  workingDays: WorkingDay[],
  busy: BusyMs[],
  workRun: WorkRun,
  nowMs: number
): SpareCapacity {
  const byDate: Array<{ date: string; freeMinutes: number }> = [];
  let totalMinutes = 0;
  let gapCount = 0;
  let largestGapMinutes = 0;

  for (const wd of workingDays) {
    // Clip the working-hours window to the now-cutoff; a fully-past day is skipped.
    const windowStart = Math.max(wd.whStartMs, nowMs);
    const windowEnd = wd.whEndMs;
    if (windowStart >= windowEnd) continue;

    // Occupied blocks (all busy incl. breaks) clipped to the window; free gaps are
    // the complement within [windowStart, windowEnd]. Overlapping/touching blocks
    // coalesce (gap <= 0).
    const occupied = mergeIntervals(
      busy
        .map(b => ({ start: Math.max(b.start, windowStart), end: Math.min(b.end, windowEnd) }))
        .filter(b => b.end > b.start),
      gap => gap <= 0
    );

    let dayFree = 0;
    let cursor = windowStart;
    for (const block of [...occupied, { start: windowEnd, end: windowEnd }]) {
      if (block.start > cursor) {
        // Usable minutes are what the placement validator would actually accept
        // in this gap — not the raw span with a heuristic buffer deduction.
        const mins = usableGapMinutes(cursor, block.start, busy, workRun);
        if (mins > 0) {
          dayFree += mins;
          gapCount += 1;
          if (mins > largestGapMinutes) largestGapMinutes = mins;
        }
      }
      cursor = Math.max(cursor, block.end);
    }

    if (dayFree > 0) byDate.push({ date: wd.dateStr, freeMinutes: dayFree });
    totalMinutes += dayFree;
  }

  return { totalMinutes, gapCount, largestGapMinutes, byDate };
}

// A real task the engine could place nowhere. There is only ONE way this can
// happen: no free gap long enough exists in working hours. The work-run cap can
// never be the cause, because the soft rule (findFlexibleSlot) already retries
// every placement with the cap dropped before a task is treated as leftover.
export interface UnplaceableTask {
  id: string; // gid or adhocId
  title: string;
  category: string;
}

// Clause explaining an unplaceable/overflow task, in the engine's reason style,
// so the review UI can say WHY a task wasn't scheduled.
const NO_FREE_GAP_CLAUSE = 'no free gap long enough in working hours';

export function proposeBlocks(
  input: ProposeBlocksInput,
  unplaceableOut?: UnplaceableTask[]
): ProposedBlock[] {
  const { config, candidateTasks } = input;

  const outOfOfficeDates = input.outOfOfficeDates ?? new Set<string>();
  const {
    workingHoursEnd,
    workRun,
    workingDays,
    configuredWorkingDaysPerWeek,
    availableWorkingDaysPerWeek,
  } = resolveWorkingWindow(config.scheduling, input.weekStart, input.now, outOfOfficeDates);

  // Quotas in the capacity lib's shape, for classification reuse.
  const quotas: CapacityQuota[] = Object.entries(config.taskQuotas).map(([category, quota]) => ({
    category,
    weeklyCount: quota.weeklyCount,
    targetLength: quota.targetLength,
    types: config.typeMapping?.[category] ?? [],
  }));

  // Bucket candidate tasks by category (via the shared classifier).
  const tasksByCategory = new Map<string, CandidateTask[]>();
  for (const task of candidateTasks) {
    const category = classifyBlockCategoryWithCatchAll(task.typeSignals, quotas);
    if (!category) continue;
    const list = tasksByCategory.get(category) ?? [];
    list.push(task);
    tasksByCategory.set(category, list);
  }
  for (const list of tasksByCategory.values()) {
    list.sort((a, b) => compareKeys(taskSortKey(a), taskSortKey(b)));
  }

  // Remaining "count to place" per category. Two kinds of category:
  //  * Quota'd (weeklyCount > 0): place up to the unmet weekly quota, filling
  //    with reserved blocks when candidates run out.
  //  * No-quota catch-all (no weeklyCount, e.g. "General Todos"): there is no
  //    weekly target, but the wizard still lets the user SELECT any number of its
  //    tasks. Place one block per selected candidate task (target = candidate
  //    count), never a reserved block, and process them AFTER quota'd categories
  //    so this filler can't steal morning/preferred slots from deep work etc.
  const remainingByCategory = new Map<string, number>();
  const noQuotaCategories = new Set<string>();
  for (const quota of quotas) {
    // Effective target honours the `daily` / `scaleToTasks` overrides (see
    // effectiveWeeklyCount) before falling back to the fixed weeklyCount.
    const cfg = config.taskQuotas[quota.category];
    const candidateCountForCat = (tasksByCategory.get(quota.category) ?? []).length;
    const weeklyCount = cfg
      ? effectiveWeeklyCount(cfg, {
          remainingWorkingDays: workingDays.length,
          configuredWorkingDaysPerWeek,
          availableWorkingDaysPerWeek,
          selectedTaskCount: candidateCountForCat,
        })
      : quota.weeklyCount ?? 0;
    if (weeklyCount <= 0) {
      // A genuine no-quota catch-all (no weeklyCount, not daily/scaleToTasks)
      // schedules one block per selected task. A scaleToTasks category that
      // computed 0 (no tasks selected) is NOT a catch-all — it simply gets no
      // blocks, so only route to the catch-all path when the config truly lacks a
      // target mechanism.
      const isCatchAll = !cfg?.daily && !cfg?.scaleToTasks && (cfg?.weeklyCount ?? 0) <= 0;
      if (isCatchAll && candidateCountForCat > 0) {
        remainingByCategory.set(quota.category, candidateCountForCat);
        noQuotaCategories.add(quota.category);
      }
      continue;
    }
    const already = input.existingScheduledCounts[quota.category] ?? 0;
    const quotaRemaining = Math.max(0, weeklyCount - already);
    // Over-quota manual selection: when the user explicitly picks tasks for a
    // manual (non-auto-select, non-grouped) category, every pick should be
    // attempted even beyond the weekly quota. So place max(quotaRemaining,
    // selectedCount) blocks. Auto-select and grouped categories keep the quota
    // cap. Reserved filler only ever appears when candidates run short of
    // quotaRemaining, so it stays bounded by the quota (never over-fills).
    const isAutoSelect = config.taskQuotas[quota.category]?.autoSelect === true;
    const isGroupedCat = config.taskQuotas[quota.category]?.grouped === true;
    let remaining = quotaRemaining;
    if (!isAutoSelect && !isGroupedCat && input.selectedCountsByCategory) {
      remaining = Math.max(quotaRemaining, input.selectedCountsByCategory[quota.category] ?? 0);
    }
    if (remaining > 0) remainingByCategory.set(quota.category, remaining);
  }

  // Mutable run state.
  const busy: BusyMs[] = input.busyIntervals.map(i => ({
    start: i.start.getTime(),
    end: i.end.getTime(),
    isBreak: i.isBreak,
  }));
  const usedTaskIds = new Set<string>();
  const nowMs = input.now.getTime();
  const proposals: ProposedBlock[] = [];

  const quotaByCategory = new Map(quotas.map(q => [q.category, q]));

  // Real selected tasks that couldn't be placed inside working hours. After the
  // normal pass they get an OPTIONAL evening-overflow block (see below). Reserved
  // filler and unmet-quota blocks are never collected here — only real tasks.
  const leftovers: Array<{ task: CandidateTask; category: string; duration: number }> = [];

  // Category-level block length: a per-category override, else the parsed
  // targetLength (default 30). A single-task block may further override per task.
  const categoryDurationFor = (category: string): number =>
    input.durationOverridesByCategory?.[category] ??
    (parseTargetLength(quotaByCategory.get(category)!.targetLength) || 30);

  const preferredWindowsFor = (category: string): Array<[TimeOfDay, TimeOfDay]> =>
    preferredWindowsForCategory(config, category, workingHoursEnd);

  // Per-date count of each category's blocks, seeded from what's already on the
  // calendar. Drives the leveled (spread) search so same-category blocks fan out
  // across distinct days before doubling up. Shared across the must-do first pass
  // and the main category loop so both contribute to the same spread state.
  const catCountByCategory = new Map<string, Record<string, number>>();
  for (const category of remainingByCategory.keys()) {
    const catCount: Record<string, number> = {};
    for (const wd of workingDays) {
      catCount[wd.dateStr] = input.existingCategoryCountsByDate?.[wd.dateStr]?.[category] ?? 0;
    }
    catCountByCategory.set(category, catCount);
  }

  // Leveled (spread) slot search shared by every pass: level 0 allows only days
  // with zero blocks of this category, level 1 up to one, etc. Window ordering
  // (preferred/bestTime, then working hours) is preserved within each level, so
  // spread outranks earliness but preferred times still win across distinct days.
  const findLeveledSlot = (
    catCount: Record<string, number>,
    windows: Window[],
    duration: number,
    wr: WorkRun = workRun
  ) => {
    let slot: ReturnType<typeof findSlot> = null;
    for (let level = 0; level <= 7 && !slot; level++) {
      const allowed = new Set(
        workingDays.filter(wd => catCount[wd.dateStr] <= level).map(wd => wd.dateStr)
      );
      slot = findSlot(windows, duration, wr, busy, nowMs, allowed);
    }
    return slot;
  };

  const isGroupedCategory = (category: string): boolean =>
    config.taskQuotas[category]?.grouped === true && !noQuotaCategories.has(category);

  // --- Must-do first pass ---------------------------------------------------
  // A task flagged "must be done this week" (isPriority) has to land as early in
  // the week as possible, ahead of equal-length non-priority work — even work in
  // a category the main loop processes earlier. Because the main loop walks
  // categories in a fixed order and isPriority only sorts WITHIN a category, a
  // must-do in a late category (e.g. a no-quota General Todo) would otherwise be
  // pushed to the end of the week. So place every isPriority single-task
  // candidate up front, across all (non-grouped) categories in deadline-then-name
  // order, each using its own category's duration, preferred windows and shared
  // spread state, and consuming that category's quota + marking the task used so
  // the main pass never double-places it. Grouped categories are excluded here (a
  // must-do agenda item can't move its shared container); instead a grouped
  // category holding a must-do has its CONTAINER placement bumped to the front of
  // the category loop (see orderedCategories below). A must-do that finds no slot
  // here is left unconsumed so the main pass and leftover/overflow logic see it.
  const mustDos: Array<{ task: CandidateTask; category: string }> = [];
  for (const category of remainingByCategory.keys()) {
    if (isGroupedCategory(category)) continue;
    for (const t of tasksByCategory.get(category) ?? []) {
      if (t.isPriority) mustDos.push({ task: t, category });
    }
  }
  mustDos.sort((a, b) => compareKeys(taskSortKey(a.task), taskSortKey(b.task)));

  // Placed as a closure so the orchestration below can run it at the right moment:
  // AFTER deep work has claimed the mornings, so must-dos slot in immediately
  // after deep work rather than ahead of it.
  const runMustDoPass = () => {
    for (const { task, category } of mustDos) {
      const remaining = remainingByCategory.get(category);
      if (remaining === undefined || remaining <= 0) continue; // category quota already full
      const taskId = task.gid ?? task.adhocId;
      if (taskId && usedTaskIds.has(taskId)) continue;
      const duration = (taskId && input.durationOverridesByTask?.[taskId]) || categoryDurationFor(category);
      // Earliness beats spread for must-dos: the leveled search prefers the
      // EMPTIEST day of the category (which is often Friday), so a must-do could
      // land later than ordinary tasks. Reorder the windows TIER-FIRST: try every
      // PREFERRED window (earliest day first, then start time) across the whole
      // week before ANY fallback (whole-working-day) window. This keeps a must-do
      // inside its category's preferred times — e.g. an afternoon category lands
      // the next day's afternoon rather than invading a morning fallback slot that
      // deep work / writing (whose category loop runs later) needs. Only once every
      // preferred window is full does it drop to fallback, again earliest day first.
      const windows = buildWindowsForTask(task.bestTime, preferredWindowsFor(category), workingDays)
        .slice()
        .sort((a, b) =>
          a.preferred !== b.preferred
            ? a.preferred ? -1 : 1
            : a.dateStr !== b.dateStr
              ? a.dateStr < b.dateStr ? -1 : 1
              : a.startMs - b.startMs
        );
      const catCount = catCountByCategory.get(category)!;
      // Soft run rule: full-strict, then cap-ignored (see findFlexibleSlot), so a
      // must-do lands in its preferred window rather than overflowing when the only
      // room slightly breaks the run rule. A must-do is a SINGLE task, so it is
      // never trimmed (canShrink=false) — only its full length is tried.
      const placement = findFlexibleSlot(
        (dur, wr) => findSlot(windows, dur, wr, busy, nowMs),
        duration,
        workRun,
        false
      );
      if (!placement) continue; // leave unplaced; the main pass / overflow logic will see it
      const { slot, duration: placedDuration } = placement;
      const start = timeStr(slot.startMs);
      proposals.push({
        id: `${slot.dateStr}-${start}-${category}`,
        category,
        task: {
          gid: task.gid,
          adhocId: task.adhocId,
          title: task.title,
          integrationId: task.integrationId,
        },
        date: slot.dateStr,
        start,
        durationMinutes: placedDuration,
        reason: buildReason(category, slot.preferred, task),
      });
      busy.push({ start: slot.startMs, end: slot.endMs });
      catCount[slot.dateStr] = (catCount[slot.dateStr] ?? 0) + 1;
      if (taskId) usedTaskIds.add(taskId);
      remainingByCategory.set(category, remaining - 1);
    }
  };

  // Category processing order: a grouped category that holds a must-do task comes
  // FIRST so its shared containers land early in the week (its must-do can't move
  // on its own). Then no-quota catch-all categories are always LAST (filler must
  // not steal slots from quota'd work). Among the rest, Writing/Deep Work is
  // processed first so it claims the earliest morning slots; then hard-deadline
  // categories, then by remaining quota desc, then name. Deep work is matched via
  // the whitespace-robust normalize so "Writing / Deep Work" and "Writing/Deep
  // Work" are treated the same.
  const categoryHasHard = (category: string): boolean =>
    (tasksByCategory.get(category) ?? []).some(t => t.deadlineType === 'hard');
  const groupedHasMustDo = (category: string): boolean =>
    isGroupedCategory(category) && (tasksByCategory.get(category) ?? []).some(t => t.isPriority);

  const orderedCategories = [...remainingByCategory.keys()].sort((a, b) => {
    const gmA = groupedHasMustDo(a);
    const gmB = groupedHasMustDo(b);
    if (gmA !== gmB) return gmA ? -1 : 1; // grouped-with-must-do containers first
    const noqA = noQuotaCategories.has(a);
    const noqB = noQuotaCategories.has(b);
    if (noqA !== noqB) return noqA ? 1 : -1; // no-quota categories last
    if (noqA && noqB) return a < b ? -1 : a > b ? 1 : 0; // among no-quota: by name
    const deepA = isDeepWork(a);
    const deepB = isDeepWork(b);
    if (deepA !== deepB) return deepA ? -1 : 1;
    const hardA = categoryHasHard(a);
    const hardB = categoryHasHard(b);
    if (hardA !== hardB) return hardA ? -1 : 1;
    const remA = remainingByCategory.get(a)!;
    const remB = remainingByCategory.get(b)!;
    if (remA !== remB) return remB - remA;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const placeCategory = (category: string): void => {
    // Category-level block length: a per-category override, else the parsed
    // targetLength (default 30). Grouped/reserved blocks use this; a single-task
    // block may further override it per task (see below).
    const categoryDuration = categoryDurationFor(category);
    const preferredWindows = preferredWindowsFor(category);

    let remaining = remainingByCategory.get(category)!;
    const categoryTasks = tasksByCategory.get(category) ?? [];
    const isNoQuota = noQuotaCategories.has(category);
    // Grouped mode is a quota'd behavior (places weeklyCount shared containers);
    // it never applies to a no-quota catch-all, which schedules real tasks only.
    const grouped = config.taskQuotas[category]?.grouped === true && !isNoQuota;

    // Shared per-date spread state for this category (the must-do first pass may
    // have already incremented some days). Drives the leveled search so blocks
    // fan out across distinct days before doubling up on any one day.
    const catCount = catCountByCategory.get(category)!;

    // Grouped mode: place `remaining` reserved-style blocks (no per-block task
    // consumption), then give EVERY block the SAME full agenda — all of the
    // category's selected candidate tasks (in the engine's task sort order). Each
    // block emits a ProposedBlock with `tasks` (the whole shared list) and no
    // single `task`, so every block shares the identical outreach agenda.
    if (grouped) {
      const placed: Array<{ blockId: string; dateStr: string; start: string; durationMinutes: number; trimmedMinutes: number }> = [];
      while (remaining > 0) {
        const windows = buildWindowsForTask(undefined, preferredWindows, workingDays);
        // Soft run rule for each container (a grouped block is task time and may
        // trim by 15 min to fit before the cap is dropped).
        const placement = findFlexibleSlot(
          (dur, wr) => findLeveledSlot(catCount, windows, dur, wr),
          categoryDuration,
          workRun,
          true
        );
        if (!placement) break; // no more room this week for this category
        const { slot, duration: placedDuration, trimmedMinutes } = placement;
        const start = timeStr(slot.startMs);
        placed.push({
          blockId: `${slot.dateStr}-${start}-${category}`,
          dateStr: slot.dateStr,
          start,
          durationMinutes: placedDuration,
          trimmedMinutes,
        });
        busy.push({ start: slot.startMs, end: slot.endMs });
        catCount[slot.dateStr] = (catCount[slot.dateStr] ?? 0) + 1;
        remaining -= 1;
      }
      // The full agenda shared by every placed block (same list in each).
      const agenda = categoryTasks.map(t => ({
        gid: t.gid,
        adhocId: t.adhocId,
        title: t.title,
        integrationId: t.integrationId,
      }));
      for (const slot of placed) {
        const trimmed = slot.trimmedMinutes > 0;
        const trimNote = trimmed ? ` Trimmed ${slot.trimmedMinutes} min to fit.` : '';
        proposals.push({
          id: slot.blockId,
          category,
          tasks: agenda,
          date: slot.dateStr,
          start: slot.start,
          durationMinutes: slot.durationMinutes,
          reason:
            (agenda.length > 0
              ? `${category} block — ${agenda.length} task${agenda.length === 1 ? '' : 's'} on the agenda.`
              : `Reserved ${category} time — no task assigned to this block.`) + trimNote,
          ...(trimmed ? { trimmedFromMinutes: slot.durationMinutes + slot.trimmedMinutes } : {}),
        });
      }
      return;
    }

    while (remaining > 0) {
      const task = categoryTasks.find(t => {
        const id = t.gid ?? t.adhocId;
        return id ? !usedTaskIds.has(id) : true;
      });

      // No-quota catch-all categories place only real selected tasks — never a
      // reserved filler block. Once the selected tasks are exhausted, stop.
      if (!task && isNoQuota) break;

      // A single-task block prefers this task's per-task length override; a
      // reserved block (no task) falls back to the category length. The chosen
      // duration also drives the slot search so the block is sized correctly.
      const taskId = task ? task.gid ?? task.adhocId : undefined;
      const duration =
        (taskId && input.durationOverridesByTask?.[taskId]) || categoryDuration;

      const windows = buildWindowsForTask(task?.bestTime, preferredWindows, workingDays);
      // Deep work owns the mornings: try the morning-flex placement FIRST (slide
      // later within the morning, then shrink to a 60-min floor to fit the largest
      // morning gap around a meeting), before the normal windows. Only when even a
      // 60-min block won't fit the morning does it fall through to normal placement.
      let placement: FlexSlot | null = null;
      if (isDeepWork(category)) {
        const morningWindows = deepWorkMorningWindows(preferredWindows, workingDays);
        if (morningWindows.length > 0) {
          placement = findDeepWorkMorningPlacement(
            (dur, wr) => findLeveledSlot(catCount, morningWindows, dur, wr),
            duration,
            workRun
          );
        }
      }
      // Soft run rule. This loop only ever runs for NON-grouped categories (grouped
      // ones return early above), so NOTHING here is trimmable: a single-task block
      // (Blogs, General Todos, ad-hoc) keeps its exact stated length, and so does a
      // non-grouped reserved filler block. Only grouped/container blocks trim (see
      // the grouped branch). canShrink=false → tiers a + c only (full strict, then
      // full cap-ignored), never the 15-min shrink.
      placement ??= findFlexibleSlot(
        (dur, wr) => findLeveledSlot(catCount, windows, dur, wr),
        duration,
        workRun,
        false
      );
      if (!placement) {
        // No room left this week for this category inside working hours. A real
        // selected task becomes an evening-overflow candidate; the rest of this
        // category's remaining budget is collected too (they won't fit either).
        // A reserved block (no task) is never an overflow candidate.
        if (task) {
          let budget = remaining;
          for (const t of categoryTasks) {
            if (budget <= 0) break;
            const tid = t.gid ?? t.adhocId;
            if (tid && usedTaskIds.has(tid)) continue;
            if (tid) usedTaskIds.add(tid);
            leftovers.push({
              task: t,
              category,
              duration: (tid && input.durationOverridesByTask?.[tid]) || categoryDuration,
            });
            budget -= 1;
          }
        }
        break;
      }

      // Only deep-work morning-flex trims a block in this (non-grouped) loop
      // (shorten to fit a meeting-shortened morning); every other block keeps its
      // full requested length, so trimmedMinutes is 0 and placedDuration is full.
      const { slot, duration: placedDuration, trimmedMinutes } = placement;
      const start = timeStr(slot.startMs);
      const blockId = `${slot.dateStr}-${start}-${category}`;
      const trimNote =
        trimmedMinutes > 0 ? ` Shortened ${trimmedMinutes} min to fit the morning.` : '';
      const trimField =
        trimmedMinutes > 0 ? { trimmedFromMinutes: placedDuration + trimmedMinutes } : {};

      if (task) {
        usedTaskIds.add(taskId!);
        proposals.push({
          id: blockId,
          category,
          task: {
            gid: task.gid,
            adhocId: task.adhocId,
            title: task.title,
            integrationId: task.integrationId,
          },
          date: slot.dateStr,
          start,
          durationMinutes: placedDuration,
          reason: buildReason(category, slot.preferred, task) + trimNote,
          ...trimField,
        });
      } else {
        proposals.push({
          id: blockId,
          category,
          date: slot.dateStr,
          start,
          durationMinutes: placedDuration,
          reason:
            `Reserved ${category} time — quota not yet met and no matching task available.` +
            trimNote,
          ...trimField,
        });
      }

      // Occupy the slot for the rest of the run.
      busy.push({ start: slot.startMs, end: slot.endMs });
      catCount[slot.dateStr] = (catCount[slot.dateStr] ?? 0) + 1;
      remaining -= 1;
    }
  };

  // --- Placement order ------------------------------------------------------
  // 1. Deep work FIRST: it must lead every working day, so it claims the earliest
  //    morning (preferred-window) slots before anything else competes for them.
  // 2. Must-dos NEXT: they slot in immediately after deep work (non-deep must-dos
  //    keep their tier-first preferred-window behaviour).
  // 3. Everything else, in the computed category order.
  const deepCategories = orderedCategories.filter(c => isDeepWork(c));
  const otherCategories = orderedCategories.filter(c => !isDeepWork(c));
  for (const category of deepCategories) placeCategory(category);
  runMustDoPass();
  for (const category of otherCategories) placeCategory(category);

  // --- Leftover retry in working hours -------------------------------------
  // Before falling to evening overflow, give every leftover a final, unrestricted
  // pass over the plain working-hours windows on ALL remaining days — ignoring the
  // spread (leveled) preference and preferred-time ordering that the category loop
  // applied. This guarantees a task only overflows if it GENUINELY cannot be
  // placed in working hours under the run rule, not merely because the spread
  // heuristic or preferred-window ordering skipped its day. Placed here it is a
  // normal (non-overflow) working-hours block.
  const workingHoursWindows: Window[] = workingDays
    .map(day => ({
      date: day.date,
      dateStr: day.dateStr,
      startMs: day.whStartMs,
      endMs: day.whEndMs,
      preferred: false,
      bestTimeMatch: false,
    }))
    .sort((a, b) => a.startMs - b.startMs);
  const stillLeftover: Array<{ task: CandidateTask; category: string; duration: number }> = [];
  for (const lo of leftovers) {
    // Leftovers are real SINGLE tasks — full length only (strict then cap-ignored),
    // never trimmed. A leftover overflows only when no free gap fits its full length.
    const placement = findFlexibleSlot(
      (dur, wr) => findSlot(workingHoursWindows, dur, wr, busy, nowMs),
      lo.duration,
      workRun,
      false
    );
    if (!placement) {
      stillLeftover.push(lo);
      continue;
    }
    const { slot, duration: placedDuration } = placement;
    const start = timeStr(slot.startMs);
    proposals.push({
      id: `${slot.dateStr}-${start}-${lo.category}`,
      category: lo.category,
      task: {
        gid: lo.task.gid,
        adhocId: lo.task.adhocId,
        title: lo.task.title,
        integrationId: lo.task.integrationId,
      },
      date: slot.dateStr,
      start,
      durationMinutes: placedDuration,
      reason: buildReason(lo.category, false, lo.task),
    });
    busy.push({ start: slot.startMs, end: slot.endMs });
  }

  // --- Optional evening overflow -------------------------------------------
  // For real tasks that didn't fit inside working hours, try to place an OPTIONAL
  // block in the configured overflow window (e.g. 21:00–23:00) on the remaining
  // days. The overflow window sits OUTSIDE working hours, so buildWorkingDays'
  // working-hours windows don't cover it — build sibling overflow windows for the
  // same days explicitly. Calendar busy + already-placed blocks are respected and
  // the work-run rule applies within the window. Blocks are marked overflow:true
  // so the UI can offer them as opt-in (default-rejected).
  const overflowStart = config.scheduling.overflow
    ? parseTimeOfDay(config.scheduling.overflow.start)
    : null;
  const overflowEnd = config.scheduling.overflow
    ? parseTimeOfDay(config.scheduling.overflow.end)
    : null;
  const overflowWindows: Window[] =
    overflowStart && overflowEnd
      ? workingDays
          .map(day => ({
            date: day.date,
            dateStr: day.dateStr,
            startMs: msAt(day.date, overflowStart),
            endMs: msAt(day.date, overflowEnd),
            preferred: false,
            bestTimeMatch: false,
          }))
          .filter(w => w.endMs > w.startMs)
          .sort((a, b) => a.startMs - b.startMs)
      : [];

  for (const lo of stillLeftover) {
    // Each leftover already failed the working-hours search with the run cap
    // dropped, so it is simply out of free time. Either place an optional evening
    // overflow block or report the task as fully unplaceable.
    const slot = overflowWindows.length
      ? findSlot(overflowWindows, lo.duration, workRun, busy, nowMs)
      : null;
    if (slot) {
      const start = timeStr(slot.startMs);
      proposals.push({
        id: `${slot.dateStr}-${start}-overflow-${lo.category}`,
        category: lo.category,
        kind: 'task',
        task: {
          gid: lo.task.gid,
          adhocId: lo.task.adhocId,
          title: lo.task.title,
          integrationId: lo.task.integrationId,
        },
        date: slot.dateStr,
        start,
        durationMinutes: lo.duration,
        reason: `${lo.category} — didn't fit in working hours (${NO_FREE_GAP_CLAUSE}); optional evening overflow.`,
        overflow: true,
      });
      busy.push({ start: slot.startMs, end: slot.endMs });
    } else if (unplaceableOut) {
      // Fully unplaceable: no working-hours slot and no evening overflow slot.
      const id = lo.task.gid ?? lo.task.adhocId;
      if (id) unplaceableOut.push({ id, title: lo.task.title, category: lo.category });
    }
  }

  return proposals;
}

function buildReason(category: string, preferred: boolean, task: CandidateTask): string {
  const bits: string[] = [`${category} block`];
  if (task.deadlineType === 'hard') bits.push('hard deadline');
  else if (task.deadlineType) bits.push(`${task.deadlineType} deadline`);
  if (task.dueDate) bits.push(`due ${task.dueDate}`);
  bits.push(preferred ? 'in a preferred window' : 'in working hours');
  return bits.join(', ') + '.';
}
