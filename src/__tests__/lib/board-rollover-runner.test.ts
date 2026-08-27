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
  getBoardRolloverState,
} from '@/lib/user-data-storage';
import { __resetDbForTests } from '@/lib/storage/db';
import type { AdHocTask, ScheduledAsanaTask } from '@/types';

// Local noon on a given day, so logicalToday (04:00 rollover) resolves to it.
function noon(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d, 12, 0, 0);
}

async function seed(scheduled: ScheduledAsanaTask[], adhoc: AdHocTask[]) {
  const data = await getUserData();
  data.scheduledAsanaTasks = scheduled;
  data.adHocTasks = adhoc;
  await saveUserData(data);
}

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
