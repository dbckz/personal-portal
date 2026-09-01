/**
 * Tests for gatherWeekContext's week-scoped candidate exclusion — the mechanism
 * behind grouped-block (and single-task) rollover: a task scheduled in a PRIOR
 * week is not `inWeek` for the current planning week, so it stays a candidate and
 * can be selected again; a task scheduled IN the current week is excluded. All
 * I/O (config, storage, Asana, Google) is mocked so the test is deterministic.
 */
import { gatherWeekContext } from '@/lib/scheduling/gather';
import { getScheduledAsanaTasks, getAdHocTasks, getCustomTaskTypes, getAllTaskMetadata, getPrepBlocks, getRitualBlocks, getTaskDeferrals, removeTaskDeferrals, getCarryOvers, removeCarryOvers } from '@/lib/user-data-storage';
import { getEnabledAsanaIntegrations, getEnabledGoogleIntegrations } from '@/lib/integration-storage';
import { getMyTasks } from '@/lib/asana';
import { getWorkflowConfig } from '@/lib/workflow-config-storage';
import type { AdHocTask, AsanaTask, ScheduledAsanaTask } from '@/types';

jest.mock('@/lib/workflow-config-storage', () => ({ getWorkflowConfig: jest.fn() }));
jest.mock('@/lib/user-data-storage', () => ({
  getScheduledAsanaTasks: jest.fn(),
  getAdHocTasks: jest.fn(),
  getCustomTaskTypes: jest.fn(),
  getAllTaskMetadata: jest.fn(),
  getPrepBlocks: jest.fn(),
  getRitualBlocks: jest.fn(),
  unscheduleAsanaTask: jest.fn(),
  updateAdHocTask: jest.fn(),
  deletePrepBlock: jest.fn(),
  deleteRitualBlock: jest.fn(),
  removeGoogleEventAttribution: jest.fn(),
  getTaskDeferrals: jest.fn().mockResolvedValue({}),
  removeTaskDeferrals: jest.fn().mockResolvedValue(0),
  getCarryOvers: jest.fn().mockResolvedValue({}),
  removeCarryOvers: jest.fn().mockResolvedValue(0),
}));
jest.mock('@/lib/integration-storage', () => ({
  getEnabledAsanaIntegrations: jest.fn(),
  getEnabledGoogleIntegrations: jest.fn(),
  updateIntegration: jest.fn(),
}));
jest.mock('@/lib/asana', () => ({ getMyTasks: jest.fn(), refreshAsanaToken: jest.fn() }));

const asanaTask = (gid: string, name: string): AsanaTask => ({
  id: gid,
  gid,
  name,
  completed: false,
  customFields: [{ name: 'Type', displayValue: 'engage' } as never],
});
const scheduled = (asanaTaskId: string, scheduledDate: string): ScheduledAsanaTask => ({
  id: `s-${asanaTaskId}`,
  asanaTaskId,
  scheduledDate,
  scheduledTime: '13:00',
  duration: 60,
  googleEventId: `evt-${scheduledDate}`,
});

