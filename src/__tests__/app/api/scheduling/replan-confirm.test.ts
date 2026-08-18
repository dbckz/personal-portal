/**
 * @jest-environment node
 *
 * Tests for the replan confirm route's "prioritise tomorrow" displacement path:
 * a victim block's calendar event is deleted, its stored schedule cleared, and
 * its tasks deferred to next week — while the prioritised block rides the normal
 * move path into the freed slot. All module boundaries are mocked so the route
 * runs pure.
 */
jest.mock('@/lib/google-calendar', () => ({
  createCalendarEvent: jest.fn(),
  deleteCalendarEvent: jest.fn(),
  updateCalendarEvent: jest.fn(),
  ensureValidCredentials: jest.fn(),
}));

jest.mock('@/lib/asana', () => ({
  completeTask: jest.fn(),
  deleteTask: jest.fn(),
  refreshAsanaToken: jest.fn(),
}));

jest.mock('@/lib/integration-storage', () => ({
  getEnabledGoogleIntegrations: jest.fn(),
  getGoogleIntegrationById: jest.fn(),
  getIntegrationById: jest.fn(),
  updateIntegration: jest.fn(),
}));

jest.mock('@/lib/workflow-config-storage', () => ({ getWorkflowConfig: jest.fn() }));
jest.mock('@/lib/scheduling/ritual-events', () => ({ createRitualEvent: jest.fn() }));
jest.mock('@/lib/scheduling/rituals', () => ({ ritualIntegrationIdForBlock: jest.fn() }));

jest.mock('@/lib/user-data-storage', () => ({
  getAdHocTasks: jest.fn(),
  getPrepBlocks: jest.fn(),
  getRitualBlocks: jest.fn(),
  getScheduledAsanaTasks: jest.fn(),
  addAdHocTask: jest.fn(),
  addPrepBlock: jest.fn(),
  updateAdHocTask: jest.fn(),
  updatePrepBlock: jest.fn(),
  deletePrepBlock: jest.fn(),
  deleteRitualBlock: jest.fn(),
  unscheduleAsanaTask: jest.fn(),
  scheduleAsanaTask: jest.fn(),
  setBlockDoneOverride: jest.fn(),
  removeGoogleEventAttribution: jest.fn(),
  removeBlockDoneOverride: jest.fn(),
  setTaskDeferrals: jest.fn(),
  updateScheduledAsanaTasksByGoogleEvent: jest.fn(),
  deleteAdHocTask: jest.fn(),
  removeCarryOvers: jest.fn(),
  setWeeklyTaskOutcomes: jest.fn(),
}));

import { addDays, format, startOfWeek } from 'date-fns';

import { POST } from '@/app/api/scheduling/replan/confirm/route';
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent, ensureValidCredentials } from '@/lib/google-calendar';
import { getEnabledGoogleIntegrations, getGoogleIntegrationById, getIntegrationById } from '@/lib/integration-storage';
import { deleteTask } from '@/lib/asana';
import {
  getAdHocTasks,
  getPrepBlocks,
  getRitualBlocks,
  getScheduledAsanaTasks,
  addPrepBlock,
  deletePrepBlock,
  unscheduleAsanaTask,
  updateAdHocTask,
  setTaskDeferrals,
  removeBlockDoneOverride,
  removeGoogleEventAttribution,
  updateScheduledAsanaTasksByGoogleEvent,
  deleteAdHocTask,
  removeCarryOvers,
  setWeeklyTaskOutcomes,
  scheduleAsanaTask,
} from '@/lib/user-data-storage';

