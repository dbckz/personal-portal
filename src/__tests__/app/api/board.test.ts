/**
 * @jest-environment node
 *
 * The board endpoints: GET builds the week's local stores (normalising the
 * requested date to its Monday), PATCH upserts a card's status and validates it.
 * All storage is mocked so the routes run pure.
 */
jest.mock('@/lib/user-data-storage', () => ({
  getBoardTaskStates: jest.fn(),
  getScheduledAsanaTasks: jest.fn(),
  getAdHocTasks: jest.fn(),
  getRitualBlocks: jest.fn(),
  getAllTaskMetadata: jest.fn(),
  getWeeklyStats: jest.fn(),
  upsertBoardTaskState: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/board/route';
import { PATCH } from '@/app/api/board/status/route';
import {
  getBoardTaskStates,
  getScheduledAsanaTasks,
  getAdHocTasks,
  getRitualBlocks,
  getAllTaskMetadata,
  getWeeklyStats,
  upsertBoardTaskState,
} from '@/lib/user-data-storage';

function getReq(url: string) {
  return new NextRequest(new Request(url));
}
function patchReq(body: unknown) {
  return new NextRequest(
    new Request('http://localhost/api/board/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  (getBoardTaskStates as jest.Mock).mockResolvedValue({});
  (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([]);
  (getAdHocTasks as jest.Mock).mockResolvedValue([]);
  (getRitualBlocks as jest.Mock).mockResolvedValue([]);
  (getAllTaskMetadata as jest.Mock).mockResolvedValue({});
  (getWeeklyStats as jest.Mock).mockResolvedValue(null);
});

describe('GET /api/board', () => {
  it('normalises any date in the week to its Monday', async () => {
    // Thursday 20 Aug 2026 → Monday 17 Aug 2026.
    const res = await GET(getReq('http://localhost/api/board?weekStart=2026-08-20'));
    const body = await res.json();
    expect(body.weekStart).toBe('2026-08-17');
  });

  it('filters scheduled Asana and ritual blocks to the week', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([
      { id: '1', asanaTaskId: 'g1', scheduledDate: '2026-08-18', scheduledTime: '09:00', duration: 60 },
      { id: '2', asanaTaskId: 'g2', scheduledDate: '2026-08-24', scheduledTime: '09:00', duration: 60 },
    ]);
    (getRitualBlocks as jest.Mock).mockResolvedValue([
      { id: 'r1', googleEventId: 'e', googleIntegrationId: 'g', title: '📧 Emails', date: '2026-08-18', start: '16:00', durationMinutes: 30, createdAt: '' },
      { id: 'r2', googleEventId: 'e', googleIntegrationId: 'g', title: '📧 Emails', date: '2026-08-10', start: '16:00', durationMinutes: 30, createdAt: '' },
    ]);
    const res = await GET(getReq('http://localhost/api/board?weekStart=2026-08-17'));
    const body = await res.json();
    expect(body.scheduledAsanaTasks.map((s: { asanaTaskId: string }) => s.asanaTaskId)).toEqual(['g1']);
    expect(body.ritualBlocks).toHaveLength(1);
  });

  it('returns portalDone gids and started task ids', async () => {
    (getAllTaskMetadata as jest.Mock).mockResolvedValue({
      g1: { asanaTaskGid: 'g1', integrationId: 'om', portalDone: true, updatedAt: '' },
      g2: { asanaTaskGid: 'g2', integrationId: 'om', updatedAt: '' },
    });
    (getWeeklyStats as jest.Mock).mockResolvedValue({
      weekStart: '2026-08-17',
      createdAt: '',
      updatedAt: '',
      tasks: {
        g3: { taskId: 'g3', category: 'x', scheduledAt: '', outcome: 'started' },
        g4: { taskId: 'g4', category: 'x', scheduledAt: '', outcome: 'done' },
      },
      integrations: {},
    });
    const res = await GET(getReq('http://localhost/api/board?weekStart=2026-08-17'));
    const body = await res.json();
    expect(body.portalDoneGids).toEqual(['g1']);
    expect(body.startedTaskIds).toEqual(['g3']);
  });

  it('defaults to the current Monday when no date is given', async () => {
    const res = await GET(getReq('http://localhost/api/board'));
    const body = await res.json();
    // A yyyy-MM-dd that is a Monday.
    expect(body.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [y, m, d] = body.weekStart.split('-').map(Number);
    expect(new Date(y, m - 1, d).getDay()).toBe(1);
  });
});

describe('PATCH /api/board/status', () => {
  it('upserts a valid status and returns the state', async () => {
    (upsertBoardTaskState as jest.Mock).mockImplementation(async (s) => s);
    const res = await PATCH(
      patchReq({ stateKey: 'asana:g1', key: 'asana:g1', status: 'waiting', title: 'T', integrationId: 'om' })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.state).toMatchObject({ key: 'asana:g1', status: 'waiting', title: 'T', integrationId: 'om' });
    expect(upsertBoardTaskState).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown status', async () => {
    const res = await PATCH(patchReq({ stateKey: 'asana:g1', key: 'asana:g1', status: 'nope' }));
    expect(res.status).toBe(400);
    expect(upsertBoardTaskState).not.toHaveBeenCalled();
  });

  it('rejects a missing stateKey', async () => {
    const res = await PATCH(patchReq({ key: 'asana:g1', status: 'todo' }));
    expect(res.status).toBe(400);
    expect(upsertBoardTaskState).not.toHaveBeenCalled();
  });
});
