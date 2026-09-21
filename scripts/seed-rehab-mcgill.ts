// Extend the daily rehab block to the McGill Big 3 list.
//
// docs/full-body-routine-plan.md §4: add Cat-cow, 90/90 hip switch and McGill
// curl-up, and dose Side plank and Bird dog to the McGill 5-3-1 × 10 s standard.
// The list lives as a constant in src/lib/full-body-routine.ts; the existing six
// ids are preserved so past ticks stay valid.
//
// updateRehabExercises replaces the list while keeping the tick history for ids
// that survive (all six existing ones do), so no ticked day is lost. Idempotent:
// re-running writes the same list.
//
// Uses the real data directory unless PORTAL_DATA_DIR (or CALENDAR_DB_PATH) is
// set. Run with:
//
//   npx tsx scripts/seed-rehab-mcgill.ts

import { getRehabRoutine, updateRehabExercises } from '../src/lib/storage/rehab';
import { MCGILL_REHAB_EXERCISES } from '../src/lib/full-body-routine';
import { DATA_DIR } from '../src/lib/data-paths';

async function main() {
  const before = await getRehabRoutine();
  const tickDays = Object.keys(before.ticks).length;

  const after = await updateRehabExercises(MCGILL_REHAB_EXERCISES);

  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Rehab exercises: ${after.exercises.map(e => e.id).join(', ')}`);
  console.log(`Tick days preserved: ${Object.keys(after.ticks).length}/${tickDays}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
