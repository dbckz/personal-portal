/**
 * @jest-environment node
 *
 * Exercise evidence, focused on the peak-metric unit: a "run 10K" goal is judged
 * by the single longest distance in the period, not a tally of sessions.
 */
import { resolveEvidence } from '@/lib/goal-evidence';
import { createSession } from '@/lib/storage/exercise';
import { __resetDbForTests } from '@/lib/storage/db';
import type { Goal } from '@/types/life';

function runGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    sectionId: 'exercise',
    periodKind: 'month',
    periodKey: '2026-08',
    title: 'Run 10K',
    target: { value: 10, unit: 'km' },
    evidence: { kind: 'exercise', unit: 'max-distance-km' },
    checkIns: [],
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('max-distance-km evidence', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('reports the longest single distance in the period, from the session or its exercises', async () => {
    await createSession({ date: '2026-08-03', type: 'run', distanceKm: 5 });
    await createSession({ date: '2026-08-10', type: 'run', distanceKm: 7 });
    // Distance logged on an exercise inside a gym session counts too.
    await createSession({
      date: '2026-08-18',
      type: 'gym',
      exercises: [{ name: 'Treadmill run', distanceKm: 8.2 }],
    });

    const result = await resolveEvidence(runGoal());
    expect(result.actual).toBe(8.2);
    expect(result.label).toMatch(/Longest 8.2 km/);
  });

  it('ignores sessions outside the period', async () => {
    await createSession({ date: '2026-07-31', type: 'run', distanceKm: 12 });
    await createSession({ date: '2026-08-05', type: 'run', distanceKm: 6 });
    expect((await resolveEvidence(runGoal())).actual).toBe(6);
  });

  it('reports no distance rather than zero when nothing qualifies', async () => {
    await createSession({ date: '2026-08-05', type: 'gym', exercises: [{ name: 'Bench', weightKg: 40 }] });
    const result = await resolveEvidence(runGoal());
    expect(result.actual).toBeNull();
    expect(result.label).toMatch(/No distance/);
  });

  it('restricts to a session type when the ref names one', async () => {
    await createSession({ date: '2026-08-05', type: 'run', distanceKm: 6 });
    await createSession({ date: '2026-08-12', type: 'cycle', distanceKm: 20 });
    const result = await resolveEvidence(
      runGoal({ evidence: { kind: 'exercise', ref: 'run', unit: 'max-distance-km' } })
    );
    expect(result.actual).toBe(6);
  });
});

describe('exercise-name matching', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  const runByName = runGoal({ evidence: { kind: 'exercise', ref: 'run', unit: 'max-distance-km' } });

  it("counts a run logged as an exercise inside a session whose type isn't 'run'", async () => {
    // Dave's real shape: an "Outdoor run" exercise in a "strength + cardio" session.
    await createSession({
      date: '2026-08-13',
      type: 'strength + cardio',
      exercises: [{ name: 'Outdoor run', distanceKm: 2 }],
    });
    const result = await resolveEvidence(runByName);
    expect(result.actual).toBe(2);
    expect(result.label).toMatch(/Longest 2 km/);
  });

  it('takes distance only from the matching exercises, not the whole session', async () => {
    // A 28 km walk with no run in it must never count toward a run goal, even
    // though the session as a whole carries the distance.
    await createSession({ date: '2026-08-14', type: 'walk', distanceKm: 28 });
    await createSession({
      date: '2026-08-15',
      type: 'strength + cardio',
      // Session's own distance is large, but only the run exercise should count.
      distanceKm: 15,
      exercises: [{ name: 'Outdoor run', distanceKm: 3 }, { name: 'Bench', weightKg: 40 }],
    });
    const result = await resolveEvidence(runByName);
    expect(result.actual).toBe(3);
  });

  it('sums only the matching exercises for a minutes goal', async () => {
    await createSession({
      date: '2026-08-16',
      type: 'strength + cardio',
      durationMinutes: 90,
      exercises: [
        { name: 'Outdoor run', durationMinutes: 25 },
        { name: 'Squats', durationMinutes: 30 },
      ],
    });
    const result = await resolveEvidence(
      runGoal({
        evidence: { kind: 'exercise', ref: 'run', unit: 'minutes' },
        target: { value: 60, unit: 'min' },
      })
    );
    expect(result.actual).toBe(25);
  });

  it('still matches by session type as well as by exercise name', async () => {
    await createSession({ date: '2026-08-10', type: 'run', distanceKm: 5 });
    await createSession({
      date: '2026-08-17',
      type: 'strength + cardio',
      exercises: [{ name: 'Treadmill run', distanceKm: 6 }],
    });
    const result = await resolveEvidence(runByName);
    // Longest across both matches (the type-run 5 km and the named 6 km).
    expect(result.actual).toBe(6);
  });
});

