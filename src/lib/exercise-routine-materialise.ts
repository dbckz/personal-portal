// Materialise planned sessions from the standing weekly routine.
//
// Planning lives in the portal: the weekly routine (src/lib/storage/weekly-
// routine.ts) is the repeating shape of the week. This turns that shape into
// DATED planned sessions for the days ahead and keeps them in step as the
// routine is edited — so Dave's Google calendar stays synced without him
// writing each week's events by hand.
//
// This module is the PURE planner: given the routine, the sessions already in
// the store, and today's date, it decides WHAT to create, update or remove. The
// I/O — reading the store, writing sessions, pushing calendar events — lives in
// exercise-calendar.ts (materialiseRoutineSessions), mirroring how the pull is
// structured. Keeping the decision pure makes every rule unit-testable without
// Google or the store.

import { addDays, format, parseISO } from 'date-fns';

import { parsePlannedTitle } from './exercise-parse';
import type { ExerciseSession, WeeklyRoutineDay } from '@/types/life';

// How many days ahead to materialise, counting today. Today through +13 is the
// fortnight the calendar sync already covers forward.
export const DEFAULT_HORIZON_DAYS = 14;

// The content of a routine-derived session, parsed from the routine day title
// the same way the calendar pull parses an all-day event title — so a routine
// day and a hand-written event with the same title yield the same components.
export interface RoutineSessionShape {
  date: string; // yyyy-MM-dd
  type: string;
  label: string;
  components: string[];
  targetDistanceKm?: number;
}

// The decision, as three lists the I/O layer executes in order.
export interface RoutineMaterialisationPlan {
  create: RoutineSessionShape[];
  update: Array<{ sessionId: string; shape: RoutineSessionShape }>;
  remove: string[]; // session ids to delete (routine day became rest)
}

// Parse a bare routine title ("Push (chest & arms)", "Run + core") into the same
// shape the calendar pull derives from "🏋️ Push (chest & arms)". parsePlannedTitle
// gates on an emoji prefix and then classifies purely from the body, so a benign
// prefix here yields identical components/type/distance either way. Returns null
// when the title carries no recognised training word — nothing to materialise.
function shapeFromRoutineDay(day: WeeklyRoutineDay, date: string): RoutineSessionShape | null {
  const parsed = parsePlannedTitle(`🏋️ ${day.title}`);
  if (!parsed) return null;
  return {
    date,
    type: parsed.type,
    label: parsed.title,
    components: parsed.components,
    ...(parsed.targetDistanceKm ? { targetDistanceKm: parsed.targetDistanceKm } : {}),
  };
}

function sameComponents(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return (a?.length ?? 0) === 0 && (b?.length ?? 0) === 0;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Whether a stored session already carries the routine day's content. Compares
// the CONTENT fields (label, type, components) — a title changing its distance
// also changes a component string ("Run (2 km)" → "Run (5 km)"), so distance
// edits still register here. targetDistanceKm is written on create/update but not
// compared, because updateSession cannot clear a field a shrinking title dropped,
// and comparing it would make such a day re-update on every run.
function shapeMatchesSession(shape: RoutineSessionShape, session: ExerciseSession): boolean {
  return (
    session.type === shape.type &&
    (session.label ?? '') === shape.label &&
    sameComponents(session.components, shape.components)
  );
}

// Given the routine, the sessions already stored, and today's date, decide the
// create/update/remove actions to bring the fortnight ahead in line with the
// routine. Pure and idempotent: run twice with the first run's writes applied and
// the second returns nothing.
//
// Rules:
//   CREATE — for each day today…+13 that is a non-rest routine day and holds NO
//     planned or completed session yet (any source: a hand-made calendar event or
//     a manual plan already there wins the date).
//   UPDATE — a FUTURE (date > today) routine-sourced, not-completed session whose
//     routine day title has changed → bring its content back in line.
//   REMOVE — a FUTURE routine-sourced, not-completed session whose routine day is
//     now a rest day (or no longer parses as training) → delete it.
//   Sessions that are 'calendar', 'manual', 'sheet' or 'freeform', completed, or
//   dated today or earlier are never touched. Today, once created, is left alone.
export function planRoutineMaterialisation(
  routine: WeeklyRoutineDay[],
  existingSessions: ExerciseSession[],
  today: string,
  horizonDays: number = DEFAULT_HORIZON_DAYS
): RoutineMaterialisationPlan {
  const byDayOfWeek = new Map<number, WeeklyRoutineDay>();
  for (const day of routine) byDayOfWeek.set(day.dayOfWeek, day);

  const routineShapeFor = (date: string): RoutineSessionShape | null => {
    const day = byDayOfWeek.get(parseISO(date).getDay());
    if (!day || day.rest) return null;
    return shapeFromRoutineDay(day, date);
  };

  const create: RoutineSessionShape[] = [];
  const start = parseISO(today);

  for (let i = 0; i < horizonDays; i++) {
    const date = format(addDays(start, i), 'yyyy-MM-dd');
    const shape = routineShapeFor(date);
    if (!shape) continue; // rest day, gap in the routine, or an unparseable title

    // A day already holding a plan or a done session produces nothing.
    const occupied = existingSessions.some(s => s.date === date && (s.planned || s.completed));
    if (!occupied) create.push(shape);
  }

  const update: RoutineMaterialisationPlan['update'] = [];
  const remove: string[] = [];

  for (const session of existingSessions) {
    if (session.source !== 'routine' || session.completed) continue;
    if (session.date <= today) continue; // today is left alone once it exists; past is history

    const shape = routineShapeFor(session.date);
    if (!shape) {
      remove.push(session.id); // became a rest day (or stopped parsing as training)
      continue;
    }
    if (!shapeMatchesSession(shape, session)) update.push({ sessionId: session.id, shape });
  }

  return { create, update, remove };
}
