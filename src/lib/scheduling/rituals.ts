// Pure daily-ritual block placement (lunch + exercise + emails).
//
// Every working day should get, if missing:
//   * 🍽️ Lunch — 30 min, ideally 11:30–13:00 (else nearest free 30-min slot in
//     11:00–14:00; else skipped). Counts as a BREAK for the work-run rule.
//   * 🏋️ Exercise — 60 min, ideally starting at 15:00 (else the free 60-min slot
//     whose start is CLOSEST to 15:00, searched outward within 13:00–18:00; else
//     skipped). Counts as a BREAK for the work-run rule (like lunch).
//   * 📧 Emails — 30 min, toward the END of the working day (last free 30-min slot
//     in the final 2 hours, falling back earlier in the afternoon; else skipped).
//     Counts as WORK for the work-run rule.
//
// Like prep.ts / engine.ts this is I/O-free and deterministic: every input is
// passed in and the output is a plain list of ProposedBlocks, so the propose
// route stays thin and the logic is unit-testable.

import type { SchedulingConfig, WorkflowConfig } from '@/lib/workflow-config-storage';
import type { CalendarEvent } from '@/types';

import {
  buildWindowsForTask,
  findSlot,
  localDateStr,
  parseTimeOfDay,
  resolveWorkingWindow,
  slotIsValid,
  timeStr,
  type BusyMs,
  type TimeOfDay,
  type Window,
  type WorkingDay,
  type WorkRun,
} from './engine';
import type { BusyInterval, ProposedBlock } from './types';

// Exact ritual event titles. Shared so free/busy tagging, dedupe, reset sweeping
// and replan all agree on the convention instead of hard-coding the literals.
export const LUNCH_TITLE = '🍽️ Lunch';
export const EXERCISE_TITLE = '🏋️ Exercise';
export const EMAILS_TITLE = '📧 Emails';
// WORK-type rituals (they count toward work runs, coloured yellow like tasks).
// Kindle notes is WEEKLY x2 (placed on two distinct days a week); grooming + retro
// are WEEKLY x1 (placed once per week, deduped by title across the whole week).
export const KINDLE_TITLE = '📚 Kindle notes';
export const GROOMING_TITLE = '🧹 Backlog grooming';
export const RETRO_TITLE = '🔄 Retrospective';
// Reviewing what the delegation agents produced. WEEKLY x2 like Kindle notes:
// the "For review" inbox fills up between runs, and a twice-weekly sweep keeps
// it from becoming a backlog of its own.
export const DELEGATION_REVIEW_TITLE = '🤖 Delegation review';
// Daily BREAK-type walk (paired with a podcast; the pairing is just flavour).
// Like lunch/exercise it splits work runs and never counts as worked time.
export const WALK_TITLE = '🚶 Walk';
// Office-day BREAK-type rituals (see placeOfficeAndTravelBlocks). Both split work
// runs and never count as worked time (like the walk). Get ready sits immediately
// before the commute.
export const GET_READY_TITLE = '🪞 Get ready';
export const COMMUTE_TITLE = '🚇 Commute to office';
// Travel-day fixed block: "✈️ Travel to {destination}" (fallback "✈️ Travel").
// The title is dynamic (carries the destination), so it is matched by PREFIX
// rather than listed in RITUAL_TITLES. Personal/non-work time, like a break.
export const TRAVEL_TITLE_PREFIX = '✈️ Travel';
export function travelBlockTitle(destination?: string): string {
  const d = destination?.trim();
  return d ? `${TRAVEL_TITLE_PREFIX} to ${d}` : TRAVEL_TITLE_PREFIX;
}
export function isTravelTitle(title: string): boolean {
  return title.trim().startsWith(TRAVEL_TITLE_PREFIX);
}
// WEEKLY x1 WORK-type rituals (placed once per week, deduped by title across the
// whole week). 📖 Reading is an afternoon-preferred single; 🎰 New bookies is
// placed in the EVENING (Mon/Fri, >= 18:00, outside working hours) by its own
// helper — see the new-bookies section in proposeRitualBlocks.
export const NEW_BOOKIES_TITLE = '🎰 New bookies';
export const READING_TITLE = '📖 Reading';
// RETIRED rituals — no longer proposed. Kept as constants (and listed in
// RETIRED_RITUAL_TITLES below) purely so reset / reconcile / replan sweeps still
// recognise any blocks left on the calendar from when these were active.
// 🛠️ Side projects is dropped for good; 🎓 Learning and 💼 Consulting are parked
// "for now" (learning may be reintroduced later), so the concepts are kept rather
// than deleted.
export const CONSULTING_TITLE = '💼 Consulting';
export const SIDE_PROJECTS_TITLE = '🛠️ Side projects';
export const LEARNING_TITLE = '🎓 Learning';
// Explicit break events placed after each ~2h work run (see breaks.ts). Tracked
// in the ritualBlocks store like the daily rituals so reconcile / reset / replan
// sweeps cover them.
export const BREAK_TITLE = '☕ Break';
export const RITUAL_TITLES: readonly string[] = [
  LUNCH_TITLE,
  EXERCISE_TITLE,
  EMAILS_TITLE,
  KINDLE_TITLE,
  GROOMING_TITLE,
  RETRO_TITLE,
  DELEGATION_REVIEW_TITLE,
  WALK_TITLE,
  GET_READY_TITLE,
  COMMUTE_TITLE,
  CONSULTING_TITLE,
  SIDE_PROJECTS_TITLE,
  NEW_BOOKIES_TITLE,
  READING_TITLE,
  LEARNING_TITLE,
  BREAK_TITLE,
];

// Rituals that are no longer proposed but may still exist on the calendar from
// when they were active. Sweeps (reset / reconcile) recognise them via
// RITUAL_TITLES; the replan flow additionally proposes any not-yet-ended block
// with one of these titles for REMOVAL (see planReplan).
export const RETIRED_RITUAL_TITLES: readonly string[] = [
  CONSULTING_TITLE,
  SIDE_PROJECTS_TITLE,
  LEARNING_TITLE,
];

// The ritual/break kinds. Lunch + exercise + break are BREAKS (split work runs);
// emails + kindle + grooming + retro count as WORK.
export type RitualKind =
  | 'lunch'
  | 'exercise'
  | 'emails'
  | 'kindleNotes'
  | 'grooming'
  | 'retro'
  | 'delegationReview'
  | 'walk'
  | 'getReady'
  | 'commute'
  | 'travel'
  | 'consulting'
  | 'sideProjects'
  | 'newBookies'
  | 'reading'
  | 'learning'
  | 'break';

