// Muscle taxonomy and the exercise→muscle mapping behind the Muscles heatmap.
//
// Pure and I/O-free so it can be unit-tested and run on either the server (the
// /api/exercise/muscles route) or the client. Three layers:
//   1. MUSCLES — the ~18 muscles the body diagram draws, each with the plain
//      description and example exercises the detail panel shows.
//   2. EXERCISE_MUSCLES — canonical exercise name → the muscles it works, keyed
//      by `normalizeExerciseName` output (so spelling drift is handled upstream).
//   3. FALLBACK — keyword regexes (modelled on exercise-targets' CLASSIFY) so an
//      unmapped or brand-new name still lands somewhere sensible.
// aggregateMuscleLoad rolls logged and planned work up per muscle and attaches a
// deterministic assessment sentence and a 0–1 heat value for colouring.

import { normalizeExerciseName } from './exercise-names';
import { entryWasPerformed } from './exercise-entry';
import { classifyExercise, componentGroups, type Group } from './exercise-targets';
import type { ExerciseEntry, ExerciseSession } from '@/types/life';

export type MuscleView = 'front' | 'back';
export type MuscleRoleKind = 'primary' | 'secondary';

export interface Muscle {
  id: string;
  label: string;
  // One plain-English line: what the muscle is / does.
  description: string;
  view: MuscleView;
  // One or two exercises to suggest when the muscle is under-worked.
  examples: string[];
}

// The muscles the diagram draws, front view then back view. Ids are stable
// (used as SVG data-muscle keys and mapping targets); order here is the order the
// "most missed" strip and any lists fall back to.
export const MUSCLES: Muscle[] = [
  // --- Front ---
  {
    id: 'chest',
    label: 'Chest',
    description: 'The pecs — push the arms forward and across the body.',
    view: 'front',
    examples: ['Incline DB press', 'Pec fly'],
  },
  {
    id: 'front-delts',
    label: 'Front delts',
    description: 'Front of the shoulder — raises the arm forward and presses overhead.',
    view: 'front',
    examples: ['Converging shoulder press'],
  },
  {
    id: 'side-delts',
    label: 'Side delts',
    description: 'Side of the shoulder — lifts the arm out to the side; the width muscle.',
    view: 'front',
    examples: ['DB lateral raise'],
  },
  {
    id: 'biceps',
    label: 'Biceps',
    description: 'Front of the upper arm — bends the elbow and turns the palm up.',
    view: 'front',
    examples: ['Hammer curls', 'Cable bicep curl'],
  },
  {
    id: 'forearms',
    label: 'Forearms',
    description: 'Grip and wrist muscles below the elbow.',
    view: 'front',
    examples: ['Hammer curls', 'Dead hang'],
  },
  {
    id: 'abs',
    label: 'Abs',
    description: 'The front of the core — flexes the trunk and resists it extending.',
    view: 'front',
    examples: ['Plank', 'Hanging knee raise'],
  },
  {
    id: 'obliques',
    label: 'Obliques',
    description: 'Sides of the waist — rotate the trunk and resist twisting.',
    view: 'front',
    examples: ['Pallof press'],
  },
  {
    id: 'quads',
    label: 'Quads',
    description: 'Front of the thigh — straightens the knee.',
    view: 'front',
    examples: ['Leg press', 'Leg extension'],
  },
  {
    id: 'hip-flexors',
    label: 'Hip flexors',
    description: 'Front of the hip — lifts the knee toward the chest.',
    view: 'front',
    examples: ['Hanging knee raise', 'Dead bug'],
  },
  // --- Back ---
  {
    id: 'traps',
    label: 'Traps',
    description: 'Top of the back and neck — shrugs and stabilises the shoulder blades.',
    view: 'back',
    examples: ['Shrug'],
  },
  {
    id: 'rear-delts',
    label: 'Rear delts',
    description: 'Back of the shoulder — pulls the arm backward; posture and balance.',
    view: 'back',
    examples: ['Reverse pec deck', 'Face pull'],
  },
  {
    id: 'triceps',
    label: 'Triceps',
    description: 'Back of the upper arm — straightens the elbow on every press.',
    view: 'back',
    examples: ['Triceps pushdown'],
  },
  {
    id: 'lats',
    label: 'Lats',
    description: 'The big wing muscles of the back — pull the arms down and in.',
    view: 'back',
    examples: ['Lat pulldown', 'Neutral-grip pull-up'],
  },
  {
    id: 'upper-back',
    label: 'Upper back',
    description: 'Rhomboids and mid-traps between the shoulder blades — the rowing muscles.',
    view: 'back',
    examples: ['Seated cable row', 'Chest-supported DB row'],
  },
  {
    id: 'lower-back',
    description: 'The spinal erectors — hold the back straight and extend the hips.',
    label: 'Lower back',
    view: 'back',
    examples: ['Deadlift', 'Plank'],
  },
  {
    id: 'glutes',
    label: 'Glutes',
    description: 'The buttocks — drive the hips forward; the biggest muscle you have.',
    view: 'back',
    examples: ['Cable glute kickback', 'Reverse lunge'],
  },
  {
    id: 'hamstrings',
    label: 'Hamstrings',
    description: 'Back of the thigh — bends the knee and extends the hip.',
    view: 'back',
    examples: ['Seated leg curl'],
  },
  {
    id: 'calves',
    label: 'Calves',
    description: 'Back of the lower leg — points the toes and drives every stride.',
    view: 'back',
    examples: ['Standing calf raise'],
  },
];

