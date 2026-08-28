import {
  planBoardRollover,
  decideTaskRollover,
  nextWorkingDayOnOrAfter,
  type RolloverInput,
} from '@/lib/board-rollover';
import type { AdHocTask, ScheduledAsanaTask } from '@/types';
import type { PrepBlock } from '@/lib/storage/core';

// Mon 24 – Sun 30 Aug 2026. Wed 26 is a working day; Sat 29 is not.
const WED = '2026-08-26';

let seq = 0;
function scheduled(over: Partial<ScheduledAsanaTask> = {}): ScheduledAsanaTask {
  return {
    id: `s-${seq++}`,
    asanaTaskId: `g-${seq}`,
    scheduledDate: '2026-08-24',
    scheduledTime: '09:00',
    duration: 60,
    ...over,
  };
}

function adhoc(over: Partial<AdHocTask> = {}): AdHocTask {
  return {
    id: `a-${seq++}`,
    title: 'Task',
    completed: false,
    priority: 'medium',
    taskType: 'focus',
    dueDate: '2026-08-24',
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

function prep(over: Partial<PrepBlock> = {}): PrepBlock {
  const n = seq++;
  return {
    id: `p-${n}`,
    googleEventId: `ev-${n}`,
    googleIntegrationId: 'gi',
    meetingEventId: `m-${n}`,
    meetingTitle: 'Meeting',
    meetingStart: '2026-08-28T12:00:00.000Z',
    date: '2026-08-24',
    start: '09:00',
    durationMinutes: 30,
    done: false,
    createdAt: '',
    ...over,
  };
}

function input(over: Partial<RolloverInput> = {}): RolloverInput {
  return {
    logicalToday: WED,
    scheduledAsanaTasks: [],
    adHocTasks: [],
    prepBlocks: [],
    states: {},
    portalDoneGids: new Set(),
    blockDoneEventIds: new Set(),
    doneTaskIds: new Set(),
    deferrals: {},
    ...over,
  };
}

beforeEach(() => {
  seq = 0;
});

describe('nextWorkingDayOnOrAfter', () => {
  it('maps a working day to itself', () => {
    expect(nextWorkingDayOnOrAfter('2026-08-26')).toBe('2026-08-26'); // Wed
  });

  it('maps a Saturday to the following Monday', () => {
    expect(nextWorkingDayOnOrAfter('2026-08-29')).toBe('2026-08-31');
  });

  it('maps a Sunday to the following Monday', () => {
    expect(nextWorkingDayOnOrAfter('2026-08-30')).toBe('2026-08-31');
  });

  it('honours a custom working-day set', () => {
    // Only Wednesdays work: Thu 27 → next Wed 2 Sep.
    expect(nextWorkingDayOnOrAfter('2026-08-27', ['Wednesday'])).toBe('2026-09-02');
  });
});

describe('decideTaskRollover', () => {
  it('rolls the latest overdue record and removes the rest', () => {
    const d = decideTaskRollover(
      [
        { id: 'r1', date: '2026-08-24' },
        { id: 'r2', date: '2026-08-25' },
        { id: 'r3', date: '2026-08-24' },
      ],
      WED
    );
    expect(d.keep).toBe('r2');
    expect(d.remove.sort()).toEqual(['r1', 'r3']);
    expect(d.rollTarget).toBe(WED);
  });

  it('with a record on/after today, drops only stale ROLLED overdue records and keeps genuine ones', () => {
    const d = decideTaskRollover(
      [
        { id: 'genuine-past', date: '2026-08-24' }, // genuine overdue → kept as history
        { id: 'rolled-past', date: '2026-08-25', rolls: 1 }, // stale rolled → removed
        { id: 'today', date: WED }, // anchor on/after today
      ],
      WED
    );
    expect(d.keep).toBeNull();
    expect(d.remove).toEqual(['rolled-past']);
  });

  it('protects genuine multi-day planning: two future records + a stale rolled overdue one', () => {
    const d = decideTaskRollover(
      [
        { id: 'thu', date: '2026-08-27' }, // genuine future
        { id: 'fri', date: '2026-08-28' }, // genuine future
        { id: 'stale', date: '2026-08-24', originallyPlannedFor: '2026-08-24', rolls: 2 },
      ],
      WED
    );
    expect(d.keep).toBeNull();
    expect(d.remove).toEqual(['stale']);
  });

  it('ignores a record dated before this week\'s Monday: not rolled, not removed', () => {
    // weekStart for WED (26 Aug) is Mon 24 Aug; 17 Aug is the prior week and out
    // of scope for the daily rollover even with nothing scheduled today or later.
    const d = decideTaskRollover([{ id: 'preweek', date: '2026-08-17' }], WED);
    expect(d).toEqual({ keep: null, remove: [] });
  });

  it('still rolls a record from earlier in the SAME week', () => {
    // Mon 24 Aug is in this week (weekStart) and before WED → a rollover candidate.
    const d = decideTaskRollover([{ id: 'mon', date: '2026-08-24' }], WED);
    expect(d).toMatchObject({ keep: 'mon', remove: [], rollTarget: WED });
  });

  it('leaves a pre-week rolled duplicate alone (out of scope, never removed)', () => {
    const d = decideTaskRollover(
      [
        { id: 'today', date: WED }, // anchor on/after today
        { id: 'preweek-rolled', date: '2026-08-17', originallyPlannedFor: '2026-08-10', rolls: 2 },
      ],
      WED
    );
    expect(d.keep).toBeNull();
    expect(d.remove).toEqual([]); // the pre-week rolled record is not swept up
  });

  it('leaves a single overdue record rolling as before', () => {
    const d = decideTaskRollover([{ id: 'r1', date: '2026-08-24' }], WED);
    expect(d).toMatchObject({ keep: 'r1', remove: [], rollTarget: WED });
  });

  it('tie-breaks equal scheduledDate by the latest originallyPlannedFor', () => {
    const d = decideTaskRollover(
      [
        { id: 'a', date: '2026-08-24', originallyPlannedFor: '2026-08-18', rolls: 1 },
        { id: 'b', date: '2026-08-24', originallyPlannedFor: '2026-08-20', rolls: 1 },
      ],
      WED
    );
    expect(d.keep).toBe('b');
    expect(d.remove).toEqual(['a']);
  });

  it('never rolls or removes blocked (done/deferred) records', () => {
    const d = decideTaskRollover(
      [
        { id: 'done', date: '2026-08-20', blocked: true },
        { id: 'live', date: '2026-08-24' },
      ],
      WED
    );
    expect(d.keep).toBe('live');
    expect(d.remove).toEqual([]);
  });
});

describe('planBoardRollover', () => {
  it('rolls a past-dated, unfinished scheduled task to the logical day (a working day)', () => {
    const s = scheduled({ scheduledDate: '2026-08-24' });
    const plan = planBoardRollover(input({ scheduledAsanaTasks: [s] }));
    expect(plan.scheduled).toEqual([
      { id: s.id, date: WED, originallyPlannedFor: '2026-08-24', rolls: 1 },
    ]);
    expect(plan.adhoc).toEqual([]);
  });

  it('rolls a past-dated ad-hoc task by its dueDate', () => {
    const t = adhoc({ dueDate: '2026-08-25' });
    const plan = planBoardRollover(input({ adHocTasks: [t] }));
    expect(plan.adhoc).toEqual([
      { id: t.id, date: WED, originallyPlannedFor: '2026-08-25', rolls: 1 },
    ]);
  });

  it('leaves tasks dated today or in the future untouched', () => {
    const today = scheduled({ scheduledDate: WED });
    const future = scheduled({ scheduledDate: '2026-08-28' });
    const plan = planBoardRollover(input({ scheduledAsanaTasks: [today, future] }));
    expect(plan.scheduled).toEqual([]);
  });

  it('leaves undated tasks untouched', () => {
    const s = scheduled({ scheduledDate: undefined as unknown as string });
    const t = adhoc({ dueDate: undefined });
    const plan = planBoardRollover(input({ scheduledAsanaTasks: [s], adHocTasks: [t] }));
    expect(plan.scheduled).toEqual([]);
    expect(plan.adhoc).toEqual([]);
  });

  it('skips done tasks (board state, portal-done, block-done, weekly-done, completed)', () => {
    const byState = scheduled({ scheduledDate: '2026-08-24', id: 'sched-done', asanaTaskId: 'gs' });
    const byPortal = scheduled({ scheduledDate: '2026-08-24', asanaTaskId: 'gp' });
    const byBlock = scheduled({ scheduledDate: '2026-08-24', googleEventId: 'ev-done', asanaTaskId: 'gb' });
    const byWeekly = scheduled({ scheduledDate: '2026-08-24', asanaTaskId: 'gw' });
    const completedAdhoc = adhoc({ dueDate: '2026-08-24', completed: true });

    const plan = planBoardRollover(
      input({
        scheduledAsanaTasks: [byState, byPortal, byBlock, byWeekly],
        adHocTasks: [completedAdhoc],
        states: { 'sched:sched-done': { key: 'sched:sched-done', status: 'done', updatedAt: '' } },
        portalDoneGids: new Set(['gp']),
        blockDoneEventIds: new Set(['ev-done']),
        doneTaskIds: new Set(['gw']),
      })
    );
    expect(plan.scheduled).toEqual([]);
    expect(plan.adhoc).toEqual([]);
  });

  it('skips a task deferred to a future date, but rolls one whose deferral has expired', () => {
    const deferred = scheduled({ scheduledDate: '2026-08-24', asanaTaskId: 'gd' });
    const expired = scheduled({ scheduledDate: '2026-08-24', asanaTaskId: 'ge' });
    const plan = planBoardRollover(
      input({
        scheduledAsanaTasks: [deferred, expired],
        deferrals: { gd: '2026-09-01', ge: '2026-08-20' },
      })
    );
    expect(plan.scheduled.map(r => r.id)).toEqual([expired.id]);
  });

  it('skips the weekend: a Friday task rolls to Monday when the logical day is Saturday', () => {
    const s = scheduled({ scheduledDate: '2026-08-28' }); // Fri
    const plan = planBoardRollover(input({ logicalToday: '2026-08-29', scheduledAsanaTasks: [s] }));
    expect(plan.scheduled[0].date).toBe('2026-08-31'); // Mon
  });

  it('sets originallyPlannedFor once and preserves it across multiple rolls, incrementing rolls', () => {
    // First roll: no prior original, rolls absent → original = current date, rolls = 1.
    const firstRoll = scheduled({ scheduledDate: '2026-08-24' });
    const p1 = planBoardRollover(input({ scheduledAsanaTasks: [firstRoll] }));
    expect(p1.scheduled[0]).toMatchObject({ originallyPlannedFor: '2026-08-24', rolls: 1 });

    // Later roll: the record already carries the ORIGINAL date and a roll count;
    // the original is preserved and rolls increments, even though the current
    // date has since moved on.
    const laterRoll = scheduled({
      scheduledDate: '2026-08-25',
      originallyPlannedFor: '2026-08-20',
      rolls: 2,
    });
    const p2 = planBoardRollover(input({ scheduledAsanaTasks: [laterRoll] }));
    expect(p2.scheduled[0]).toMatchObject({ originallyPlannedFor: '2026-08-20', rolls: 3 });
  });

  it('dedupes several overdue records for ONE task: rolls the latest, removes the rest', () => {
    const r1 = scheduled({ asanaTaskId: 'dup', scheduledDate: '2026-08-24' });
    const r2 = scheduled({ asanaTaskId: 'dup', scheduledDate: '2026-08-25' });
    const r3 = scheduled({ asanaTaskId: 'dup', scheduledDate: '2026-08-24' });
    const plan = planBoardRollover(input({ scheduledAsanaTasks: [r1, r2, r3] }));
    expect(plan.scheduled).toEqual([
      { id: r2.id, date: WED, originallyPlannedFor: '2026-08-25', rolls: 1 },
    ]);
    expect(plan.removeScheduledIds.sort()).toEqual([r1.id, r3.id].sort());
  });

  it('with a future record, removes stale ROLLED overdue records but keeps genuine ones (rolls none)', () => {
    const genuinePast = scheduled({ asanaTaskId: 'here', scheduledDate: '2026-08-24' });
    const rolledPast = scheduled({
      asanaTaskId: 'here',
      scheduledDate: '2026-08-25',
      originallyPlannedFor: '2026-08-19',
      rolls: 1,
    });
    const future = scheduled({ asanaTaskId: 'here', scheduledDate: '2026-08-28' });
    const plan = planBoardRollover(input({ scheduledAsanaTasks: [genuinePast, rolledPast, future] }));
    expect(plan.scheduled).toEqual([]);
    expect(plan.removeScheduledIds).toEqual([rolledPast.id]);
  });

  it('keeps genuine future multi-day records and deletes only the stale rolled overdue one', () => {
    const thu = scheduled({ asanaTaskId: 'multi', scheduledDate: '2026-08-27' }); // genuine future
    const fri = scheduled({ asanaTaskId: 'multi', scheduledDate: '2026-08-28' }); // genuine future
    const stale = scheduled({
      asanaTaskId: 'multi',
      scheduledDate: '2026-08-24',
      originallyPlannedFor: '2026-08-18',
      rolls: 2,
    });
    const plan = planBoardRollover(input({ scheduledAsanaTasks: [thu, fri, stale] }));
    expect(plan.scheduled).toEqual([]);
    expect(plan.removeScheduledIds).toEqual([stale.id]);
  });

  it('dedupes overdue ad-hoc-equivalent: distinct tasks each still roll once', () => {
    const a = adhoc({ dueDate: '2026-08-24' });
    const b = adhoc({ dueDate: '2026-08-25' });
    const plan = planBoardRollover(input({ adHocTasks: [a, b] }));
    expect(plan.adhoc.map(r => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(plan.removeAdhocIds).toEqual([]);
  });

  it('ignores a task dated before this week\'s Monday: not rolled, not removed', () => {
    // 17 Aug is last week; the daily rollover leaves it entirely for the
    // end-of-week review, even with nothing scheduled today or later.
    const preweek = scheduled({ scheduledDate: '2026-08-17' });
    const preweekAdhoc = adhoc({ dueDate: '2026-08-17' });
    const plan = planBoardRollover(
      input({ scheduledAsanaTasks: [preweek], adHocTasks: [preweekAdhoc] })
    );
    expect(plan.scheduled).toEqual([]);
    expect(plan.adhoc).toEqual([]);
    expect(plan.removeScheduledIds).toEqual([]);
    expect(plan.removeAdhocIds).toEqual([]);
  });

  it('is a no-op on a plan already applied for the day (rolled dates are not before today)', () => {
    // A task already rolled to today (or later) does not roll again.
    const rolled = scheduled({ scheduledDate: WED, originallyPlannedFor: '2026-08-24', rolls: 1 });
    const plan = planBoardRollover(input({ scheduledAsanaTasks: [rolled] }));
    expect(plan.scheduled).toEqual([]);
  });
});

describe('planBoardRollover — prep blocks', () => {
  it('rolls an unfinished, in-week overdue prep block whose meeting is still to come', () => {
    // Prepped Mon 24 (in-week, overdue), meeting Fri 28 → rolls to WED.
    const pb = prep({ date: '2026-08-24', meetingStart: '2026-08-28T12:00:00.000Z' });
    const plan = planBoardRollover(input({ prepBlocks: [pb] }));
    expect(plan.prep).toEqual([
      { id: pb.id, date: WED, originallyPlannedFor: '2026-08-24', rolls: 1 },
    ]);
  });

  it('rolls when the target lands exactly on the meeting\'s local date (boundary)', () => {
    const pb = prep({ date: '2026-08-24', meetingStart: '2026-08-26T12:00:00.000Z' }); // meeting WED
    const plan = planBoardRollover(input({ prepBlocks: [pb] }));
    expect(plan.prep).toEqual([
      { id: pb.id, date: WED, originallyPlannedFor: '2026-08-24', rolls: 1 },
    ]);
  });

  it('preserves originallyPlannedFor and increments rolls on a re-rolled prep block', () => {
    const pb = prep({
      date: '2026-08-25',
      meetingStart: '2026-08-28T12:00:00.000Z',
      originallyPlannedFor: '2026-08-20',
      rolls: 2,
    });
    const plan = planBoardRollover(input({ prepBlocks: [pb] }));
    expect(plan.prep).toEqual([
      { id: pb.id, date: WED, originallyPlannedFor: '2026-08-20', rolls: 3 },
    ]);
  });

  it('does NOT roll a prep block whose meeting date has already passed', () => {
    // Prepped Mon 24, meeting Tue 25 — already behind us; prep is pointless now.
    const pb = prep({ date: '2026-08-24', meetingStart: '2026-08-25T12:00:00.000Z' });
    const plan = planBoardRollover(input({ prepBlocks: [pb] }));
    expect(plan.prep).toEqual([]);
  });

  it('does NOT roll a done prep block (own flag or block-done facts)', () => {
    const byFlag = prep({ date: '2026-08-24', done: true });
    const byFacts = prep({ date: '2026-08-24', googleEventId: 'ev-done' });
    const plan = planBoardRollover(
      input({ prepBlocks: [byFlag, byFacts], blockDoneEventIds: new Set(['ev-done']) })
    );
    expect(plan.prep).toEqual([]);
  });

  it('does NOT roll a prep block dated before this week\'s Monday', () => {
    // 17 Aug is last week — out of scope for the daily rollover even though the
    // meeting is still to come.
    const pb = prep({ date: '2026-08-17', meetingStart: '2026-08-28T12:00:00.000Z' });
    const plan = planBoardRollover(input({ prepBlocks: [pb] }));
    expect(plan.prep).toEqual([]);
  });

  it('leaves a prep block dated today or in the future untouched', () => {
    const today = prep({ date: WED, meetingStart: '2026-08-28T12:00:00.000Z' });
    const future = prep({ date: '2026-08-27', meetingStart: '2026-08-28T12:00:00.000Z' });
    const plan = planBoardRollover(input({ prepBlocks: [today, future] }));
    expect(plan.prep).toEqual([]);
  });
});
