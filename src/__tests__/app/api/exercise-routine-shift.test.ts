/**
 * @jest-environment node
 *
 * POST /api/exercise/routine/shift pushes the plan one day later across a window:
 * `from` becomes rest, each day's plan slides onto the next, and the last plan
 * lands on `until + 1` (which must be a free rest day). It records the move as
 * per-date overrides AND re-dates the sessions, dragging their calendar events.
 * Storage, the calendar push and the routine are mocked so the route runs pure.
 */
import type { ExerciseSession, WeeklyRoutineDay } from '@/types/life';

jest.mock('@/lib/storage/exercise', () => ({
  getAllSessions: jest.fn(),
  updateSession: jest.fn(),
}));

jest.mock('@/lib/exercise-calendar', () => ({
  pushPlannedSession: jest.fn(),
}));

jest.mock('@/lib/storage/weekly-routine', () => ({
  getWeeklyRoutine: jest.fn(),
}));

jest.mock('@/lib/storage/routine-overrides', () => ({
  getRoutineOverrides: jest.fn(),
  setRoutineOverride: jest.fn(),
}));

jest.mock('@/lib/exercise-prewarm', () => ({
  prewarmProgramme: jest.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/exercise/routine/shift/route';
import { getAllSessions, updateSession } from '@/lib/storage/exercise';
import { pushPlannedSession } from '@/lib/exercise-calendar';
import { getWeeklyRoutine } from '@/lib/storage/weekly-routine';
import { getRoutineOverrides, setRoutineOverride } from '@/lib/storage/routine-overrides';
import { NextRequest } from 'next/server';

const mockGetAll = getAllSessions as jest.Mock;
const mockUpdate = updateSession as jest.Mock;
const mockPush = pushPlannedSession as jest.Mock;
const mockRoutine = getWeeklyRoutine as jest.Mock;
const mockGetOverrides = getRoutineOverrides as jest.Mock;
const mockSetOverride = setRoutineOverride as jest.Mock;

// The seeded week: Wed (3) Pull + Legs, Thu (4) push day, Fri (5) Rest.
function routine(): WeeklyRoutineDay[] {
  return [
    { dayOfWeek: 3, title: 'Pull + Legs', anchors: ['Leg press'] },
    { dayOfWeek: 4, title: 'Push (shoulders) + Run', anchors: ['Overhead press'] },
    { dayOfWeek: 5, title: 'Rest', anchors: [], rest: true },
  ];
}

function session(over: Partial<ExerciseSession> & Pick<ExerciseSession, 'id' | 'date'>): ExerciseSession {
  return {
    type: 'strength',
    planned: true,
    completed: false,
    source: 'calendar',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

async function post(body: Record<string, unknown>) {
  const req = new NextRequest('http://localhost/api/exercise/routine/shift', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRoutine.mockResolvedValue(routine());
  mockGetOverrides.mockResolvedValue({});
  // Accumulate overrides across calls and return the running map.
  const overrides: Record<string, unknown> = {};
  mockSetOverride.mockImplementation(async (date: string, override: unknown) => {
    if (override === null) delete overrides[date];
    else overrides[date] = override;
    return { ...overrides };
  });
  // Re-date the matched session and echo it back with the patch applied.
  mockUpdate.mockImplementation(async (id: string, patch: Partial<ExerciseSession>) => {
    const all: ExerciseSession[] = await mockGetAll();
    const found = all.find(s => s.id === id);
    return found ? { ...found, ...patch } : null;
  });
  mockPush.mockImplementation(async (s: ExerciseSession) => s);
});

describe('POST /api/exercise/routine/shift', () => {
  it('shifts a two-day window: overrides, reverse-order moves, calendar pushes', async () => {
    mockGetAll.mockResolvedValue([
      // Wed's Pull + Legs and Thu's push day, both with calendar events.
      session({ id: 'wed', date: '2026-09-02', label: 'Pull + Legs', googleEventId: 'g-wed' }),
      session({ id: 'thu', date: '2026-09-03', label: 'Push (shoulders) + Run', googleEventId: 'g-thu' }),
    ]);

    const { status, json } = await post({ from: '2026-09-02', until: '2026-09-03' });

    expect(status).toBe(200);

    // Sessions moved from `until` down to `from` — Thursday first, then Wednesday.
    expect(json.moved).toEqual([
      { id: 'thu', from: '2026-09-03', to: '2026-09-04', label: 'Push (shoulders) + Run' },
      { id: 'wed', from: '2026-09-02', to: '2026-09-03', label: 'Pull + Legs' },
    ]);
    expect(json.skipped).toEqual([]);

    // Each shifted date follows the routine day it now carries; `from` is rested.
    expect(json.overrides['2026-09-02']).toEqual({ rest: true });
    expect(json.overrides['2026-09-03']).toEqual({ dayOfWeek: 3 });
    expect(json.overrides['2026-09-04']).toEqual({ dayOfWeek: 4 });

    // The Google events were dragged with the sessions.
    expect(mockPush).toHaveBeenCalledTimes(2);
    const pushedDates = mockPush.mock.calls.map(c => c[0].date).sort();
    expect(pushedDates).toEqual(['2026-09-03', '2026-09-04']);
  });

  it('leaves started/completed sessions where they are and reports them', async () => {
    // Shift Thursday only; the target is Friday (a free rest day).
    mockGetAll.mockResolvedValue([
      session({ id: 'thu', date: '2026-09-03', label: 'Push (shoulders) + Run', googleEventId: 'g-thu' }),
      // A started session on the same day (has logged exercises) must not move.
      session({
        id: 'started',
        date: '2026-09-03',
        label: 'Push (shoulders) + Run',
        exercises: [{ id: 'e1', name: 'Leg press' }],
      }),
    ]);

    const { status, json } = await post({ from: '2026-09-03', until: '2026-09-03' });

    expect(status).toBe(200);
    expect(json.moved.map((m: { id: string }) => m.id)).toEqual(['thu']);
    expect(json.skipped).toEqual([
      { id: 'started', date: '2026-09-03', label: 'Push (shoulders) + Run', reason: 'started' },
    ]);
  });

  it('400s when the target day already holds a session', async () => {
    mockGetAll.mockResolvedValue([
      session({ id: 'wed', date: '2026-09-02', label: 'Pull + Legs' }),
      // Something already sits on Friday 2026-09-04, the shift target.
      session({ id: 'fri', date: '2026-09-04', label: 'Existing', completed: true, planned: false }),
    ]);

    const { status, json } = await post({ from: '2026-09-02', until: '2026-09-03' });

    expect(status).toBe(400);
    expect(json.error).toMatch(/2026-09-04/);
    expect(mockSetOverride).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('400s when the target day is not a rest day', async () => {
    mockGetAll.mockResolvedValue([
      session({ id: 'thu', date: '2026-09-03', label: 'Push (shoulders) + Run' }),
    ]);
    // until = Wed 2026-09-02, so target = Thu 2026-09-03, a training day.
    const { status, json } = await post({ from: '2026-09-02', until: '2026-09-02' });

    expect(status).toBe(400);
    expect(json.error).toMatch(/rest day/i);
    expect(mockSetOverride).not.toHaveBeenCalled();
  });

  it('400s on a reversed or over-long window', async () => {
    mockGetAll.mockResolvedValue([]);
    const reversed = await post({ from: '2026-09-03', until: '2026-09-02' });
    expect(reversed.status).toBe(400);

    const tooLong = await post({ from: '2026-09-02', until: '2026-09-12' });
    expect(tooLong.status).toBe(400);
  });
});
