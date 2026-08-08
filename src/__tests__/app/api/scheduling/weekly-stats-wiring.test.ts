/**
 * @jest-environment node
 *
 * The durable weekly record is written at the events that change it: a plan
 * confirm puts tasks INTO the week, a replan/daily-review confirm settles their
 * outcomes, and a week reset marks the wiped ones dropped without destroying the
 * record. All I/O is mocked so the routes run pure.
 */
jest.mock('@/lib/google-calendar', () => ({
  createCalendarEvent: jest.fn(),
  deleteCalendarEvent: jest.fn(),
  updateCalendarEvent: jest.fn(),
  ensureValidCredentials: jest.fn(),
}));
jest.mock('@/lib/asana', () => ({ completeTask: jest.fn(), refreshAsanaToken: jest.fn() }));
jest.mock('@/lib/integration-storage', () => ({
  getEnabledGoogleIntegrations: jest.fn(),
  getEnabledAsanaIntegrations: jest.fn(),
  getGoogleIntegrationById: jest.fn(),
  getIntegrationById: jest.fn(),
  updateIntegration: jest.fn(),
}));
jest.mock('@/lib/workflow-config-storage', () => ({ getWorkflowConfig: jest.fn() }));
jest.mock('@/lib/scheduling/ritual-events', () => ({ createRitualEvent: jest.fn() }));
jest.mock('@/lib/scheduling/rituals', () => ({
  ...jest.requireActual('@/lib/scheduling/rituals'),
  ritualIntegrationIdForBlock: jest.fn(),
}));
jest.mock('@/lib/scheduling/gather', () => ({
  fetchWeekEvents: jest.fn(),
  adHocTypeSignals: jest.fn(() => []),
}));
jest.mock('@/lib/scheduling/free-busy', () => ({ eventsToBusyIntervals: jest.fn(() => []) }));

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
  setGoogleEventAttribution: jest.fn(),
  setTaskDeferrals: jest.fn(),
  setCarryOvers: jest.fn(),
  removeCarryOvers: jest.fn(),
  updateScheduledAsanaTasksByGoogleEvent: jest.fn(),
  recordWeeklyTasks: jest.fn(),
  setWeeklyTaskOutcomes: jest.fn(),
  getWeeklyStats: jest.fn(),
}));

import { POST as planConfirm } from '@/app/api/scheduling/confirm/route';
import { POST as replanConfirm } from '@/app/api/scheduling/replan/confirm/route';
import { POST as resetWeek } from '@/app/api/scheduling/reset-week/route';
import { createCalendarEvent, ensureValidCredentials } from '@/lib/google-calendar';
import { getEnabledGoogleIntegrations, getEnabledAsanaIntegrations, getGoogleIntegrationById } from '@/lib/integration-storage';
import { getWorkflowConfig } from '@/lib/workflow-config-storage';
import { fetchWeekEvents } from '@/lib/scheduling/gather';
import {
  getAdHocTasks,
  getPrepBlocks,
  getRitualBlocks,
  getScheduledAsanaTasks,
  updateScheduledAsanaTasksByGoogleEvent,
  recordWeeklyTasks,
  setWeeklyTaskOutcomes,
  getWeeklyStats,
} from '@/lib/user-data-storage';

