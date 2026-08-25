import type { ExerciseEntry } from '@/types/life';

// Whether an exercise entry records something that was ACTUALLY performed.
//
// `done` has three states that must be read carefully:
//   true      — ticked off on the Today checklist, or backfilled by an import
//               (freeform / sheet) that records what was actually done.
//   false     — seeded from a target at the start of a session and never
//               ticked, or explicitly un-ticked. The pre-filled target numbers
//               were never performed, so the entry does NOT count.
//   undefined — legacy data with no per-exercise done flag: a session logged
//               before the flag existed, or one entered through the desktop
//               "Log a session" form (which writes named rows with no `done`),
//               whose rows ARE a record of what was done.
//
// So only an explicit `done === false` means "not performed"; undefined is
// treated as performed. This is the single definition shared by the history
// views, the progression / target derivation, accessory harvesting, the
// programmer input and the analysis totals, so the whole app agrees on what
// counts as done.
export function entryWasPerformed(entry: Pick<ExerciseEntry, 'done'>): boolean {
  return entry.done !== false;
}
