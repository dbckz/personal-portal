/**
 * @jest-environment node
 *
 * The exercise analysis and its rule-based suggestions. The rules only fire on
 * conditions the data actually supports — an empty suggestions list is a valid
 * "nothing to say", not a bug.
 */
import { analyseExercise } from '@/lib/exercise-analysis';
import type { ExerciseSession } from '@/types/life';

let counter = 0;
function session(overrides: Partial<ExerciseSession> & { date: string }): ExerciseSession {
  counter += 1;
  return {
    id: `s${counter}`,
    type: 'run',
    durationMinutes: 45,
    planned: false,
    completed: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('analyseExercise', () => {
  it('reports an empty window without dividing by zero', () => {
    const analysis = analyseExercise([], '2026-07-01', '2026-07-28');
    expect(analysis.totalSessions).toBe(0);
    expect(analysis.sessionsPerWeek).toBe(0);
    expect(analysis.planAdherence).toBeNull();
    expect(analysis.currentStreakWeeks).toBe(0);
    expect(analysis.suggestions).toHaveLength(1);
    expect(analysis.suggestions[0]).toMatch(/Nothing logged/);
  });

  it('totals only completed sessions inside the window', () => {
    const analysis = analyseExercise(
      [
        session({ date: '2026-07-06', durationMinutes: 60, distanceKm: 10 }),
        session({ date: '2026-07-08', durationMinutes: 30 }),
        // Planned but not done — counts toward adherence, not totals.
        session({ date: '2026-07-09', planned: true, completed: false }),
        // Outside the window.
        session({ date: '2026-06-01', durationMinutes: 90 }),
      ],
      '2026-07-01',
      '2026-07-28'
    );

    expect(analysis.totalSessions).toBe(2);
    expect(analysis.totalDistanceKm).toBe(10);
    expect(analysis.planAdherence).toBe(0);
  });

  it('counts only exercises ticked done', () => {
    const analysis = analyseExercise(
      [
        // A gym-flow session: two of three exercises ticked off.
        session({
          date: '2026-07-06',
          type: 'gym',
          exercises: [
            { id: 'a', name: 'Squat', done: true },
            { id: 'b', name: 'Bench', done: true },
            { id: 'c', name: 'Row', done: false },
          ],
        }),
        // Entries with no done flag don't count. Sheet imports are backfilled to
        // done:true, so anything still unticked is genuinely not done.
        session({
          date: '2026-07-08',
          type: 'gym',
          exercises: [
            { id: 'd', name: 'Deadlift' },
            { id: 'e', name: 'Pull-up' },
          ],
        }),
      ],
      '2026-07-01',
      '2026-07-28'
    );

    expect(analysis.totalExercisesDone).toBe(2);
    const gym = analysis.byType.find(t => t.type === 'gym');
    expect(gym?.exercisesDone).toBe(2);
  });

  it('folds entry-level distance into the totals when the session has none', () => {
    const analysis = analyseExercise(
      [
        // A gym session whose only distance is on a treadmill entry, not the
        // session — this used to be invisible to the distance total.
        session({
          date: '2026-07-06',
          type: 'gym',
          distanceKm: undefined,
          exercises: [
            { id: 'a', name: 'Treadmill run', distanceKm: 3, done: true },
            { id: 'b', name: 'Bench', done: true },
          ],
        }),
      ],
      '2026-07-01',
      '2026-07-28'
    );
    expect(analysis.totalDistanceKm).toBe(3);
    expect(analysis.byType.find(t => t.type === 'gym')?.distanceKm).toBe(3);
  });

  it('does not double-count when distance is logged at both levels', () => {
    const analysis = analyseExercise(
      [
        // Session records 5 km overall; one entry restates 3 km of it. The larger
        // (session) figure is taken, not the sum.
        session({
          date: '2026-07-06',
          type: 'run',
          distanceKm: 5,
          exercises: [{ id: 'a', name: 'Treadmill run', distanceKm: 3, done: true }],
        }),
      ],
      '2026-07-01',
      '2026-07-28'
    );
    expect(analysis.totalDistanceKm).toBe(5);
  });

  it('measures adherence by date, since plans and logs are separate records', () => {
    const analysis = analyseExercise(
      [
        // Four planned days (from calendar events)…
        session({ date: '2026-07-06', planned: true, completed: false }),
        session({ date: '2026-07-07', planned: true, completed: false }),
        session({ date: '2026-07-08', planned: true, completed: false }),
        session({ date: '2026-07-09', planned: true, completed: false }),
        // …two of which have a logged session against them.
        session({ date: '2026-07-06' }),
        session({ date: '2026-07-07' }),
      ],
      '2026-07-01',
      '2026-07-28'
    );
    expect(analysis.planAdherence).toBe(0.5);
    expect(analysis.suggestions.some(s => /50% of planned sessions/.test(s))).toBe(true);
  });

  it('counts a planned day once however many sessions are logged on it', () => {
    const analysis = analyseExercise(
      [
        session({ date: '2026-07-06', planned: true, completed: false }),
        session({ date: '2026-07-06', type: 'run' }),
        session({ date: '2026-07-06', type: 'strength' }),
      ],
      '2026-07-01',
      '2026-07-28'
    );
    expect(analysis.planAdherence).toBe(1);
  });

  it('groups by type, busiest first', () => {
    const analysis = analyseExercise(
      [
        session({ date: '2026-07-06', type: 'run' }),
        session({ date: '2026-07-07', type: 'gym' }),
        session({ date: '2026-07-08', type: 'gym' }),
      ],
      '2026-07-01',
      '2026-07-28'
    );
    expect(analysis.byType.map(t => t.type)).toEqual(['gym', 'run']);
    expect(analysis.byType[0].sessions).toBe(2);
  });

  it('counts a streak back from the final week, allowing the current week grace', () => {
    const analysis = analyseExercise(
      [
        session({ date: '2026-07-06' }), // w/c 6 Jul
        session({ date: '2026-07-14' }), // w/c 13 Jul
        session({ date: '2026-07-21' }), // w/c 20 Jul
      ],
      '2026-07-01',
      // The final week (w/c 27 Jul) has nothing yet — that shouldn't break it.
      '2026-07-29'
    );
    expect(analysis.currentStreakWeeks).toBe(3);
  });

  it('breaks a streak on a genuinely empty intervening week', () => {
    const analysis = analyseExercise(
      [session({ date: '2026-07-06' }), session({ date: '2026-07-21' })],
      '2026-07-01',
      '2026-07-26'
    );
    // w/c 13 Jul is empty, so only the most recent week counts.
    expect(analysis.currentStreakWeeks).toBe(1);
  });

  it('flags a single-type log and a hard-session-heavy block', () => {
    const analysis = analyseExercise(
      [
        session({ date: '2026-07-06', intensity: 'hard' }),
        session({ date: '2026-07-08', intensity: 'hard' }),
        session({ date: '2026-07-10', intensity: 'easy' }),
      ],
      '2026-07-01',
      '2026-07-12'
    );
    expect(analysis.suggestions.some(s => /"run"/.test(s))).toBe(true);
    expect(analysis.suggestions.some(s => /marked hard/.test(s))).toBe(true);
  });

  it('stays quiet about intensity when none was recorded', () => {
    const analysis = analyseExercise(
      [session({ date: '2026-07-06' }), session({ date: '2026-07-08' })],
      '2026-07-01',
      '2026-07-12'
    );
    expect(analysis.suggestions.some(s => /marked hard/.test(s))).toBe(false);
  });
});

describe('adherence with an explicit plan link', () => {
  it('counts a session linked to its plan, whatever date it carries', () => {
    const plan = session({ date: '2026-07-06', planned: true, completed: false });
    const analysis = analyseExercise(
      [
        plan,
        // Logged the morning after, but explicitly against that plan.
        { ...session({ date: '2026-07-07' }), plannedSessionId: plan.id },
      ],
      '2026-07-01',
      '2026-07-28'
    );
    expect(analysis.planAdherence).toBe(1);
  });

  it('still matches on date for imported history that was never linked', () => {
    const analysis = analyseExercise(
      [
        session({ date: '2026-07-06', planned: true, completed: false }),
        session({ date: '2026-07-06' }),
        session({ date: '2026-07-08', planned: true, completed: false }),
      ],
      '2026-07-01',
      '2026-07-28'
    );
    expect(analysis.planAdherence).toBe(0.5);
  });
});
