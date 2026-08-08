/**
 * @jest-environment node
 *
 * The /start route seeds today's session from the targets built off the PREVIOUS
 * workout. The seeded entries have to carry the full shape of each target — not
 * just sets/reps/kg — so a run keeps its distance and time, a plank its seconds,
 * and unilateral work its "each side". Storage is mocked so the route runs pure
 * and the seeded entries can be inspected.
 */
import type { ExerciseSession } from '@/types/life';

jest.mock('@/lib/storage/exercise', () => ({
  getAllSessions: jest.fn(),
  createSession: jest.fn(),
}));

import { POST } from '@/app/api/exercise/start/route';
import { getAllSessions, createSession } from '@/lib/storage/exercise';
import { NextRequest } from 'next/server';

const mockGetAll = getAllSessions as jest.Mock;
const mockCreate = createSession as jest.Mock;

// A previous, logged workout: a treadmill run (distance + time), a side plank
// (timed, per side) and a loaded press. Targets for the next session are built
// from this.
function previousSession(): ExerciseSession {
  return {
    id: 'prev',
    date: '2026-08-05',
    type: 'gym',
    planned: false,
    completed: true,
    source: 'manual',
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    exercises: [
      { id: 'p1', name: 'Treadmill run', durationMinutes: 15, distanceKm: 2.5, done: true },
      { id: 'p2', name: 'Side plank', sets: 3, holdSeconds: 30, perSide: true, done: true },
      { id: 'p3', name: 'Chest press machine', sets: 3, reps: 8, weightKg: 32, done: true },
    ],
  };
}

async function start(): Promise<Array<Record<string, unknown>>> {
  const req = new NextRequest('http://localhost/api/exercise/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-08-06' }),
  });
  await POST(req);
  return (mockCreate.mock.calls[0]?.[0]?.exercises ?? []) as Array<Record<string, unknown>>;
}

describe('POST /api/exercise/start — seeding the session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAll.mockResolvedValue([previousSession()]);
    mockCreate.mockImplementation(async (s: Record<string, unknown>) => ({ id: 's1', ...s }));
  });

  it('carries the run’s distance and time onto its seeded entry', async () => {
    const entries = await start();
    const run = entries.find(e => e.name === 'Treadmill run')!;
    expect(run.durationMinutes).toBe(15);
    expect(run.distanceKm).toBe(2.5);
    // The pre-filled target reads in cardio units, not "—".
    expect(run.targetText).toBe('15 min · 2.5 km');
  });

  it('carries a plank’s seconds and marks unilateral work each side', async () => {
    const entries = await start();
    const plank = entries.find(e => e.name === 'Side plank')!;
    expect(plank.holdSeconds).toBeDefined();
    expect(plank.perSide).toBe(true);
    expect(plank.targetText).toMatch(/s each side$/);
    expect(plank.reps).toBeUndefined();
  });

  it('still seeds a loaded lift with sets/reps/kg', async () => {
    const entries = await start();
    const press = entries.find(e => e.name === 'Chest press machine')!;
    expect(press.sets).toBe(3);
    expect(press.weightKg).toBeDefined();
    expect(press.targetText).toMatch(/kg$/);
  });
});