const MUSCLE_IDS = new Set(MUSCLES.map(m => m.id));

export interface MuscleRole {
  muscleId: string;
  role: MuscleRoleKind;
}

// A tiny helper so the map below reads as data, not object literals.
function primary(...ids: string[]): MuscleRole[] {
  return ids.map(muscleId => ({ muscleId, role: 'primary' as const }));
}
function secondary(...ids: string[]): MuscleRole[] {
  return ids.map(muscleId => ({ muscleId, role: 'secondary' as const }));
}

// Canonical exercise name → muscles worked. Keys are in `normalizeExerciseName`
// output form. Covers every canonical value in EXERCISE_NAME_ALIASES plus the
// names visible in the live log; anything missing falls through to FALLBACK.
export const EXERCISE_MUSCLES: Record<string, MuscleRole[]> = {
  // Push — chest
  'Incline DB press': [...primary('chest'), ...secondary('front-delts', 'triceps')],
  'Flat DB press': [...primary('chest'), ...secondary('front-delts', 'triceps')],
  'DB bench press': [...primary('chest'), ...secondary('front-delts', 'triceps')],
  'Bench press': [...primary('chest'), ...secondary('front-delts', 'triceps')],
  'Converging chest press': [...primary('chest'), ...secondary('front-delts', 'triceps')],
  'Pec fly': primary('chest'),
  'Cable crossover': primary('chest'),
  'Slow push-ups': [...primary('chest'), ...secondary('triceps', 'front-delts', 'abs')],
  'Push-ups': [...primary('chest'), ...secondary('triceps', 'front-delts', 'abs')],
  'Dips': [...primary('chest', 'triceps'), ...secondary('front-delts')],

  // Push — shoulders
  'Converging shoulder press': [...primary('front-delts'), ...secondary('side-delts', 'triceps')],
  'Seated DB shoulder press': [...primary('front-delts'), ...secondary('side-delts', 'triceps')],
  'Overhead press': [...primary('front-delts'), ...secondary('side-delts', 'triceps')],
  'DB lateral raise': primary('side-delts'),
  'Cable lateral raise': primary('side-delts'),

  // Push — triceps
  'Triceps pushdown': primary('triceps'),
  'Tricep pushdown': primary('triceps'),
  'Cable tricep pushdown': primary('triceps'),
  'Skull crushers': primary('triceps'),

  // Pull — back
  'Seated cable row': [...primary('upper-back', 'lats'), ...secondary('biceps', 'rear-delts')],
  'Cable row': [...primary('upper-back', 'lats'), ...secondary('biceps', 'rear-delts')],
  'Chest-supported DB row': [...primary('upper-back', 'lats'), ...secondary('rear-delts', 'biceps')],
  'Lat pulldown': [...primary('lats'), ...secondary('biceps', 'upper-back')],
  'Neutral-grip lat pulldown': [...primary('lats'), ...secondary('biceps', 'upper-back')],
  'Wide-grip lat pulldown': [...primary('lats'), ...secondary('upper-back', 'biceps')],
  'Neutral-grip pull-up': [...primary('lats'), ...secondary('biceps', 'upper-back')],
  'Pull-up': [...primary('lats'), ...secondary('biceps', 'upper-back')],
  'Reverse pec deck': [...primary('rear-delts'), ...secondary('upper-back')],
  'Band pull-aparts': [...primary('rear-delts'), ...secondary('upper-back')],
  'Face pull': [...primary('rear-delts'), ...secondary('upper-back')],
  'Shrug': primary('traps'),
  'Dead hang': [...primary('forearms'), ...secondary('lats')],

  // Pull — biceps
  'Hammer curls': [...primary('biceps'), ...secondary('forearms')],
  'Hammer curl': [...primary('biceps'), ...secondary('forearms')],
  'Incline DB curl': primary('biceps'),
  'Incline DB curls': primary('biceps'),
  'Cable bicep curl': primary('biceps'),
  'Cable curl': primary('biceps'),
  'Cable curls': primary('biceps'),
  'DB bicep curl': primary('biceps'),

  // Legs
  'Leg press': [...primary('quads'), ...secondary('glutes', 'hamstrings')],
  'Leg extension': primary('quads'),
  'Seated leg curl': primary('hamstrings'),
  'Reverse lunge': [...primary('quads', 'glutes'), ...secondary('hamstrings')],
  'Cable glute kickback': primary('glutes'),
  'Hip thrust': [...primary('glutes'), ...secondary('hamstrings')],
  'Squat': [...primary('quads', 'glutes'), ...secondary('hamstrings')],
  'Deadlift': [...primary('hamstrings', 'glutes', 'lower-back'), ...secondary('traps')],
  'Step-up': [...primary('quads', 'glutes'), ...secondary('hamstrings')],
  'Standing calf raise': primary('calves'),

  // Core
  'Plank': [...primary('abs'), ...secondary('obliques', 'lower-back')],
  'Dead bug': [...primary('abs'), ...secondary('hip-flexors')],
  'Hanging knee raise': [...primary('abs'), ...secondary('hip-flexors')],
  'Pallof press': [...primary('obliques'), ...secondary('abs')],
  'Glute bridge': [...primary('glutes'), ...secondary('abs')],
};