const INTEGRATION = { id: 'gi1', clientId: 'c', clientSecret: 's', credentials: { accessToken: 't' } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function confirm(body: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST({ json: async () => body } as any);
  return res.json();
}

beforeEach(() => {
  jest.clearAllMocks();
  (getEnabledGoogleIntegrations as jest.Mock).mockResolvedValue([INTEGRATION]);
  (getGoogleIntegrationById as jest.Mock).mockResolvedValue(INTEGRATION);
  (ensureValidCredentials as jest.Mock).mockResolvedValue(INTEGRATION.credentials);
  (getAdHocTasks as jest.Mock).mockResolvedValue([]);
  (getPrepBlocks as jest.Mock).mockResolvedValue([]);
  (getRitualBlocks as jest.Mock).mockResolvedValue([]);
  (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([
    { id: 's-thu', asanaTaskId: 'g-thu', googleEventId: 'evt-thu' },
  ]);
  (updateScheduledAsanaTasksByGoogleEvent as jest.Mock).mockResolvedValue(1);
  (deleteCalendarEvent as jest.Mock).mockResolvedValue(undefined);
  (updateCalendarEvent as jest.Mock).mockResolvedValue(undefined);
});

describe('replan confirm — prioritise tomorrow (displace)', () => {
  it('deletes the victim event, unschedules it, defers its tasks and moves the prioritised block in', async () => {
    const out = await confirm({
      displace: [
        {
          googleEventId: 'evt-thu',
          googleIntegrationId: 'gi1',
          taskIds: ['g-thu'],
          mode: 'defer',
          durationMinutes: 90,
          priorityDurationMinutes: 90,
        },
      ],
      moves: [
        { googleEventId: 'evt-missed', googleIntegrationId: 'gi1', date: '2026-07-16', start: '09:00', durationMinutes: 90 },
      ],
    });

    // Victim event removed and its stored schedule cleared.
    expect(deleteCalendarEvent).toHaveBeenCalledTimes(1);
    expect((deleteCalendarEvent as jest.Mock).mock.calls[0][3]).toBe('evt-thu');
    expect(unscheduleAsanaTask).toHaveBeenCalledWith('s-thu');
    // Tasks deferred to next week (server-computed date, so just assert the task id).
    expect(setTaskDeferrals).toHaveBeenCalledTimes(1);
    expect((setTaskDeferrals as jest.Mock).mock.calls[0][0]).toEqual([
      expect.objectContaining({ taskId: 'g-thu' }),
    ]);
    expect(removeBlockDoneOverride).toHaveBeenCalledWith('evt-thu');
    expect(removeGoogleEventAttribution).toHaveBeenCalledWith('evt-thu');

    // Prioritised block patched into the freed slot.
    expect((updateCalendarEvent as jest.Mock).mock.calls[0][3]).toBe('evt-missed');

    expect(out.displaceResults).toEqual([{ googleEventId: 'evt-thu', success: true }]);
    expect(out.results).toEqual([{ googleEventId: 'evt-missed', success: true }]);
  });

  it("leaves a victim's tasks in the pool (no deferral) and records them unscheduled when mode is 'leave'", async () => {
    await confirm({
      displace: [
        {
          googleEventId: 'evt-thu',
          googleIntegrationId: 'gi1',
          taskIds: ['g-thu'],
          mode: 'leave',
          durationMinutes: 60,
          priorityDurationMinutes: 60,
        },
      ],
      moves: [],
    });

    expect(unscheduleAsanaTask).toHaveBeenCalledWith('s-thu');
    expect(setTaskDeferrals).not.toHaveBeenCalled();
    expect(removeBlockDoneOverride).toHaveBeenCalledWith('evt-thu');
    // Left without a slot but still open → recorded as unscheduled for the week.
    expect((setWeeklyTaskOutcomes as jest.Mock).mock.calls[0][1]).toEqual([
      { taskId: 'g-thu', outcome: 'unscheduled' },
    ]);
  });

  it('rejects a victim too short to hold the prioritised block', async () => {
    const out = await confirm({
      displace: [
        {
          googleEventId: 'evt-thu',
          googleIntegrationId: 'gi1',
          taskIds: ['g-thu'],
          mode: 'defer',
          durationMinutes: 30,
          priorityDurationMinutes: 90,
        },
      ],
      moves: [],
    });

    // Nothing displaced: the victim's slot is too small.
    expect(deleteCalendarEvent).not.toHaveBeenCalled();
    expect(unscheduleAsanaTask).not.toHaveBeenCalled();
    expect(setTaskDeferrals).not.toHaveBeenCalled();
    expect(out.displaceResults).toHaveLength(1);
    expect(out.displaceResults[0]).toMatchObject({ googleEventId: 'evt-thu', success: false });
  });

  it('clears the ad-hoc schedule for an ad-hoc victim', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([{ id: 'ah1', googleEventId: 'evt-adhoc' }]);

    await confirm({
      displace: [
        {
          googleEventId: 'evt-adhoc',
          googleIntegrationId: 'gi1',
          taskIds: ['ah1'],
          mode: 'defer',
          durationMinutes: 60,
          priorityDurationMinutes: 60,
        },
      ],
      moves: [],
    });

    expect(updateAdHocTask).toHaveBeenCalledWith('ah1', {
      googleEventId: undefined,
      dueDate: undefined,
      dueTime: undefined,
    });
    expect(setTaskDeferrals).toHaveBeenCalledTimes(1);
  });
});

describe('replan confirm — drop (delete task outright)', () => {
  it('deletes the calendar block, the Asana task, clears local records and records a dropped outcome', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([
      { id: 's1', asanaTaskId: 'g1', integrationId: 'ai1', googleEventId: 'evt-drop' },
    ]);
    (getIntegrationById as jest.Mock).mockResolvedValue({
      id: 'ai1',
      type: 'asana',
      clientId: 'c',
      clientSecret: 's',
      credentials: { accessToken: 'atok' },
    });

    const out = await confirm({
      drop: [{ googleEventId: 'evt-drop', googleIntegrationId: 'gi1', taskIds: ['g1'] }],
    });

    // Calendar block removed.
    expect(deleteCalendarEvent).toHaveBeenCalledTimes(1);
    expect((deleteCalendarEvent as jest.Mock).mock.calls[0][3]).toBe('evt-drop');
    // Backing Asana task deleted with the resolved token + its gid.
    expect(deleteTask).toHaveBeenCalledWith('atok', 'g1');
    // Local schedule cleared; carry-over marker dropped.
    expect(unscheduleAsanaTask).toHaveBeenCalledWith('s1');
    expect(removeCarryOvers).toHaveBeenCalledWith(['g1']);
    expect(removeBlockDoneOverride).toHaveBeenCalledWith('evt-drop');
    expect(removeGoogleEventAttribution).toHaveBeenCalledWith('evt-drop');
    // Recorded as dropped for the week.
    expect((setWeeklyTaskOutcomes as jest.Mock).mock.calls[0][1]).toEqual([
      { taskId: 'g1', outcome: 'dropped' },
    ]);
    expect(out.dropResults).toEqual([{ googleEventId: 'evt-drop', success: true }]);
  });

  it('removes only the local record for an ad-hoc block (no Asana call)', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([{ id: 'ah1', googleEventId: 'evt-adhoc' }]);

    const out = await confirm({
      drop: [{ googleEventId: 'evt-adhoc', googleIntegrationId: 'gi1', taskIds: ['ah1'] }],
    });

    expect(deleteCalendarEvent).toHaveBeenCalledTimes(1);
    expect(deleteAdHocTask).toHaveBeenCalledWith('ah1');
    // No Asana task to delete for an ad-hoc block.
    expect(deleteTask).not.toHaveBeenCalled();
    expect(out.dropResults).toEqual([{ googleEventId: 'evt-adhoc', success: true }]);
  });

  it('reports failure per row and continues when the Asana delete fails', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([
      { id: 's1', asanaTaskId: 'g1', integrationId: 'ai1', googleEventId: 'evt-drop' },
    ]);
    (getIntegrationById as jest.Mock).mockResolvedValue({
      id: 'ai1',
      type: 'asana',
      clientId: 'c',
      clientSecret: 's',
      credentials: { accessToken: 'atok' },
    });
    (deleteTask as jest.Mock).mockRejectedValueOnce(new Error('Asana 500'));

    const out = await confirm({
      drop: [{ googleEventId: 'evt-drop', googleIntegrationId: 'gi1', taskIds: ['g1'] }],
    });

    expect(out.dropResults).toHaveLength(1);
    expect(out.dropResults[0]).toMatchObject({ googleEventId: 'evt-drop', success: false });
  });

  it('deletes the calendar block cleanly for a task-less (meeting-prep) row with empty taskIds', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
    (getPrepBlocks as jest.Mock).mockResolvedValue([{ id: 'p1', googleEventId: 'evt-prep' }]);

    const out = await confirm({
      drop: [{ googleEventId: 'evt-prep', googleIntegrationId: 'gi1', taskIds: [] }],
    });

    // Calendar block + prep record removed, even with nothing to delete in Asana.
    expect(deleteCalendarEvent).toHaveBeenCalledTimes(1);
    expect((deleteCalendarEvent as jest.Mock).mock.calls[0][3]).toBe('evt-prep');
    expect(deletePrepBlock).toHaveBeenCalledWith('p1');
    expect(deleteTask).not.toHaveBeenCalled();
    // No task ids → no 'dropped' outcomes recorded.
    expect(setWeeklyTaskOutcomes).not.toHaveBeenCalled();
    expect(out.dropResults).toEqual([{ googleEventId: 'evt-prep', success: true }]);
  });
});

