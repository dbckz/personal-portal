/**
 * @jest-environment node
 *
 * Tests for the batch drill-down block-member route. Each per-member action must
 * hit the SAME recording paths a review uses: 'done' completes the Asana task and
 * records a 'done' weekly outcome; 'remove' unschedules the member and records an
 * 'unscheduled' outcome — for the week the block belongs to. All module
 * boundaries are mocked so the route runs pure.
 */
jest.mock('@/lib/asana', () => ({
  completeTask: jest.fn(),
  refreshAsanaToken: jest.fn(),
}));

jest.mock('@/lib/integration-storage', () => ({
  getIntegrationById: jest.fn(),
  updateIntegration: jest.fn(),
}));

jest.mock('@/lib/user-data-storage', () => ({
  getScheduledAsanaTasks: jest.fn(),
  getAdHocTasks: jest.fn(),
  unscheduleAsanaTask: jest.fn(),
  updateAdHocTask: jest.fn(),
  removeCarryOvers: jest.fn(),
  setWeeklyTaskOutcomes: jest.fn(),
  getAllTaskMetadata: jest.fn(),
  upsertTaskMetadata: jest.fn(),
}));

import { format, startOfWeek } from 'date-fns';

import { POST } from '@/app/api/scheduling/block-member/route';
import { completeTask } from '@/lib/asana';
import { getIntegrationById } from '@/lib/integration-storage';
import {
  getScheduledAsanaTasks,
  getAdHocTasks,
  unscheduleAsanaTask,
  updateAdHocTask,
  removeCarryOvers,
  setWeeklyTaskOutcomes,
  getAllTaskMetadata,
  upsertTaskMetadata,
} from '@/lib/user-data-storage';

const ASANA_INTEGRATION = {
  id: 'int-1',
  type: 'asana',
  clientId: 'c',
  clientSecret: 's',
  credentials: { accessToken: 'tok' },
};

const SCHEDULED = {
  id: 's1',
  asanaTaskId: 'g1',
  integrationId: 'int-1',
  scheduledDate: '2026-07-24', // a Friday — its week's Monday is 2026-07-20
  scheduledTime: '09:00',
  duration: 30,
  googleEventId: 'evt-batch',
};

const EXPECTED_WEEK = format(startOfWeek(new Date('2026-07-24T00:00:00'), { weekStartsOn: 1 }), 'yyyy-MM-dd');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(body: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST({ json: async () => body } as any);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([SCHEDULED]);
  (getAdHocTasks as jest.Mock).mockResolvedValue([]);
  (getIntegrationById as jest.Mock).mockResolvedValue(ASANA_INTEGRATION);
  (getAllTaskMetadata as jest.Mock).mockResolvedValue({});
});

