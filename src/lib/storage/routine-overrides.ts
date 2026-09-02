// Per-date routine overrides: one-off deviations from the standing weekly routine
// (src/lib/storage/weekly-routine.ts) that outlive a single calendar sync.
//
// Why this exists: the weekly routine is the repeating shape of the week, and the
// materialiser keeps future dates in step with it. But a single week sometimes
// has to diverge — Dave takes an unplanned rest day and shunts that week's plan a
// day later. Simply re-dating the sessions does not hold: the next sync sees the
// vacated weekday as an unoccupied non-rest routine day and CREATES a fresh
// session there, and treats the moved session as belonging to the weekday it now
// lands on. An override records "for THIS date, follow that weekday's routine
// entry" or "for THIS date, rest", so the shifted shape survives every resync
// until the override is cleared or ages out.
//
// Its own `routineOverrides` domain in the user-data store (see ./db and
// ./core — a new domain must be whitelisted there or it is silently dropped),
// read and written directly like the weekly routine.

import { format, parseISO, differenceInCalendarDays } from 'date-fns';

import { readAllDomains, writeAllDomains } from './db';
import type { RoutineOverride } from '@/types/life';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

// Overrides more than this many days in the past are pruned on write: a shifted
// week is a near-term concern, and old entries are dead weight the sync no longer
// consults (it only materialises today forward).
const MAX_AGE_DAYS = 60;

export type RoutineOverrides = Record<string, RoutineOverride>;

// Coerce one stored value to a valid override, or null to drop it. Tolerant so a
// malformed entry can't corrupt the map.
function normaliseOverride(raw: unknown): RoutineOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { dayOfWeek?: unknown; rest?: unknown };
  if (value.rest === true) return { rest: true };
  if (
    typeof value.dayOfWeek === 'number' &&
    Number.isInteger(value.dayOfWeek) &&
    value.dayOfWeek >= 0 &&
    value.dayOfWeek <= 6
  ) {
    return { dayOfWeek: value.dayOfWeek };
  }
  return null;
}

// Read the stored overrides, keeping only well-formed { yyyy-MM-dd -> override }
// entries. A missing/empty domain yields {}.
function readOverrides(): RoutineOverrides {
  const raw = readAllDomains().routineOverrides;
  if (!raw || typeof raw !== 'object') return {};
  const out: RoutineOverrides = {};
  for (const [date, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!DATE_KEY.test(date)) continue;
    const override = normaliseOverride(value);
    if (override) out[date] = override;
  }
  return out;
}

// The current per-date overrides, keyed by yyyy-MM-dd.
export async function getRoutineOverrides(): Promise<RoutineOverrides> {
  return readOverrides();
}

// Set (or, with a null override, clear) the override for one date, then prune
// entries dated more than 60 days before today. Returns the resulting map.
export async function setRoutineOverride(
  date: string,
  override: RoutineOverride | null
): Promise<RoutineOverrides> {
  if (!DATE_KEY.test(date)) throw new Error(`Invalid date: ${date}`);
  if (override !== null) {
    const normalised = normaliseOverride(override);
    if (!normalised) throw new Error('Invalid override: expected { dayOfWeek: 0-6 } or { rest: true }');
    override = normalised;
  }

  const overrides = readOverrides();
  if (override === null) delete overrides[date];
  else overrides[date] = override;

  const today = format(new Date(), 'yyyy-MM-dd');
  const pruned: RoutineOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (differenceInCalendarDays(parseISO(today), parseISO(key)) > MAX_AGE_DAYS) continue;
    pruned[key] = value;
  }

  writeAllDomains({ routineOverrides: pruned });
  return pruned;
}
