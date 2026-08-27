import { computeWellbeingAnalysis } from '@/lib/wellbeing-analysis';
import type { HabitLog, WellbeingDay } from '@/types/wellbeing';

function day(date: string, habits: HabitLog[], notes?: string): WellbeingDay {
  return {
    date,
    habits,
    ...(notes ? { notes } : {}),
    createdAt: `${date}T20:00:00.000Z`,
    updatedAt: `${date}T20:00:00.000Z`,
  };
}

const yes = (habitId: string): HabitLog => ({ habitId, done: true });
const no = (habitId: string, reason: string): HabitLog => ({ habitId, done: false, reason });

function meditate(analysis: ReturnType<typeof computeWellbeingAnalysis>) {
  return analysis.habits.find(h => h.habitId === 'meditate')!;
}

describe('computeWellbeingAnalysis', () => {
  it('rates a habit over the days actually logged, not the whole window', () => {
    const analysis = computeWellbeingAnalysis(
      [
        day('2026-08-03', [yes('meditate')]),
        day('2026-08-04', [no('meditate', 'Overslept')]),
      ],
      '2026-08-01',
      '2026-08-07'
    );

    const habit = meditate(analysis);
    expect(habit.daysLogged).toBe(2);
    expect(habit.daysDone).toBe(1);
    expect(habit.rate).toBe(0.5);
    expect(analysis.daysLogged).toBe(2);
  });

  it('reports a null rate for a habit that has never been logged', () => {
    const analysis = computeWellbeingAnalysis(
      [day('2026-08-03', [yes('meditate')])],
      '2026-08-01',
      '2026-08-07'
    );

    const pages = analysis.habits.find(h => h.habitId === 'morning-pages')!;
    expect(pages.rate).toBeNull();
    expect(pages.daysLogged).toBe(0);
  });

  it('counts a current streak back from the end of the window', () => {
    const analysis = computeWellbeingAnalysis(
      [
        day('2026-08-05', [yes('meditate')]),
        day('2026-08-06', [yes('meditate')]),
        day('2026-08-07', [yes('meditate')]),
      ],
      '2026-08-01',
      '2026-08-07'
    );

    expect(meditate(analysis).currentStreak).toBe(3);
  });

  it('lets the final day be unanswered without breaking the streak', () => {
    // The analysis is routinely looked at before the day's review has happened.
    const analysis = computeWellbeingAnalysis(
      [day('2026-08-05', [yes('meditate')]), day('2026-08-06', [yes('meditate')])],
      '2026-08-01',
      '2026-08-07'
    );

    expect(meditate(analysis).currentStreak).toBe(2);
  });

  it('breaks the streak on an unlogged day that is not the final one', () => {
    const analysis = computeWellbeingAnalysis(
      [
        day('2026-08-04', [yes('meditate')]),
        // 5 Aug missing entirely — nothing is known about it.
        day('2026-08-06', [yes('meditate')]),
        day('2026-08-07', [yes('meditate')]),
      ],
      '2026-08-01',
      '2026-08-07'
    );

    expect(meditate(analysis).currentStreak).toBe(2);
  });

  it('breaks the streak on a day answered no', () => {
    const analysis = computeWellbeingAnalysis(
      [
        day('2026-08-05', [yes('meditate')]),
        day('2026-08-06', [no('meditate', 'Travelling')]),
        day('2026-08-07', [yes('meditate')]),
      ],
      '2026-08-01',
      '2026-08-07'
    );

    expect(meditate(analysis).currentStreak).toBe(1);
  });

  it('tracks the longest streak across the window', () => {
    const analysis = computeWellbeingAnalysis(
      [
        day('2026-08-01', [yes('meditate')]),
        day('2026-08-02', [yes('meditate')]),
        day('2026-08-03', [yes('meditate')]),
        day('2026-08-04', [no('meditate', 'Ill')]),
        day('2026-08-05', [yes('meditate')]),
      ],
      '2026-08-01',
      '2026-08-07'
    );

    expect(meditate(analysis).longestStreak).toBe(3);
  });

  it('groups skip reasons case- and punctuation-insensitively, keeping the latest wording', () => {
    const analysis = computeWellbeingAnalysis(
      [
        day('2026-08-01', [no('meditate', 'too tired')]),
        day('2026-08-02', [no('meditate', 'Too tired.')]),
        day('2026-08-03', [no('meditate', 'Out all evening')]),
      ],
      '2026-08-01',
      '2026-08-07'
    );

    const reasons = meditate(analysis).reasons;
    expect(reasons[0]).toEqual({ reason: 'Too tired.', count: 2, lastOn: '2026-08-02' });
    expect(reasons[1].count).toBe(1);
  });

  it('buckets days into ISO weeks with logged and done counts', () => {
    const analysis = computeWellbeingAnalysis(
      [
        // Mon 3 Aug 2026 and Tue 4 Aug are the same week; Mon 10 Aug the next.
        day('2026-08-03', [yes('meditate')]),
        day('2026-08-04', [no('meditate', 'Overslept')]),
        day('2026-08-10', [yes('meditate')]),
      ],
      '2026-08-01',
      '2026-08-14'
    );

    expect(meditate(analysis).byWeek).toEqual([
      { weekStart: '2026-08-03', done: 1, logged: 2 },
      { weekStart: '2026-08-10', done: 1, logged: 1 },
    ]);
  });

  it('returns the most recent notes newest first', () => {
    const analysis = computeWellbeingAnalysis(
      [
        day('2026-08-03', [yes('meditate')], 'Slept badly'),
        day('2026-08-04', [yes('meditate')]),
        day('2026-08-05', [yes('meditate')], 'Good day'),
      ],
      '2026-08-01',
      '2026-08-07'
    );

    expect(analysis.recentNotes).toEqual([
      { date: '2026-08-05', note: 'Good day' },
      { date: '2026-08-03', note: 'Slept badly' },
    ]);
  });

  it('flags a repeated obstacle once it has blocked the habit three times', () => {
    const analysis = computeWellbeingAnalysis(
      [
        day('2026-08-01', [no('meditate', 'Overslept')]),
        day('2026-08-02', [no('meditate', 'overslept')]),
        day('2026-08-03', [no('meditate', 'Overslept')]),
      ],
      '2026-08-01',
      '2026-08-03'
    );

    expect(analysis.suggestions.some(s => s.includes('Overslept') && s.includes('3 times'))).toBe(
      true
    );
  });

  it('says so plainly when nothing has been logged', () => {
    const analysis = computeWellbeingAnalysis([], '2026-08-01', '2026-08-07');
    expect(analysis.daysLogged).toBe(0);
    expect(analysis.suggestions).toEqual([
      'No days logged yet — the daily review is where these get recorded.',
    ]);
  });

  it('ignores days outside the window', () => {
    const analysis = computeWellbeingAnalysis(
      [day('2026-07-20', [yes('meditate')]), day('2026-08-03', [yes('meditate')])],
      '2026-08-01',
      '2026-08-07'
    );

    expect(analysis.daysLogged).toBe(1);
    expect(meditate(analysis).daysLogged).toBe(1);
  });
});