describe('replan confirm — leave unscheduled', () => {
  it("clears the override and records the block's tasks as unscheduled", async () => {
    const out = await confirm({ leaveUnscheduled: ['evt-thu'] });

    expect(removeBlockDoneOverride).toHaveBeenCalledWith('evt-thu');
    expect((setWeeklyTaskOutcomes as jest.Mock).mock.calls[0][1]).toEqual([
      { taskId: 'g-thu', outcome: 'unscheduled' },
    ]);
    // Folded into deferResults so the row shows a status icon in the UI.
    expect(out.deferResults).toEqual([{ taskIds: [], googleEventId: 'evt-thu', success: true }]);
  });
});

describe('replan confirm — weekly outcome attributed to the block\'s own week', () => {
  // Dates relative to the real "now" (the route keys the current week off
  // new Date()), so the test is stable whenever it runs.
  const thisMonday = startOfWeek(new Date(), { weekStartsOn: 1 });
  const thisMondayStr = format(thisMonday, 'yyyy-MM-dd');
  const lastMondayStr = format(addDays(thisMonday, -7), 'yyyy-MM-dd');
  const priorDate = format(addDays(thisMonday, -4), 'yyyy-MM-dd'); // last Thursday
  const curDate = format(addDays(thisMonday, 1), 'yyyy-MM-dd'); // this Tuesday

  it('writes a prior-week block\'s done outcome to the prior week and the current one to this week', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([
      { id: 's-prior', asanaTaskId: 'g-prior', googleEventId: 'evt-prior', scheduledDate: priorDate },
      { id: 's-cur', asanaTaskId: 'g-cur', googleEventId: 'evt-cur', scheduledDate: curDate },
    ]);

    await confirm({ done: ['evt-prior', 'evt-cur'] });

    const calls = (setWeeklyTaskOutcomes as jest.Mock).mock.calls;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priorCall = calls.find((c: any[]) => c[0] === lastMondayStr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const curCall = calls.find((c: any[]) => c[0] === thisMondayStr);
    expect(priorCall?.[1]).toEqual([{ taskId: 'g-prior', outcome: 'done' }]);
    expect(curCall?.[1]).toEqual([{ taskId: 'g-cur', outcome: 'done' }]);
  });

  it('routes a started outcome for a prior-week block into the prior week', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([
      { id: 's-prior', asanaTaskId: 'g-prior', googleEventId: 'evt-prior', scheduledDate: priorDate },
    ]);

    await confirm({ started: [{ googleEventId: 'evt-prior', taskIds: ['g-prior'] }] });

    const calls = (setWeeklyTaskOutcomes as jest.Mock).mock.calls;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priorCall = calls.find((c: any[]) => c[0] === lastMondayStr);
    expect(priorCall?.[1]).toEqual([{ taskId: 'g-prior', outcome: 'started' }]);
  });

  it('keeps the single current-week write when nothing crosses the boundary', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([
      { id: 's-cur', asanaTaskId: 'g-cur', googleEventId: 'evt-cur', scheduledDate: curDate },
    ]);

    await confirm({ done: ['evt-cur'] });

    const calls = (setWeeklyTaskOutcomes as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(thisMondayStr);
    expect(calls[0][1]).toEqual([{ taskId: 'g-cur', outcome: 'done' }]);
  });
});