describe('treadmill duration equivalence', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('credits a duration-only treadmill run at 5 min per km', async () => {
    // Treadmill entries are stored time-only, with no distanceKm: 20 min is a 4 km.
    await createSession({
      date: '2026-08-06',
      type: 'gym',
      exercises: [{ name: 'Treadmill run', durationMinutes: 20 }],
    });
    const result = await resolveEvidence(runGoal());
    expect(result.actual).toBe(4);
  });

  it('credits 50 min on the treadmill as a 10K via a whole-session match', async () => {
    await createSession({ date: '2026-08-07', type: 'run', durationMinutes: 50, exercises: [] });
    // Treadmill exercise inside the session carries the duration; session-level
    // distance is absent, so the equivalence supplies the figure.
    await createSession({
      date: '2026-08-08',
      type: 'run',
      exercises: [{ name: 'Treadmill run', durationMinutes: 50 }],
    });
    const result = await resolveEvidence(
      runGoal({ evidence: { kind: 'exercise', ref: 'run', unit: 'max-distance-km' } })
    );
    expect(result.actual).toBe(10);
  });

  it('uses the real distance, not the equivalence, when a treadmill run logs both', async () => {
    // 20 min would equal 4 km, but a real 8 km distance is present and wins.
    await createSession({
      date: '2026-08-09',
      type: 'gym',
      exercises: [{ name: 'Treadmill run', durationMinutes: 20, distanceKm: 8 }],
    });
    const result = await resolveEvidence(runGoal());
    expect(result.actual).toBe(8);
  });

  it('does not apply the equivalence to a non-treadmill duration-only entry', async () => {
    await createSession({
      date: '2026-08-11',
      type: 'gym',
      exercises: [{ name: 'Outdoor run', durationMinutes: 30 }],
    });
    const result = await resolveEvidence(runGoal());
    expect(result.actual).toBeNull();
    expect(result.label).toMatch(/No distance/);
  });

  it('does not apply the equivalence to a minutes goal', async () => {
    // For a minutes goal the treadmill duration counts as minutes, unchanged —
    // it is not converted into a distance.
    await createSession({
      date: '2026-08-12',
      type: 'strength + cardio',
      exercises: [{ name: 'Treadmill run', durationMinutes: 20 }],
    });
    const result = await resolveEvidence(
      runGoal({
        evidence: { kind: 'exercise', ref: 'run', unit: 'minutes' },
        target: { value: 60, unit: 'min' },
      })
    );
    expect(result.actual).toBe(20);
  });
});

describe('manual override on an auto source', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('reports the higher of the self-report and the auto figure, showing both', async () => {
    await createSession({ date: '2026-08-05', type: 'run', distanceKm: 2 });
    const result = await resolveEvidence(runGoal({ manualValue: 10 }));
    expect(result.actual).toBe(10);
    expect(result.label).toMatch(/Self-reported 10 km/);
    expect(result.label).toMatch(/auto: longest 2 km/);
  });

  it('keeps the auto figure when it exceeds the self-report', async () => {
    await createSession({ date: '2026-08-05', type: 'run', distanceKm: 8 });
    const result = await resolveEvidence(runGoal({ manualValue: 5 }));
    expect(result.actual).toBe(8);
    expect(result.label).toMatch(/Self-reported 5 km/);
  });

  it('uses the self-report outright when nothing was auto-derived', async () => {
    const result = await resolveEvidence(runGoal({ manualValue: 4 }));
    expect(result.actual).toBe(4);
    expect(result.label).toMatch(/Self-reported 4 km/);
    expect(result.label).toMatch(/No distance/);
  });

  it('leaves the auto figure untouched when there is no self-report', async () => {
    await createSession({ date: '2026-08-05', type: 'run', distanceKm: 6 });
    const result = await resolveEvidence(runGoal());
    expect(result.actual).toBe(6);
    expect(result.label).toMatch(/^Longest 6 km/);
  });
});
