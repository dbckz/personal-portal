// Pre-generating the AI session programme off the request path, so the Today
// checklist almost never has to wait on Claude.
//
// The programme is cached per (date, hash), where the hash folds in the plan, the
// routine day and the logged history (see programmeHash). Any change to those —
// a routine edit, a logged (or backdated) entry, a plan session re-asserted from
// the calendar — moves the hash and invalidates the cache, so the next Today open
// would otherwise sit on the fallback for ~2 minutes while generation runs.
//
// The fix: whenever a mutation changes those inputs, fire prewarmProgramme() so
// the new programme is generated and cached BEFORE the page is next opened. It is
// the same background kickoff the /targets route already did on a cache miss,
// lifted here and shared — including the in-flight dedup, so a mutation's prewarm
// and a concurrent page load never spawn two Claude calls for the same plan.

import { format } from 'date-fns';

import { generateProgramme, type ProgrammerInput } from '@/lib/exercise-programmer';
import { saveCachedProgramme } from '@/lib/storage/exercise-programmes';
import { getAllSessions } from '@/lib/storage/exercise';
import { resolveSessionTargets } from '@/lib/exercise-session-targets';

// In-flight generations, keyed by date+hash, so overlapping kickoffs (a page load
// racing a mutation's prewarm, or a client poll firing before the first finished)
// never spawn two Claude calls for the same plan. Per-process — a best-effort
// guard, not a distributed lock. The stored value is the running promise so a
// second caller can await the first rather than start its own.
const inFlight = new Map<string, Promise<void>>();

// Kick off a background generation for an already-resolved (date, hash, input),
// returning the in-flight promise. Fire-and-forget for callers that don't care
// (the /targets route serves the fallback and lets the client poll); awaitable
// for callers (and tests) that do. Deduped by date+hash.
export function kickOffGeneration(
  date: string,
  hash: string,
  input: ProgrammerInput
): Promise<void> {
  const key = `${date}:${hash}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  // Fire-and-forget: the response has already gone; the long-running server
  // finishes this and caches the result for the next fetch.
  const run = generateProgramme(input)
    .then(rows => {
      if (rows) saveCachedProgramme(date, hash, rows);
    })
    .catch(error => {
      console.error('Background exercise programme generation failed:', error);
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, run);
  return run;
}

// Pre-generate and cache the AI programme for a date (default today), if one is
// not already cached for its current inputs. A no-op when the programme is
// already cached (source 'ai') or when there is nothing to program from (a rest
// day / empty vocabulary — input.exercises is empty), so callers can fire it
// unconditionally after any mutation; the hash dedup and the cache hit make it
// cheap when nothing actually changed.
export async function prewarmProgramme(
  date: string = format(new Date(), 'yyyy-MM-dd')
): Promise<void> {
  const sessions = await getAllSessions();
  const resolved = await resolveSessionTargets(date, sessions);
  if (resolved.source === 'ai') return;
  if (resolved.input.exercises.length === 0) return;
  await kickOffGeneration(date, resolved.hash, resolved.input);
}
