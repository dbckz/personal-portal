/**
 * @jest-environment node
 *
 * The single "which routine day applies on a date" rule: an override beats the
 * weekday, a rest override yields a synthetic Rest day for that date's weekday,
 * and with no override the plain weekday entry is returned.
 */
import { routineDayForDate } from '@/lib/exercise-routine-day';
import type { RoutineOverride, WeeklyRoutineDay } from '@/types/life';

const ROUTINE: WeeklyRoutineDay[] = [
  { dayOfWeek: 3, title: 'Pull + Legs', anchors: ['Leg press'] },
  { dayOfWeek: 4, title: 'Push (shoulders) + Run', anchors: ['Overhead press'] },
  { dayOfWeek: 5, title: 'Rest', anchors: [], rest: true },
];

describe('routineDayForDate', () => {
  it('returns the weekday entry with no override', () => {
    // 2026-09-02 is a Wednesday (dayOfWeek 3).
    const day = routineDayForDate(ROUTINE, {}, '2026-09-02');
    expect(day?.title).toBe('Pull + Legs');
  });

  it('a dayOfWeek override wins over the weekday', () => {
    const overrides: Record<string, RoutineOverride> = { '2026-09-03': { dayOfWeek: 3 } };
    // 2026-09-03 is a Thursday, but the override points at Wednesday's entry.
    const day = routineDayForDate(ROUTINE, overrides, '2026-09-03');
    expect(day?.title).toBe('Pull + Legs');
    expect(day?.dayOfWeek).toBe(3);
  });

  it('a rest override yields a synthetic Rest day for the date weekday', () => {
    const overrides: Record<string, RoutineOverride> = { '2026-09-02': { rest: true } };
    const day = routineDayForDate(ROUTINE, overrides, '2026-09-02');
    expect(day).toEqual({ dayOfWeek: 3, title: 'Rest', anchors: [], rest: true });
  });

  it('is undefined when no routine entry matches the weekday', () => {
    // 2026-09-01 is a Tuesday (dayOfWeek 2), absent from ROUTINE.
    expect(routineDayForDate(ROUTINE, {}, '2026-09-01')).toBeUndefined();
  });
});
