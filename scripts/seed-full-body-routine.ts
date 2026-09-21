// Seed the "Full body (3-day)" routine into the routine library and activate it.
//
// docs/full-body-routine-plan.md §3: Mon/Wed/Fri full-body lifts, Tue/Thu
// treadmill runs, Sat parkrun, Sun rest. The routine days live as a constant in
// src/lib/full-body-routine.ts so the tests build from the same source.
//
// Additive and idempotent: the first storage call migrates the existing
// `weeklyRoutine` row into the library under "Split (6-day)" (leaving the legacy
// row in place), then this upserts the full-body entry and switches the active
// routine to it. Re-running re-writes the same entry and re-activates — no
// duplication, and the Split entry is untouched.
//
// Uses the real data directory unless PORTAL_DATA_DIR (or CALENDAR_DB_PATH) is
// set. Run with:
//
//   npx tsx scripts/seed-full-body-routine.ts

import {
  listRoutines,
  saveRoutine,
  setActiveRoutine,
} from '../src/lib/storage/weekly-routine';
import { materialiseRoutineSessions } from '../src/lib/exercise-calendar';
import { FULL_BODY_3DAY_NAME, FULL_BODY_3DAY_ROUTINE } from '../src/lib/full-body-routine';
import { DATA_DIR } from '../src/lib/data-paths';

async function main() {
  // Upsert the v2 entry (overwriting any v1 stored under the same name) and make
  // it active — the Split (6-day) entry is left untouched.
  await saveRoutine(FULL_BODY_3DAY_NAME, FULL_BODY_3DAY_ROUTINE);
  await setActiveRoutine(FULL_BODY_3DAY_NAME);

  // Reconcile the 14-day horizon of routine-sourced plans to the new routine —
  // the same reconcile the activate route runs — so the fortnight ahead is
  // retitled and the Mon/Wed/Fri/Sun home days gain venue 'home'. Best-effort:
  // this touches Google Calendar, and a calendar failure must not leave the
  // routine un-seeded, so it is logged, not thrown.
  try {
    const result = await materialiseRoutineSessions();
    console.log(
      `Reconciled plan: created ${result.created}, updated ${result.updated}, removed ${result.removed}`
    );
  } catch (error) {
    console.error('Failed to reconcile the plan (routine still seeded and active):', error);
  }

  const { names, active } = await listRoutines();
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Routines in library: ${names.join(', ')}`);
  console.log(`Active routine: ${active}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