describe('replan confirm — prep additions (early-next-week meetings)', () => {
  it('creates a "📖 Prep:" event and a linked PrepBlock for an accepted prep addition', async () => {
    (createCalendarEvent as jest.Mock).mockResolvedValue({ id: 'evt-prep-new' });

    const out = await confirm({
      additions: [
        {
          id: 'add-prep-1',
          kind: 'prep',
          category: 'Meeting prep',
          date: '2026-07-17',
          start: '15:00',
          durationMinutes: 15,
          reason: 'Prep for "Board review"',
          meeting: {
            eventId: 'evt-next-mon',
            title: 'Board review',
            meetingStart: '2026-07-20T10:00:00.000Z',
          },
        },
      ],
    });

    expect(createCalendarEvent).toHaveBeenCalledTimes(1);
    // Title carries the prep prefix built from the meeting title.
    expect((createCalendarEvent as jest.Mock).mock.calls[0][3]).toBe('📖 Prep: Board review');
    // PrepBlock record links to the (next-week) meeting so the morning briefing finds it.
    expect(addPrepBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        googleEventId: 'evt-prep-new',
        meetingEventId: 'evt-next-mon',
        meetingTitle: 'Board review',
        meetingStart: '2026-07-20T10:00:00.000Z',
        date: '2026-07-17',
        start: '15:00',
        durationMinutes: 15,
      })
    );
    expect(out.additionResults).toEqual([
      { id: 'add-prep-1', success: true, googleEventId: 'evt-prep-new' },
    ]);
  });
});

