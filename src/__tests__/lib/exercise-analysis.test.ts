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

  it('excludes only explicitly not-done exercises, counting legacy undefined as done', () => {
    const analysis = analyseExercise(
      [
        // A gym-flow session: two of three exercises ticked off. The third was
        // seeded from a target and never ticked (done:false), so it doesn't
        // count.
        session({
          date: '2026-07-06',
          type: 'gym',
          exercises: [
            { id: 'a', name: 'Squat', done: true },
            { id: 'b', name: 'Bench', done: true },
            { id: 'c', name: 'Row', done: false },
          ],
        }),
        // Legacy / manually-logged entries carry no done flag: they are a record
        // of what was actually done, so they DO count (only an explicit
        // done:false is a skip).
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

    // 2 ticked + 2 legacy-undefined = 4; the single done:false Row is excluded.
    expect(analysis.totalExercisesDone).toBe(4);
    const gym = analysis.byType.find(t => t.type === 'gym');
    expect(gym?.exercisesDone).toBe(4);
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

describe('per-week adherence', () => {
  it('buckets session adherence by the week a plan falls in', () => {
    const analysis = analyseExercise(
      [
        // Week of 6 Jul: two planned, both met (one by date, one linked).
        session({ date: '2026-07-06', planned: true, completed: false }),
        session({ date: '2026-07-08', planned: true, completed: false }),
        session({ date: '2026-07-06' }),
        session({ date: '2026-07-08' }),
        // Week of 13 Jul: two planned, one met.
        session({ date: '2026-07-13', planned: true, completed: false }),
        session({ date: '2026-07-15', planned: true, completed: false }),
        session({ date: '2026-07-13' }),
      ],
      '2026-07-01',
      '2026-07-28'
    );

    const first = analysis.byWeek.find(w => w.weekStart === '2026-07-06');
    const second = analysis.byWeek.find(w => w.weekStart === '2026-07-13');
    expect(first?.sessionAdherence).toBe(1);
    expect(second?.sessionAdherence).toBe(0.5);
  });

  it('reads session adherence as null for a week with nothing planned', () => {
    const analysis = analyseExercise(
      [session({ date: '2026-07-06' })],
      '2026-07-01',
      '2026-07-12'
    );
    const week = analysis.byWeek.find(w => w.weekStart === '2026-07-06');
    expect(week?.sessionAdherence).toBeNull();
  });

  it('reads exercise adherence off a seeded, partly-ticked session (5 of 8)', () => {
    const analysis = analyseExercise(
      [
        session({
          date: '2026-07-06',
          type: 'gym',
          exercises: [
            { id: 'a', name: 'Squat', done: true },
            { id: 'b', name: 'Bench', done: true },
            { id: 'c', name: 'Row', done: true },
            { id: 'd', name: 'Press', done: true },
            { id: 'e', name: 'Curl', done: true },
            { id: 'f', name: 'Fly', done: false },
            { id: 'g', name: 'Raise', done: false },
            { id: 'h', name: 'Plank', done: false },
          ],
        }),
      ],
      '2026-07-01',
      '2026-07-12'
    );
    const week = analysis.byWeek.find(w => w.weekStart === '2026-07-06');
    expect(week?.exerciseAdherence).toBeCloseTo(5 / 8);
    expect(analysis.exerciseAdherence).toBeCloseTo(5 / 8);
  });

  it('reads exercise adherence as 100% for manual/freeform entries (undefined done)', () => {
    const analysis = analyseExercise(
      [
        session({
          date: '2026-07-06',
          type: 'gym',
          exercises: [
            { id: 'a', name: 'Deadlift' },
            { id: 'b', name: 'Pull-up' },
          ],
        }),
      ],
      '2026-07-01',
      '2026-07-12'
    );
    const week = analysis.byWeek.find(w => w.weekStart === '2026-07-06');
    expect(week?.exerciseAdherence).toBe(1);
  });

  it('reads exercise adherence as 100% for a week whose sessions carry no exercises', () => {
    // A completed session with no exercise list (a run, a walk) skipped
    // nothing, so the week rates 100% rather than leaving a gap.
    const analysis = analyseExercise(
      [session({ date: '2026-07-06', type: 'run' })],
      '2026-07-01',
      '2026-07-12'
    );
    const week = analysis.byWeek.find(w => w.weekStart === '2026-07-06');
    expect(week?.exerciseAdherence).toBe(1);
    expect(analysis.exerciseAdherence).toBe(1);
  });

  it('reads exercise adherence as null for a week with no completed sessions', () => {
    const analysis = analyseExercise([], '2026-07-01', '2026-07-12');
    expect(analysis.exerciseAdherence).toBeNull();
  });

  it('keeps the aggregate and weekly figures consistent', () => {
    const sessions = [
      // Week of 6 Jul: 2 planned, 1 met; gym session 2 of 3 done.
      session({ date: '2026-07-06', planned: true, completed: false }),
      session({ date: '2026-07-08', planned: true, completed: false }),
      session({
        date: '2026-07-06',
        type: 'gym',
        exercises: [
          { id: 'a', name: 'Squat', done: true },
          { id: 'b', name: 'Bench', done: true },
          { id: 'c', name: 'Row', done: false },
        ],
      }),
      // Week of 13 Jul: 1 planned, met; gym session 3 of 4 done.
      session({ date: '2026-07-13', planned: true, completed: false }),
      session({
        date: '2026-07-13',
        type: 'gym',
        exercises: [
          { id: 'd', name: 'Deadlift', done: true },
          { id: 'e', name: 'Pull-up', done: true },
          { id: 'f', name: 'Dip', done: true },
          { id: 'g', name: 'Curl', done: false },
        ],
      }),
    ];
    const analysis = analyseExercise(sessions, '2026-07-01', '2026-07-28');

    // Aggregate plan adherence: 2 met days of 3 planned days.
    expect(analysis.planAdherence).toBeCloseTo(2 / 3);
    // Aggregate exercise adherence: 5 performed of 7 entries.
    expect(analysis.exerciseAdherence).toBeCloseTo(5 / 7);

    // The weekly figures recombine (day-weighted) to the aggregate: the two
    // series are computed from the same helpers, so they can't drift apart.
    const plannedDays = analysis.byWeek.reduce((sum, w) => sum + w.plannedSessions, 0);
    const metDays = analysis.byWeek.reduce(
      (sum, w) => sum + (w.sessionAdherence ?? 0) * w.plannedSessions,
      0
    );
    expect(metDays / plannedDays).toBeCloseTo(analysis.planAdherence!);
  });
});
