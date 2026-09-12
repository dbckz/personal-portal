/**
 * The 75 Hard rules engine: which rules a day requires (walk drops out on
 * Sundays), a day's pass/miss/pending status against "today", and the two
 * failure conditions — at most 1 miss in any rolling 7-day window, and at most
 * 5 misses in total.
 */
import {
  CHALLENGE_LENGTH,
  DEFAULT_START_DATE,
  challengeDates,
  dayNumberFor,
  dayStatusFor,
  evaluateAttempt,
  isDayComplete,
  isWalkRequired,
  requiredRulesFor,
} from '@/lib/challenge75';
import type { Challenge75Attempt, Challenge75DayTicks } from '@/types/life';

const START = DEFAULT_START_DATE; // 2026-09-14, a Monday

// The dates of the attempt starting on START, day 1 first.
const DATES = challengeDates(START);
// The date of a given 1-based challenge day.
const day = (n: number): string => DATES[n - 1];

// A day that meets every required rule for its date (walk included unless it's
// a Sunday, where it isn't required).
function passTicks(date: string): Challenge75DayTicks {
  const ticks: Challenge75DayTicks = {};
  for (const rule of requiredRulesFor(date)) ticks[rule] = true;
  return ticks;
}

// Build an attempt whose days 1..through are all passes, except the given day
// numbers, which are left blank (misses once they're in the past).
function attemptWithMisses(missDayNumbers: number[], through: number): Challenge75Attempt {
  const misses = new Set(missDayNumbers);
  const days: Record<string, Challenge75DayTicks> = {};
  for (let n = 1; n <= through; n++) {
    if (!misses.has(n)) days[day(n)] = passTicks(day(n));
  }
  return { startDate: START, days };
}

describe('challenge dates', () => {
  it('spans 75 days from Monday 14 Sep 2026 to Friday 27 Nov 2026', () => {
    expect(DATES).toHaveLength(CHALLENGE_LENGTH);
    expect(DATES[0]).toBe('2026-09-14');
    expect(DATES[CHALLENGE_LENGTH - 1]).toBe('2026-11-27');
  });

  it('maps dates to 1-based day numbers, null outside the window', () => {
    expect(dayNumberFor(START, '2026-09-14')).toBe(1);
    expect(dayNumberFor(START, '2026-11-27')).toBe(75);
    expect(dayNumberFor(START, '2026-09-13')).toBeNull();
    expect(dayNumberFor(START, '2026-11-28')).toBeNull();
  });
});

describe('required rules', () => {
  it('requires the walk Monday–Saturday', () => {
    expect(isWalkRequired('2026-09-14')).toBe(true); // Monday
    expect(isWalkRequired('2026-09-19')).toBe(true); // Saturday
    expect(requiredRulesFor('2026-09-14')).toEqual(['exercise', 'walk', 'water', 'read', 'photo']);
  });

  it('drops the walk on Sundays', () => {
    expect(isWalkRequired('2026-09-20')).toBe(false); // Sunday
    expect(requiredRulesFor('2026-09-20')).toEqual(['exercise', 'water', 'read', 'photo']);
  });
});

describe('day completeness', () => {
  it('is complete only when every required box is ticked', () => {
    expect(isDayComplete('2026-09-14', { exercise: true, walk: true, water: true, read: true, photo: true })).toBe(true);
    expect(isDayComplete('2026-09-14', { exercise: true, walk: true, water: true, read: true })).toBe(false);
  });

  it('does not require the walk on a Sunday', () => {
    // No walk ticked, but it's Sunday — still complete.
    expect(isDayComplete('2026-09-20', { exercise: true, water: true, read: true, photo: true })).toBe(true);
    // A ticked walk on Sunday is harmless.
    expect(isDayComplete('2026-09-20', { exercise: true, walk: true, water: true, read: true, photo: true })).toBe(true);
  });
});

describe('day status against today', () => {
  it('is pending for a future day', () => {
    expect(dayStatusFor(day(10), {}, day(5))).toBe('pending');
    expect(dayStatusFor(day(10), passTicks(day(10)), day(5))).toBe('pending');
  });

  it('is pending for today until complete, then pass', () => {
    expect(dayStatusFor(day(5), {}, day(5))).toBe('pending');
    expect(dayStatusFor(day(5), passTicks(day(5)), day(5))).toBe('pass');
  });

  it('is a miss for an incomplete past day, a pass for a complete one', () => {
    expect(dayStatusFor(day(3), {}, day(5))).toBe('miss');
    expect(dayStatusFor(day(3), passTicks(day(3)), day(5))).toBe('pass');
  });
});

