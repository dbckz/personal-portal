import {
  MUSCLES,
  EXERCISE_MUSCLES,
  exerciseMuscles,
  aggregateMuscleLoad,
  coolestMuscles,
  isCardioExercise,
  type MuscleProgrammeDay,
} from '@/lib/exercise-muscles';
import { EXERCISE_NAME_ALIASES } from '@/lib/exercise-names';
import type { ExerciseSession } from '@/types/life';

const MUSCLE_IDS = new Set(MUSCLES.map(m => m.id));

function session(partial: Partial<ExerciseSession> & { date: string }): ExerciseSession {
  return {
    id: partial.id ?? `s-${partial.date}`,
    type: 'gym',
    planned: false,
    completed: false,
    exercises: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...partial,
  };
}

const NOW = new Date('2026-08-25T12:00:00.000Z');

describe('exerciseMuscles mapping', () => {
  it('maps every canonical alias value to at least one real muscle', () => {
    for (const canonical of new Set(Object.values(EXERCISE_NAME_ALIASES))) {
      const roles = exerciseMuscles(canonical);
      expect(roles.length).toBeGreaterThan(0);
      for (const r of roles) expect(MUSCLE_IDS.has(r.muscleId)).toBe(true);
    }
  });

  it('references only real muscle ids in the explicit map', () => {
    for (const roles of Object.values(EXERCISE_MUSCLES)) {
      for (const r of roles) expect(MUSCLE_IDS.has(r.muscleId)).toBe(true);
    }
  });

  it('normalises the raw name before mapping (dumbbell -> DB)', () => {
    expect(exerciseMuscles('incline dumbbell press')).toEqual(exerciseMuscles('Incline DB press'));
    expect(exerciseMuscles('Incline DB press').some(r => r.muscleId === 'chest' && r.role === 'primary')).toBe(true);
  });

  it('falls back on keyword for an unmapped name', () => {
    // Not in EXERCISE_MUSCLES, but "curl" should land on biceps via fallback.
    expect(EXERCISE_MUSCLES['Preacher curl']).toBeUndefined();
    expect(exerciseMuscles('Preacher curl')).toEqual([{ muscleId: 'biceps', role: 'primary' }]);
    // "Barbell bench" -> push fallback -> chest primary.
    expect(exerciseMuscles('Barbell bench').some(r => r.muscleId === 'chest')).toBe(true);
  });

  it('maps strength rows to the back, not cardio (explicit map beats cardio check)', () => {
    for (const name of ['Seated cable row', 'Cable row', 'Chest-supported DB row']) {
      expect(isCardioExercise(name)).toBe(false);
      const roles = exerciseMuscles(name);
      const primaries = roles.filter(r => r.role === 'primary').map(r => r.muscleId);
      expect(primaries).toContain('upper-back');
      expect(primaries).toContain('lats');
      expect(primaries).not.toContain('quads');
    }
  });

  it('still treats a genuine rowing/erg machine as cardio', () => {
    expect(isCardioExercise('Rowing machine')).toBe(true);
    expect(isCardioExercise('Erg')).toBe(true);
    expect(exerciseMuscles('Rowing machine').some(r => r.muscleId === 'quads' && r.role === 'primary')).toBe(true);
  });

  it('treats cardio names as legs-dominant and tagged cardio', () => {
    expect(isCardioExercise('Outdoor run')).toBe(true);
    expect(isCardioExercise('Football')).toBe(true);
    const roles = exerciseMuscles('Outdoor run');
    expect(roles.some(r => r.muscleId === 'quads' && r.role === 'primary')).toBe(true);
    expect(roles.some(r => r.muscleId === 'calves' && r.role === 'secondary')).toBe(true);
  });

  it('returns nothing for an unrecognised, non-cardio name', () => {
    expect(exerciseMuscles('Underwater basket weaving')).toEqual([]);
  });
});

