/**
 * When the month-end / quarter-end reflection nudge fires. It waits for the
 * period to actually end, for there to have been goals to reflect on, and stays
 * quiet once the reflection is done or has already been nudged — at most one per
 * period.
 */
import {
  reflectionNudgeContent,
  selectReflectionNudge,
  type ReflectionNudgeInput,
} from '@/lib/reflection-nudge';

// A working weekday evening: Wednesday 2026-08-05 at 18:00, nudging about the
// just-ended month (July 2026).
const WORKING_EVENING = new Date(2026, 7, 5, 18, 0);
const WORKING_AFTERNOON = new Date(2026, 7, 5, 15, 0);
const SATURDAY_EVENING = new Date(2026, 7, 1, 18, 0);

// Defaults to "July has ended, one goal was set, not yet reflected or nudged".
const input = (over: Partial<ReflectionNudgeInput> = {}): ReflectionNudgeInput => ({
  periodKind: 'month',
  periodKey: '2026-07',
  periodOver: true,
  hasGoals: true,
  reflectionDone: false,
  now: WORKING_EVENING,
  isWorkingDay: true,
  ...over,
});

describe('selectReflectionNudge', () => {
  it('fires once the period has ended, on a working evening, with goals unreflected', () => {
    expect(selectReflectionNudge(input())).toBe(true);
  });

  it('stays quiet mid-period, before the period has ended', () => {
    expect(selectReflectionNudge(input({ periodOver: false }))).toBe(false);
  });

  it('stays quiet when the period had no goals to reflect on', () => {
    expect(selectReflectionNudge(input({ hasGoals: false }))).toBe(false);
  });

  it('is suppressed once the reflection has been done', () => {
    expect(selectReflectionNudge(input({ reflectionDone: true }))).toBe(false);
  });

  it('is suppressed once it has already nudged for this period', () => {
    expect(selectReflectionNudge(input({ lastNudgedPeriod: '2026-07' }))).toBe(false);
    // A different period's marker does not suppress this one.
    expect(selectReflectionNudge(input({ lastNudgedPeriod: '2026-06' }))).toBe(true);
  });

  it('stays quiet before the evening hour', () => {
    expect(selectReflectionNudge(input({ now: WORKING_AFTERNOON }))).toBe(false);
  });

  it('never fires on a non-working day', () => {
    expect(
      selectReflectionNudge(input({ now: SATURDAY_EVENING, isWorkingDay: false }))
    ).toBe(false);
  });

  it('works the same for a just-ended quarter', () => {
    expect(selectReflectionNudge(input({ periodKind: 'quarter', periodKey: '2026-Q2' }))).toBe(true);
    expect(
      selectReflectionNudge({
        ...input({ periodKind: 'quarter', periodKey: '2026-Q2' }),
        reflectionDone: true,
      })
    ).toBe(false);
  });
});

describe('reflectionNudgeContent', () => {
  it('names the ended month and reads as a reflection prompt', () => {
    const { title, body } = reflectionNudgeContent('month', '2026-07');
    expect(title).toMatch(/monthly reflection/i);
    expect(body).toContain('July 2026');
  });

  it('distinguishes a quarter from a month', () => {
    const { title, body } = reflectionNudgeContent('quarter', '2026-Q2');
    expect(title).toMatch(/quarterly reflection/i);
    expect(body).toContain('Q2 2026');
  });
});
