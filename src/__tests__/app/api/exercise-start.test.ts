/**
 * @jest-environment node
 *
 * The /start route seeds today's session from the SAME targets the checklist's
 * /targets route serves (resolveSessionTargets): the cached AI programme when one
 * exists, else the deterministic targets built off the PREVIOUS workout. It must
 * never trigger a fresh AI generation.
 *
 * Two things are checked here. First, the seeded entries carry the full shape of
 * each target — not just sets/reps/kg — so a run keeps its distance and time, a
 * plank its seconds, and unilateral work its "each side". Second, when an AI
 * programme is cached its numbers win over the deterministic ones, so the
 * pre-filled "done" figures match what the screen recommends. Storage is mocked
 * so the route runs pure and the seeded entries can be inspected.
 */
import type { ExerciseSession } from '@/types/life';
import type { ProgrammeRow } from '@/lib/exercise-programmer';
import { exerciseKey } from '@/lib/exercise-progression';
import { parsePrescription } from '@/lib/exercise-prescription';

jest.mock('@/lib/storage/exercise', () => ({
  getAllSessions: jest.fn(),
  createSession: jest.fn(),
}));

// The AI-programme cache, mocked so a test can place a programme (or not) for the
// day and inspect which source the seeding drew from.
jest.mock('@/lib/storage/exercise-programmes', () => ({
  getCachedProgramme: jest.fn(),
  saveCachedProgramme: jest.fn(),
}));

// No active goals in these tests — keeps the resolved hash stable and avoids the
// goal-evidence path. (An empty list is also what an in-memory test DB returns.)
jest.mock('@/lib/storage/goals', () => ({
  queryGoals: jest.fn().mockResolvedValue([]),
}));

// Keep the real programmer helpers (input/hash/row mapping the resolver needs)
// but spy on generateProgramme so a test can assert the start route never fires
// a Claude generation.
const mockGenerate = jest.fn();
jest.mock('@/lib/exercise-programmer', () => ({
  ...jest.requireActual('@/lib/exercise-programmer'),
  generateProgramme: (...args: unknown[]) => mockGenerate(...args),
}));

import { POST } from '@/app/api/exercise/start/route';
import { getAllSessions, createSession } from '@/lib/storage/exercise';
import { getCachedProgramme } from '@/lib/storage/exercise-programmes';
import { NextRequest } from 'next/server';

const mockGetAll = getAllSessions as jest.Mock;
const mockCreate = createSession as jest.Mock;
const mockGetCached = getCachedProgramme as jest.Mock;

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

// A cached AI programme for the day: it prescribes the chest press at 3 × 10
// (progressing the reps) where the last logged session — and so the deterministic
// target — sits at 3 × 8. Seeding must take the AI numbers.
function cachedProgramme(): ProgrammeRow[] {
  return [
    {
      name: 'Chest press machine',
      key: exerciseKey('Chest press machine'),
      kind: 'core',
      toFailure: false,
      target: { sets: 3, reps: 10, weightKg: 32 },
      rationale: 'Last time 3 × 8 · 32kg with room to spare — add two reps a set.',
      lastSummary: '5 Aug · 3 × 8 · 32kg',
    },
  ];
}

describe('POST /api/exercise/start — seeding the session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAll.mockResolvedValue([previousSession()]);
    mockCreate.mockImplementation(async (s: Record<string, unknown>) => ({ id: 's1', ...s }));
    // Default: no AI programme cached, so seeding uses the deterministic targets.
    mockGetCached.mockReturnValue(null);
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

  it('seeds from the cached AI programme’s numbers when one exists (3 × 10, not 3 × 8)', async () => {
    mockGetCached.mockReturnValue(cachedProgramme());
    const entries = await start();
    const press = entries.find(e => e.name === 'Chest press machine')!;
    // The AI programme says 3 × 10; the last log (and the deterministic target)
    // is 3 × 8. The seeded, pre-filled "done" numbers must be the AI's, so a tick
    // records what the screen recommended.
    expect(press.sets).toBe(3);
    expect(press.reps).toBe(10);
    expect(press.weightKg).toBe(32);
    expect(press.targetText).toBe('3 × 10 · 32kg');
  });

  it('falls back to the deterministic target when no AI programme is cached', async () => {
    mockGetCached.mockReturnValue(null);
    const entries = await start();
    const press = entries.find(e => e.name === 'Chest press machine')!;
    // Deterministic double-progression holds the reps at the last logged 8 (the
    // note gave no sign there was anything to spare), never the AI's 10.
    expect(press.reps).toBe(8);
  });

  it('never triggers an AI generation', async () => {
    mockGetCached.mockReturnValue(null);
    await start();
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

// A planned session whose calendar event prescribed rep and hold RANGES. Seeding
// must pre-fill the LOWER bound of each range as the "done" number while the
// target text shows the whole range.
function plannedPrescription(): ExerciseSession {
  const { sections } = parsePrescription(
    `Anchors:\n- Seated cable row: 3 x 8–12\n\nCore:\n- Side plank: 3 x 30–45 sec each side\n\nAccessories:\n- Cable shrugs: 2 x 15`
  );
  return {
    id: 'plan',
    date: '2026-08-06',
    type: 'strength',
    planned: true,
    completed: false,
    source: 'calendar',
    label: 'Pull + core',
    components: ['Pull', 'core'],
    prescription: sections,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('POST /api/exercise/start — seeding a prescribed session with ranges', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAll.mockResolvedValue([previousSession(), plannedPrescription()]);
    mockCreate.mockImplementation(async (s: Record<string, unknown>) => ({ id: 's1', ...s }));
    mockGetCached.mockReturnValue(null);
  });

  it('seeds the lower bound of a rep range and shows the range in the target text', async () => {
    const entries = await start();
    // Exactly the prescribed exercises, in order.
    expect(entries.map(e => e.name)).toEqual(['Seated cable row', 'Side plank', 'Cable shrugs']);
    const row = entries.find(e => e.name === 'Seated cable row')!;
    expect(row.reps).toBe(8); // lower bound seeded
    expect(row.sets).toBe(3);
    expect(row.targetText).toMatch(/3 × 8–12/);
  });

  it('seeds the lower bound of a hold range and carries each side', async () => {
    const entries = await start();
    const plank = entries.find(e => e.name === 'Side plank')!;
    expect(plank.holdSeconds).toBe(30);
    expect(plank.perSide).toBe(true);
    expect(plank.reps).toBeUndefined();
    expect(plank.targetText).toMatch(/3 × 30–45s each side/);
  });

  it('seeds a single-value scheme as a plain count', async () => {
    const entries = await start();
    const shrugs = entries.find(e => e.name === 'Cable shrugs')!;
    expect(shrugs.reps).toBe(15);
    expect(shrugs.targetText).toBe('2 × 15');
  });
});