// Ritual cadence. Daily rituals are placed on (and deduped per) each working day;
// weekly rituals are placed a fixed number of times across the week (once for
// grooming/retro, twice for kindle notes) on distinct days, deduped by title.
export type RitualCadence = 'daily' | 'weekly';
export function ritualCadenceForTitle(title: string): RitualCadence {
  const t = title.trim();
  return t === GROOMING_TITLE ||
    t === RETRO_TITLE ||
    t === KINDLE_TITLE ||
    t === DELEGATION_REVIEW_TITLE ||
    t === CONSULTING_TITLE ||
    t === SIDE_PROJECTS_TITLE ||
    t === NEW_BOOKIES_TITLE ||
    t === READING_TITLE ||
    t === LEARNING_TITLE
    ? 'weekly'
    : 'daily';
}

// How many times a WEEKLY ritual is placed across the week (on distinct days).
export const KINDLE_WEEKLY_COUNT = 2;
export const DELEGATION_REVIEW_WEEKLY_COUNT = 2;

// Lunch + exercise + break are breaks (split work runs); emails counts as work.
// A calendar event titled exactly like any of them is treated as a break by the
// run rule so it keeps work runs split.
export function isLunchTitle(title: string): boolean {
  return title.trim() === LUNCH_TITLE;
}
export function isExerciseTitle(title: string): boolean {
  return title.trim() === EXERCISE_TITLE;
}
export function isBreakTitle(title: string): boolean {
  const t = title.trim();
  return (
    t === LUNCH_TITLE ||
    t === EXERCISE_TITLE ||
    t === WALK_TITLE ||
    t === BREAK_TITLE ||
    t === GET_READY_TITLE ||
    t === COMMUTE_TITLE ||
    isTravelTitle(t)
  );
}
export function isRitualTitle(title: string): boolean {
  return RITUAL_TITLES.includes(title.trim());
}

// Drop any leading pictographs / variation selectors / ZWJs and surrounding
// whitespace, so "📧 Emails", "Emails" and " emails " all reduce to "emails".
export function ritualBaseName(title: string): string {
  return title
    .replace(/^[\s\p{Extended_Pictographic}️‍]+/u, '')
    .trim()
    .toLowerCase();
}

// The bare names behind the emoji constants ("lunch", "emails", "break", …),
// derived from RITUAL_TITLES so a new ritual needs no second list.
const RITUAL_BASE_NAMES: ReadonlySet<string> = new Set(RITUAL_TITLES.map(ritualBaseName));

// Tolerant BREAK identity: lunch / exercise / break, however the title is
// typed. Breaks are not work — used by time attribution to keep them out of
// worked time, whether the app created the block or Dave typed it in himself.
// The WORK rituals (emails, kindle notes, grooming, retrospective) are NOT
// breaks and deliberately do count.
const BREAK_BASE_NAMES: ReadonlySet<string> = new Set(
  [LUNCH_TITLE, EXERCISE_TITLE, WALK_TITLE, BREAK_TITLE].map(ritualBaseName)
);

export function isBreakLikeTitle(title: string): boolean {
  if (!title) return false;
  return BREAK_BASE_NAMES.has(ritualBaseName(title));
}

// Dave's standing decision: personal / visibility events never count as work,
// whatever calendar they sit on. Dave parks personal things on the OM calendar
// purely so others see him as busy (a cycle to football, the match itself, a
// flight, holiday, a wind-down). These are excluded by isCountableWorkEvent, so
// a stored attribution rule CANNOT rescue them (that filter runs before
// attribution) — and that is intended: they are not time spent working.
//
// Kept as named, exported lists so the set is easy to extend. Emoji markers
// match at the START of the title; terms match anywhere, case-insensitively.
export const PERSONAL_LIKE_TITLE_EMOJIS: readonly string[] = ['🚲', '⚽', '🏃', '✈️', '🌴'];
export const PERSONAL_LIKE_TITLE_TERMS: readonly string[] = [
  'footy',
  'parkrun',
  'flight:',
  'cycle to',
  'travel to',
  'wind down',
];

export function isPersonalLikeTitle(title: string): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  if (PERSONAL_LIKE_TITLE_EMOJIS.some(emoji => trimmed.startsWith(emoji))) return true;
  const lower = trimmed.toLowerCase();
  return PERSONAL_LIKE_TITLE_TERMS.some(term => lower.includes(term));
}

// Tolerant ritual identity, for EXCLUSION decisions only: is this title one of
// the rituals, however the user typed it? A manually-created "Emails" event (no
// emoji) is still the emails ritual and must never be adopted as a task or
// offered for carry-over — but it is NOT app-created, so the exact-title
// constants above still govern dedupe, reset sweeps and free/busy tagging.
// Matching is whole-name: "Email triage" is a real task, not the ritual.
export function isRitualLikeTitle(title: string): boolean {
  if (!title) return false;
  return RITUAL_BASE_NAMES.has(ritualBaseName(title));
}
// Resolve a ritual/break title to its kind. A non-ritual title falls back to
// 'emails' (callers pass ritual titles only; the fallback keeps the return total).
export function ritualKindForTitle(title: string): RitualKind {
  const t = title.trim();
  if (t === EXERCISE_TITLE) return 'exercise';
  if (t === LUNCH_TITLE) return 'lunch';
  if (t === WALK_TITLE) return 'walk';
  if (t === GET_READY_TITLE) return 'getReady';
  if (t === COMMUTE_TITLE) return 'commute';
  if (isTravelTitle(t)) return 'travel';
  if (t === BREAK_TITLE) return 'break';
  if (t === KINDLE_TITLE) return 'kindleNotes';
  if (t === GROOMING_TITLE) return 'grooming';
  if (t === RETRO_TITLE) return 'retro';
  if (t === DELEGATION_REVIEW_TITLE) return 'delegationReview';
  if (t === CONSULTING_TITLE) return 'consulting';
  if (t === SIDE_PROJECTS_TITLE) return 'sideProjects';
  if (t === NEW_BOOKIES_TITLE) return 'newBookies';
  if (t === READING_TITLE) return 'reading';
  if (t === LEARNING_TITLE) return 'learning';
  return 'emails';
}

