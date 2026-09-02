/**
 * @jest-environment node
 *
 * PATCH /api/exercise/[id] updates a session. When the update MOVES a planned
 * session that owns a Google event to a new date, the calendar event must follow
 * (pushPlannedSession). A same-date edit, or a session without a calendar event,
 * must not push. Storage, the calendar and the prewarm are mocked.
 */
import type { ExerciseSession } from '@/types/life';

jest.mock('@/lib/storage/exercise', () => ({
  getAllSessions: jest.fn(),
  updateSession: jest.fn(),
  deleteSession: jest.fn(),
}));

jest.mock('@/lib/exercise-calendar', () => ({
  removePlannedEvent: jest.fn(),
  pushPlannedSession: jest.fn(),
}));

jest.mock('@/lib/exercise-prewarm', () => ({
  prewarmProgramme: jest.fn().mockResolvedValue(undefined),
}));

import { PATCH } from '@/app/api/exercise/[id]/route';
import { getAllSessions, updateSession } from '@/lib/storage/exercise';
import { pushPlannedSession } from '@/lib/exercise-calendar';
import { NextRequest } from 'next/server';

const mockGetAll = getAllSessions as jest.Mock;
const mockUpdate = updateSession as jest.Mock;
const mockPush = pushPlannedSession as jest.Mock;

function session(over: Partial<ExerciseSession> & Pick<ExerciseSession, 'id' | 'date'>): ExerciseSession {
  return {
    type: 'strength',
    planned: true,
    completed: false,
    source: 'routine',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

async function patch(id: string, body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/exercise/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await PATCH(req, { params: Promise.resolve({ id }) });
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPush.mockImplementation(async (s: ExerciseSession) => s);
});

describe('PATCH /api/exercise/[id] — calendar follows a date change', () => {
  it('pushes the calendar event when a planned session with an event is moved', async () => {
    const stored = session({ id: 's1', date: '2026-09-02', googleEventId: 'g1' });
    mockGetAll.mockResolvedValue([stored]);
    mockUpdate.mockResolvedValue({ ...stored, date: '2026-09-03' });

    const { status } = await patch('s1', { date: '2026-09-03' });

    expect(status).toBe(200);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0].date).toBe('2026-09-03');
  });

  it('does not push when the date is unchanged', async () => {
    const stored = session({ id: 's1', date: '2026-09-02', googleEventId: 'g1' });
    mockGetAll.mockResolvedValue([stored]);
    mockUpdate.mockResolvedValue({ ...stored, notes: 'edited' });

    await patch('s1', { date: '2026-09-02', notes: 'edited' });

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does not push a moved session that has no calendar event', async () => {
    const stored = session({ id: 's1', date: '2026-09-02' });
    mockGetAll.mockResolvedValue([stored]);
    mockUpdate.mockResolvedValue({ ...stored, date: '2026-09-03' });

    await patch('s1', { date: '2026-09-03' });

    expect(mockPush).not.toHaveBeenCalled();
  });
});
