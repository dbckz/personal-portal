/**
 * The durable weekly record: task counting across grouped/single blocks, the
 * high-water-mark rule (a carried-out task stays in the denominator and counts
 * as not done), and the derived summaries the dashboard and Analysis view read.
 */
import {
  getAllWeeklyStats,
  getWeeklyStats,
  recordWeeklyTasks,
  setWeeklyTaskOutcomes,
  recordWeeklyTime,
  recordOutOfOfficeDay,
} from '@/lib/user-data-storage';
import {
  summariseWeek,
  weeklyProgressRows,
  unscheduledThisWeek,
  workingDaysAvailable,
} from '@/lib/weekly-stats';
import { __resetDbForTests } from '@/lib/storage/db';
import type { WeeklyStatsRecord } from '@/types';
import type { CarryOverEntry } from '@/lib/storage/carry-overs';

const WEEK = '2026-07-20';

// A grouped Engagement block carrying three agenda tasks plus two single-task
// Writing blocks: 5 tasks scheduled into the week, not 3 blocks.
const GROUPED_AND_SINGLES = [
  { taskId: 'e1', category: 'Engagement', title: 'Email Ana' },
  { taskId: 'e2', category: 'Engagement', title: 'Email Bo' },
  { taskId: 'e3', category: 'Engagement', title: 'Email Cy' },
  { taskId: 'w1', category: 'Writing', title: 'Draft the brief' },
  { taskId: 'w2', category: 'Writing', title: 'Edit the brief' },
];

beforeEach(() => {
  __resetDbForTests();
});

describe('weekly stats storage', () => {
  it('counts every member task of a grouped block, and one per single block', async () => {
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES);

    const record = (await getWeeklyStats(WEEK))!;
    expect(Object.keys(record.tasks)).toHaveLength(5);
    const summary = summariseWeek(record);
    expect(summary.categories).toEqual([
      { category: 'Engagement', scheduled: 3, completed: 0, started: 0, carried: 0, dropped: 0 },
      { category: 'Writing', scheduled: 2, completed: 0, started: 0, carried: 0, dropped: 0 },
    ]);
    expect(summary.totalScheduled).toBe(5);
  });

  it('grows Y when a task is added mid-week, and never lowers it', async () => {
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES);
    await recordWeeklyTasks(WEEK, [{ taskId: 'w3', category: 'Writing', title: 'Late addition' }]);
    // Re-running the same plan must not duplicate or reset anything.
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES);

    const summary = summariseWeek((await getWeeklyStats(WEEK))!);
    expect(summary.totalScheduled).toBe(6);
  });

  it('X rises as the review marks work done', async () => {
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES);
    await setWeeklyTaskOutcomes(WEEK, [
      { taskId: 'e1', outcome: 'done' },
      { taskId: 'w1', outcome: 'done' },
    ]);

    const summary = summariseWeek((await getWeeklyStats(WEEK))!);
    expect(summary.totalCompleted).toBe(2);
    expect(summary.completionRate).toBeCloseTo(0.4); // 2 of 5
    expect(summary.categories.find(c => c.category === 'Writing')).toMatchObject({
      scheduled: 2,
      completed: 1,
    });
  });

  it('a carried-out task keeps Y unchanged and counts as NOT done', async () => {
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES);
    await setWeeklyTaskOutcomes(WEEK, [{ taskId: 'e2', outcome: 'carried' }]);
    // Carrying unschedules it, so a later reconcile no longer sees it — the
    // record must keep it anyway (that is the over-scheduling evidence).
    await recordWeeklyTasks(
      WEEK,
      GROUPED_AND_SINGLES.filter(t => t.taskId !== 'e2')
    );

    const summary = summariseWeek((await getWeeklyStats(WEEK))!);
    expect(summary.totalScheduled).toBe(5);
    expect(summary.totalCompleted).toBe(0);
    expect(summary.categories.find(c => c.category === 'Engagement')).toMatchObject({
      scheduled: 3,
      carried: 1,
      completed: 0,
    });
  });

  it('a reconcile never resets an outcome that was already settled', async () => {
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES);
    await setWeeklyTaskOutcomes(WEEK, [{ taskId: 'e1', outcome: 'carried' }]);
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES); // no outcome asserted

    const record = (await getWeeklyStats(WEEK))!;
    expect(record.tasks.e1.outcome).toBe('carried');
  });

  it('ignores an outcome for a task the week never scheduled', async () => {
    await recordWeeklyTasks(WEEK, [{ taskId: 'w1', category: 'Writing' }]);
    const changed = await setWeeklyTaskOutcomes(WEEK, [{ taskId: 'stranger', outcome: 'done' }]);

    expect(changed).toBe(0);
    expect(summariseWeek((await getWeeklyStats(WEEK))!).totalScheduled).toBe(1);
  });

  it('keeps a per-integration, per-day time split and totals it for the week', async () => {
    await recordWeeklyTime(WEEK, '2026-07-20', [
      { integrationId: 'om', integrationName: 'OM', minutesScheduled: 240, minutesWorked: 200 },
      { integrationId: 'dbc', integrationName: 'DBC', minutesScheduled: 120, minutesWorked: 60 },
    ]);
    await recordWeeklyTime(WEEK, '2026-07-21', [
      { integrationId: 'om', integrationName: 'OM', minutesScheduled: 180, minutesWorked: 180 },
    ]);
    // A re-report for the same day replaces that day, never doubles it.
    await recordWeeklyTime(WEEK, '2026-07-20', [
      { integrationId: 'om', integrationName: 'OM', minutesScheduled: 240, minutesWorked: 230 },
    ]);

    const summary = summariseWeek((await getWeeklyStats(WEEK))!);
    expect(summary.minutesWorkedByIntegration).toEqual([
      { integrationId: 'dbc', integrationName: 'DBC', minutes: 60 },
      { integrationId: 'om', integrationName: 'OM', minutes: 410 },
    ]);
    expect(summary.totalMinutesWorked).toBe(470);
  });

  it('keeps each week separate and survives an unrelated week being written', async () => {
    await recordWeeklyTasks('2026-07-13', [{ taskId: 'old', category: 'Writing' }]);
    await recordWeeklyTasks(WEEK, [{ taskId: 'new', category: 'Writing' }]);

    const all = await getAllWeeklyStats();
    expect(Object.keys(all).sort()).toEqual(['2026-07-13', '2026-07-20']);
    expect(Object.keys(all['2026-07-13'].tasks)).toEqual(['old']);
  });
});