// A future 🎰 New bookies block is validly placed ONLY on a Monday or Friday
// evening (start >= 18:00, i.e. outside working hours). Any other day, or any
// start before 18:00 (inside working hours), is invalid — the replan flow removes
// such a block and re-places it per the evening rule. `date` is yyyy-MM-dd and
// `start` is HH:mm (local).
export const NEW_BOOKIES_EVENING_HOUR = 18;
export function newBookiesPlacementIsValid(date: string, start: string): boolean {
  const [y, mo, d] = date.split('-').map(Number);
  const [h] = start.split(':').map(Number);
  const weekday = new Date(y, mo - 1, d).getDay(); // 0=Sun … 6=Sat
  const isMondayOrFriday = weekday === 1 || weekday === 5;
  return isMondayOrFriday && h >= NEW_BOOKIES_EVENING_HOUR;
}

// Per-kind ritual calendar routing. Exercise (and the break events, which are
// also green/non-work and belong on the same personal calendar) resolve to the
// exercise calendar; lunch + emails resolve to their own calendar, falling back
// to the legacy single `ritualGoogleIntegrationId` so existing configs still work.
// Returns undefined when nothing is configured for the kind → caller uses the
// default Google integration.
export function ritualIntegrationIdForKind(
  scheduling: Pick<SchedulingConfig, 'ritualCalendars' | 'ritualGoogleIntegrationId'>,
  kind: RitualKind
): string | undefined {
  const cals = scheduling.ritualCalendars;
  const legacy = scheduling.ritualGoogleIntegrationId;
  if (kind === 'exercise' || kind === 'break') return cals?.exercise;
  // Walk is a break-type personal ritual: its own calendar, else the exercise
  // (personal) calendar like the other breaks.
  if (kind === 'walk') return cals?.walk ?? cals?.exercise;
  // Get ready / Commute / Travel are personal, break-type daily blocks — route
  // them to the same (personal) calendar the other breaks use.
  if (kind === 'getReady' || kind === 'commute' || kind === 'travel') return cals?.exercise;
  if (kind === 'lunch') return cals?.lunch ?? legacy;
  if (kind === 'emails') return cals?.emails ?? legacy;
  // The WORK-type rituals (kindle / grooming / retro / delegation review /
  // new bookies / reading — plus the retired consulting / side projects / learning
  // kinds, still routed here for any old blocks) default to the emails calendar
  // setting (→ OM), still per-kind configurable.
  return cals?.[kind] ?? cals?.emails ?? legacy;
}

// The ritual calendar for a proposed ritual/break block (by its exact title).
export function ritualIntegrationIdForBlock(
  scheduling: Pick<SchedulingConfig, 'ritualCalendars' | 'ritualGoogleIntegrationId'>,
  title: string
): string | undefined {
  return ritualIntegrationIdForKind(scheduling, ritualKindForTitle(title));
}

const MS_PER_MINUTE = 60 * 1000;
const SLOT_STEP_MINUTES = 15;
const RITUAL_DURATION_MINUTES = 30;
const EXERCISE_DURATION_MINUTES = 60;
const KINDLE_DURATION_MINUTES = 30;
const GROOMING_DURATION_MINUTES = 60;
const RETRO_DURATION_MINUTES = 60;
const DELEGATION_REVIEW_DURATION_MINUTES = 30;
const WALK_DURATION_MINUTES = 45;
const GET_READY_DURATION_MINUTES = 45;
const COMMUTE_DURATION_MINUTES = 45;
// Office-day pair: target the commute to END at 12:00 (get ready 10:30–11:15,
// commute 11:15–12:00) when the morning is otherwise clear.
const OFFICE_COMMUTE_TARGET_END_HOUR = 12;
// A fixed calendar meeting starting before this hour pulls the commute earlier so
// it ends at/before the meeting.
const OFFICE_MORNING_MEETING_CUTOFF_HOUR = 13;
// Never place the get-ready/commute pair earlier than this (a sensible morning
// floor so a very early meeting simply skips the pair rather than landing it at
// dawn).
const OFFICE_PAIR_FLOOR_HOUR = 6;
// Default travel-block placement when the wizard omits values.
const DEFAULT_TRAVEL_DEPART: TimeOfDay = { h: 9, m: 0 };
const DEFAULT_TRAVEL_MINUTES = 120;
const NEW_BOOKIES_DURATION_MINUTES = 30;
const READING_DURATION_MINUTES = 60;
// WORK rituals PREFER the afternoon (from this hour) with a morning fallback, so
// deep work — placed first (see the propose route / engine) — keeps first claim
// on the mornings and the rituals fit around it.
const WORK_RITUAL_AFTERNOON_HOUR = 12;
// New bookies sits in the evening: Mon/Fri, 18:00–22:00 window, outside working
// hours (the work-run rule does not apply there).
const NEW_BOOKIES_WINDOW_START_HOUR = NEW_BOOKIES_EVENING_HOUR; // 18:00
const NEW_BOOKIES_WINDOW_END_HOUR = 22; // 22:00

export interface ProposeRitualsInput {
  config: WorkflowConfig;
  busyIntervals: BusyInterval[];
  weekStart: Date;
  now: Date;
  // Per-date set of ritual titles already present on the calendar that day
  // (exact-match on "🍽️ Lunch" / "📧 Emails"), so an existing ritual is not
  // duplicated. Keyed by yyyy-MM-dd.
  existingRitualTitlesByDate: Record<string, Set<string>>;
  // Out-of-office dates (yyyy-MM-dd) to drop from working days — no rituals there.
  outOfOfficeDates?: Set<string>;
  // Days (yyyy-MM-dd) the user opted in to a 🚶 walk. The walk is OPT-IN PER DAY:
  // it is placed ONLY on a listed day that is also a working day. Absent or empty
  // → no walks at all. Every other ritual is unaffected.
  walkDays?: string[];
  // Which rituals to place. 'daily' places only the per-day rituals
  // (walk / lunch / exercise / emails); 'weekly' places only the weekly rituals
  // (kindle / delegation review / grooming / retro / new bookies / reading).
  // 'all' (the default) places both. The propose route places 'daily' BEFORE task
  // blocks (so lunch/exercise structure the day) and 'weekly' AFTER them (so deep
  // work claims the mornings first and the weekly work rituals fit around it).
  phase?: 'all' | 'daily' | 'weekly';
}

