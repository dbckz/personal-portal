// The single rule for "which routine day applies on a given date", once per-date
// overrides are taken into account. Everything that maps a date to its routine
// shape — the materialiser, the session-target resolver, the venue plan builder —
// goes through here so the override-beats-weekday rule lives in one place.

import { parseISO } from 'date-fns';

import type { RoutineOverride, WeeklyRoutineDay } from '@/types/life';

// The routine day to apply on `date`. An override for the date wins over the
// weekday:
//   { rest: true }  -> a synthetic Rest day for that date's weekday.
//   { dayOfWeek: n } -> the routine entry for weekday n (the plan was moved here).
// With no override, the routine entry for the date's own weekday. Undefined when
// no routine entry matches (a gap in the routine).
export function routineDayForDate(
  routine: WeeklyRoutineDay[],
  overrides: Record<string, RoutineOverride>,
  date: string
): WeeklyRoutineDay | undefined {
  const weekday = parseISO(date).getDay();
  const override = overrides[date];

  if (override) {
    if ('rest' in override) {
      return { dayOfWeek: weekday, title: 'Rest', anchors: [], rest: true };
    }
    return routine.find(d => d.dayOfWeek === override.dayOfWeek);
  }

  return routine.find(d => d.dayOfWeek === weekday);
}
