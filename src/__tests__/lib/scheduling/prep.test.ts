/**
 * Tests for the pure meeting-prep block placer.
 * Dates use the local Date constructor so tests are timezone-independent.
 */
import { proposePrepBlocks, type PrepMeeting } from '@/lib/scheduling/prep';
import type { BusyInterval } from '@/lib/scheduling/types';
import type { WorkflowConfig } from '@/lib/workflow-config-storage';

const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEK_START = new Date(2026, 6, 13, 0, 0, 0, 0); // Monday 2026-07-13

function makeConfig(overrides: Partial<WorkflowConfig['scheduling']> = {}): WorkflowConfig {
  return {
    taskQuotas: {},
    typeMapping: {},
    scheduling: {
      bufferBetweenTasks: '30min',
      workingDays: ALL_DAYS,
      workingHours: { start: '09:00', end: '17:00' },
      ...overrides,
    },
    lastUpdated: '2026-07-12T00:00:00.000Z',
  };
}

function meeting(overrides: Partial<PrepMeeting> & { startMs: number }): PrepMeeting {
  const d = new Date(overrides.startMs);
  return {
    eventId: 'evt-1',
    title: 'Board sync',
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    ...overrides,
  };
}

function run(input: {
  meetings: PrepMeeting[];
  scheduling?: Partial<WorkflowConfig['scheduling']>;
  busyIntervals?: BusyInterval[];
}) {
  return proposePrepBlocks({
    meetings: input.meetings,
    config: makeConfig(input.scheduling),
    busyIntervals: input.busyIntervals ?? [],
    weekStart: WEEK_START,
    now: WEEK_START,
  });
}