describe('aggregateMuscleLoad', () => {
  function loadFor(loads: ReturnType<typeof aggregateMuscleLoad>, id: string) {
    const l = loads.find(m => m.muscleId === id);
    if (!l) throw new Error(`no load for ${id}`);
    return l;
  }

  it('weights primary 1.0 and secondary 0.5 times sets', () => {
    const sessions = [
      session({
        date: '2026-08-20',
        completed: true,
        exercises: [
          { id: 'e1', name: 'Incline DB press', sets: 4, done: true }, // chest primary, front-delts+triceps 0.5
        ],
      }),
    ];
    const loads = aggregateMuscleLoad(sessions, [], 28, NOW);
    expect(loadFor(loads, 'chest').doneWeightedSets).toBe(4); // 1.0 * 4
    expect(loadFor(loads, 'triceps').doneWeightedSets).toBe(2); // 0.5 * 4
    expect(loadFor(loads, 'front-delts').doneWeightedSets).toBe(2);
  });

  it('defaults a row with no sets to one unit', () => {
    const sessions = [
      session({
        date: '2026-08-20',
        completed: true,
        exercises: [{ id: 'e1', name: 'Outdoor run', done: true }],
      }),
    ];
    const loads = aggregateMuscleLoad(sessions, [], 28, NOW);
    expect(loadFor(loads, 'quads').doneWeightedSets).toBe(1); // primary * 1
    expect(loadFor(loads, 'calves').doneWeightedSets).toBe(0.5);
  });

  it('excludes not-performed rows and out-of-window sessions', () => {
    const sessions = [
      session({
        date: '2026-08-20',
        completed: true,
        exercises: [{ id: 'e1', name: 'Pec fly', sets: 3, done: false }],
      }),
      session({
        date: '2026-06-01', // before the 28-day window
        completed: true,
        exercises: [{ id: 'e2', name: 'Pec fly', sets: 3, done: true }],
      }),
    ];
    const loads = aggregateMuscleLoad(sessions, [], 28, NOW);
    expect(loadFor(loads, 'chest').doneWeightedSets).toBe(0);
  });

  it('counts planned session rows as planned, not done', () => {
    const sessions = [
      session({
        date: '2026-08-26',
        planned: true,
        completed: false,
        exercises: [{ id: 'e1', name: 'Leg press', sets: 3 }],
      }),
    ];
    const loads = aggregateMuscleLoad(sessions, [], 28, NOW);
    expect(loadFor(loads, 'quads').plannedWeightedSets).toBe(3);
    expect(loadFor(loads, 'quads').doneWeightedSets).toBe(0);
  });

  it('uses programme rows only for dates with no session rows (no double count)', () => {
    const sessions = [
      session({
        date: '2026-08-20',
        completed: true,
        exercises: [{ id: 'e1', name: 'Leg press', sets: 3, done: true }],
      }),
    ];
    const programmes: MuscleProgrammeDay[] = [
      // Same date as a session with rows -> ignored.
      { date: '2026-08-20', rows: [{ name: 'Leg press', sets: 5 }] },
      // A bare date with no session -> counts as planned.
      { date: '2026-08-22', rows: [{ name: 'Leg extension', sets: 4 }] },
    ];
    const loads = aggregateMuscleLoad(sessions, programmes, 28, NOW);
    // Only the session's done work, plus the lone programme day's planned work.
    expect(loadFor(loads, 'quads').doneWeightedSets).toBe(3);
    expect(loadFor(loads, 'quads').plannedWeightedSets).toBe(4);
  });

  it('marks a muscle worked only through cardio as cardioOnly', () => {
    const sessions = [
      session({
        date: '2026-08-24',
        completed: true,
        exercises: [{ id: 'e1', name: 'Outdoor run', done: true }],
      }),
    ];
    const loads = aggregateMuscleLoad(sessions, [], 28, NOW);
    expect(loadFor(loads, 'calves').cardioOnly).toBe(true);
    expect(loadFor(loads, 'calves').assessment).toMatch(/cardio/i);
  });
});

describe('assessment tiers', () => {
  function assessmentFor(exerciseName: string, sets: number, windowDays: number, id: string): string {
    const sessions = [
      session({
        date: '2026-08-24',
        completed: true,
        exercises: [{ id: 'e1', name: exerciseName, sets, done: true }],
      }),
    ];
    const loads = aggregateMuscleLoad(sessions, [], windowDays, NOW);
    return loads.find(m => m.muscleId === id)!.assessment;
  }

  it('flags zero logged work with a suggestion', () => {
    const loads = aggregateMuscleLoad([], [], 28, NOW);
    const chest = loads.find(m => m.muscleId === 'chest')!;
    expect(chest.tier).toBe('none');
    expect(chest.assessment).toMatch(/No logged work/i);
  });

  it('calls light volume light', () => {
    // 2 sets of chest over 28 days -> 0.5 sets/wk -> light.
    expect(assessmentFor('Pec fly', 2, 28, 'chest')).toMatch(/Light/i);
  });

  it('calls mid volume solid', () => {
    // 16 sets over 28 days -> 4 sets/wk -> solid.
    expect(assessmentFor('Pec fly', 16, 28, 'chest')).toMatch(/Solid/i);
  });

  it('calls heavy volume high', () => {
    // 88 sets over 28 days -> 22 sets/wk -> high.
    expect(assessmentFor('Pec fly', 88, 28, 'chest')).toMatch(/High/i);
  });
});

describe('coolestMuscles', () => {
  it('returns the least-worked muscles first', () => {
    const sessions = [
      session({
        date: '2026-08-24',
        completed: true,
        exercises: [{ id: 'e1', name: 'Pec fly', sets: 20, done: true }],
      }),
    ];
    const loads = aggregateMuscleLoad(sessions, [], 28, NOW);
    const cool = coolestMuscles(loads, 3);
    expect(cool).toHaveLength(3);
    // Chest was hammered, so it must not be among the coolest.
    expect(cool.some(l => l.muscleId === 'chest')).toBe(false);
    expect(cool[0].heat).toBeLessThanOrEqual(cool[1].heat);
  });
});