describe('block-member done', () => {
  it('completes the Asana task and records a done outcome in the block’s week', async () => {
    const { status, body } = await post({
      action: 'done',
      member: { source: 'asana', taskId: 'g1', gid: 'g1', integrationId: 'int-1', scheduleId: 's1' },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(completeTask).toHaveBeenCalledWith('tok', 'g1', true);
    expect(removeCarryOvers).toHaveBeenCalledWith(['g1']);
    expect(setWeeklyTaskOutcomes).toHaveBeenCalledWith(EXPECTED_WEEK, [{ taskId: 'g1', outcome: 'done' }]);
    expect(unscheduleAsanaTask).not.toHaveBeenCalled();
  });

  it('marks an ad-hoc member complete without touching Asana', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([
      { id: 'a1', dueDate: '2026-07-24', googleEventId: 'evt-batch', completed: false },
    ]);

    const { status } = await post({
      action: 'done',
      member: { source: 'adhoc', taskId: 'a1', adhocId: 'a1' },
    });

    expect(status).toBe(200);
    expect(updateAdHocTask).toHaveBeenCalledWith('a1', { completed: true });
    expect(completeTask).not.toHaveBeenCalled();
    expect(setWeeklyTaskOutcomes).toHaveBeenCalledWith(EXPECTED_WEEK, [{ taskId: 'a1', outcome: 'done' }]);
  });

  it('requires gid and integrationId for an Asana completion', async () => {
    const { status } = await post({
      action: 'done',
      member: { source: 'asana', taskId: 'g1' },
    });
    expect(status).toBe(400);
    expect(completeTask).not.toHaveBeenCalled();
  });
});

describe('block-member remove', () => {
  it('unschedules the Asana member and records an unscheduled outcome', async () => {
    const { status, body } = await post({
      action: 'remove',
      member: { source: 'asana', taskId: 'g1', gid: 'g1', integrationId: 'int-1', scheduleId: 's1' },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(unscheduleAsanaTask).toHaveBeenCalledWith('s1');
    expect(completeTask).not.toHaveBeenCalled();
    expect(setWeeklyTaskOutcomes).toHaveBeenCalledWith(EXPECTED_WEEK, [{ taskId: 'g1', outcome: 'unscheduled' }]);
  });

  it('clears an ad-hoc member’s slot and records an unscheduled outcome', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
    (getAdHocTasks as jest.Mock).mockResolvedValue([
      { id: 'a1', dueDate: '2026-07-24', googleEventId: 'evt-batch', completed: false },
    ]);

    const { status } = await post({
      action: 'remove',
      member: { source: 'adhoc', taskId: 'a1', adhocId: 'a1' },
    });

    expect(status).toBe(200);
    expect(updateAdHocTask).toHaveBeenCalledWith('a1', { googleEventId: undefined, dueTime: undefined });
    expect(setWeeklyTaskOutcomes).toHaveBeenCalledWith(EXPECTED_WEEK, [{ taskId: 'a1', outcome: 'unscheduled' }]);
  });
});

describe('block-member portalDone', () => {
  it('flags the task portal-done without touching Asana and records the outcome', async () => {
    const { status, body } = await post({
      action: 'portalDone',
      member: { source: 'asana', taskId: 'g1', gid: 'g1', integrationId: 'int-1', scheduleId: 's1', title: 'Publish it' },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(completeTask).not.toHaveBeenCalled();
    expect(upsertTaskMetadata).toHaveBeenCalledWith(
      'g1',
      'int-1',
      expect.objectContaining({ portalDone: true, portalDoneTitle: 'Publish it' })
    );
    expect(removeCarryOvers).toHaveBeenCalledWith(['g1']);
    expect(setWeeklyTaskOutcomes).toHaveBeenCalledWith(EXPECTED_WEEK, [{ taskId: 'g1', outcome: 'portalDone' }]);
  });

  it('clears the flag on reopenPortalDone and records a scheduled outcome', async () => {
    const { status } = await post({
      action: 'reopenPortalDone',
      member: { source: 'asana', taskId: 'g1', gid: 'g1', integrationId: 'int-1', scheduleId: 's1' },
    });

    expect(status).toBe(200);
    expect(completeTask).not.toHaveBeenCalled();
    expect(upsertTaskMetadata).toHaveBeenCalledWith(
      'g1',
      'int-1',
      expect.objectContaining({ portalDone: false, portalDoneAt: undefined, portalDoneTitle: undefined })
    );
    expect(setWeeklyTaskOutcomes).toHaveBeenCalledWith(EXPECTED_WEEK, [{ taskId: 'g1', outcome: 'scheduled' }]);
  });

  it('clears a portal-done flag when completing the same task in Asana', async () => {
    (getAllTaskMetadata as jest.Mock).mockResolvedValue({
      g1: { asanaTaskGid: 'g1', integrationId: 'int-1', portalDone: true, updatedAt: 'x' },
    });

    const { status } = await post({
      action: 'done',
      member: { source: 'asana', taskId: 'g1', gid: 'g1', integrationId: 'int-1', scheduleId: 's1' },
    });

    expect(status).toBe(200);
    expect(completeTask).toHaveBeenCalledWith('tok', 'g1', true);
    expect(upsertTaskMetadata).toHaveBeenCalledWith(
      'g1',
      'int-1',
      expect.objectContaining({ portalDone: false })
    );
  });

  it('rejects portalDone on an ad-hoc member', async () => {
    const { status } = await post({
      action: 'portalDone',
      member: { source: 'adhoc', taskId: 'a1', adhocId: 'a1' },
    });
    expect(status).toBe(400);
    expect(upsertTaskMetadata).not.toHaveBeenCalled();
  });
});

describe('block-member validation', () => {
  it('rejects an unknown action', async () => {
    const { status } = await post({ action: 'nope', member: { source: 'asana', taskId: 'g1' } });
    expect(status).toBe(400);
  });

  it('rejects a missing member', async () => {
    const { status } = await post({ action: 'done' });
    expect(status).toBe(400);
  });
});
