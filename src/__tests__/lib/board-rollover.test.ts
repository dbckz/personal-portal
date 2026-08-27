import { planBoardRollover, nextWorkingDayOnOrAfter, type RolloverInput } from '@/lib/board-rollover';
import type { AdHocTask, ScheduledAsanaTask } from '@/types';

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

function input(over: Partial<RolloverInput> = {}): RolloverInput {
  return {
    logicalToday: WED,
    scheduledAsanaTasks: [],
    adHocTasks: [],
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

  it('is a no-op on a plan already applied for the day (rolled dates are not before today)', () => {
    // A task already rolled to today (or later) does not roll again.
    const rolled = scheduled({ scheduledDate: WED, originallyPlannedFor: '2026-08-24', rolls: 1 });
    const plan = planBoardRollover(input({ scheduledAsanaTasks: [rolled] }));
    expect(plan.scheduled).toEqual([]);
  });
});