describe('evaluateAttempt — counts and header', () => {
  it('reports day 0 before the challenge starts', () => {
    const summary = evaluateAttempt({ startDate: START, days: {} }, '2026-09-10');
    expect(summary.currentDay).toBe(0);
    expect(summary.daysRemaining).toBe(75);
    expect(summary.state).toBe('active');
  });

  it('counts passes, misses and misses remaining', () => {
    // Days 1–5 in the past; day 3 missed, rest passed. Today is day 6.
    const attempt = attemptWithMisses([3], 5);
    const summary = evaluateAttempt(attempt, day(6));
    expect(summary.currentDay).toBe(6);
    expect(summary.passes).toBe(4);
    expect(summary.misses).toBe(1);
    expect(summary.missesRemaining).toBe(4);
    expect(summary.state).toBe('active');
  });

  it('keeps today pending until its boxes are all ticked', () => {
    const attempt = attemptWithMisses([], 5); // days 1–5 passed
    const summary = evaluateAttempt(attempt, day(5));
    const today = summary.days.find(d => d.date === day(5))!;
    // Day 5 is today and fully ticked -> pass; day 6 onwards pending.
    expect(today.status).toBe('pass');
    expect(summary.days.find(d => d.date === day(6))!.status).toBe('pending');
  });
});

describe('evaluateAttempt — rolling window', () => {
  it('fails when two misses fall inside a 7-day window', () => {
    // Days 3 and 5 missed (2 within 7), rest of days 1–10 passed. Today day 11.
    const attempt = attemptWithMisses([3, 5], 10);
    const summary = evaluateAttempt(attempt, day(11));
    expect(summary.state).toBe('failed');
    expect(summary.failReason).toBe('rolling');
  });

  it('survives isolated single misses more than 7 days apart', () => {
    const attempt = attemptWithMisses([1, 9], 12);
    const summary = evaluateAttempt(attempt, day(13));
    expect(summary.state).toBe('active');
    expect(summary.misses).toBe(2);
  });

  it('reports the current rolling window as "N of last M"', () => {
    const attempt = attemptWithMisses([], 3); // 3 clean days
    const summary = evaluateAttempt(attempt, day(3));
    expect(summary.rolling.label).toBe('3 of last 3');
    expect(summary.rolling.ok).toBe(true);
  });
});

describe('evaluateAttempt — total miss cap', () => {
  it('fails on the sixth miss even when they never cluster', () => {
    // Six misses spaced 8 days apart: no 7-day window holds two, so only the
    // cap can catch it.
    const missDays = [1, 9, 17, 25, 33, 41];
    const attempt = attemptWithMisses(missDays, 42);
    const summary = evaluateAttempt(attempt, day(43));
    expect(summary.misses).toBe(6);
    expect(summary.state).toBe('failed');
    expect(summary.failReason).toBe('cap');
  });

  it('stays active at exactly five spaced-out misses', () => {
    const missDays = [1, 9, 17, 25, 33];
    const attempt = attemptWithMisses(missDays, 34);
    const summary = evaluateAttempt(attempt, day(35));
    expect(summary.misses).toBe(5);
    expect(summary.missesRemaining).toBe(0);
    expect(summary.state).toBe('active');
  });
});

describe('evaluateAttempt — completion and archived outcomes', () => {
  it('completes once past the final day with no breach', () => {
    const attempt = attemptWithMisses([], 75); // every day passed
    const summary = evaluateAttempt(attempt, '2026-11-28');
    expect(summary.state).toBe('complete');
    expect(summary.currentDay).toBe(75);
    expect(summary.daysRemaining).toBe(0);
  });

  it('honours a recorded outcome on an archived attempt', () => {
    const failed = evaluateAttempt(
      { startDate: START, days: {}, endedAt: '2026-09-20T00:00:00Z', outcome: 'failed' },
      day(3)
    );
    expect(failed.state).toBe('failed');
    expect(failed.failReason).toBeUndefined();

    const complete = evaluateAttempt(
      { startDate: START, days: {}, endedAt: '2026-11-28T00:00:00Z', outcome: 'complete' },
      day(3)
    );
    expect(complete.state).toBe('complete');
  });
});