describe('weeklyProgressRows', () => {
  const record: WeeklyStatsRecord = {
    weekStart: WEEK,
    createdAt: '',
    updatedAt: '',
    tasks: {
      a: { taskId: 'a', category: 'Writing', scheduledAt: '', outcome: 'done' },
      b: { taskId: 'b', category: 'Writing', scheduledAt: '', outcome: 'carried' },
      c: { taskId: 'c', category: 'Retired category', scheduledAt: '', outcome: 'done' },
    },
    integrations: {},
  };

  it('reports X / Y per configured category, in configured order', () => {
    expect(weeklyProgressRows(record, ['Writing', 'Engagement'])).toEqual([
      { category: 'Writing', scheduledTasks: 2, completedTasks: 1, startedTasks: 0 },
      { category: 'Engagement', scheduledTasks: 0, completedTasks: 0, startedTasks: 0 },
      // History under a category the config dropped is still shown, last.
      { category: 'Retired category', scheduledTasks: 1, completedTasks: 1, startedTasks: 0 },
    ]);
  });

  it('is all zeroes before the week is planned', () => {
    expect(weeklyProgressRows(null, ['Writing'])).toEqual([
      { category: 'Writing', scheduledTasks: 0, completedTasks: 0, startedTasks: 0 },
    ]);
  });
});