describe('gatherWeekContext - week-scoped rollover', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Wednesday 2026-07-15 -> planning week is Mon 2026-07-13 .. Sun 2026-07-19.
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 15, 9, 0, 0));

    (getWorkflowConfig as jest.Mock).mockResolvedValue({ taskQuotas: {}, typeMapping: {} });
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([
      scheduled('inweek', '2026-07-15'), // scheduled this week -> excluded
      scheduled('rollover', '2026-07-06'), // scheduled last week -> rolls over
    ]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([]);
    (getCustomTaskTypes as jest.Mock).mockResolvedValue([]);
    (getAllTaskMetadata as jest.Mock).mockResolvedValue({});
    (getPrepBlocks as jest.Mock).mockResolvedValue([]);
    (getRitualBlocks as jest.Mock).mockResolvedValue([]);
    (getEnabledGoogleIntegrations as jest.Mock).mockResolvedValue([]);
    // Deferrals / carry-overs are per-test state: reset them so cases stay
    // order-independent (clearAllMocks keeps implementations).
    (getTaskDeferrals as jest.Mock).mockResolvedValue({});
    (getCarryOvers as jest.Mock).mockResolvedValue({});
    (getEnabledAsanaIntegrations as jest.Mock).mockResolvedValue([
      {
        id: 'int1',
        clientId: 'c',
        clientSecret: 's',
        workspaceId: 'ws',
        credentials: { accessToken: 'tok', expiresAt: Date.now() + 3_600_000 },
      },
    ]);
    (getMyTasks as jest.Mock).mockResolvedValue([
      asanaTask('inweek', 'Outreach A'),
      asanaTask('rollover', 'Outreach B'),
    ]);
  });

  afterEach(() => jest.useRealTimers());

  it('excludes an in-week-scheduled task but keeps a prior-week one as a candidate', async () => {
    const ctx = await gatherWeekContext();
    const gids = ctx.candidateTasks.map(t => t.gid);
    expect(gids).toContain('rollover'); // incomplete last-week task is selectable again
    expect(gids).not.toContain('inweek'); // already scheduled this week -> not a candidate
  });

  it('holds an actively-deferred task out of the candidate pool and counts it', async () => {
    (getWorkflowConfig as jest.Mock).mockResolvedValue({
      taskQuotas: { Engage: { weeklyCount: 2, targetLength: '1h' } },
      typeMapping: { Engage: ['engage'] },
    });
    // 'rollover' resumes next Monday (after this week's Sunday end) -> still deferred.
    (getTaskDeferrals as jest.Mock).mockResolvedValue({ rollover: '2026-07-20' });

    const ctx = await gatherWeekContext();
    const gids = ctx.candidateTasks.map(t => t.gid);
    expect(gids).not.toContain('rollover');
    expect(ctx.deferredCountsByCategory.Engage).toBe(1);
  });

  it('holds a portal-done task out of the candidate pool and exposes its gid', async () => {
    (getAllTaskMetadata as jest.Mock).mockResolvedValue({
      rollover: { asanaTaskGid: 'rollover', integrationId: 'int1', portalDone: true, updatedAt: 'x' },
    });

    const ctx = await gatherWeekContext();
    expect(ctx.candidateTasks.map(t => t.gid)).not.toContain('rollover');
    expect(ctx.portalDoneGids.has('rollover')).toBe(true);
  });

  it('prunes an expired deferral and lets the task return as a candidate', async () => {
    (getTaskDeferrals as jest.Mock).mockResolvedValue({ rollover: '2026-07-15' }); // within this week -> expired

    const ctx = await gatherWeekContext();
    const gids = ctx.candidateTasks.map(t => t.gid);
    expect(gids).toContain('rollover');
    expect(removeTaskDeferrals).toHaveBeenCalledWith(['rollover']);
  });

  it('flags a task carried out of an earlier week and ignores a same-week marker', async () => {
    (getCarryOvers as jest.Mock).mockResolvedValue({
      rollover: { fromWeek: '2026-07-06', at: 1 }, // last week -> badge
      inweek: { fromWeek: '2026-07-13', at: 1 }, // the week being planned -> no badge
    });

    const ctx = await gatherWeekContext();
    const carried = ctx.candidateTasks.find(t => t.gid === 'rollover');
    expect(carried).toEqual(
      expect.objectContaining({ carriedOver: true, carriedFromWeek: '2026-07-06' })
    );
    expect(removeCarryOvers).not.toHaveBeenCalled();
  });

  it('planning NEXT week badges a task carried out of THIS week', async () => {
    // The end-of-week review carries a task out of the current week (fromWeek =
    // this Monday). Planning next week, that marker predates the planning week,
    // so the wizard badges it — the whole point of the carry-over.
    (getCarryOvers as jest.Mock).mockResolvedValue({
      rollover: { fromWeek: '2026-07-13', at: 1 },
    });

    const thisWeek = await gatherWeekContext();
    expect(thisWeek.candidateTasks.find(t => t.gid === 'rollover')).not.toHaveProperty('carriedOver');

    const nextWeek = await gatherWeekContext('2026-07-20');
    expect(nextWeek.weekStartStr).toBe('2026-07-20');
    expect(nextWeek.candidateTasks.find(t => t.gid === 'rollover')).toEqual(
      expect.objectContaining({ carriedOver: true, carriedFromWeek: '2026-07-13' })
    );
  });

  it('planning NEXT week frees a task deferred to next Monday', async () => {
    // Deferred until 2026-07-20: still parked for THIS week (resume date falls
    // after this week's Sunday), available again once next week is the one
    // being planned.
    (getTaskDeferrals as jest.Mock).mockResolvedValue({ rollover: '2026-07-20' });

    const thisWeek = await gatherWeekContext();
    expect(thisWeek.candidateTasks.map(t => t.gid)).not.toContain('rollover');

    const nextWeek = await gatherWeekContext('2026-07-20');
    expect(nextWeek.candidateTasks.map(t => t.gid)).toContain('rollover');
  });

  it('carries the streak and must-do flag through to the candidate', async () => {
    (getCarryOvers as jest.Mock).mockResolvedValue({
      rollover: { fromWeek: '2026-07-06', at: 1, carries: 3, mustDo: true },
    });

    const ctx = await gatherWeekContext();
    expect(ctx.candidateTasks.find(t => t.gid === 'rollover')).toEqual(
      expect.objectContaining({ carriedOver: true, carryStreak: 3, mustDo: true })
    );
  });

  it('reports a single carry for a marker with no stored streak', async () => {
    (getCarryOvers as jest.Mock).mockResolvedValue({ rollover: { fromWeek: '2026-07-06', at: 1 } });

    const ctx = await gatherWeekContext();
    const task = ctx.candidateTasks.find(t => t.gid === 'rollover');
    expect(task).toEqual(expect.objectContaining({ carryStreak: 1 }));
    expect(task).not.toHaveProperty('mustDo');
  });

  it('prunes a carry-over marker older than four weeks', async () => {
    (getCarryOvers as jest.Mock).mockResolvedValue({
      rollover: { fromWeek: '2026-06-08', at: 1 }, // 5 weeks before the planning week
    });

    const ctx = await gatherWeekContext();
    expect(ctx.candidateTasks.find(t => t.gid === 'rollover')).not.toHaveProperty('carriedOver');
    expect(removeCarryOvers).toHaveBeenCalledWith(['rollover']);
  });
});

