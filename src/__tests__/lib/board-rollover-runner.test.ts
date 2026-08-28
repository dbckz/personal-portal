/**
 * Round-trip tests for the board-rollover RUNNER (lib/storage/board-rollover):
 * it reads the local stores, applies the plan and stamps the last-run day, once
 * per logical day. Backed by the in-memory test db, so the real storage helpers
 * run end-to-end.
 */
import {
  getUserData,
  saveUserData,
  runBoardRollover,
  getScheduledAsanaTasks,
  getAdHocTasks,
  getPrepBlocks,
  getBoardRolloverState,
} from '@/lib/user-data-storage';
import { __resetDbForTests } from '@/lib/storage/db';
import type { AdHocTask, ScheduledAsanaTask } from '@/types';
import type { PrepBlock } from '@/lib/storage/core';

// Local noon on a given day, so logicalToday (04:00 rollover) resolves to it.
function noon(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d, 12, 0, 0);
}

async function seed(scheduled: ScheduledAsanaTask[], adhoc: AdHocTask[], prepBlocks: PrepBlock[] = []) {
  const data = await getUserData();
  data.scheduledAsanaTasks = scheduled;
  data.adHocTasks = adhoc;
  data.prepBlocks = prepBlocks;
  await saveUserData(data);
}

const prepBlock: PrepBlock = {
  id: 'pb1',
  googleEventId: 'ev1',
  googleIntegrationId: 'gi',
  meetingEventId: 'm1',
  meetingTitle: 'Meeting',
  meetingStart: '2026-08-28T12:00:00.000Z',
  date: '2026-08-24',
  start: '09:00',
  durationMinutes: 30,
  done: false,
  createdAt: '',
};

const sched: ScheduledAsanaTask = {
  id: 's1',
  asanaTaskId: 'g1',
  scheduledDate: '2026-08-24',
  scheduledTime: '09:00',
  duration: 60,
};
const task: AdHocTask = {
  id: 'a1',
  title: 'Buy milk',
  completed: false,
  priority: 'medium',
  taskType: 'focus',
  dueDate: '2026-08-24',
  createdAt: '',
  updatedAt: '',
};

describe('runBoardRollover', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('rolls stale tasks to the logical day and stamps the run', async () => {
    await seed([{ ...sched }], [{ ...task }]);

    const res = await runBoardRollover({ now: noon(2026, 8, 26), rolloverHour: 4 });
    expect(res).toMatchObject({ rolledCount: 2, logicalDay: '2026-08-26', alreadyRan: false });

    const [s] = await getScheduledAsanaTasks();
    expect(s).toMatchObject({ scheduledDate: '2026-08-26', originallyPlannedFor: '2026-08-24', rolls: 1 });
    const [t] = await getAdHocTasks();
    expect(t).toMatchObject({ dueDate: '2026-08-26', originallyPlannedFor: '2026-08-24', rolls: 1 });

    expect((await getBoardRolloverState()).lastRolloverDay).toBe('2026-08-26');
  });

  it('is idempotent for a logical day: a second run does nothing', async () => {
    await seed([{ ...sched }], [{ ...task }]);
    await runBoardRollover({ now: noon(2026, 8, 26), rolloverHour: 4 });

    const res2 = await runBoardRollover({ now: noon(2026, 8, 26), rolloverHour: 4 });
    expect(res2).toMatchObject({ rolledCount: 0, alreadyRan: true });

    const [s] = await getScheduledAsanaTasks();
    expect(s.rolls).toBe(1); // not double-rolled
  });

  it('dedupes duplicate overdue records for one task: one rolls, the rest are deleted', async () => {
    const dupes: ScheduledAsanaTask[] = [
      { ...sched, id: 'd1', asanaTaskId: 'gdup', scheduledDate: '2026-08-24' },
      { ...sched, id: 'd2', asanaTaskId: 'gdup', scheduledDate: '2026-08-25' },
      { ...sched, id: 'd3', asanaTaskId: 'gdup', scheduledDate: '2026-08-24' },
    ];
    await seed(dupes, []);

    const res = await runBoardRollover({ now: noon(2026, 8, 26), rolloverHour: 4 });
    expect(res).toMatchObject({ rolledCount: 1, removedCount: 2, alreadyRan: false });

    const remaining = await getScheduledAsanaTasks();
    expect(remaining.map(s => s.id)).toEqual(['d2']);
    expect(remaining[0]).toMatchObject({ scheduledDate: '2026-08-26', rolls: 1 });
  });

  it('rolls an overdue prep block forward (date-only) when its meeting is still to come', async () => {
    await seed([], [], [{ ...prepBlock }]);

    const res = await runBoardRollover({ now: noon(2026, 8, 26), rolloverHour: 4 });
    expect(res).toMatchObject({ rolledCount: 1, alreadyRan: false });

    const [pb] = await getPrepBlocks();
    // Date moved forward; the block's start time is untouched.
    expect(pb).toMatchObject({
      date: '2026-08-26',
      start: '09:00',
      originallyPlannedFor: '2026-08-24',
      rolls: 1,
    });
  });

  it('leaves an overdue prep block put once its meeting has passed', async () => {
    const past = { ...prepBlock, meetingStart: '2026-08-25T12:00:00.000Z' };
    await seed([], [], [past]);

    const res = await runBoardRollover({ now: noon(2026, 8, 26), rolloverHour: 4 });
    expect(res.rolledCount).toBe(0);

    const [pb] = await getPrepBlocks();
    expect(pb.date).toBe('2026-08-24'); // unchanged
  });

  it('rolls again on a NEW logical day, preserving the original date and incrementing rolls', async () => {
    await seed([{ ...sched }], []);
    await runBoardRollover({ now: noon(2026, 8, 26), rolloverHour: 4 }); // Wed

    // Thursday: the task now sits on Wed (yesterday) and is still not done.
    const res = await runBoardRollover({ now: noon(2026, 8, 27), rolloverHour: 4 });
    expect(res.rolledCount).toBe(1);

    const [s] = await getScheduledAsanaTasks();
    expect(s).toMatchObject({ scheduledDate: '2026-08-27', originallyPlannedFor: '2026-08-24', rolls: 2 });
  });
});
