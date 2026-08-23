/**
 * @jest-environment node
 *
 * resolveSessionTargets resolves "what to aim for" for a date. The routine day it
 * uses normally comes from the weekday, but a planned session MOVED onto another
 * day must be programmed as its OWN routine day, not as the weekday it landed on.
 *
 * Friday 21 Aug 2026 is a Rest day in the routine. When Dave drags Thursday's
 * "Push (shoulders) + Run" onto that Friday, the resolver must pick the Thursday
 * routine day (with its anchors) — not the Friday Rest day, which would program
 * nothing. getWeeklyRoutine and the programme cache are mocked so the resolver
 * runs pure.
 */
import type { ExerciseSession, WeeklyRoutineDay } from '@/types/life';

jest.mock('@/lib/storage/weekly-routine', () => ({
  getWeeklyRoutine: jest.fn(),
}));

jest.mock('@/lib/storage/exercise-programmes', () => ({
  getCachedProgramme: jest.fn(),
  saveCachedProgramme: jest.fn(),
}));

jest.mock('@/lib/storage/goals', () => ({
  queryGoals: jest.fn().mockResolvedValue([]),
}));

import { resolveSessionTargets } from '@/lib/exercise-session-targets';
import { getWeeklyRoutine } from '@/lib/storage/weekly-routine';
import { getCachedProgramme } from '@/lib/storage/exercise-programmes';

const mockRoutine = getWeeklyRoutine as jest.Mock;
const mockGetCached = getCachedProgramme as jest.Mock;

// A minimal weekly routine: Friday (5) is Rest, Thursday (4) is the push+run day
// with an anchor. The anchor is what tells us the Thursday day was chosen.
function routine(): WeeklyRoutineDay[] {
  return [
    { dayOfWeek: 5, title: 'Rest', anchors: [], staples: [], rest: true },
    {
      dayOfWeek: 4,
      title: 'Push (shoulders) + Run',
      anchors: ['Overhead press'],
      staples: ['Lateral raise'],
    },
  ];
}

// A planned session dropped onto Friday 21 Aug 2026 (a Rest weekday) carrying the
// label of the Thursday push+run routine day.
function movedPlan(): ExerciseSession {
  return {
    id: 'moved',
    date: '2026-08-21',
    type: 'gym',
    planned: true,
    completed: false,
    source: 'manual',
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    label: 'Push (shoulders) + Run',
    components: ['Push (shoulders)', 'Run'],
  };
}

describe('resolveSessionTargets — a plan moved onto another weekday', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRoutine.mockResolvedValue(routine());
    mockGetCached.mockReturnValue(null);
  });

  it('programs a moved plan as its matching routine day, not the weekday it landed on', async () => {
    const resolved = await resolveSessionTargets('2026-08-21', [movedPlan()]);

    // The Thursday routine day, chosen by the plan's label — NOT the Friday Rest.
    expect(resolved.input.plan.routineDay?.title).toBe('Push (shoulders) + Run');
    expect(resolved.input.plan.routineDay?.rest).toBeUndefined();
    expect(resolved.input.plan.routineDay?.anchors).toContain('Overhead press');

    // The anchor makes the programmer input non-empty even with no history.
    expect(resolved.input.exercises.length).toBeGreaterThan(0);
  });
});

// A Saturday "Parkrun + core" with no run ever logged: the deterministic
// fallback (a cache miss) builds targets only from logged exercises, so without a
// guarantee it would show no run at all. The resolver must still surface a
// tickable, cardio-classified parkrun row leading the session.
function parkrunPlan(): ExerciseSession {
  return {
    id: 'parkrun',
    date: '2026-08-22',
    type: 'gym',
    planned: true,
    completed: false,
    source: 'manual',
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    label: 'Parkrun + core',
    components: ['Parkrun', 'core'],
  };
}

describe('resolveSessionTargets — a planned run with no run history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRoutine.mockResolvedValue([
      { dayOfWeek: 6, title: 'Parkrun + core', anchors: [], staples: [] },
    ]);
    mockGetCached.mockReturnValue(null);
  });

  it('guarantees a cardio row on the deterministic fallback', async () => {
    const resolved = await resolveSessionTargets('2026-08-22', [parkrunPlan()]);
    expect(resolved.source).toBe('fallback');
    const cardio = resolved.targets.filter(t => t.kind === 'cardio');
    expect(cardio).toHaveLength(1);
    expect(cardio[0].name).toBe('Parkrun');
    // Cardio leads the session.
    expect(resolved.targets[0].name).toBe('Parkrun');
  });
});