// Absolute ms for an hour/minute on a working day (local).
function msAtDay(day: WorkingDay, h: number, m: number): number {
  return new Date(
    day.date.getFullYear(),
    day.date.getMonth(),
    day.date.getDate(),
    h,
    m,
    0,
    0
  ).getTime();
}

function ceilToStep(ms: number): number {
  const stepMs = SLOT_STEP_MINUTES * MS_PER_MINUTE;
  return Math.ceil(ms / stepMs) * stepMs;
}

function overlapsBusy(start: number, end: number, busy: BusyMs[]): boolean {
  for (const b of busy) {
    if (b.start < end && b.end > start) return true;
  }
  return false;
}

// Scan a [winStart, winEnd) window on the 15-min grid for a free duration-long
// slot (>= now, no overlap with busy). Returns the earliest free start, or the
// latest when `latestFirst`, or null when none fits.
function findFreeSlot(
  winStartMs: number,
  winEndMs: number,
  durationMs: number,
  busy: BusyMs[],
  nowMs: number,
  latestFirst: boolean
): number | null {
  const stepMs = SLOT_STEP_MINUTES * MS_PER_MINUTE;
  let start = ceilToStep(Math.max(winStartMs, nowMs));
  let last: number | null = null;
  while (start + durationMs <= winEndMs) {
    if (start >= nowMs && !overlapsBusy(start, start + durationMs, busy)) {
      if (!latestFirst) return start;
      last = start;
    }
    start += stepMs;
  }
  return last;
}

// Scan a [winStart, winEnd) window on the 15-min grid for the free duration-long
// slot (>= now, no overlap with busy) whose START is CLOSEST to `targetMs`. Ties
// (equal distance on either side) prefer the earlier start for determinism.
// Returns null when no slot fits. Used to anchor exercise near 15:00.
function findClosestFreeSlot(
  targetMs: number,
  winStartMs: number,
  winEndMs: number,
  durationMs: number,
  busy: BusyMs[],
  nowMs: number
): number | null {
  const stepMs = SLOT_STEP_MINUTES * MS_PER_MINUTE;
  const earliest = ceilToStep(Math.max(winStartMs, nowMs));
  const candidates: number[] = [];
  for (let start = earliest; start + durationMs <= winEndMs; start += stepMs) {
    candidates.push(start);
  }
  candidates.sort((a, b) => {
    const da = Math.abs(a - targetMs);
    const db = Math.abs(b - targetMs);
    if (da !== db) return da - db;
    return a - b; // equal distance → earlier start wins
  });
  for (const start of candidates) {
    if (start >= nowMs && !overlapsBusy(start, start + durationMs, busy)) return start;
  }
  return null;
}

// Build the per-date set of ritual titles already present on the calendar this
// week (exact-match on the ritual titles), so an existing ritual — including one
// added manually — is never duplicated. Keyed by yyyy-MM-dd. Shared by every
// route that places rituals so the dedupe convention stays in one place.
export function existingRitualTitlesByDateFromEvents(
  weekEvents: CalendarEvent[]
): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const e of weekEvents) {
    if (e.allDay) continue;
    const title = e.title?.trim();
    if (!title || !RITUAL_TITLES.includes(title)) continue;
    const dateStr = localDateStr(e.startTime);
    (out[dateStr] ??= new Set<string>()).add(title);
  }
  return out;
}

// Assemble proposeRitualBlocks inputs from the week context and place this
// week's rituals. Both the propose route and the prep-candidates route call this
// with identical inputs, so a ritual placement is deterministic across the two
// steps (given the same busy set): the prep step reserves the ritual slots (so
// prep never steals the 15:00 exercise slot), and the propose step re-derives the
// same slots because the accepted prep it adds to busy never overlaps them.
export function placeWeekRituals(params: {
  config: WorkflowConfig;
  weekEvents: CalendarEvent[];
  busyIntervals: BusyInterval[];
  weekStart: Date;
  now: Date;
  outOfOfficeDates?: Set<string>;
  // Days (yyyy-MM-dd) the user opted in to a 🚶 walk. Omit for no walks (the
  // default): the prep-candidates route reserves ritual time before walks are
  // picked, so it passes nothing here.
  walkDays?: string[];
  // Which rituals to place (see ProposeRitualsInput.phase). Defaults to 'all'.
  phase?: 'all' | 'daily' | 'weekly';
}): ProposedBlock[] {
  return proposeRitualBlocks({
    config: params.config,
    busyIntervals: params.busyIntervals,
    weekStart: params.weekStart,
    now: params.now,
    existingRitualTitlesByDate: existingRitualTitlesByDateFromEvents(params.weekEvents),
    outOfOfficeDates: params.outOfOfficeDates,
    walkDays: params.walkDays,
    phase: params.phase,
  });
}

// Convert a proposed block's date + HH:mm + duration into a busy interval so
// callers can add accepted prep/ritual blocks to the busy set. A break ritual
// (lunch / exercise) is tagged as a break (splits work runs); everything else
// counts as work.
export function proposedBlockToBusyInterval(block: ProposedBlock): BusyInterval {
  const [y, mo, d] = block.date.split('-').map(Number);
  const [h, m] = block.start.split(':').map(Number);
  const start = new Date(y, mo - 1, d, h, m, 0, 0);
  const end = new Date(start.getTime() + block.durationMinutes * MS_PER_MINUTE);
  const isBreak =
    block.kind === 'break' ||
    (block.kind === 'ritual' && !!block.title && isBreakTitle(block.title));
  return { start, end, ...(isBreak ? { isBreak: true } : {}) };
}

// Afternoon-preferred (12:00 → working-hours end) + whole-working-day fallback
// windows across the given days, for the WORK-type rituals (Kindle notes /
// delegation review / backlog grooming / reading). Mirrors the engine's afternoon
// default so these prefer the afternoon; the whole-day fallback tier keeps them
// landing SOMEWHERE on a busy day. This is intentionally two-tier: deep work is
// placed FIRST (see the propose route), so by the time these place it has already
// taken the morning space it needs and any morning fallback used here is space
// deep work did not want.
function afternoonWorkWindows(days: WorkingDay[], workingHoursEnd: TimeOfDay): Window[] {
  return buildWindowsForTask(
    undefined,
    [[{ h: WORK_RITUAL_AFTERNOON_HOUR, m: 0 }, workingHoursEnd]],
    days
  );
}

