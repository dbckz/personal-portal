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

// The name the legacy single-routine `weeklyRoutine` row is migrated into the
// library under, so the original 6-day split survives as a named, switchable
// entry once the library exists.
export const LEGACY_ROUTINE_NAME = 'Split (6-day)';

// Normalise and dedupe-check an incoming set of days. Shared by every write path
// (the active routine, a named library entry). Throws on a non-array or a weekday
// that lands twice — the routine is one entry per weekday.
function normaliseRoutineDays(days: unknown): WeeklyRoutineDay[] {
  if (!Array.isArray(days)) {
    throw new Error('weeklyRoutine must be an array of days');
  }
  const normalised = days.map(normaliseDay).filter((d): d is WeeklyRoutineDay => d !== null);
  const seen = new Set<number>();
  for (const day of normalised) {
    if (seen.has(day.dayOfWeek)) {
      throw new Error(`Duplicate day ${day.dayOfWeek} in routine`);
    }
    seen.add(day.dayOfWeek);
  }
  return normalised;
}

// The legacy single-routine row, or null when it is empty/absent. This is the
// migration SOURCE: once the library exists it is only mirrored to (never the
// resolution path) so nothing that still reads the raw `weeklyRoutine` row
// regresses.
function readLegacyRow(): WeeklyRoutineDay[] | null {
  const raw = readAllDomains().weeklyRoutine;
  if (!Array.isArray(raw)) return null;
  const days = raw.map(normaliseDay).filter((d): d is WeeklyRoutineDay => d !== null);
  return days.length ? days : null;
}

// The routine library, keyed by name. Malformed entries (non-array, or a name
// that normalises to nothing) are dropped rather than corrupting the store.
function readLibrary(): Record<string, WeeklyRoutineDay[]> {
  const raw = readAllDomains().weeklyRoutineLibrary;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, WeeklyRoutineDay[]> = {};
  for (const [name, days] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name !== 'string' || !name.trim() || !Array.isArray(days)) continue;
    const norm = days.map(normaliseDay).filter((d): d is WeeklyRoutineDay => d !== null);
    if (norm.length) out[name] = norm;
  }
  return out;
}

function readActiveName(): string {
  const raw = readAllDomains().activeRoutineName;
  return typeof raw === 'string' ? raw.trim() : '';
}

// Resolve the active routine, migrating on first use. Semantics:
//   - When the active name names a library entry, that entry is the routine
//     (the fast path — no writes).
//   - Otherwise the library is bootstrapped: an empty library is seeded from the
//     legacy `weeklyRoutine` row (or, when even that is empty, from SEED_ROUTINE,
//     which is also written back to the legacy row to preserve the old
//     seed-on-empty behaviour) under LEGACY_ROUTINE_NAME, and the active name is
//     set to a valid entry (LEGACY_ROUTINE_NAME when present, else the first).
// The legacy row is left in place as a migration source; it is only ever mirrored
// to by a save/activate of the legacy-derived entry, never read for resolution
// once the library exists.
function ensureMigrated(): {
  name: string;
  library: Record<string, WeeklyRoutineDay[]>;
  days: WeeklyRoutineDay[];
} {
  let library = readLibrary();
  let active = readActiveName();
  if (active && library[active]) return { name: active, library, days: library[active] };

  const patch: Record<string, unknown> = {};
  if (Object.keys(library).length === 0) {
    let legacy = readLegacyRow();
    if (!legacy) {
      legacy = SEED_ROUTINE.map(d => ({ ...d }));
      patch.weeklyRoutine = legacy; // preserve the original seed-on-empty behaviour
    }
    library = { [LEGACY_ROUTINE_NAME]: legacy };
    patch.weeklyRoutineLibrary = library;
  }
  active = library[LEGACY_ROUTINE_NAME] ? LEGACY_ROUTINE_NAME : Object.keys(library)[0];
  patch.activeRoutineName = active;
  writeAllDomains(patch);
  return { name: active, library, days: library[active] };
}

// The full seven-day routine, Mon→Sun: the ACTIVE library entry, resolved (and
// migrated on first use) by ensureMigrated. No caller signature changes — this
// still returns the days to build sessions from.
export async function getWeeklyRoutine(): Promise<WeeklyRoutineDay[]> {
  const { days } = ensureMigrated();
  return [...days].sort(byDisplayOrder);
}

// Replace the ACTIVE routine. The client edits and saves the seven days as a set,
// so a wholesale replace (validated per day) is the honest operation. When the
// active entry is the legacy-derived one, the legacy `weeklyRoutine` row is
// mirrored too so nothing that still reads it regresses.
export async function saveWeeklyRoutine(days: unknown): Promise<WeeklyRoutineDay[]> {
  const normalised = normaliseRoutineDays(days);
  const { name, library } = ensureMigrated();
  const patch: Record<string, unknown> = {
    weeklyRoutineLibrary: { ...library, [name]: normalised },
  };
  if (name === LEGACY_ROUTINE_NAME) patch.weeklyRoutine = normalised;
  writeAllDomains(patch);
  return [...normalised].sort(byDisplayOrder);
}

// The names in the library, and the active name. Migrates on first use so the
// list is never empty.
export async function listRoutines(): Promise<{ names: string[]; active: string }> {
  const { name, library } = ensureMigrated();
  return { names: Object.keys(library), active: name };
}

export async function getActiveRoutineName(): Promise<string> {
  return ensureMigrated().name;
}

// One named routine's days (sorted), or null when no entry has that name.
export async function getRoutine(name: string): Promise<WeeklyRoutineDay[] | null> {
  const { library } = ensureMigrated();
  const days = library[name];
  return days ? [...days].sort(byDisplayOrder) : null;
}

// Create or replace a NAMED routine (not necessarily the active one), so a
// non-active routine can be edited or a new one duplicated in. Mirrors the legacy
// row only when writing the legacy-derived entry.
export async function saveRoutine(name: string, days: unknown): Promise<WeeklyRoutineDay[]> {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new Error('Routine name is required');
  const normalised = normaliseRoutineDays(days);
  const { library } = ensureMigrated();
  const patch: Record<string, unknown> = {
    weeklyRoutineLibrary: { ...library, [trimmed]: normalised },
  };
  if (trimmed === LEGACY_ROUTINE_NAME) patch.weeklyRoutine = normalised;
  writeAllDomains(patch);
  return [...normalised].sort(byDisplayOrder);
}

// Delete a named routine. Refuses to delete the active one (there must always be
// a routine to resolve) and refuses an unknown name.
export async function deleteRoutine(name: string): Promise<void> {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const { name: active, library } = ensureMigrated();
  if (!library[trimmed]) throw new Error(`Unknown routine: ${trimmed}`);
  if (trimmed === active) throw new Error('Cannot delete the active routine');
  const next = { ...library };
  delete next[trimmed];
  writeAllDomains({ weeklyRoutineLibrary: next });
}

// Switch the active routine. Refuses an unknown name. Returns the now-active
// routine's days (sorted); mirrors the legacy row when the legacy-derived entry
// is activated, so the raw `weeklyRoutine` row tracks the active split.
export async function setActiveRoutine(name: string): Promise<WeeklyRoutineDay[]> {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const { library } = ensureMigrated();
  const days = library[trimmed];
  if (!days) throw new Error(`Unknown routine: ${trimmed}`);
  const patch: Record<string, unknown> = { activeRoutineName: trimmed };
  if (trimmed === LEGACY_ROUTINE_NAME) patch.weeklyRoutine = days;
  writeAllDomains(patch);
  return [...days].sort(byDisplayOrder);
}