// Cardio maps to a legs-dominant set but is tagged so the UI can keep it out of
// the strength volume story. Matched by name keyword, and only AFTER the explicit
// map (see exerciseMuscles) so a strength "Seated cable row" is never swept in.
// A cardio row is a "Rowing machine"/"rower"/"erg" in practice, so the bare word
// "row" is deliberately NOT a cardio word — it belongs to strength rows.
const CARDIO_RE = /\b(run|treadmill|parkrun|jog|cardio|football|footy|5k|10k|bike|cycle|rowing|rower|erg|swim|elliptical)\b/i;
const CARDIO_MUSCLES: MuscleRole[] = [
  ...primary('quads'),
  ...secondary('hamstrings', 'calves', 'glutes'),
];

// Keyword fallback, most-specific first: the FIRST regex an unmapped name
// matches supplies its muscles. Mirrors exercise-targets' CLASSIFY precedence so
// "Leg press" lands in legs before push's press, "Reverse ..." in rear delts,
// and push stays the catch-all last.
const FALLBACK: Array<[RegExp, MuscleRole[]]> = [
  [/\b(plank|dead ?bug|hollow|sit-?ups?|crunch|hanging (leg|knee))\b/i, [...primary('abs'), ...secondary('obliques')]],
  [/\b(pallof|paloff|oblique|russian twist|woodchop)\b/i, [...primary('obliques'), ...secondary('abs')]],
  [/\bglute bridge\b/i, [...primary('glutes'), ...secondary('abs')]],
  [/\b(calf|calves)\b/i, primary('calves')],
  [/\b(leg curl|hamstring)\b/i, primary('hamstrings')],
  [/\b(leg extension|quad)\b/i, primary('quads')],
  [/\b(glute|hip thrust|kickback)\b/i, primary('glutes')],
  [/\b(squat|lunge|leg press|step-?up)\b/i, [...primary('quads', 'glutes'), ...secondary('hamstrings')]],
  [/\b(deadlift|hip hinge|good ?morning|back extension)\b/i, [...primary('hamstrings', 'glutes', 'lower-back')]],
  [/\b(lat ?pulldown|pulldown|pull-?ups?|pullups?|chin)\b/i, [...primary('lats'), ...secondary('biceps', 'upper-back')]],
  [/\b(row|rows)\b/i, [...primary('upper-back', 'lats'), ...secondary('biceps', 'rear-delts')]],
  [/\b(rear delt|reverse pec|reverse fly|face pull|band pull)\b/i, [...primary('rear-delts'), ...secondary('upper-back')]],
  [/\b(shrug|traps?)\b/i, primary('traps')],
  [/\b(hammer|forearm|wrist|grip|dead hang)\b/i, [...primary('biceps'), ...secondary('forearms')]],
  [/\b(curl|bicep)\b/i, primary('biceps')],
  [/\b(tricep|pushdown|skull ?crusher|dip)\b/i, primary('triceps')],
  [/\b(lateral raise|side delt)\b/i, primary('side-delts')],
  [/\b(shoulder|overhead|press up|ohp)\b/i, [...primary('front-delts'), ...secondary('side-delts', 'triceps')]],
  [/\b(fly|flye|crossover|chest|pec)\b/i, primary('chest')],
  [/\b(push-?ups?|press|bench|push)\b/i, [...primary('chest'), ...secondary('triceps', 'front-delts')]],
];

