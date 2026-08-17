/**
 * @jest-environment node
 *
 * The replan confirm route creates accepted task-backfill blocks exactly like the
 * weekly-plan confirm: a Google event, its scheduled-Asana record + attribution,
 * and the durable weekly-task record. All module boundaries are mocked so the
 * route runs pure.
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
  getEnabledAsanaIntegrations: jest.fn(),
  getEnabledGoogleIntegrations: jest.fn(),
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
  setGoogleEventAttribution: jest.fn(),
  recordWeeklyTasks: jest.fn(),
  markCarryOversScheduled: jest.fn(),
}));

import { POST } from '@/app/api/scheduling/replan/confirm/route';
import { createCalendarEvent, ensureValidCredentials } from '@/lib/google-calendar';
import {
  getEnabledAsanaIntegrations,
  getEnabledGoogleIntegrations,
  getGoogleIntegrationById,
} from '@/lib/integration-storage';
import {
  getAdHocTasks,
  getPrepBlocks,
  getRitualBlocks,
  getScheduledAsanaTasks,
  scheduleAsanaTask,
  setGoogleEventAttribution,
  recordWeeklyTasks,
  markCarryOversScheduled,
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
  (getEnabledAsanaIntegrations as jest.Mock).mockResolvedValue([]);
  (getGoogleIntegrationById as jest.Mock).mockResolvedValue(INTEGRATION);
  (ensureValidCredentials as jest.Mock).mockResolvedValue(INTEGRATION.credentials);
  (getAdHocTasks as jest.Mock).mockResolvedValue([]);
  (getPrepBlocks as jest.Mock).mockResolvedValue([]);
  (getRitualBlocks as jest.Mock).mockResolvedValue([]);
  (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
  (createCalendarEvent as jest.Mock).mockResolvedValue({ id: 'new-evt' });
});

describe('replan confirm — task backfill', () => {
  it('creates the calendar event, schedules the Asana task + attribution, and records the weekly task', async () => {
    const out = await confirm({
      backfill: [
        {
          id: 'bf1',
          category: 'Deep',
          task: { gid: 'a1', title: 'Write memo', integrationId: 'asana1' },
          date: '2026-07-16',
          start: '09:00',
          durationMinutes: 60,
          reason: 'Deep block.',
        },
      ],
    });

    expect(createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(scheduleAsanaTask).toHaveBeenCalledWith(
      'a1',
      'asana1',
      '2026-07-16',
      '09:00',
      60,
      'new-evt',
      'gi1',
      'Write memo'
    );
    expect(setGoogleEventAttribution).toHaveBeenCalledWith('new-evt', 'gi1', 'asana1');
    expect(recordWeeklyTasks).toHaveBeenCalledTimes(1);
    const weeklyArgs = (recordWeeklyTasks as jest.Mock).mock.calls[0][1];
    expect(weeklyArgs).toEqual([
      expect.objectContaining({ taskId: 'a1', category: 'Deep', scheduledMinutes: 60 }),
    ]);
    expect(markCarryOversScheduled).toHaveBeenCalledWith(['a1'], expect.any(String));
    expect(out.backfillResults).toEqual([{ id: 'bf1', success: true, googleEventId: 'new-evt' }]);
  });

  it('creates a reserved backfill block (no task) with no scheduling records', async () => {
    const out = await confirm({
      backfill: [
        {
          id: 'bf-res',
          category: 'Deep',
          date: '2026-07-16',
          start: '11:00',
          durationMinutes: 60,
          reason: 'Reserved Deep time.',
        },
      ],
    });

    expect(createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(scheduleAsanaTask).not.toHaveBeenCalled();
    expect(recordWeeklyTasks).not.toHaveBeenCalled();
    expect(out.backfillResults).toEqual([{ id: 'bf-res', success: true, googleEventId: 'new-evt' }]);
  });
});