// The LATEST run-rule-valid start for a work block of `durationMs` within
// [winStartMs, winEndMs) on the 15-min grid (>= now). Returns null when none
// fits. Used to place the retrospective as late as possible in a day.
function findLatestValidStart(
  winStartMs: number,
  winEndMs: number,
  durationMs: number,
  busy: BusyMs[],
  nowMs: number,
  workRun: WorkRun
): number | null {
  const stepMs = SLOT_STEP_MINUTES * MS_PER_MINUTE;
  let start = ceilToStep(Math.max(winStartMs, nowMs));
  let last: number | null = null;
  while (start + durationMs <= winEndMs) {
    if (start >= nowMs && slotIsValid(start, start + durationMs, busy, workRun)) last = start;
    start += stepMs;
  }
  return last;
}

export function proposeRitualBlocks(input: ProposeRitualsInput): ProposedBlock[] {
  const { config, weekStart, now, existingRitualTitlesByDate } = input;
  const { workingDays, workRun, workingHoursEnd } = resolveWorkingWindow(
    config.scheduling,
    weekStart,
    now,
    input.outOfOfficeDates
  );
  const nowMs = now.getTime();
  const durationMs = RITUAL_DURATION_MINUTES * MS_PER_MINUTE;
  const exerciseDurationMs = EXERCISE_DURATION_MINUTES * MS_PER_MINUTE;
  const walkDurationMs = WALK_DURATION_MINUTES * MS_PER_MINUTE;
  // Walk is opt-in per day: place it only on the days the user picked (that are
  // also working days). No picks → no walks.
  const walkDaySet = new Set(input.walkDays ?? []);

  // Titles present on ANY day this week (for weekly-ritual dedupe: a weekly
  // ritual is skipped when its title already exists — or already happened —
  // somewhere in the week).
  const presentAnyDay = new Set<string>();
  for (const set of Object.values(existingRitualTitlesByDate)) {
    for (const t of set) presentAnyDay.add(t);
  }

  // Mutable run state so lunch/emails never collide with each other or meetings.
  const busy: BusyMs[] = input.busyIntervals.map(i => ({
    start: i.start.getTime(),
    end: i.end.getTime(),
    isBreak: i.isBreak,
  }));

  const proposals: ProposedBlock[] = [];

  const phase = input.phase ?? 'all';
  const placeDaily = phase !== 'weekly';
  const placeWeekly = phase !== 'daily';

  for (const day of workingDays) {
    if (!placeDaily) break;
    const present = existingRitualTitlesByDate[day.dateStr] ?? new Set<string>();

    // --- Walk (break) — mid-morning, ideal 10:30–11:30, widening to 09:30–12:00
    // (earliest-first, like lunch). Placed first so it sits before lunch; the
    // busy set it pushes keeps every later ritual off it. Opt-in per day: only a
    // day the user picked gets a walk. ---
    if (walkDaySet.has(day.dateStr) && !present.has(WALK_TITLE)) {
      let startMs = findFreeSlot(
        msAtDay(day, 10, 30),
        msAtDay(day, 11, 30),
        walkDurationMs,
        busy,
        nowMs,
        false
      );
      if (startMs === null) {
        startMs = findFreeSlot(
          msAtDay(day, 9, 30),
          msAtDay(day, 12, 0),
          walkDurationMs,
          busy,
          nowMs,
          false
        );
      }
      if (startMs !== null) {
        const start = timeStr(startMs);
        proposals.push({
          id: `${day.dateStr}-${start}-ritual-walk`,
          category: 'Walk',
          kind: 'ritual',
          title: WALK_TITLE,
          date: day.dateStr,
          start,
          durationMinutes: WALK_DURATION_MINUTES,
          reason: 'Daily walk (paired with a podcast).',
        });
        // Walk is a break: still busy, but splits work runs.
        busy.push({ start: startMs, end: startMs + walkDurationMs, isBreak: true });
      }
    }

    // --- Lunch (break) — ideal 11:30–13:00, fallback 11:00–14:00 ---
    if (!present.has(LUNCH_TITLE)) {
      let startMs = findFreeSlot(
        msAtDay(day, 11, 30),
        msAtDay(day, 13, 0),
        durationMs,
        busy,
        nowMs,
        false
      );
      if (startMs === null) {
        startMs = findFreeSlot(
          msAtDay(day, 11, 0),
          msAtDay(day, 14, 0),
          durationMs,
          busy,
          nowMs,
          false
        );
      }
      if (startMs !== null) {
        const start = timeStr(startMs);
        proposals.push({
          id: `${day.dateStr}-${start}-ritual-lunch`,
          category: 'Lunch',
          kind: 'ritual',
          title: LUNCH_TITLE,
          date: day.dateStr,
          start,
          durationMinutes: RITUAL_DURATION_MINUTES,
          reason: 'Daily lunch break.',
        });
        // Lunch is a break: still busy, but splits work runs.
        busy.push({ start: startMs, end: startMs + durationMs, isBreak: true });
      }
    }

    // --- Exercise (break) — NUMBER ONE priority: it must land EVERY working day.
    // Ideally starting at 15:00, else the free 60-min slot whose start is closest
    // to 15:00, searched outward within 13:00–18:00. When nothing fits in that
    // core window, widen the search to the ENTIRE working day (still closest to
    // 15:00); only skip the day when no free 60-min slot exists at all. ---
    if (!present.has(EXERCISE_TITLE)) {
      let startMs = findClosestFreeSlot(
        msAtDay(day, 15, 0),
        msAtDay(day, 13, 0),
        msAtDay(day, 18, 0),
        exerciseDurationMs,
        busy,
        nowMs
      );
      if (startMs === null) {
        startMs = findClosestFreeSlot(
          msAtDay(day, 15, 0),
          day.whStartMs,
          day.whEndMs,
          exerciseDurationMs,
          busy,
          nowMs
        );
      }
      if (startMs !== null) {
        const start = timeStr(startMs);
        proposals.push({
          id: `${day.dateStr}-${start}-ritual-exercise`,
          category: 'Exercise',
          kind: 'ritual',
          title: EXERCISE_TITLE,
          date: day.dateStr,
          start,
          durationMinutes: EXERCISE_DURATION_MINUTES,
          reason: 'Daily exercise.',
        });
        // Exercise is a break: still busy, but splits work runs.
        busy.push({ start: startMs, end: startMs + exerciseDurationMs, isBreak: true });
      }
    }

    // --- Emails (work) — end of the day: last free slot in the final 2 hours,
    // falling back to the wider afternoon (latest-first keeps it near day-end) ---
    if (!present.has(EMAILS_TITLE)) {
      const finalTwoHoursStart = day.whEndMs - 2 * 60 * MS_PER_MINUTE;
      let startMs = findFreeSlot(
        Math.max(finalTwoHoursStart, day.whStartMs),
        day.whEndMs,
        durationMs,
        busy,
        nowMs,
        true
      );
      if (startMs === null) {
        startMs = findFreeSlot(
          Math.max(msAtDay(day, 12, 0), day.whStartMs),
          day.whEndMs,
          durationMs,
          busy,
          nowMs,
          true
        );
      }
      if (startMs !== null) {
        const start = timeStr(startMs);
        proposals.push({
          id: `${day.dateStr}-${start}-ritual-emails`,
          category: 'Emails',
          kind: 'ritual',
          title: EMAILS_TITLE,
          date: day.dateStr,
          start,
          durationMinutes: RITUAL_DURATION_MINUTES,
          reason: 'Daily email time.',
        });
        // Emails counts as work — no isBreak flag, so it forms/extends runs.
        busy.push({ start: startMs, end: startMs + durationMs });
      }
    }

  }

  // --- Weekly rituals (placed a fixed number of times across the week, on
  // distinct days, deduped by title). Placed after the daily rituals so they
  // flow around them. ---
  if (placeWeekly) {

  // Kindle notes (work) — WEEKLY x2, 30 min each, afternoon preference: place on
  // up to two DISTINCT working days (earliest-day-first), skipping any day that
  // already has a kindle event. Existing kindle events across the week count
  // toward the two, so a mid-week re-run tops up rather than re-adding.
  {
    let kindleExisting = 0;
    for (const set of Object.values(existingRitualTitlesByDate)) {
      if (set.has(KINDLE_TITLE)) kindleExisting += 1;
    }
    let kindleToPlace = Math.max(0, KINDLE_WEEKLY_COUNT - kindleExisting);
    for (const day of workingDays) {
      if (kindleToPlace <= 0) break;
      const present = existingRitualTitlesByDate[day.dateStr] ?? new Set<string>();
      if (present.has(KINDLE_TITLE)) continue; // day already has one
      const slot = findSlot(
        afternoonWorkWindows([day], workingHoursEnd),
        KINDLE_DURATION_MINUTES,
        workRun,
        busy,
        nowMs
      );
      if (!slot) continue;
      const start = timeStr(slot.startMs);
      proposals.push({
        id: `${day.dateStr}-${start}-ritual-kindle`,
        category: 'Kindle notes',
        kind: 'ritual',
        title: KINDLE_TITLE,
        date: day.dateStr,
        start,
        durationMinutes: KINDLE_DURATION_MINUTES,
        reason: 'Kindle notes processing (twice weekly).',
      });
      busy.push({ start: slot.startMs, end: slot.endMs }); // work — forms runs
      kindleToPlace -= 1;
    }
  }

  // Delegation review (work) — WEEKLY x2, 30 min: catch up on what the agents
  // produced. Same top-up shape as Kindle notes, so a mid-week re-run adds only
  // what is missing rather than a second pair.
  {
    let reviewExisting = 0;
    for (const set of Object.values(existingRitualTitlesByDate)) {
      if (set.has(DELEGATION_REVIEW_TITLE)) reviewExisting += 1;
    }
    let reviewToPlace = Math.max(0, DELEGATION_REVIEW_WEEKLY_COUNT - reviewExisting);
    for (const day of workingDays) {
      if (reviewToPlace <= 0) break;
      const present = existingRitualTitlesByDate[day.dateStr] ?? new Set<string>();
      if (present.has(DELEGATION_REVIEW_TITLE)) continue; // day already has one
      const slot = findSlot(
        afternoonWorkWindows([day], workingHoursEnd),
        DELEGATION_REVIEW_DURATION_MINUTES,
        workRun,
        busy,
        nowMs
      );
      if (!slot) continue;
      const start = timeStr(slot.startMs);
      proposals.push({
        id: `${day.dateStr}-${start}-ritual-delegation-review`,
        category: 'Delegation review',
        kind: 'ritual',
        title: DELEGATION_REVIEW_TITLE,
        date: day.dateStr,
        start,
        durationMinutes: DELEGATION_REVIEW_DURATION_MINUTES,
        reason: 'Review delegated agent output (twice weekly).',
      });
      busy.push({ start: slot.startMs, end: slot.endMs }); // work — forms runs
      reviewToPlace -= 1;
    }
  }

  // Backlog grooming (work) — WEEKLY, 60 min: any working day with a free
  // run-valid hour, earliest-day-first, afternoon preference.
  if (!presentAnyDay.has(GROOMING_TITLE)) {
    const slot = findSlot(
      afternoonWorkWindows(workingDays, workingHoursEnd),
      GROOMING_DURATION_MINUTES,
      workRun,
      busy,
      nowMs
    );
    if (slot) {
      const start = timeStr(slot.startMs);
      proposals.push({
        id: `${slot.dateStr}-${start}-ritual-grooming`,
        category: 'Backlog grooming',
        kind: 'ritual',
        title: GROOMING_TITLE,
        date: slot.dateStr,
        start,
        durationMinutes: GROOMING_DURATION_MINUTES,
        reason: 'Weekly backlog grooming.',
      });
      busy.push({ start: slot.startMs, end: slot.endMs }); // work — forms runs
    }
  }

  // Retrospective (work) — WEEKLY, 60 min: the LAST working day preferred (as
  // late in that day as fits), falling back to earlier days (still late in the
  // day) when the last day is full.
  if (!presentAnyDay.has(RETRO_TITLE)) {
    const retroDurationMs = RETRO_DURATION_MINUTES * MS_PER_MINUTE;
    for (let i = workingDays.length - 1; i >= 0; i--) {
      const day = workingDays[i];
      const startMs = findLatestValidStart(
        day.whStartMs,
        day.whEndMs,
        retroDurationMs,
        busy,
        nowMs,
        workRun
      );
      if (startMs === null) continue;
      const start = timeStr(startMs);
      proposals.push({
        id: `${day.dateStr}-${start}-ritual-retro`,
        category: 'Retrospective',
        kind: 'ritual',
        title: RETRO_TITLE,
        date: day.dateStr,
        start,
        durationMinutes: RETRO_DURATION_MINUTES,
        reason: 'Weekly retrospective.',
      });
      busy.push({ start: startMs, end: startMs + retroDurationMs }); // work
      break;
    }
  }

  // --- New bookies (evening) — WEEKLY x1, 30 min, Monday PREFERRED then Friday,
  // in the 18:00–22:00 window OUTSIDE working hours. This is deliberately not a
  // working-hours slot: it just avoids busy events on the 15-min grid, and the
  // work-run rule does NOT apply in the evening. Deduped by title across the week.
  // Monday first; if Monday's evening is full or already past, fall back to Friday. ---
  if (!presentAnyDay.has(NEW_BOOKIES_TITLE)) {
    const newBookiesDurationMs = NEW_BOOKIES_DURATION_MINUTES * MS_PER_MINUTE;
    // Monday (getDay 1) before Friday (getDay 5); other days never host it.
    const eveningDays = workingDays
      .filter(d => d.date.getDay() === 1 || d.date.getDay() === 5)
      .sort((a, b) => a.date.getDay() - b.date.getDay());
    for (const day of eveningDays) {
      const startMs = findFreeSlot(
        msAtDay(day, NEW_BOOKIES_WINDOW_START_HOUR, 0),
        msAtDay(day, NEW_BOOKIES_WINDOW_END_HOUR, 0),
        newBookiesDurationMs,
        busy,
        nowMs,
        false
      );
      if (startMs === null) continue;
      const start = timeStr(startMs);
      proposals.push({
        id: `${day.dateStr}-${start}-ritual-new-bookies`,
        category: 'New bookies',
        kind: 'ritual',
        title: NEW_BOOKIES_TITLE,
        date: day.dateStr,
        start,
        durationMinutes: NEW_BOOKIES_DURATION_MINUTES,
        reason: 'Weekly new-bookies slot (Mon/Fri evening).',
      });
      // Evening block: still busy, but the work-run rule never applies here.
      busy.push({ start: startMs, end: startMs + newBookiesDurationMs });
      break;
    }
  }

  // --- Weekly WORK single (reading) — placed ONCE for the week, afternoon
  // preference (morning fallback), deduped by title across the whole week. ---
  if (!presentAnyDay.has(READING_TITLE)) {
    const slot = findSlot(
      afternoonWorkWindows(workingDays, workingHoursEnd),
      READING_DURATION_MINUTES,
      workRun,
      busy,
      nowMs
    );
    if (slot) {
      const start = timeStr(slot.startMs);
      proposals.push({
        id: `${slot.dateStr}-${start}-ritual-reading`,
        category: 'Reading',
        kind: 'ritual',
        title: READING_TITLE,
        date: slot.dateStr,
        start,
        durationMinutes: READING_DURATION_MINUTES,
        reason: 'Weekly reading time.',
      });
      busy.push({ start: slot.startMs, end: slot.endMs }); // work — forms runs
    }
  }

  } // end placeWeekly

  return proposals;
}