describe('started-but-unfinished outcome', () => {
  const STARTED_WEEK = '2026-08-03';

  it('counts a started task as progress but NOT as completed', async () => {
    await recordWeeklyTasks(STARTED_WEEK, [
      { taskId: 'a', category: 'Writing' },
      { taskId: 'b', category: 'Writing' },
      { taskId: 'c', category: 'Writing' },
    ]);
    await setWeeklyTaskOutcomes(STARTED_WEEK, [
      { taskId: 'a', outcome: 'done' },
      { taskId: 'b', outcome: 'started' },
    ]);

    const summary = summariseWeek((await getWeeklyStats(STARTED_WEEK))!);
    expect(summary.totalCompleted).toBe(1);
    expect(summary.totalStarted).toBe(1);
    expect(summary.totalScheduled).toBe(3);
    // Headline progress counts finished + started: 2 of 3.
    expect(summary.completionRate).toBeCloseTo(2 / 3);
    expect(summary.categories[0]).toMatchObject({ completed: 1, started: 1, scheduled: 3 });
  });

  it('keeps the finished / started split in the progress rows', async () => {
    await recordWeeklyTasks(STARTED_WEEK, [
      { taskId: 'a', category: 'Writing' },
      { taskId: 'b', category: 'Writing' },
    ]);
    await setWeeklyTaskOutcomes(STARTED_WEEK, [{ taskId: 'b', outcome: 'started' }]);

    const rows = weeklyProgressRows(await getWeeklyStats(STARTED_WEEK), ['Writing']);
    expect(rows[0]).toEqual({
      category: 'Writing',
      scheduledTasks: 2,
      completedTasks: 0,
      startedTasks: 1,
    });
  });

  it('lets a started task later become done or carried', async () => {
    await recordWeeklyTasks(STARTED_WEEK, [{ taskId: 'a', category: 'Writing' }]);
    await setWeeklyTaskOutcomes(STARTED_WEEK, [{ taskId: 'a', outcome: 'started' }]);
    await setWeeklyTaskOutcomes(STARTED_WEEK, [{ taskId: 'a', outcome: 'carried' }]);

    const summary = summariseWeek((await getWeeklyStats(STARTED_WEEK))!);
    expect(summary.totalStarted).toBe(0);
    expect(summary.categories[0]).toMatchObject({ carried: 1, started: 0, completed: 0 });
  });

  it('never downgrades a done task back to started', async () => {
    // A task done earlier in the week that a later review re-seeds (and confirms)
    // as 'started' must stay done — 'done' is a positive terminal outcome.
    await recordWeeklyTasks(STARTED_WEEK, [{ taskId: 'a', category: 'Writing' }]);
    await setWeeklyTaskOutcomes(STARTED_WEEK, [{ taskId: 'a', outcome: 'done' }]);
    const changed = await setWeeklyTaskOutcomes(STARTED_WEEK, [{ taskId: 'a', outcome: 'started' }]);

    expect(changed).toBe(0);
    const summary = summariseWeek((await getWeeklyStats(STARTED_WEEK))!);
    expect(summary.totalCompleted).toBe(1);
    expect(summary.totalStarted).toBe(0);
  });
});

describe('unscheduledThisWeek (dashboard "Left unscheduled" derivation)', () => {
  const record = (tasks: WeeklyStatsRecord['tasks']): WeeklyStatsRecord => ({
    weekStart: WEEK,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    tasks,
    integrations: {},
  });

  it('returns carried AND unscheduled tasks (not done/dropped), newest first, with a reason', () => {
    const rows = unscheduledThisWeek(
      record({
        w1: { taskId: 'w1', title: 'Draft the brief', category: 'Writing', scheduledAt: 'x', outcome: 'carried', outcomeAt: '2026-07-22T09:00:00.000Z' },
        e1: { taskId: 'e1', title: 'Email Ana', category: 'Engagement', scheduledAt: 'x', outcome: 'carried', outcomeAt: '2026-07-24T09:00:00.000Z' },
        u1: { taskId: 'u1', title: 'Left out', category: 'Writing', scheduledAt: 'x', outcome: 'unscheduled', outcomeAt: '2026-07-23T09:00:00.000Z' },
        d1: { taskId: 'd1', title: 'Done thing', category: 'Writing', scheduledAt: 'x', outcome: 'done' },
        w2: { taskId: 'w2', title: 'Dropped thing', category: 'Writing', scheduledAt: 'x', outcome: 'dropped' },
      }),
      {}
    );
    // The two carried + the one unscheduled, newest first; done/dropped excluded.
    expect(rows.map(r => r.taskId)).toEqual(['e1', 'u1', 'w1']);
    // Reason discriminates deferred (carried) from left-unscheduled.
    expect(rows.find(r => r.taskId === 'e1')).toMatchObject({ reason: 'deferred' });
    expect(rows.find(r => r.taskId === 'u1')).toMatchObject({
      reason: 'unscheduled',
      title: 'Left out',
      category: 'Writing',
      droppedAt: '2026-07-23T09:00:00.000Z',
    });
  });

  it('joins the carry-over streak where the marker tracks one', () => {
    const carryOvers: Record<string, CarryOverEntry> = {
      w1: { fromWeek: WEEK, at: 0, carries: 3 },
    };
    const rows = unscheduledThisWeek(
      record({
        w1: { taskId: 'w1', title: 'Sliding task', category: 'Writing', scheduledAt: 'x', outcome: 'carried', outcomeAt: '2026-07-22T09:00:00.000Z' },
        w2: { taskId: 'w2', title: 'First slip', category: 'Writing', scheduledAt: 'x', outcome: 'carried', outcomeAt: '2026-07-21T09:00:00.000Z' },
      }),
      carryOvers
    );
    expect(rows.find(r => r.taskId === 'w1')?.carryStreak).toBe(3);
    // A task with no carry-over marker (mid-week defer) has no streak.
    expect(rows.find(r => r.taskId === 'w2')?.carryStreak).toBeUndefined();
  });

  it('returns an empty list for a missing record', () => {
    expect(unscheduledThisWeek(null, {})).toEqual([]);
  });

  it("folds an 'unscheduled' outcome into the carried counter in summariseWeek", async () => {
    await recordWeeklyTasks(WEEK, [
      { taskId: 'a', category: 'Writing' },
      { taskId: 'b', category: 'Writing' },
    ]);
    await setWeeklyTaskOutcomes(WEEK, [
      { taskId: 'a', outcome: 'carried' },
      { taskId: 'b', outcome: 'unscheduled' },
    ]);

    const summary = summariseWeek((await getWeeklyStats(WEEK))!);
    // Both count as planned-but-not-done: carried = 2, none completed.
    expect(summary.categories[0]).toMatchObject({ carried: 2, completed: 0, scheduled: 2 });
  });
});

