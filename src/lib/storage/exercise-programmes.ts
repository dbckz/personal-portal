// Cache for AI-generated session programmes, one entry per date.
//
// Its own `exerciseProgrammes` domain, read and written through the db layer
// directly (like projectSummaries): getUserData() rebuilds a whitelisted
// UserData object and would drop this one, silently emptying the cache and
// re-running Claude on every load.
//
// The cache is keyed by date and guarded by a hash of the plan and the history
// the model saw (see programmeHash). Serving only on a hash match means the
// programme is reused all day but regenerated the moment the plan or the logged
// history changes. Nothing here needs backing up — it regenerates from the log.

import { readAllDomains, writeAllDomains } from './db';
import type { ProgrammeRow } from '../exercise-programmer';

export interface CachedProgramme {
  hash: string;
  rows: ProgrammeRow[];
  generatedAt: string;
}

type ProgrammeCache = Record<string, CachedProgramme>;

function readCache(): ProgrammeCache {
  const raw = readAllDomains().exerciseProgrammes;
  return raw && typeof raw === 'object' ? (raw as ProgrammeCache) : {};
}

// The cached rows for a date, but only when the hash still matches — a stale
// plan or newer history returns null so the caller regenerates.
export function getCachedProgramme(date: string, hash: string): ProgrammeRow[] | null {
  const entry = readCache()[date];
  return entry && entry.hash === hash ? entry.rows : null;
}

export function saveCachedProgramme(date: string, hash: string, rows: ProgrammeRow[]): void {
  const cache = readCache();
  cache[date] = { hash, rows, generatedAt: new Date().toISOString() };
  writeAllDomains({ exerciseProgrammes: cache });
}

// Every cached programme whose date falls in the inclusive [from, to] window,
// hash IGNORED. The muscle heatmap uses these as the planned volume for days
// with no session rows; a stale hash only means the plan has since moved on, not
// that the rows are worthless for a rough "what was planned" read.
export function getProgrammesInRange(
  from: string,
  to: string
): Array<{ date: string; rows: ProgrammeRow[] }> {
  const cache = readCache();
  return Object.entries(cache)
    .filter(([date]) => date >= from && date <= to)
    .map(([date, entry]) => ({ date, rows: entry.rows }));
}