// Where Dave is on a given working day. Missing entry = home (no extra blocks).
export interface DayLocation {
  type: 'home' | 'office' | 'travel';
  destination?: string;
  departTime?: string; // "HH:mm"
  travelMinutes?: number;
}

// Sanitise the wizard's raw dayLocations payload into a clean map for the placer.
// Keeps only entries whose date is one of this week's dates (`weekDateStrs`) and
// whose type is 'office' or 'travel' ('home'/unknown → dropped, since home adds no
// blocks). Travel entries validate departTime ("HH:mm"), clamp travelMinutes to
// 15–720, and trim/cap the destination. Pure so the route stays thin and this is
// unit-testable.
export function sanitizeDayLocations(
  raw: unknown,
  weekDateStrs: Set<string>
): Record<string, DayLocation> {
  const out: Record<string, DayLocation> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [dateStr, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!weekDateStrs.has(dateStr) || !value || typeof value !== 'object') continue;
    const r = value as Record<string, unknown>;
    if (r.type === 'office') {
      out[dateStr] = { type: 'office' };
    } else if (r.type === 'travel') {
      const destination =
        typeof r.destination === 'string' && r.destination.trim()
          ? r.destination.trim().slice(0, 200)
          : undefined;
      const departTime =
        typeof r.departTime === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(r.departTime)
          ? r.departTime
          : undefined;
      const tm = Number(r.travelMinutes);
      const travelMinutes = Number.isFinite(tm)
        ? Math.min(720, Math.max(15, Math.round(tm)))
        : undefined;
      out[dateStr] = {
        type: 'travel',
        ...(destination ? { destination } : {}),
        ...(departTime ? { departTime } : {}),
        ...(travelMinutes !== undefined ? { travelMinutes } : {}),
      };
    }
    // 'home' (or anything else) → no entry, no blocks.
  }
  return out;
}

