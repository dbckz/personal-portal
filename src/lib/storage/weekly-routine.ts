// Dave's standing weekly training routine: the repeating shape of the week that
// the plan is built from. Stored (not derived live) because it OUTLIVES the
// authored calendar plan — once that plan ends (3 Sep 2026) the portal will
// DEFINE future sessions from this routine, so it must be durable, editable data.
//
// Its own `weeklyRoutine` domain in the user-data store (see ./db), read and
// written directly rather than through getUserData(): a dedicated module owns
// the seed-on-empty and the per-day validation, which don't belong in the
// whole-object rebuild.
//
// SEED_ROUTINE is a deliberate captured default, not a placeholder: on the first
// read of an empty store it is written in so the tab has real content, then
// becomes ordinary editable data. Its exercise names are verbatim from the
// calendar prescriptions so they match the plan today and the logged history
// later. Captured 9 Aug 2026 from the verified calendar routine.

import { readAllDomains, writeAllDomains } from './db';
import type { WeeklyRoutineDay } from '@/types/life';

// dayOfWeek follows JS Date.getDay(): 0 = Sunday … 6 = Saturday.
const SEED_ROUTINE: WeeklyRoutineDay[] = [
  {
    dayOfWeek: 1, // Monday
    title: 'Push (chest & arms)',
    note: 'Push A.',
    anchors: ['Incline dumbbell press', 'Flat dumbbell press'],
  },
  {
    dayOfWeek: 2, // Tuesday
    title: 'Run + core',
    note: 'Easy run, distance ramping weekly.',
    anchors: [],
    staples: ['Dead bug', 'Side plank', 'Pallof press'],
  },
  {
    dayOfWeek: 3, // Wednesday
    title: 'Pull + Legs',
    note: 'Pull A + legs.',
    anchors: [
      'Wide-grip lat pulldown',
      'Chest-supported dumbbell row',
      'Leg press',
      'Seated leg curl',
    ],
  },
  {
    dayOfWeek: 4, // Thursday
    title: 'Push (shoulders) + Run',
    note: 'Push B.',
    anchors: ['Seated dumbbell shoulder press', 'Incline dumbbell press'],
  },
  {
    dayOfWeek: 5, // Friday
    title: 'Rest',
    anchors: [],
    rest: true,
  },
  {
    dayOfWeek: 6, // Saturday
    title: 'Parkrun + core',
    note: 'Parkrun 5 km.',
    anchors: [],
    staples: ['Dead bug', 'Side plank', 'Pallof press'],
  },
  {
    dayOfWeek: 0, // Sunday
    title: 'Pull (back & arms) + legs',
    note: 'Pull B + legs.',
    anchors: ['Seated cable row', 'Neutral-grip lat pulldown', 'Leg press', 'Seated leg curl'],
  },
];

// Monday-first display order over JS getDay() values: Mon…Sun.
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function byDisplayOrder(a: WeeklyRoutineDay, b: WeeklyRoutineDay): number {
  return DISPLAY_ORDER.indexOf(a.dayOfWeek) - DISPLAY_ORDER.indexOf(b.dayOfWeek);
}

// Clean one incoming day: coerce the shape, trim names, drop blanks. A rest day
// keeps no exercises. Kept tolerant so a malformed field can't corrupt the store.
function normaliseDay(raw: unknown): WeeklyRoutineDay | null {
  if (!raw || typeof raw !== 'object') return null;
  const day = raw as Partial<WeeklyRoutineDay>;
  if (typeof day.dayOfWeek !== 'number' || day.dayOfWeek < 0 || day.dayOfWeek > 6) return null;

  const names = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
      : [];

  const rest = day.rest === true;
  const title = typeof day.title === 'string' ? day.title.trim() : '';
  const note = typeof day.note === 'string' ? day.note.trim() : '';
  const anchors = rest ? [] : names(day.anchors);
  const staples = rest ? [] : names(day.staples);

  return {
    dayOfWeek: day.dayOfWeek,
    title,
    ...(note ? { note } : {}),
    anchors,
    ...(staples.length ? { staples } : {}),
    ...(rest ? { rest: true } : {}),
  };
}

function readRoutine(): WeeklyRoutineDay[] | null {
  const raw = readAllDomains().weeklyRoutine;
  if (!Array.isArray(raw)) return null;
  const days = raw.map(normaliseDay).filter((d): d is WeeklyRoutineDay => d !== null);
  return days.length ? days : null;
}

// The full seven-day routine, Mon→Sun. Seeds the captured default on first read
// of an empty store, persisting it so subsequent reads and edits build on it.
export async function getWeeklyRoutine(): Promise<WeeklyRoutineDay[]> {
  const existing = readRoutine();
  if (existing) return [...existing].sort(byDisplayOrder);

  const seeded = SEED_ROUTINE.map(d => ({ ...d }));
  writeAllDomains({ weeklyRoutine: seeded });
  return [...seeded].sort(byDisplayOrder);
}

// Replace the whole routine. The client edits and saves the seven days as a set,
// so a wholesale replace (validated per day) is the honest operation — there is
// no partial-day merge to reason about.
export async function saveWeeklyRoutine(days: unknown): Promise<WeeklyRoutineDay[]> {
  if (!Array.isArray(days)) {
    throw new Error('weeklyRoutine must be an array of days');
  }
  const normalised = days.map(normaliseDay).filter((d): d is WeeklyRoutineDay => d !== null);

  // Guard against a day landing twice — the routine is one entry per weekday.
  const seen = new Set<number>();
  for (const day of normalised) {
    if (seen.has(day.dayOfWeek)) {
      throw new Error(`Duplicate day ${day.dayOfWeek} in routine`);
    }
    seen.add(day.dayOfWeek);
  }

  writeAllDomains({ weeklyRoutine: normalised });
  return [...normalised].sort(byDisplayOrder);
}
