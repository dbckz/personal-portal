// Pure meeting-prep block placement.
//
// Given the week's meetings that need preparation (already AI/user-decided
// upstream), proposePrepBlocks books a prep block for each (per-meeting
// duration via PrepMeeting.durationMinutes, default 15): the day
// before during working hours if possible, else the day of before the meeting
// starts (leaving the configured buffer), else walking further back through
// earlier working days. Meetings that fit nowhere are returned as `unplaced`,
// each with a short human reason. Like the scheduling engine this is I/O-free and
// deterministic; it reuses the engine's slot-search and working-day helpers so
// prep and task blocks obey the same buffer/working-hours rules.

import type { WorkflowConfig } from '@/lib/workflow-config-storage';

import {
  findSlot,
  localDateStr,
  resolveWorkingWindow,
  timeStr,
  MORNING_PREP_EXCLUSION_MINUTES,
  type BusyMs,
  type Window,
} from './engine';
import type { BusyInterval, ProposedBlock } from './types';

const DEFAULT_PREP_DURATION_MINUTES = 15;
const PREP_CATEGORY = 'Meeting prep';
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// A working day's placeable span: the shape resolveWorkingWindow returns.
interface DayWindow {
  dateStr: string;
  whStartMs: number;
  whEndMs: number;
}

// yyyy-MM-dd → a local Date at midnight (not UTC, unlike `new Date(str)`).
function parseLocalDate(dateStr: string): Date {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, d);
}

// A meeting that needs a prep block. `startMs` is the meeting's absolute start;
// `date` is its local yyyy-MM-dd.
export interface PrepMeeting {
  eventId: string;
  title: string;
  startMs: number;
  date: string;
  // Length of this meeting's prep block in minutes; defaults to 15 when absent.
  durationMinutes?: number;
  // User's chosen day (yyyy-MM-dd) for this prep block, always a working day of
  // THIS week. When set, placement tries that day first (with the before-meeting
  // end-cap when it is the meeting day), then walks BACKWARDS through earlier
  // working days to today — never to a day later than the pick. Nothing fitting
  // anywhere in that walk leaves the meeting unplaced. When absent, default
  // behaviour applies.
  preferredDate?: string;
}

export interface ProposePrepInput {
  meetings: PrepMeeting[];
  config: WorkflowConfig;
  busyIntervals: BusyInterval[];
  weekStart: Date;
  now: Date;
  // Out-of-office dates (yyyy-MM-dd) to drop from working days — no prep there.
  outOfOfficeDates?: Set<string>;
}

// A meeting that couldn't be placed, with a short human reason (rendered after
// the meeting title in the wizard's "couldn't fit prep" box).
export interface UnplacedPrep {
  meeting: PrepMeeting;
  reason: string;
}

