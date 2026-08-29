/**
 * @jest-environment node
 *
 * prewarmProgramme pre-generates and caches the AI session programme off the
 * request path, so the Today checklist rarely has to wait on Claude. Three things
 * matter: a cache HIT (a programme already cached for today's inputs) does no
 * work; a cache MISS generates the programme and caches it under the resolved
 * hash; and two concurrent prewarms for the same day dedup to a single Claude
 * call. Storage and the programmer's Claude call are mocked so the helper runs
 * pure and the generation can be inspected (and never actually spawns Claude).
 */
import type { ExerciseSession } from '@/types/life';
import type { ProgrammeRow } from '@/lib/exercise-programmer';
import { exerciseKey } from '@/lib/exercise-progression';

jest.mock('@/lib/storage/exercise', () => ({
  getAllSessions: jest.fn(),
  pruneUntouchedSeededEntries: jest.fn().mockResolvedValue({ removed: 0 }),
}));

jest.mock('@/lib/storage/exercise-programmes', () => ({
  getCachedProgramme: jest.fn(),
  saveCachedProgramme: jest.fn(),
}));

// No active goals — keeps the resolved hash stable and avoids the goal-evidence
// path. (An empty list is also what an in-memory test DB returns.)
jest.mock('@/lib/storage/goals', () => ({
  queryGoals: jest.fn().mockResolvedValue([]),
}));

// No standing routine for these dates, so the deterministic resolution reflects
// the full history rather than a routine day's component filter.
jest.mock('@/lib/storage/weekly-routine', () => ({
  getWeeklyRoutine: jest.fn().mockResolvedValue([]),
}));

// Keep the real programmer helpers (input/hash/row mapping the resolver needs)
// but spy on generateProgramme so a test can drive it without spawning Claude and
// assert how many times it fires.
const mockGenerate = jest.fn();
jest.mock('@/lib/exercise-programmer', () => ({
  ...jest.requireActual('@/lib/exercise-programmer'),
  generateProgramme: (...args: unknown[]) => mockGenerate(...args),
}));

import { prewarmProgramme } from '@/lib/exercise-prewarm';
import { getAllSessions, pruneUntouchedSeededEntries } from '@/lib/storage/exercise';
import { getCachedProgramme, saveCachedProgramme } from '@/lib/storage/exercise-programmes';

const mockGetAll = getAllSessions as jest.Mock;
const mockGetCached = getCachedProgramme as jest.Mock;
const mockSaveCached = saveCachedProgramme as jest.Mock;
const mockPrune = pruneUntouchedSeededEntries as jest.Mock;

// A previous, logged workout — the history the next session's programme is built
// from, so the resolved input has exercises to program.
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
      { id: 'p1', name: 'Chest press machine', sets: 3, reps: 8, weightKg: 32, done: true },
    ],
  };
}

function programme(): ProgrammeRow[] {
  return [
    {
      name: 'Chest press machine',
      key: exerciseKey('Chest press machine'),
      kind: 'core',
      toFailure: false,
      target: { sets: 3, reps: 10, weightKg: 32 },
      rationale: 'Room to spare — add two reps a set.',
      lastSummary: '5 Aug · 3 × 8 · 32kg',
    },
  ];
}

const DATE = '2026-08-06';

describe('prewarmProgramme', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAll.mockResolvedValue([previousSession()]);
  });

  it('does nothing when a programme is already cached (cache hit)', async () => {
    mockGetCached.mockReturnValue(programme());
    await prewarmProgramme(DATE);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockSaveCached).not.toHaveBeenCalled();
  });

  it('generates and caches the programme on a cache miss', async () => {
    mockGetCached.mockReturnValue(null);
    const rows = programme();
    mockGenerate.mockResolvedValue(rows);

    await prewarmProgramme(DATE);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockSaveCached).toHaveBeenCalledTimes(1);
    expect(mockSaveCached).toHaveBeenCalledWith(DATE, expect.any(String), rows);
  });

  it('does not cache when generation yields nothing', async () => {
    mockGetCached.mockReturnValue(null);
    mockGenerate.mockResolvedValue(null);

    await prewarmProgramme(DATE);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockSaveCached).not.toHaveBeenCalled();
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it('prunes stale seeded rows against the freshly cached programme', async () => {
    // A session started before the programme regenerated may carry rows seeded
    // from the OLD one (a treadmill on a parkrun day, 29 Aug 2026). After
    // caching, the prune runs with the new rows' names so only untouched rows
    // the new programme no longer contains are dropped.
    mockGetCached.mockReturnValue(null);
    const rows = programme();
    mockGenerate.mockResolvedValue(rows);

    await prewarmProgramme(DATE);

    expect(mockPrune).toHaveBeenCalledTimes(1);
    expect(mockPrune).toHaveBeenCalledWith(
      DATE,
      rows.map(r => r.name)
    );
  });

  it('dedups concurrent prewarms for the same day into one generation', async () => {
    mockGetCached.mockReturnValue(null);
    // A generation that stays pending until we release it, so both callers reach
    // the in-flight guard while the first is still running.
    let release!: (rows: ProgrammeRow[]) => void;
    mockGenerate.mockReturnValue(
      new Promise<ProgrammeRow[]>(resolve => {
        release = resolve;
      })
    );

    const both = Promise.all([prewarmProgramme(DATE), prewarmProgramme(DATE)]);
    // Let both resolve their storage reads and reach kickOffGeneration, where the
    // still-pending generation parks them on the shared in-flight promise.
    await new Promise(resolve => setTimeout(resolve, 0));

    release(programme());
    await both;

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockSaveCached).toHaveBeenCalledTimes(1);
  });
});