describe('gatherWeekContext - existing block counts dedupe across record types', () => {
  const batchAsanaTask = (gid: string): AsanaTask => ({
    id: gid,
    gid,
    name: `Batch ${gid}`,
    completed: false,
    customFields: [{ name: 'Type', displayValue: 'batch' } as never],
  });
  const scheduledOn = (asanaTaskId: string, eventId: string): ScheduledAsanaTask => ({
    id: `s-${asanaTaskId}-${eventId}`,
    asanaTaskId,
    scheduledDate: '2026-07-15',
    scheduledTime: '13:00',
    duration: 30,
    googleEventId: eventId,
  });
  const adhoc = (id: string, googleEventId?: string): AdHocTask => ({
    id,
    title: `Ad-hoc ${id}`,
    completed: false,
    priority: 'medium',
    taskType: 'batch', // built-in "Batch" -> classifies to the Batch category
    dueDate: '2026-07-15',
    dueTime: '13:00',
    duration: 30,
    googleEventId,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 15, 9, 0, 0));

    (getWorkflowConfig as jest.Mock).mockResolvedValue({
      taskQuotas: { Batch: { weeklyCount: 2, targetLength: '30min' } },
      typeMapping: { Batch: ['batch'] },
    });
    (getCustomTaskTypes as jest.Mock).mockResolvedValue([]);
    (getAllTaskMetadata as jest.Mock).mockResolvedValue({});
    (getPrepBlocks as jest.Mock).mockResolvedValue([]);
    (getRitualBlocks as jest.Mock).mockResolvedValue([]);
    (getEnabledGoogleIntegrations as jest.Mock).mockResolvedValue([]);
    (getEnabledAsanaIntegrations as jest.Mock).mockResolvedValue([
      {
        id: 'int1',
        clientId: 'c',
        clientSecret: 's',
        workspaceId: 'ws',
        credentials: { accessToken: 'tok', expiresAt: Date.now() + 3_600_000 },
      },
    ]);
  });

  afterEach(() => jest.useRealTimers());

  it('counts a mixed Asana + ad-hoc grouped block (one shared event) as 1', async () => {
    // A Batch container event carries one Asana task and one ad-hoc task, both
    // pointing at the SAME googleEventId. That is ONE block, not two.
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([scheduledOn('a1', 'evt-batch')]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([adhoc('ad1', 'evt-batch')]);
    (getMyTasks as jest.Mock).mockResolvedValue([batchAsanaTask('a1')]);

    const ctx = await gatherWeekContext();
    expect(ctx.existingScheduledCounts.Batch).toBe(1);
  });

  it('counts an ad-hoc-only grouped block (one shared event) as 1', async () => {
    // Two ad-hoc tasks recorded against the SAME container event -> 1 block.
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([
      adhoc('ad1', 'evt-batch'),
      adhoc('ad2', 'evt-batch'),
    ]);
    (getMyTasks as jest.Mock).mockResolvedValue([]);

    const ctx = await gatherWeekContext();
    expect(ctx.existingScheduledCounts.Batch).toBe(1);
  });

  it('counts ad-hoc tasks placed as their own (event-bearing) blocks separately', async () => {
    // Two ad-hoc tasks, each on its OWN calendar event -> 2 distinct blocks.
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([adhoc('ad1', 'evt-1'), adhoc('ad2', 'evt-2')]);
    (getMyTasks as jest.Mock).mockResolvedValue([]);

    const ctx = await gatherWeekContext();
    expect(ctx.existingScheduledCounts.Batch).toBe(2);
  });

  it('does NOT count a bare in-week ad-hoc task (rolled due date, no event) as a block', async () => {
    // The daily-board rollover bumps an unfinished task's dueDate to today every
    // day WITHOUT giving it a calendar event. Such a task is not placed, so it
    // must not inflate existing counts. It also stays a candidate.
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([adhoc('ad1'), adhoc('ad2')]);
    (getMyTasks as jest.Mock).mockResolvedValue([]);

    const ctx = await gatherWeekContext();
    expect(ctx.existingScheduledCounts.Batch).toBeUndefined();
    expect(ctx.candidateTasks.map(t => t.adhocId)).toEqual(expect.arrayContaining(['ad1', 'ad2']));
  });

  it('places a bare-due-date task in the candidate pool but excludes a placed one', async () => {
    // Regression for the rolling-task bug: an ad-hoc task whose dueDate keeps
    // rolling to today (no googleEventId) must remain schedulable, while one with
    // an actual calendar block is treated as already scheduled this week.
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([
      adhoc('rolled'), // bare in-week due date, no event -> candidate, uncounted
      adhoc('placed', 'evt-placed'), // real calendar block -> excluded, counted
    ]);
    (getMyTasks as jest.Mock).mockResolvedValue([]);

    const ctx = await gatherWeekContext();
    const adhocIds = ctx.candidateTasks.map(t => t.adhocId);
    expect(adhocIds).toContain('rolled');
    expect(adhocIds).not.toContain('placed');
    expect(ctx.existingScheduledCounts.Batch).toBe(1); // only the placed block counts
  });

  it('keeps a task with a dueTime but no event as a candidate (dueTime is not placement)', async () => {
    // adhoc() carries a dueTime of 13:00 but no googleEventId; a bare time without
    // a calendar event is a rolled/annotated task, not a placed one.
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([adhoc('timed')]);
    (getMyTasks as jest.Mock).mockResolvedValue([]);

    const ctx = await gatherWeekContext();
    expect(ctx.candidateTasks.map(t => t.adhocId)).toContain('timed');
    expect(ctx.existingScheduledCounts.Batch).toBeUndefined();
  });

  it('classifies a grouped Asana block whose only member task is completed', async () => {
    // The scheduled member's Asana task has since been completed. Completed tasks
    // drop out of the incomplete-only fetch, so the block used to lose its "Type"
    // and go unclassified/uncounted. getMyTasks(completedSince) now returns the
    // completed task, so its type still classifies the block.
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([scheduledOn('a1', 'evt-batch')]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([]);
    (getMyTasks as jest.Mock).mockResolvedValue([
      { ...batchAsanaTask('a1'), completed: true },
    ]);

    const ctx = await gatherWeekContext();
    expect(ctx.existingScheduledCounts.Batch).toBe(1);
  });

  it('classifies a grouped block when the FIRST member is a completed, type-less record', async () => {
    // Two Asana tasks share one event; the first (a1) is completed and — worst
    // case — carries no resolvable type, the second (a2) is the live classifying
    // member. Unioning signals across the group (not first-record-wins) keeps the
    // block classified and counted once.
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([
      scheduledOn('a1', 'evt-batch'),
      scheduledOn('a2', 'evt-batch'),
    ]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([]);
    (getMyTasks as jest.Mock).mockResolvedValue([
      // a1 completed with no "Type" custom field -> empty signal
      { id: 'a1', gid: 'a1', name: 'Batch a1', completed: true, customFields: [] },
      batchAsanaTask('a2'),
    ]);

    const ctx = await gatherWeekContext();
    expect(ctx.existingScheduledCounts.Batch).toBe(1);
  });

  it('counts a completed, placed ad-hoc block toward existing blocks', async () => {
    // A completed ad-hoc block that was actually placed (has a calendar event)
    // still consumed its slot this week, so it counts — matching the dashboard
    // capacity route (which counts completed blocks too).
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([{ ...adhoc('ad1', 'evt-done'), completed: true }]);
    (getMyTasks as jest.Mock).mockResolvedValue([]);

    const ctx = await gatherWeekContext();
    expect(ctx.existingScheduledCounts.Batch).toBe(1);
  });
});