export function proposePrepBlocks(
  input: ProposePrepInput
): { placed: ProposedBlock[]; unplaced: UnplacedPrep[] } {
  const { config, weekStart, now } = input;

  const { workRun, workingDays } = resolveWorkingWindow(
    config.scheduling,
    weekStart,
    now,
    input.outOfOfficeDates
  );
  const dayByDateStr = new Map(workingDays.map(d => [d.dateStr, d]));

  const todayStr = localDateStr(now);

  // Mutable run state shared across all preps so they never collide.
  const busy: BusyMs[] = input.busyIntervals.map(i => ({
    start: i.start.getTime(),
    end: i.end.getTime(),
  }));
  const nowMs = now.getTime();

  const placed: ProposedBlock[] = [];
  const unplaced: UnplacedPrep[] = [];

  // Earlier meetings pick their prep slot first.
  const meetings = [...input.meetings].sort((a, b) => a.startMs - b.startMs);

  for (const meeting of meetings) {
    const meetingDate = new Date(meeting.startMs);
    const prepDuration = meeting.durationMinutes ?? DEFAULT_PREP_DURATION_MINUTES;

    // End-cap for a day is the meeting start only when that day IS the meeting
    // day (prep must end before the meeting begins).
    const endCapFor = (dateStr: string): number | undefined =>
      dateStr === meeting.date ? meeting.startMs : undefined;

    // The days we actually tried, so an unplaced meeting can name them.
    const tried: string[] = [];
    const attempt = (day: DayWindow | undefined, endCapMs?: number): ReturnType<typeof tryDay> => {
      if (!day) return null;
      tried.push(day.dateStr);
      return tryDay(day, prepDuration, endCapMs);
    };

    let slot: ReturnType<typeof tryDay> = null;

    if (meeting.preferredDate) {
      // (0) User-preferred day: try the CHOSEN day first, then walk BACKWARDS
      // through each preceding working day to today. The pick is always a
      // this-week working day (the route drops any override into next week), so
      // draw from this week's days only. Prep may sit on the meeting day or
      // earlier, never after it — so cap the walk at the meeting date and apply
      // the before-meeting end-cap on the meeting day itself. If nothing fits on
      // the chosen day or any earlier day, the meeting goes unplaced (we never
      // slide prep to a day LATER than the user's pick).
      const latestStr = meeting.preferredDate < meeting.date ? meeting.preferredDate : meeting.date;
      const daysBackToToday = workingDays
        .filter(d => d.dateStr <= latestStr)
        .sort((a, b) => (a.dateStr < b.dateStr ? 1 : -1)); // chosen/latest first, back to today
      for (const day of daysBackToToday) {
        slot = attempt(day, endCapFor(day.dateStr));
        if (slot) break;
      }
    } else {
      // (a) Day before, anywhere in working hours.
      const dayBeforeStr = localDateStr(new Date(meeting.startMs - MS_PER_DAY));
      slot = attempt(dayByDateStr.get(dayBeforeStr), endCapFor(dayBeforeStr));

      // (b) Day of, before the meeting starts. The work-run rule handles run
      // lengths; prep just has to end by the meeting start.
      if (!slot) {
        slot = attempt(dayByDateStr.get(meeting.date), endCapFor(meeting.date));
      }

      // (c) Further back: earlier working days (before the day-before) down to
      // today, latest first, so a meeting whose day-before AND day-of are both
      // packed still gets prep earlier in the week rather than going unplaced.
      if (!slot) {
        const earlierDays = workingDays
          .filter(d => d.dateStr < dayBeforeStr)
          .sort((a, b) => (a.dateStr < b.dateStr ? 1 : -1)); // latest first, back to today
        for (const day of earlierDays) {
          slot = attempt(day, endCapFor(day.dateStr));
          if (slot) break;
        }
      }
    }

    if (!slot) {
      unplaced.push({ meeting, reason: unplacedReason(meeting, tried) });
      continue;
    }

    const start = timeStr(slot.startMs);
    const reason = `Prep for "${meeting.title}" (${WEEKDAY_ABBR[meetingDate.getDay()]} ${timeStr(meeting.startMs)})`;
    placed.push({
      id: `${slot.dateStr}-${start}-prep-${meeting.eventId}`,
      category: PREP_CATEGORY,
      kind: 'prep',
      date: slot.dateStr,
      start,
      durationMinutes: prepDuration,
      reason,
      meeting: {
        eventId: meeting.eventId,
        title: meeting.title,
        meetingStart: new Date(meeting.startMs).toISOString(),
      },
    });

    busy.push({ start: slot.startMs, end: slot.endMs });
  }

  return { placed, unplaced };

  // First-fit a prep-length slot within a working day, preferring the afternoon
  // (12:00 → end) so mornings stay free for deep work, then the rest of the day.
  // The first MORNING_PREP_EXCLUSION_MINUTES of the working day are excluded from
  // BOTH windows so a day never STARTS with prep (deep work / todos / meetings go
  // first). An optional end cap (day-of case, so prep ends before the meeting)
  // also applies to both. If a meeting is so early that only the excluded window
  // could hold day-of prep, no slot is returned here — prep then falls back to
  // the day before (or unplaced), never violating the morning rule.
  function tryDay(
    day: DayWindow,
    prepDuration: number,
    endCapMs?: number
  ): { startMs: number; endMs: number; dateStr: string; preferred: boolean } | null {
    const earliestStartMs = day.whStartMs + MORNING_PREP_EXCLUSION_MINUTES * MS_PER_MINUTE;
    const endMs = endCapMs !== undefined ? Math.min(day.whEndMs, endCapMs) : day.whEndMs;
    if (endMs <= earliestStartMs) return null;

    const noonMs = new Date(new Date(day.whStartMs).setHours(12, 0, 0, 0)).getTime();
    const afternoonStartMs = Math.max(noonMs, earliestStartMs);
    const windows: Window[] = [];
    // Afternoon window first (only when it starts after the excluded morning and
    // is non-empty).
    if (afternoonStartMs > earliestStartMs && afternoonStartMs < endMs) {
      windows.push({
        date: new Date(day.whStartMs),
        dateStr: day.dateStr,
        startMs: afternoonStartMs,
        endMs,
        preferred: false,
        bestTimeMatch: false,
      });
    }
    // Rest-of-day window (from the end of the excluded morning) as the fallback.
    windows.push({
      date: new Date(day.whStartMs),
      dateStr: day.dateStr,
      startMs: earliestStartMs,
      endMs,
      preferred: false,
      bestTimeMatch: false,
    });
    return findSlot(windows, prepDuration, workRun, busy, nowMs);
  }

  // A short human reason a meeting's prep couldn't be placed, from what the
  // placement loop knows. A meeting TODAY has no earlier day to fall back to and
  // no room left before it starts; otherwise we name the working days we tried.
  function unplacedReason(meeting: PrepMeeting, tried: string[]): string {
    if (meeting.date === todayStr) {
      return 'meeting is today — no free slot left before it starts';
    }
    const labels: string[] = [];
    for (const dateStr of [...tried].sort()) {
      const abbr = WEEKDAY_ABBR[parseLocalDate(dateStr).getDay()];
      if (!labels.includes(abbr)) labels.push(abbr);
    }
    if (labels.length === 0) return 'no free slot before the meeting';
    return `no free slot on ${labels.join(', ')} before the meeting`;
  }
}