describe('replan confirm — convert a legacy deep-work block to a container', () => {
  it('retitles the event "Deep work", lists the agenda, and records the missing members', async () => {
    // The event 'evt-thu' already has member g-thu scheduled against it (beforeEach).
    const out = await confirm({
      conversions: [
        {
          googleEventId: 'evt-thu',
          googleIntegrationId: 'gi1',
          category: 'Writing/Deep Work',
          date: '2026-07-16',
          start: '09:00',
          durationMinutes: 90,
          tasks: [
            { gid: 'g-thu', title: 'Already here', integrationId: 'om' },
            { gid: 'g-new', title: 'New member', integrationId: 'om' },
          ],
        },
      ],
    });

    // Event retitled to the generic deep-work container title (index 6 = title).
    expect(updateCalendarEvent).toHaveBeenCalledTimes(1);
    const call = (updateCalendarEvent as jest.Mock).mock.calls[0];
    expect(call[3]).toBe('evt-thu');
    expect(call[6]).toBe('✍️ Deep work');
    // Description lists the week's deep-work tasks.
    expect(call[7]).toContain('Already here');
    expect(call[7]).toContain('New member');

    // Only the member NOT already scheduled against the event is added.
    expect(scheduleAsanaTask).toHaveBeenCalledTimes(1);
    expect((scheduleAsanaTask as jest.Mock).mock.calls[0][0]).toBe('g-new');
    expect((scheduleAsanaTask as jest.Mock).mock.calls[0][5]).toBe('evt-thu'); // same event
    // The deep-work category is stamped on the converted container member (index
    // 8 = category), so the next analyze prefers it over the Asana Type.
    expect((scheduleAsanaTask as jest.Mock).mock.calls[0][8]).toBe('Writing/Deep Work');

    expect(out.conversionResults).toEqual([{ googleEventId: 'evt-thu', success: true }]);
  });
});