describe('computeWellbeingAnalysis — habit daily series', () => {
  it('holds consistency at 1 when every day is done', () => {
    const analysis = computeWellbeingAnalysis(
      [
        day('2026-08-01', [yes('meditate')]),
        day('2026-08-02', [yes('meditate')]),
        day('2026-08-03', [yes('meditate')]),
        day('2026-08-04', [yes('meditate')]),
        day('2026-08-05', [yes('meditate')]),
        day('2026-08-06', [yes('meditate')]),
      ],
      '2026-08-01',
      '2026-08-07' // to = today, excluded
    );

    const daily = meditate(analysis).daily;
    // First logged day (1 Aug) to yesterday (6 Aug) inclusive.
    expect(daily.map(d => d.date)).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
    ]);
    expect(daily.every(d => d.done && d.logged)).toBe(true);
    expect(daily.every(d => d.consistency === 1 && d.rolling7 === 1)).toBe(true);
  });

  it('dips far deeper for three consecutive misses than one isolated miss', () => {
    // Same length, same number of done days at the edges — only the run differs.
    const isolated = computeWellbeingAnalysis(
      [
        day('2026-08-01', [yes('meditate')]),
        day('2026-08-02', [yes('meditate')]),
        day('2026-08-03', [no('meditate', 'Ill')]),
        day('2026-08-04', [yes('meditate')]),
        day('2026-08-05', [yes('meditate')]),
        day('2026-08-06', [yes('meditate')]),
      ],
      '2026-08-01',
      '2026-08-07'
    );
    const consecutive = computeWellbeingAnalysis(
      [
        day('2026-08-01', [yes('meditate')]),
        day('2026-08-02', [yes('meditate')]),
        day('2026-08-03', [no('meditate', 'Ill')]),
        day('2026-08-04', [no('meditate', 'Ill')]),
        day('2026-08-05', [no('meditate', 'Ill')]),
        day('2026-08-06', [yes('meditate')]),
      ],
      '2026-08-01',
      '2026-08-07'
    );

    const lowestIsolated = Math.min(...isolated.habits.find(h => h.habitId === 'meditate')!.daily.map(d => d.consistency));
    const lowestConsecutive = Math.min(...consecutive.habits.find(h => h.habitId === 'meditate')!.daily.map(d => d.consistency));

    // The isolated miss only ever pulls the score to 0.75; three in a row
    // compound well below half of that dip.
    expect(lowestIsolated).toBeCloseTo(0.75, 5);
    expect(lowestConsecutive).toBeLessThan(0.45);
    expect(lowestIsolated - lowestConsecutive).toBeGreaterThan(0.3);
  });

  it('counts an unlogged past day as a miss', () => {
    const analysis = computeWellbeingAnalysis(
      [
        day('2026-08-01', [yes('meditate')]),
        // 2–4 Aug never logged, all in the past.
        day('2026-08-05', [yes('meditate')]),
      ],
      '2026-08-01',
      '2026-08-06'
    );

    const daily = meditate(analysis).daily;
    expect(daily.map(d => d.date)).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
    ]);
    // The unlogged days are misses, and marked as not logged.
    expect(daily[1]).toMatchObject({ date: '2026-08-02', done: false, logged: false });
    expect(daily[3]).toMatchObject({ date: '2026-08-04', done: false, logged: false });
    // Three consecutive misses pull consistency well down before it recovers.
    expect(daily[3].consistency).toBeLessThan(0.5);
  });

  it('excludes today from the daily series', () => {
    const analysis = computeWellbeingAnalysis(
      [
        day('2026-08-01', [yes('meditate')]),
        day('2026-08-05', [yes('meditate')]), // this is `to` — today
      ],
      '2026-08-01',
      '2026-08-05'
    );

    const daily = meditate(analysis).daily;
    expect(daily.some(d => d.date === '2026-08-05')).toBe(false);
    expect(daily[daily.length - 1].date).toBe('2026-08-04');
  });

  it('returns no daily points when a habit was only logged today', () => {
    const analysis = computeWellbeingAnalysis(
      [day('2026-08-05', [yes('meditate')])],
      '2026-08-01',
      '2026-08-05'
    );

    expect(meditate(analysis).daily).toEqual([]);
  });

  it('returns an empty daily series when nothing has been logged', () => {
    const analysis = computeWellbeingAnalysis([], '2026-08-01', '2026-08-07');
    expect(meditate(analysis).daily).toEqual([]);
  });
});
