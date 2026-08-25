// Deriving a target for a swapped-in exercise from its OWN logged history, so a
// per-entry swap inherits sensible numbers instead of keeping the ones that
// belonged to the exercise it replaced.
//
// Swapping "Cable crossover" for "Converging shoulder press" must not leave the
// crossover's sets/reps/weight on the entry: the shoulder press has its own
// history and its own recommendation. This reuses the SAME machinery the
// start/targets routes seed from — buildProgressions with `before` (so today's
// own session doesn't count as history), buildTarget, describeVolumeLoad — so a
// swapped-in target reads identically to a planned one.

import { buildProgressions, exerciseKey } from './exercise-progression';
import { buildTarget, describeVolumeLoad } from './exercise-targets';
import type { ExerciseSession } from '@/types/life';

// The entry target-fields a swap derivation asserts. Every field is present so a
// swap OVERWRITES the old exercise's numbers wholesale: a field the substitute's
// target doesn't carry is nulled (an explicit clear the storage layer removes),
// never left showing the value the previous exercise had.
export interface SwapTargetPatch {
  sets: number | null;
  reps: number | null;
  holdSeconds: number | null;
  perSide: true | null;
  weightKg: number | null;
  durationMinutes: number | null;
  distanceKm: number | null;
  targetText: string | null;
}

function clear<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

// Derive a target for `name` from its history in `sessions`, dated strictly
// before the session being edited. Returns null when the substitute has no
// history yet — the caller then leaves the target blank (a free entry).
export function deriveSwapTargetPatch(
  sessions: ExerciseSession[],
  session: ExerciseSession,
  name: string
): SwapTargetPatch | null {
  const key = exerciseKey(name);
  if (!key) return null;

  const progression = buildProgressions(sessions, { before: session.date }).find(
    p => p.key === key
  );
  if (!progression?.latest) return null;

  const target = buildTarget(progression);
  return {
    sets: clear(target.sets),
    reps: clear(target.reps),
    holdSeconds: clear(target.holdSeconds),
    perSide: target.perSide ? true : null,
    weightKg: clear(target.weightKg),
    durationMinutes: clear(target.durationMinutes),
    distanceKm: clear(target.distanceKm),
    targetText: describeVolumeLoad(target) || null,
  };
}