// Whether an exercise name is cardio, by keyword.
export function isCardioExercise(name: string): boolean {
  return CARDIO_RE.test(name);
}

// The muscles an exercise works. The explicit, hand-curated map wins first — so a
// strength "Seated cable row" maps to back, never to the cardio its "row" would
// otherwise trip. Then cardio names get the legs-dominant cardio set, then the
// keyword fallback. Unknown, non-cardio names return [] (kept out of the heatmap
// rather than force-fitted). Roles are filtered to real muscle ids so a typo in
// the tables can't leak through.
export function exerciseMuscles(rawName: string): MuscleRole[] {
  const name = normalizeExerciseName(rawName);
  if (!name) return [];

  const explicit = EXERCISE_MUSCLES[name];
  if (explicit) return explicit.filter(r => MUSCLE_IDS.has(r.muscleId));

  if (isCardioExercise(name)) return CARDIO_MUSCLES;

  for (const [re, roles] of FALLBACK) {
    if (re.test(name)) return roles.filter(r => MUSCLE_IDS.has(r.muscleId));
  }
  return [];
}

const ROLE_WEIGHT: Record<MuscleRoleKind, number> = { primary: 1, secondary: 0.5 };

// One exercise's contribution to a muscle, done vs planned.
export interface MuscleExerciseBreakdown {
  name: string;
  role: MuscleRoleKind;
  doneSets: number;
  plannedSets: number;
  lastDoneDate: string | null;
  // Set when this planned contribution was SYNTHESISED for a row-less planned
  // session (a calendar import with only components), not read from real rows.
  // `note` explains the source for the detail panel.
  estimated?: boolean;
  note?: string;
}

export type MuscleTier = 'none' | 'light' | 'solid' | 'high';

