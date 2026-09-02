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

jest.mock('@/lib/storage/routine-overrides', () => ({
  getRoutineOverrides: jest.fn().mockResolvedValue({}),
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
import { getRoutineOverrides } from '@/lib/storage/routine-overrides';
import { getCachedProgramme } from '@/lib/storage/exercise-programmes';
import type { ProgrammeRow } from '@/lib/exercise-programmer';
import { exerciseKey } from '@/lib/exercise-progression';

const mockRoutine = getWeeklyRoutine as jest.Mock;
const mockOverrides = getRoutineOverrides as jest.Mock;
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

// A programme cached BEFORE the one-variant-per-session rule: the model's pick
// "Standing calf raise (step)" plus a second "Standing calf raise (no step)" the
// legs-balance padding appended — with the to-failure finisher on that dropped
// row (as today's 27 Aug cache has). The cached read path re-runs post-processing,
// so it must shed the duplicate variant and re-mark a valid finisher.
function row(name: string, over: Partial<ProgrammeRow> = {}): ProgrammeRow {
  return {
    name,
    key: exerciseKey(name),
    kind: 'core',
    toFailure: false,
    target: { sets: 3, reps: 10, weightKg: 40 },
    rationale: '',
    lastSummary: 'no history',
    ...over,
  };
}

function legsPlan(): ExerciseSession {
  return {
    id: 'legs',
    date: '2026-08-27',
    type: 'gym',
    planned: true,
    completed: false,
    source: 'manual',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    label: 'Legs',
    components: ['Legs'],
  };
}

describe('resolveSessionTargets — a cached programme with two calf-raise variants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 2026-08-27 is a Thursday (dayOfWeek 4).
    mockRoutine.mockResolvedValue([{ dayOfWeek: 4, title: 'Legs', anchors: [], staples: [] }]);
    mockGetCached.mockReturnValue([
      row('Leg press'),
      row('Standing calf raise (step)', { kind: 'rotation' }),
      // The second variant, last and carrying the to-failure marker.
      row('Standing calf raise (no step)', { kind: 'rotation', toFailure: true }),
    ]);
  });

  it('serves only the first variant and still ends with exactly one to-failure row', async () => {
    const resolved = await resolveSessionTargets('2026-08-27', [legsPlan()]);
    expect(resolved.source).toBe('ai');

    // Only the first calf-raise variant survives; the duplicate is dropped.
    const calf = resolved.targets.filter(t => /calf raise/i.test(t.name));
    expect(calf).toHaveLength(1);
    expect(calf[0].name).toBe('Standing calf raise (step)');
    expect(resolved.targets.some(t => t.name === 'Standing calf raise (no step)')).toBe(false);

    // Exactly one to-failure finisher, on the last row — re-marked after the row
    // that carried the marker was dropped.
    const failing = resolved.targets.filter(t => t.toFailure);
    expect(failing).toHaveLength(1);
    expect(failing[0].name).toBe(resolved.targets[resolved.targets.length - 1].name);
  });
});

// A rest override on a date with no plan: the resolver must treat the date as a
// Rest day (from the override) rather than programming its ordinary weekday. With
// no matching plan title, the override is what decides the routine day.
describe('resolveSessionTargets — a rest override on a date with no plan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Wednesday 2026-09-02 is normally a training day (dayOfWeek 3).
    mockRoutine.mockResolvedValue([
      { dayOfWeek: 3, title: 'Pull + Legs', anchors: ['Leg press'], staples: [] },
    ]);
    mockOverrides.mockResolvedValue({ '2026-09-02': { rest: true } });
    mockGetCached.mockReturnValue(null);
  });

  it('resolves the date as Rest, not its weekday training day', async () => {
    const resolved = await resolveSessionTargets('2026-09-02', []);
    expect(resolved.input.plan.routineDay?.rest).toBe(true);
    expect(resolved.input.plan.routineDay?.title).toBe('Rest');
  });

  it('returns an empty rest result — no targets, no fallback list to generate', async () => {
    const resolved = await resolveSessionTargets('2026-09-02', []);
    expect(resolved.source).toBe('rest');
    expect(resolved.targets).toEqual([]);
    expect(resolved.components).toEqual([]);
  });

  it('still resolves normally when a plan sits on the rest date (a moved session)', async () => {
    // A session dropped onto the rest date has a plan of its own, so it is
    // programmed rather than short-circuited to an empty rest result.
    const movedOntoRest: ExerciseSession = {
      id: 'moved',
      date: '2026-09-02',
      type: 'gym',
      planned: true,
      completed: false,
      source: 'manual',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      label: 'Pull + Legs',
      components: ['Pull', 'Legs'],
    };
    const resolved = await resolveSessionTargets('2026-09-02', [movedOntoRest]);
    expect(resolved.source).not.toBe('rest');
    expect(resolved.plan?.id).toBe('moved');
  });
});