describe('proposePrepBlocks', () => {
  it('books prep the day before a mid-week meeting in working hours', () => {
    const startMs = new Date(2026, 6, 15, 14, 0).getTime(); // Wed 14:00
    const { placed, unplaced } = run({ meetings: [meeting({ startMs })] });

    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    const block = placed[0];
    expect(block.kind).toBe('prep');
    expect(block.category).toBe('Meeting prep');
    expect(block.durationMinutes).toBe(15);
    expect(block.date).toBe('2026-07-14'); // Tuesday, the day before
    expect(block.start).toBe('12:00'); // afternoon-first, mornings left for deep work
    expect(block.meeting?.eventId).toBe('evt-1');
    expect(block.reason).toContain('Board sync');
    expect(block.reason).toContain('Wed 14:00');
  });

  it('falls back to the day of when the day before is not a working day in the week', () => {
    // Monday meeting: the day before (Sunday) sits outside this week's days.
    const startMs = new Date(2026, 6, 13, 14, 0).getTime(); // Mon 14:00
    const { placed, unplaced } = run({ meetings: [meeting({ startMs })] });

    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0].date).toBe('2026-07-13'); // Monday, day of
    expect(placed[0].start).toBe('12:00'); // afternoon-first, before the 14:00 meeting
  });

  it('an early-morning day-of meeting falls back to the day before (never starts a day with prep)', () => {
    // Tuesday meeting at 09:40: the day-of window [09:00, 09:40] sits entirely in
    // the excluded first 90 minutes (workStart 09:00 → earliest prep 10:30), so no
    // day-of prep is allowed. Placement falls back to Monday (the day before).
    const startMs = new Date(2026, 6, 14, 9, 40).getTime(); // Tue 09:40
    const { placed, unplaced } = run({ meetings: [meeting({ startMs })] });

    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0].date).toBe('2026-07-13'); // Monday, the day before
    expect(placed[0].start).toBe('12:00'); // afternoon-first on the day before
  });

  it('never starts prep before workStart + 90 minutes (day-of, afternoon unavailable)', () => {
    // Tuesday meeting at 11:00. Monday (day before) is fully busy, so prep must go
    // day-of. The day-of window is capped at 11:00 and the afternoon (12:00) is
    // past the cap, so the rest-of-day window from workStart+90 (10:30) is used:
    // prep lands at 10:30, never in the excluded 09:00–10:30 morning.
    const startMs = new Date(2026, 6, 14, 11, 0).getTime(); // Tue 11:00
    const mondayFull: BusyInterval = {
      start: new Date(2026, 6, 13, 9, 0),
      end: new Date(2026, 6, 13, 17, 0),
    };
    const { placed, unplaced } = run({
      meetings: [meeting({ startMs })],
      busyIntervals: [mondayFull],
    });

    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0].date).toBe('2026-07-14'); // Tuesday, day of
    expect(placed[0].start).toBe('10:30'); // workStart (09:00) + 90 min
  });

  it('reports meetings that fit nowhere as unplaced', () => {
    // Monday meeting at 09:00: no prior working day, and no room before it.
    const startMs = new Date(2026, 6, 13, 9, 0).getTime();
    const { placed, unplaced } = run({ meetings: [meeting({ startMs })] });

    expect(placed).toHaveLength(0);
    expect(unplaced).toHaveLength(1);
  });

  it('places two meetings\' preps without collision', () => {
    const m1 = meeting({ eventId: 'a', title: 'One', startMs: new Date(2026, 6, 15, 14, 0).getTime() });
    const m2 = meeting({ eventId: 'b', title: 'Two', startMs: new Date(2026, 6, 15, 15, 0).getTime() });
    const { placed, unplaced } = run({ meetings: [m1, m2] });

    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(2);
    // Both prep on Tuesday, at distinct non-overlapping times.
    expect(placed.every(p => p.date === '2026-07-14')).toBe(true);
    const starts = placed.map(p => p.start).sort();
    expect(new Set(starts).size).toBe(2);
  });

  it('leaves an early-morning meeting unplaced rather than starting the day with prep', () => {
    // Meeting Tuesday 10:00. Monday (day before) is busy across all working hours,
    // so no day-before slot exists. The only day-of room is [09:00, 10:00], which
    // lies entirely within the excluded first 90 minutes (earliest prep 10:30), so
    // the morning rule wins: the prep is left unplaced rather than violated.
    const startMs = new Date(2026, 6, 14, 10, 0).getTime(); // Tue 10:00
    const mondayFull: BusyInterval = {
      start: new Date(2026, 6, 13, 9, 0),
      end: new Date(2026, 6, 13, 17, 0),
    };
    const { placed, unplaced } = run({
      meetings: [meeting({ startMs })],
      busyIntervals: [mondayFull],
    });

    expect(placed).toHaveLength(0);
    expect(unplaced).toHaveLength(1);
  });

  it('defaults a prep block to 15 minutes when the meeting has no durationMinutes', () => {
    const startMs = new Date(2026, 6, 15, 14, 0).getTime(); // Wed 14:00
    const { placed } = run({ meetings: [meeting({ startMs })] });
    expect(placed).toHaveLength(1);
    expect(placed[0].durationMinutes).toBe(15);
  });

  it('applies each meeting\'s own durationMinutes, defaulting the rest to 15', () => {
    // Two meetings the day before: one overrides to 30, the other has no
    // override → 15. Each placed block carries its own meeting's length.
    const overridden = meeting({
      eventId: 'a',
      title: 'Override',
      startMs: new Date(2026, 6, 15, 14, 0).getTime(),
      durationMinutes: 30,
    });
    const defaulted = meeting({
      eventId: 'b',
      title: 'Default',
      startMs: new Date(2026, 6, 15, 15, 0).getTime(),
    });
    const { placed, unplaced } = run({ meetings: [overridden, defaulted] });

    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(2);
    const byEvent = new Map(placed.map(p => [p.meeting!.eventId, p]));
    expect(byEvent.get('a')!.durationMinutes).toBe(30);
    expect(byEvent.get('b')!.durationMinutes).toBe(15);
  });

  it('honours a per-meeting durationMinutes of 60', () => {
    const startMs = new Date(2026, 6, 15, 14, 0).getTime(); // Wed 14:00
    const { placed } = run({ meetings: [meeting({ startMs, durationMinutes: 60 })] });
    expect(placed).toHaveLength(1);
    expect(placed[0].durationMinutes).toBe(60);
  });

  it('honours a preferredDate several days before the meeting', () => {
    // Friday meeting; user picks Monday (three days before) for the prep.
    const startMs = new Date(2026, 6, 17, 14, 0).getTime(); // Fri 14:00
    const { placed, unplaced } = run({
      meetings: [meeting({ startMs, preferredDate: '2026-07-13' })],
    });
    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0].date).toBe('2026-07-13'); // Monday, the chosen day
  });

  it('respects the before-meeting end-cap and the morning exclusion when preferredDate is the meeting day', () => {
    // Monday meeting at 11:00, prep preferred on the day of. The day-of window is
    // capped at 11:00; the excluded morning pushes the earliest start to 10:30, so
    // a 15-min prep lands at 10:30 (after the exclusion, before the meeting).
    const startMs = new Date(2026, 6, 13, 11, 0).getTime(); // Mon 11:00
    const { placed, unplaced } = run({
      meetings: [meeting({ startMs, preferredDate: '2026-07-13' })],
    });
    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0].date).toBe('2026-07-13');
    expect(placed[0].start).toBe('10:30'); // workStart+90, before the 11:00 meeting
  });

  it('places next-week prep on the LATEST working day of this week (preferLatest)', () => {
    // Meeting next Monday 09:00 — its day-before / day-of are next week, so prep
    // goes into THIS week's latest working day (Friday), freshest before the meeting.
    const startMs = new Date(2026, 6, 20, 9, 0).getTime(); // next Mon 09:00
    const { placed, unplaced } = run({
      meetings: [meeting({ startMs, preferLatest: true })],
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    });
    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0].date).toBe('2026-07-17'); // Friday, the latest working day
    expect(placed[0].start).toBe('12:00'); // afternoon-first
  });

  it('walks back to an earlier working day when the latest is full (preferLatest)', () => {
    const startMs = new Date(2026, 6, 20, 9, 0).getTime(); // next Mon 09:00
    const fridayFull: BusyInterval = {
      start: new Date(2026, 6, 17, 9, 0),
      end: new Date(2026, 6, 17, 17, 0),
    };
    const { placed, unplaced } = run({
      meetings: [meeting({ startMs, preferLatest: true })],
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
      busyIntervals: [fridayFull],
    });
    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0].date).toBe('2026-07-16'); // Thursday, next latest working day
  });

  it('honours a preferredDate over the latest-first default (preferLatest)', () => {
    const startMs = new Date(2026, 6, 20, 9, 0).getTime(); // next Mon 09:00
    const { placed, unplaced } = run({
      meetings: [meeting({ startMs, preferLatest: true, preferredDate: '2026-07-15' })],
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    });
    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0].date).toBe('2026-07-15'); // Wednesday, the chosen day
  });

  it('falls back to a PRECEDING day when the preferred day is full (never a later day)', () => {
    // Friday meeting; user prefers Wednesday, but Wednesday is fully busy. Placement
    // walks BACK to Tuesday (a preceding day), never forward to Thursday.
    const startMs = new Date(2026, 6, 17, 14, 0).getTime(); // Fri 14:00
    const wednesdayFull: BusyInterval = {
      start: new Date(2026, 6, 15, 9, 0),
      end: new Date(2026, 6, 15, 17, 0),
    };
    const { placed, unplaced } = run({
      meetings: [meeting({ startMs, preferredDate: '2026-07-15' })],
      busyIntervals: [wednesdayFull],
    });
    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0].date).toBe('2026-07-14'); // Tuesday, the preceding day
  });

  it('walks back across multiple full preceding days to the first that fits', () => {
    // Friday meeting; user prefers Thursday. Thursday and Wednesday are full, so
    // prep lands on Tuesday (the next earlier working day with room).
    const startMs = new Date(2026, 6, 17, 14, 0).getTime(); // Fri 14:00
    const busy: BusyInterval[] = [
      { start: new Date(2026, 6, 16, 9, 0), end: new Date(2026, 6, 16, 17, 0) }, // Thu full
      { start: new Date(2026, 6, 15, 9, 0), end: new Date(2026, 6, 15, 17, 0) }, // Wed full
    ];
    const { placed, unplaced } = run({
      meetings: [meeting({ startMs, preferredDate: '2026-07-16' })],
      busyIntervals: busy,
    });
    expect(unplaced).toHaveLength(0);
    expect(placed[0].date).toBe('2026-07-14'); // Tuesday
  });

  it('never slides a preferred-day prep to a LATER day: unplaced when the chosen day is the earliest and full', () => {
    // Wednesday meeting; user prefers Monday (which is today, the earliest working
    // day) but Monday is full. There is no preceding day, and we never slide to
    // Tuesday/Wednesday, so the meeting is left unplaced.
    const startMs = new Date(2026, 6, 15, 14, 0).getTime(); // Wed 14:00
    const mondayFull: BusyInterval = {
      start: new Date(2026, 6, 13, 9, 0),
      end: new Date(2026, 6, 13, 17, 0),
    };
    const { placed, unplaced } = run({
      meetings: [meeting({ startMs, preferredDate: '2026-07-13' })],
      busyIntervals: [mondayFull],
    });
    expect(placed).toHaveLength(0);
    expect(unplaced).toHaveLength(1);
  });

  it('never places a next-week meeting into next week, even given a next-week preferredDate', () => {
    // Meeting next Monday 09:00. Prep is always placed in THIS week — a
    // preferredDate that points at next Monday can't escape this week (there are
    // no next-week windows), so it lands on the latest this-week day (Friday).
    const startMs = new Date(2026, 6, 20, 9, 0).getTime(); // next Mon 09:00
    const { placed, unplaced } = run({
      meetings: [meeting({ startMs, preferLatest: true, preferredDate: '2026-07-20' })],
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    });
    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0].date).toBe('2026-07-17'); // this week's Friday, never next week
  });

  it('default placement walks back beyond the day-before when it and the day-of are full', () => {
    // Friday meeting; Thursday (day before) and Friday (day of) are both fully
    // busy. Placement walks further back to Wednesday rather than going unplaced.
    const startMs = new Date(2026, 6, 17, 14, 0).getTime(); // Fri 14:00
    const busy: BusyInterval[] = [
      { start: new Date(2026, 6, 16, 9, 0), end: new Date(2026, 6, 16, 17, 0) }, // Thu full
      { start: new Date(2026, 6, 17, 9, 0), end: new Date(2026, 6, 17, 17, 0) }, // Fri full
    ];
    const { placed, unplaced } = run({ meetings: [meeting({ startMs })], busyIntervals: busy });
    expect(unplaced).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0].date).toBe('2026-07-15'); // Wednesday
    expect(placed[0].start).toBe('12:00'); // afternoon-first
  });

  it('gives a "meeting is today" reason when a same-day meeting has no slot before it', () => {
    // Monday meeting at 09:00 (today, now = Monday): no prior day and no room.
    const startMs = new Date(2026, 6, 13, 9, 0).getTime();
    const { unplaced } = run({ meetings: [meeting({ startMs })] });
    expect(unplaced).toHaveLength(1);
    expect(unplaced[0].reason).toBe('meeting is today — no free slot left before it starts');
  });

  it('names the days tried when a non-today meeting fits nowhere', () => {
    // Wednesday meeting; Mon/Tue/Wed all fully busy, so the day-before, day-of and
    // walk-back all fail. The reason lists the working days tried, chronologically.
    const startMs = new Date(2026, 6, 15, 14, 0).getTime(); // Wed 14:00
    const busy: BusyInterval[] = [
      { start: new Date(2026, 6, 13, 9, 0), end: new Date(2026, 6, 13, 17, 0) }, // Mon full
      { start: new Date(2026, 6, 14, 9, 0), end: new Date(2026, 6, 14, 17, 0) }, // Tue full
      { start: new Date(2026, 6, 15, 9, 0), end: new Date(2026, 6, 15, 17, 0) }, // Wed full
    ];
    const { placed, unplaced } = run({ meetings: [meeting({ startMs })], busyIntervals: busy });
    expect(placed).toHaveLength(0);
    expect(unplaced).toHaveLength(1);
    expect(unplaced[0].reason).toBe('no free slot on Mon, Tue, Wed before the meeting');
  });

});