// A holiday week should read as a week off, not as a collapse in output.
describe('out-of-office days', () => {
  it('records days away and reports the working days that were left', async () => {
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES);
    await recordOutOfOfficeDay(WEEK, '2026-07-23', true);
    await recordOutOfOfficeDay(WEEK, '2026-07-22', true);

    const summary = summariseWeek((await getWeeklyStats(WEEK))!);
    // Ascending, whatever order they were recorded in.
    expect(summary.outOfOfficeDays).toEqual(['2026-07-22', '2026-07-23']);
    expect(workingDaysAvailable(summary)).toBe(3);
  });

  it('unmarks a day whose holiday was cancelled', async () => {
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES);
    await recordOutOfOfficeDay(WEEK, '2026-07-23', true);
    await recordOutOfOfficeDay(WEEK, '2026-07-23', false);

    const summary = summariseWeek((await getWeeklyStats(WEEK))!);
    expect(summary.outOfOfficeDays).toEqual([]);
    expect(workingDaysAvailable(summary)).toBe(5);
  });

  it('leaves the completion rate alone — the days are context, not a correction', async () => {
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES);
    await setWeeklyTaskOutcomes(WEEK, [{ taskId: 'e1', outcome: 'done' }]);
    await recordOutOfOfficeDay(WEEK, '2026-07-23', true);

    const summary = summariseWeek((await getWeeklyStats(WEEK))!);
    expect(summary.completionRate).toBeCloseTo(1 / 5);
  });

  it('does not create a week record just to say a day was not out of office', async () => {
    await recordOutOfOfficeDay('2026-08-03', '2026-08-04', false);
    expect(await getWeeklyStats('2026-08-03')).toBeNull();
  });

  it('reads a week with nothing recorded as a full week', async () => {
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES);
    const summary = summariseWeek((await getWeeklyStats(WEEK))!);
    expect(summary.outOfOfficeDays).toEqual([]);
    expect(workingDaysAvailable(summary)).toBe(5);
  });

  it('never reports negative days available, however many are recorded', async () => {
    await recordWeeklyTasks(WEEK, GROUPED_AND_SINGLES);
    for (const day of ['20', '21', '22', '23', '24', '25']) {
      await recordOutOfOfficeDay(WEEK, `2026-07-${day}`, true);
    }
    expect(workingDaysAvailable(summariseWeek((await getWeeklyStats(WEEK))!))).toBe(0);
  });
});

describe('scheduledMinutes (estimate-vs-actual evidence)', () => {
  it('stores a task block length and keeps it through an outcome update', async () => {
    await recordWeeklyTasks(WEEK, [{ taskId: 'w1', category: 'Writing', scheduledMinutes: 120 }]);
    expect((await getWeeklyStats(WEEK))!.tasks.w1.scheduledMinutes).toBe(120);

    // Settling the outcome later must not drop the recorded block length.
    await setWeeklyTaskOutcomes(WEEK, [{ taskId: 'w1', outcome: 'done' }]);
    const task = (await getWeeklyStats(WEEK))!.tasks.w1;
    expect(task.outcome).toBe('done');
    expect(task.scheduledMinutes).toBe(120);
  });

  it('leaves a stored block length intact when a later record omits it', async () => {
    await recordWeeklyTasks(WEEK, [{ taskId: 'w1', category: 'Writing', scheduledMinutes: 90 }]);
    // Re-running a plan that carries no minutes must not erase the known length.
    await recordWeeklyTasks(WEEK, [{ taskId: 'w1', category: 'Writing' }]);
    expect((await getWeeklyStats(WEEK))!.tasks.w1.scheduledMinutes).toBe(90);
  });
});