export interface OfficeTravelInput {
  config: WorkflowConfig;
  busyIntervals: BusyInterval[];
  weekStart: Date;
  now: Date;
  // Per-date location (yyyy-MM-dd → DayLocation). Only office/travel entries
  // produce blocks; home (or a missing entry) is a no-op.
  dayLocations: Record<string, DayLocation>;
  // Per-date set of ritual titles already on the calendar (so the get-ready /
  // commute pair is not duplicated on a re-run). Keyed by yyyy-MM-dd.
  existingRitualTitlesByDate?: Record<string, Set<string>>;
  // Dates (yyyy-MM-dd) that already have a "✈️ Travel…" event, so a travel block
  // is not duplicated on a re-run. The travel title is dynamic, so it can't be
  // deduped via existingRitualTitlesByDate.
  existingTravelDates?: Set<string>;
  // Out-of-office dates to drop from working days.
  outOfOfficeDates?: Set<string>;
}

export interface OfficeTravelResult {
  blocks: ProposedBlock[];
  // Per office-day cap (yyyy-MM-dd → absolute ms): the get-ready block's start,
  // i.e. the latest a deep-work morning block may run to on that day. Threaded
  // into the engine so deep work stops at the get-ready block on office days.
  deepWorkEndByDate: Record<string, number>;
}