// A muscle's rolled-up load over the range. Planned and done are computed over
// the SAME range, so the two figures are directly comparable — done is what was
// actually performed, planned is what the map would look like had every planned
// row been done.
export interface MuscleLoad {
  muscleId: string;
  doneWeightedSets: number;
  plannedWeightedSets: number;
  doneSetsPerWeek: number;
  plannedSetsPerWeek: number;
  // 0–1 heats for colouring the two diagrams, both off the same
  // HEAT_CAP_PER_WEEK scale so Planned and Actual read on one temperature.
  doneHeat: number;
  plannedHeat: number;
  // The done tier, kept for the assessment/most-missed logic.
  tier: MuscleTier;
  // Whether the only work hitting this muscle came from cardio — lets the UI say
  // "cardio only" rather than implying strength volume.
  cardioOnly: boolean;
  // Whether the planned load is ENTIRELY synthesised (no real planned rows) — the
  // UI can flag the Planned figure's colour as an estimate for this muscle.
  plannedEstimated: boolean;
  exercises: MuscleExerciseBreakdown[];
  assessment: string;
}

// An inclusive [from, to] date range (yyyy-MM-dd) the load is computed over.
export interface DateRange {
  from: string;
  to: string;
}

// The [anchor - windowDays, anchor] range the UI steps through.
export function rangeFromAnchor(anchor: string, windowDays: number): DateRange {
  const d = new Date(`${anchor}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - windowDays);
  return { from: d.toISOString().slice(0, 10), to: anchor };
}

// A planned session's programme rows for a date, as read from the programme
// cache. Only the fields the aggregation needs.
export interface MuscleProgrammeDay {
  date: string;
  rows: Array<{ name: string; sets?: number }>;
}

// Weekly weighted sets at or above which a muscle counts as fully "hot".
const HEAT_CAP_PER_WEEK = 10;
// Below this a muscle reads as lightly trained; at/above HIGH it's high volume.
const LIGHT_PER_WEEK = 2;
const HIGH_PER_WEEK = 10;

interface Accum {
  doneWeighted: number;
  plannedWeighted: number;
  // Of plannedWeighted, how much was synthesised — so plannedEstimated can tell
  // an entirely-estimated muscle from one with real planned rows.
  estimatedPlannedWeighted: number;
  cardioDoneWeighted: number;
  byExercise: Map<string, MuscleExerciseBreakdown>;
}

function emptyAccum(): Accum {
  return {
    doneWeighted: 0,
    plannedWeighted: 0,
    estimatedPlannedWeighted: 0,
    cardioDoneWeighted: 0,
    byExercise: new Map(),
  };
}

function bumpExercise(
  accum: Accum,
  name: string,
  role: MuscleRoleKind,
  doneSets: number,
  plannedSets: number,
  doneDate: string | null,
  opts?: { estimated?: boolean; note?: string }
): void {
  const existing = accum.byExercise.get(name);
  if (existing) {
    existing.doneSets += doneSets;
    existing.plannedSets += plannedSets;
    if (doneDate && (!existing.lastDoneDate || doneDate > existing.lastDoneDate)) {
      existing.lastDoneDate = doneDate;
    }
    // A real contribution to the same name overrides an estimate.
    if (!opts?.estimated) {
      existing.estimated = false;
      existing.note = undefined;
    }
    return;
  }
  accum.byExercise.set(name, {
    name,
    role,
    doneSets,
    plannedSets,
    lastDoneDate: doneDate,
    ...(opts?.estimated ? { estimated: true, note: opts.note } : {}),
  });
}

// Nominal per-muscle planned load (weighted-set units) for a plan COMPONENT whose
// group has no history to copy — mirrors exercise-targets' component→group logic.
const STATIC_COMPONENT_LOAD: Record<Group, Record<string, number>> = {
  push: { chest: 9, 'front-delts': 6, 'side-delts': 4, triceps: 5 },
  pull: { lats: 9, 'upper-back': 6, biceps: 6, 'rear-delts': 4 },
  legs: { quads: 9, hamstrings: 6, glutes: 6, calves: 4 },
  core: { abs: 6, obliques: 3 },
  run: { quads: 3, hamstrings: 3, calves: 3, glutes: 3 },
};

// The groups a plan component activates. Reuses exercise-targets' componentGroups,
// plus football/footy → the cardio (run) set.
function groupsForComponent(component: string): Group[] {
  const groups = componentGroups(component);
  if (groups.length > 0) return groups;
  if (/\b(football|footy|soccer)\b/i.test(component)) return ['run'];
  return [];
}

// A row-less planned session's components, flattened: split each on '+' (a
// calendar title like "Parkrun + core + Legs"), trimmed, blanks dropped. Falls
// back to the label when there are no components.
function componentList(session: ExerciseSession): string[] {
  const raw =
    session.components && session.components.length > 0
      ? session.components
      : session.label
        ? [session.label]
        : [];
  return raw
    .flatMap(c => c.split('+'))
    .map(c => c.trim())
    .filter(Boolean);
}

// The most recent row-bearing session (completed, or planned with rows) that has
// at least one exercise in one of `groups`, and the rows that match — so a
// future "Push" day can reuse the exercises from the last real Push session.
function findComponentHistory(
  history: ExerciseSession[],
  groups: Group[],
  excludeDate: string
): Array<{ name: string; sets?: number }> | null {
  const wanted = new Set(groups);
  const candidates = history
    .filter(
      s =>
        s.date !== excludeDate &&
        (s.exercises?.length ?? 0) > 0 &&
        (s.completed || (s.planned && (s.exercises?.length ?? 0) > 0))
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const session of candidates) {
    const rows = (session.exercises ?? []).filter(e => {
      const g = classifyExercise(normalizeExerciseName(e.name));
      return g !== null && wanted.has(g);
    });
    if (rows.length > 0) return rows.map(e => ({ name: e.name, sets: e.sets }));
  }
  return null;
}

// Sets a row counts for. A row with no sets (a run, a plank logged as a hold)
// counts as one unit so it isn't silently dropped from the volume.
function setsOf(sets: number | undefined): number {
  return sets && sets > 0 ? sets : 1;
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  );
}

// Roll logged and planned work up per muscle over an explicit inclusive range.
//
// BOTH loads are computed over the SAME range, so Planned and Actual are directly
// comparable. Planned counts EVERY session's exercise rows (a completed session's
// prescribed rows ARE that day's plan, regardless of whether each was performed),
// plus programme-cache rows for dates with no session rows, plus SYNTHESISED rows
// for row-less planned sessions (calendar imports with only components) — so a
// future plan of component-only sessions still colours the Planned figure. Done
// counts only completed sessions' performed rows (entryWasPerformed). A completed
// session therefore feeds both: its rows into planned, its performed rows into
// done. Weighting is primary 1.0 / secondary 0.5 × sets throughout.
//
// `sessions` may extend BEFORE the range (the route passes a longer history
// slice): out-of-range sessions never contribute to the totals, but are searched
// to synthesise a row-less planned session's expected exercises from the most
// recent matching real session.
export function aggregateMuscleLoad(
  sessions: ExerciseSession[],
  programmes: MuscleProgrammeDay[],
  range: DateRange
): MuscleLoad[] {
  const inRange = (date: string) => date >= range.from && date <= range.to;

  const accums = new Map<string, Accum>();
  const accumFor = (id: string): Accum => {
    let a = accums.get(id);
    if (!a) {
      a = emptyAccum();
      accums.set(id, a);
    }
    return a;
  };

  // Dates that already have session-level exercise rows: the programme fallback
  // and synthesis must skip these so a day's plan isn't double-counted.
  const datesWithSessionRows = new Set<string>();
  for (const session of sessions) {
    if (inRange(session.date) && (session.exercises?.length ?? 0) > 0) {
      datesWithSessionRows.add(session.date);
    }
  }

  const addPlanned = (
    name: string,
    sets: number | undefined,
    opts?: { estimated?: boolean; note?: string }
  ) => {
    const roles = exerciseMuscles(name);
    if (roles.length === 0) return;
    const n = setsOf(sets);
    for (const { muscleId, role } of roles) {
      const weighted = ROLE_WEIGHT[role] * n;
      const accum = accumFor(muscleId);
      accum.plannedWeighted += weighted;
      if (opts?.estimated) accum.estimatedPlannedWeighted += weighted;
      bumpExercise(accum, normalizeExerciseName(name), role, 0, n, null, opts);
    }
  };

  // A synthesised nominal load: a flat weighted amount on one muscle, with a
  // labelled estimated breakdown entry (there's no real exercise behind it).
  const addPlannedNominal = (muscleId: string, weighted: number, label: string) => {
    if (!MUSCLE_IDS.has(muscleId)) return;
    const accum = accumFor(muscleId);
    accum.plannedWeighted += weighted;
    accum.estimatedPlannedWeighted += weighted;
    bumpExercise(accum, label, 'primary', 0, round1(weighted), null, {
      estimated: true,
      note: label,
    });
  };

  const addDone = (entry: ExerciseEntry, date: string) => {
    const roles = exerciseMuscles(entry.name);
    if (roles.length === 0) return;
    const cardio = isCardioExercise(normalizeExerciseName(entry.name));
    const n = setsOf(entry.sets);
    for (const { muscleId, role } of roles) {
      const weighted = ROLE_WEIGHT[role] * n;
      const accum = accumFor(muscleId);
      accum.doneWeighted += weighted;
      if (cardio) accum.cardioDoneWeighted += weighted;
      bumpExercise(accum, normalizeExerciseName(entry.name), role, n, 0, date);
    }
  };

  for (const session of sessions) {
    if (!inRange(session.date)) continue;
    const entries = session.exercises ?? [];
    // Every session's rows are the plan for its day.
    for (const entry of entries) addPlanned(entry.name, entry.sets);
    // Only a completed session's performed rows count as done.
    if (session.completed) {
      for (const entry of entries) {
        if (entryWasPerformed(entry)) addDone(entry, session.date);
      }
    }
  }

  // Programme rows only for dates with no session rows at all.
  const coveredByProgramme = new Set<string>();
  for (const day of programmes) {
    if (!inRange(day.date) || datesWithSessionRows.has(day.date)) continue;
    for (const row of day.rows) addPlanned(row.name, row.sets);
    coveredByProgramme.add(day.date);
  }

  // Synthesise a plan for row-less planned sessions in range not already covered
  // by real rows or the programme cache (past skipped plans included). Per
  // component: reuse the most recent matching real session's rows, else a static
  // nominal load. Marked estimated so it's never shown as a literal prescription.
  for (const session of sessions) {
    if (!inRange(session.date)) continue;
    if (!(session.planned && !session.completed)) continue;
    if ((session.exercises?.length ?? 0) > 0) continue;
    if (datesWithSessionRows.has(session.date) || coveredByProgramme.has(session.date)) continue;

    const seen = new Set<Group>();
    for (const component of componentList(session)) {
      const groups = groupsForComponent(component).filter(g => !seen.has(g));
      if (groups.length === 0) continue;
      groups.forEach(g => seen.add(g));

      const match = findComponentHistory(sessions, groups, session.date);
      if (match) {
        for (const row of match) {
          addPlanned(row.name, row.sets, {
            estimated: true,
            note: `expected — from your usual ${component} session`,
          });
        }
      } else {
        for (const group of groups) {
          for (const [muscleId, weighted] of Object.entries(STATIC_COMPONENT_LOAD[group])) {
            addPlannedNominal(muscleId, weighted, `typical ${component} day`);
          }
        }
      }
    }
  }

  const days = Math.max(daysBetween(range.from, range.to), 1);
  const weeks = Math.max(days / 7, 1 / 7);
  return MUSCLES.map(muscle => {
    const accum = accums.get(muscle.id) ?? emptyAccum();
    const doneSetsPerWeek = accum.doneWeighted / weeks;
    const plannedSetsPerWeek = accum.plannedWeighted / weeks;
    const doneHeat = Math.min(1, doneSetsPerWeek / HEAT_CAP_PER_WEEK);
    const plannedHeat = Math.min(1, plannedSetsPerWeek / HEAT_CAP_PER_WEEK);
    const cardioOnly = accum.doneWeighted > 0 && accum.cardioDoneWeighted >= accum.doneWeighted;
    const plannedEstimated =
      accum.plannedWeighted > 0 && accum.estimatedPlannedWeighted >= accum.plannedWeighted - 1e-9;
    const tier = tierFor(doneSetsPerWeek);
    const exercises = [...accum.byExercise.values()].sort(
      (a, b) => b.doneSets - a.doneSets || b.plannedSets - a.plannedSets
    );
    return {
      muscleId: muscle.id,
      doneWeightedSets: round1(accum.doneWeighted),
      plannedWeightedSets: round1(accum.plannedWeighted),
      doneSetsPerWeek: round1(doneSetsPerWeek),
      plannedSetsPerWeek: round1(plannedSetsPerWeek),
      doneHeat,
      plannedHeat,
      tier,
      cardioOnly,
      plannedEstimated,
      exercises,
      assessment: assess(muscle, {
        doneWeighted: accum.doneWeighted,
        plannedWeighted: accum.plannedWeighted,
        doneSetsPerWeek,
        plannedSetsPerWeek,
        cardioOnly,
        days,
      }),
    };
  });
}

function tierFor(perWeek: number): MuscleTier {
  if (perWeek <= 0) return 'none';
  if (perWeek < LIGHT_PER_WEEK) return 'light';
  if (perWeek <= HIGH_PER_WEEK) return 'solid';
  return 'high';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

interface AssessInput {
  doneWeighted: number;
  plannedWeighted: number;
  doneSetsPerWeek: number;
  plannedSetsPerWeek: number;
  cardioOnly: boolean;
  days: number;
}

// One deterministic sentence for the detail panel and tooltip.
function assess(muscle: Muscle, load: AssessInput): string {
  const weeks = Math.max(1, Math.round(load.days / 7));
  const perWeek = round1(load.doneSetsPerWeek);
  const example = muscle.examples[0] ?? 'a targeted exercise';

  if (load.doneWeighted <= 0) {
    if (load.plannedWeighted > 0) {
      return `Planned but nothing logged in the last ${weeks} weeks — try ${example}.`;
    }
    return `No logged work in the last ${weeks} weeks — try ${example}.`;
  }
  if (load.cardioOnly) {
    return `Only worked through cardio in the last ${weeks} weeks — add some direct work like ${example}.`;
  }
  if (load.plannedWeighted > 0 && load.doneWeighted < load.plannedWeighted * 0.5) {
    return `Planned but rarely completed — about ${perWeek} sets a week done against more planned.`;
  }
  if (load.doneSetsPerWeek < LIGHT_PER_WEEK) {
    return `Light — only about ${perWeek} sets a week; add a set or two, e.g. ${example}.`;
  }
  if (load.doneSetsPerWeek <= HIGH_PER_WEEK) {
    return `Solid — about ${perWeek} sets a week.`;
  }
  return `High volume — about ${perWeek} sets a week, plenty for this muscle.`;
}

// The n coolest muscles by ACTUAL heat (least-worked first), for the "most
// missed" strip. Ties broken by the MUSCLES order.
export function coolestMuscles(loads: MuscleLoad[], n: number): MuscleLoad[] {
  return [...loads]
    .sort((a, b) => a.doneHeat - b.doneHeat || a.doneWeightedSets - b.doneWeightedSets)
    .slice(0, n);
}

export function muscleById(id: string): Muscle | undefined {
  return MUSCLES.find(m => m.id === id);
}