const INTEGRATION = { id: 'gi1', clientId: 'c', clientSecret: 's', credentials: { accessToken: 't' } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(handler: (r: any) => Promise<Response>, body: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await handler({ json: async () => body } as any);
  return res.json();
}

beforeEach(() => {
  jest.clearAllMocks();
  (getEnabledGoogleIntegrations as jest.Mock).mockResolvedValue([INTEGRATION]);
  (getEnabledAsanaIntegrations as jest.Mock).mockResolvedValue([]);
  (getGoogleIntegrationById as jest.Mock).mockResolvedValue(INTEGRATION);
  (ensureValidCredentials as jest.Mock).mockResolvedValue(INTEGRATION.credentials);
  (createCalendarEvent as jest.Mock).mockResolvedValue({ id: 'evt-new' });
  (getWorkflowConfig as jest.Mock).mockResolvedValue({
    taskQuotas: {},
    typeMapping: {},
    scheduling: { workingDays: ['Monday'], workingHours: { start: '09:00', end: '17:00' } },
  });
  (fetchWeekEvents as jest.Mock).mockResolvedValue({ events: [], fetchedIntegrationIds: new Set() });
  (getAdHocTasks as jest.Mock).mockResolvedValue([]);
  (getPrepBlocks as jest.Mock).mockResolvedValue([]);
  (getRitualBlocks as jest.Mock).mockResolvedValue([]);
  (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
  (updateScheduledAsanaTasksByGoogleEvent as jest.Mock).mockResolvedValue(1);
  (getWeeklyStats as jest.Mock).mockResolvedValue(null);
});

describe('plan confirm → weekly record', () => {
  it('records every member task of a grouped block and each single-task block', async () => {
    await post(planConfirm, {
      weekStart: '2026-07-20',
      proposals: [
        {
          id: 'p-group',
          category: 'Engagement',
          date: '2026-07-21',
          start: '10:00',
          durationMinutes: 90,
          reason: 'quota',
          tasks: [
            { gid: 'e1', title: 'Email Ana', integrationId: 'ai1' },
            { gid: 'e2', title: 'Email Bo', integrationId: 'ai1' },
          ],
        },
        {
          id: 'p-single',
          category: 'Writing',
          date: '2026-07-22',
          start: '09:00',
          durationMinutes: 60,
          reason: 'quota',
          task: { gid: 'w1', title: 'Draft the brief', integrationId: 'ai1' },
        },
        // Rituals and reserved blocks carry no task and must not be recorded.
        { id: 'p-ritual', category: 'Lunch', kind: 'ritual', title: '🍽️ Lunch', date: '2026-07-21', start: '12:30', durationMinutes: 30, reason: 'ritual' },
        { id: 'p-reserved', category: 'Writing', date: '2026-07-23', start: '09:00', durationMinutes: 60, reason: 'reserved' },
      ],
    });

    expect(recordWeeklyTasks).toHaveBeenCalledTimes(1);
    const [week, tasks] = (recordWeeklyTasks as jest.Mock).mock.calls[0];
    expect(week).toBe('2026-07-20');
    expect(tasks).toEqual([
      expect.objectContaining({ taskId: 'e1', category: 'Engagement', title: 'Email Ana' }),
      expect.objectContaining({ taskId: 'e2', category: 'Engagement' }),
      expect.objectContaining({ taskId: 'w1', category: 'Writing', title: 'Draft the brief' }),
    ]);
  });

  it('records block length per task: single = full block, grouped = split evenly', async () => {
    await post(planConfirm, {
      weekStart: '2026-07-20',
      proposals: [
        {
          id: 'p-group',
          category: 'Engagement',
          date: '2026-07-21',
          start: '10:00',
          durationMinutes: 90,
          reason: 'quota',
          tasks: [
            { gid: 'e1', title: 'Email Ana', integrationId: 'ai1' },
            { gid: 'e2', title: 'Email Bo', integrationId: 'ai1' },
            { gid: 'e3', title: 'Email Cy', integrationId: 'ai1' },
          ],
        },
        {
          id: 'p-single',
          category: 'Writing',
          date: '2026-07-22',
          start: '09:00',
          durationMinutes: 120,
          reason: 'quota',
          task: { gid: 'w1', title: 'Draft the brief', integrationId: 'ai1' },
        },
      ],
    });

    const [, tasks] = (recordWeeklyTasks as jest.Mock).mock.calls[0];
    // 90-minute grouped block over 3 tasks → 30m each; single keeps its full 120.
    expect(tasks).toEqual([
      expect.objectContaining({ taskId: 'e1', scheduledMinutes: 30 }),
      expect.objectContaining({ taskId: 'e2', scheduledMinutes: 30 }),
      expect.objectContaining({ taskId: 'e3', scheduledMinutes: 30 }),
      expect.objectContaining({ taskId: 'w1', scheduledMinutes: 120 }),
    ]);
  });
});

describe('replan / daily-review confirm → weekly outcomes', () => {
  beforeEach(() => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([
      { id: 's1', asanaTaskId: 'g-done', googleEventId: 'evt-done' },
      { id: 's2', asanaTaskId: 'g-carried', googleEventId: 'evt-carried' },
    ]);
  });

  it('marks a done block done, and a carried task carried (not done)', async () => {
    await post(replanConfirm, {
      moves: [],
      done: ['evt-done'],
      carry: [{ blockId: 'evt-carried', blockIds: ['evt-carried'], taskIds: ['g-carried'] }],
    });

    const [, outcomes] = (setWeeklyTaskOutcomes as jest.Mock).mock.calls[0];
    expect(outcomes).toContainEqual({ taskId: 'g-done', outcome: 'done' });
    expect(outcomes).toContainEqual({ taskId: 'g-carried', outcome: 'carried' });
  });

  it('records a deferred unplaceable block as carried', async () => {
    await post(replanConfirm, {
      moves: [],
      defer: [{ taskIds: ['g-carried'], googleEventId: 'evt-carried' }],
    });

    const [, outcomes] = (setWeeklyTaskOutcomes as jest.Mock).mock.calls[0];
    expect(outcomes).toContainEqual({ taskId: 'g-carried', outcome: 'carried' });
  });

  it("records a left-unscheduled block's tasks as unscheduled", async () => {
    await post(replanConfirm, { moves: [], leaveUnscheduled: ['evt-carried'] });

    const [, outcomes] = (setWeeklyTaskOutcomes as jest.Mock).mock.calls[0];
    expect(outcomes).toContainEqual({ taskId: 'g-carried', outcome: 'unscheduled' });
  });

  it('marks an Asana completion done, and a not-done reversal back to scheduled', async () => {
    await post(replanConfirm, { moves: [], notDone: ['evt-done'] });
    const [, outcomes] = (setWeeklyTaskOutcomes as jest.Mock).mock.calls[0];
    expect(outcomes).toContainEqual({ taskId: 'g-done', outcome: 'scheduled' });
  });

  it('writes nothing when the confirm settled no outcomes', async () => {
    // Dismissing a stale prep block settles no task outcome (it has no backing task).
    await post(replanConfirm, { moves: [], dismiss: ['evt-stale-prep'] });
    expect(setWeeklyTaskOutcomes).not.toHaveBeenCalled();
  });
});

describe('week reset → the record survives', () => {
  it('marks wiped tasks dropped but keeps ones already done', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([
      { id: 's1', asanaTaskId: 'g-done', scheduledDate: '2026-07-21', scheduledTime: '09:00', duration: 60, googleEventId: 'evt-done' },
      { id: 's2', asanaTaskId: 'g-open', scheduledDate: '2026-07-21', scheduledTime: '11:00', duration: 60, googleEventId: 'evt-open' },
    ]);
    (getWeeklyStats as jest.Mock).mockResolvedValue({
      weekStart: '2026-07-20',
      createdAt: '',
      updatedAt: '',
      tasks: {
        'g-done': { taskId: 'g-done', category: 'Writing', scheduledAt: '', outcome: 'done' },
        'g-open': { taskId: 'g-open', category: 'Writing', scheduledAt: '', outcome: 'scheduled' },
      },
      integrations: {},
    });

    await post(resetWeek, { weekStart: '2026-07-20' });

    // The record itself is never cleared — only outcomes are updated.
    const calls = (setWeeklyTaskOutcomes as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual([{ taskId: 'g-open', outcome: 'dropped' }]);
  });
});
