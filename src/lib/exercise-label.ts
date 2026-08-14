// Deriving a completed session's TITLE from what was actually done.
//
// A planned session carries a label and components straight off the calendar
// ("Parkrun + core", ["Parkrun", "core"]). When it is logged, the record used
// to keep that planned wording verbatim — so a day where the outdoor Parkrun was
// swapped for a treadmill run still read "Parkrun + core" in the history, not
// the truth. This turns the planned parts plus the logged exercises into the
// title of what was ACTUALLY done.
//
// The rules, and the bias, are deliberately conservative — a wrong rename is
// worse than a missed one:
//   - A cardio component that was SUBSTITUTED (the checklist records the swap on
//     the entry) takes the substitute's name: "Parkrun" → "Treadmill run". A
//     same-kind run done as planned keeps its wording, target annotations and
//     all.
//   - A component whose exercises were all skipped (none ticked done) drops out.
//   - A strength block that happened keeps its planned name even when individual
//     lifts inside it were swapped — a swapped bench press doesn't rename "Push".
//   - Anything that can't be mapped confidently keeps the planned name.
//   - Nothing diverged → the label is returned unchanged.

import type { ExerciseEntry } from '@/types/life';
import { isCardioName } from './exercise-parse';
import { classifyExercise, componentGroups } from './exercise-targets';

export interface DerivedSessionLabel {
  components: string[];
  label: string;
}

// Given the plan's components/label and the exercises actually logged, the
// components/label that describe what was done. Pure and I/O-free; the storage
// layer decides when to apply it.
export function deriveCompletedLabel(
  plannedComponents: string[],
  plannedLabel: string | undefined,
  exercises: ExerciseEntry[]
): DerivedSessionLabel {
  const unchanged: DerivedSessionLabel = {
    components: plannedComponents,
    label: plannedLabel ?? plannedComponents.join(' + '),
  };

  // Only what was ticked off counts: a planned row left unticked is treated as
  // not attempted. With nothing ticked the session hasn't diverged from (or even
  // started against) the plan, so the planned label stands.
  const done = exercises.filter(e => e.done);
  if (done.length === 0) return unchanged;

  const derived = plannedComponents
    .map(component => resolveComponent(component, done))
    .filter((name): name is string => name !== null);

  // Never blank the title: if every planned part appears to have dropped (e.g. a
  // session logged entirely as off-plan extras), keep the plan's own label.
  if (derived.length === 0) return unchanged;

  const changed =
    derived.length !== plannedComponents.length ||
    derived.some((name, i) => name !== plannedComponents[i]);
  return changed ? { components: derived, label: derived.join(' + ') } : unchanged;
}

// One planned component's fate against what was done: its own name if the work
// happened, the substitute's name if a cardio piece was swapped for it, or null
// if it was skipped entirely.
function resolveComponent(component: string, done: ExerciseEntry[]): string | null {
  if (isCardioName(component)) {
    const cardio = done.find(e => isCardioName(e.name));
    if (!cardio) return null; // the planned cardio wasn't done
    // A recorded swap is the reliable signal that a different piece was done in
    // its place; a same-kind run (an outdoor run logged for a planned run)
    // carries no substitutedFor and keeps the planned wording.
    return cardio.substitutedFor ? cardio.name : component;
  }

  const groups = componentGroups(component);
  // Unrecognised component words (yoga, climb, footy) can't be tied to logged
  // exercises — no evidence either way, so keep the planned name.
  if (groups.length === 0) return component;

  const happened = done.some(e => {
    const group = classifyExercise(e.name);
    return group !== null && groups.includes(group);
  });
  return happened ? component : null;
}