// Scan downward from `targetEndMs` (15-min grid) for the latest END at which a
// back-to-back pair of length `pairMs` fits free of busy, with its start >=
// `floorMs`. Returns the end ms, or null when the pair fits nowhere in range.
function findLatestPairEnd(
  targetEndMs: number,
  floorMs: number,
  pairMs: number,
  busy: BusyMs[]
): number | null {
  const stepMs = SLOT_STEP_MINUTES * MS_PER_MINUTE;
  let end = Math.floor(targetEndMs / stepMs) * stepMs;
  while (end - pairMs >= floorMs) {
    const start = end - pairMs;
    if (!overlapsBusy(start, end, busy)) return end;
    end -= stepMs;
  }
  return null;
}

// Place the office-day get-ready + commute pair and the travel-day travel block
// for this week's day locations. Pure/deterministic like proposeRitualBlocks.
//
//  * Office day → "🪞 Get ready" (45m) immediately before "🚇 Commute to office"
//    (45m), both breaks. The commute ends at 12:00 by default (get ready
//    10:30–11:15, commute 11:15–12:00); if a fixed calendar meeting starts before
//    13:00 the commute is pulled earlier so it ends at/before that meeting, at the
//    latest position that fits. Reports a per-day deep-work cap (the get-ready
//    start) so deep work stops at the pair on office days.
//  * Travel day → "✈️ Travel to {destination}" starting at departTime for
//    travelMinutes (defaults 09:00 / 120m), a fixed busy block (treated as a break
//    so it doesn't count as worked time). No get-ready/commute and no deep-work cap.
export function placeOfficeAndTravelBlocks(input: OfficeTravelInput): OfficeTravelResult {
  const { config, weekStart, now, dayLocations } = input;
  const { workingDays } = resolveWorkingWindow(
    config.scheduling,
    weekStart,
    now,
    input.outOfOfficeDates
  );
  const busy: BusyMs[] = input.busyIntervals.map(i => ({
    start: i.start.getTime(),
    end: i.end.getTime(),
    isBreak: i.isBreak,
  }));
  const getReadyMs = GET_READY_DURATION_MINUTES * MS_PER_MINUTE;
  const commuteMs = COMMUTE_DURATION_MINUTES * MS_PER_MINUTE;
  const pairMs = getReadyMs + commuteMs;

  const blocks: ProposedBlock[] = [];
  const deepWorkEndByDate: Record<string, number> = {};

  for (const day of workingDays) {
    const loc = dayLocations[day.dateStr];
    if (!loc) continue;
    const present = input.existingRitualTitlesByDate?.[day.dateStr] ?? new Set<string>();

    if (loc.type === 'office') {
      // Default: commute ends at 12:00. A fixed calendar meeting (non-break busy)
      // starting before 13:00 pulls the pair earlier so it ends at/before it.
      const cutoffMs = msAtDay(day, OFFICE_MORNING_MEETING_CUTOFF_HOUR, 0);
      const dayFloorMs = Math.max(msAtDay(day, OFFICE_PAIR_FLOOR_HOUR, 0), now.getTime());
      let targetEndMs = msAtDay(day, OFFICE_COMMUTE_TARGET_END_HOUR, 0);
      let earliestMeeting: number | null = null;
      for (const b of busy) {
        if (b.isBreak) continue; // breaks aren't meetings
        if (b.start >= day.whStartMs - pairMs && b.start < cutoffMs && b.start >= dayFloorMs) {
          if (earliestMeeting === null || b.start < earliestMeeting) earliestMeeting = b.start;
        }
      }
      if (earliestMeeting !== null && earliestMeeting < targetEndMs) targetEndMs = earliestMeeting;

      const commuteEnd = findLatestPairEnd(targetEndMs, dayFloorMs, pairMs, busy);
      if (commuteEnd === null) continue; // no room for the pair this morning
      const getReadyStart = commuteEnd - pairMs;
      const commuteStart = getReadyStart + getReadyMs;

      if (!present.has(GET_READY_TITLE)) {
        const start = timeStr(getReadyStart);
        blocks.push({
          id: `${day.dateStr}-${start}-ritual-get-ready`,
          category: 'Get ready',
          kind: 'ritual',
          title: GET_READY_TITLE,
          date: day.dateStr,
          start,
          durationMinutes: GET_READY_DURATION_MINUTES,
          reason: 'Get ready before the commute to the office.',
        });
      }
      if (!present.has(COMMUTE_TITLE)) {
        const start = timeStr(commuteStart);
        blocks.push({
          id: `${day.dateStr}-${start}-ritual-commute`,
          category: 'Commute',
          kind: 'ritual',
          title: COMMUTE_TITLE,
          date: day.dateStr,
          start,
          durationMinutes: COMMUTE_DURATION_MINUTES,
          reason: 'Commute to the office.',
        });
      }
      // The pair is a break: still busy, but splits work runs.
      busy.push({ start: getReadyStart, end: commuteEnd, isBreak: true });
      // Deep work must stop at the get-ready block on office days.
      deepWorkEndByDate[day.dateStr] = getReadyStart;
    } else if (loc.type === 'travel') {
      if (input.existingTravelDates?.has(day.dateStr)) continue; // already has one
      const depart = parseTimeOfDay(loc.departTime ?? '') ?? DEFAULT_TRAVEL_DEPART;
      const travelMinutes =
        loc.travelMinutes && loc.travelMinutes > 0 ? loc.travelMinutes : DEFAULT_TRAVEL_MINUTES;
      const startMs = msAtDay(day, depart.h, depart.m);
      const start = timeStr(startMs);
      blocks.push({
        id: `${day.dateStr}-${start}-ritual-travel`,
        category: 'Travel',
        kind: 'ritual',
        title: travelBlockTitle(loc.destination),
        date: day.dateStr,
        start,
        durationMinutes: travelMinutes,
        reason: loc.destination ? `Travelling to ${loc.destination}.` : 'Travelling.',
      });
      // Travel is personal/non-work: busy, tagged as a break so it never counts as
      // worked time and splits work runs (deep work fits around it normally).
      busy.push({ start: startMs, end: startMs + travelMinutes * MS_PER_MINUTE, isBreak: true });
    }
  }

  return { blocks, deepWorkEndByDate };
}
