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
}

export type MuscleTier = 'none' | 'light' | 'solid' | 'high';

// A muscle's rolled-up load over the window.
export interface MuscleLoad {
  muscleId: string;
  doneWeightedSets: number;
  plannedWeightedSets: number;
  doneSetsPerWeek: number;
  plannedSetsPerWeek: number;
  // 0–1 for colouring the diagram; capped so one huge week doesn't wash out the
  // scale (see HEAT_CAP_PER_WEEK).
  heat: number;
  tier: MuscleTier;
  // Whether the only work hitting this muscle came from cardio — lets the UI say
  // "cardio only" rather than implying strength volume.
  cardioOnly: boolean;
  exercises: MuscleExerciseBreakdown[];
  assessment: string;
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
  cardioDoneWeighted: number;
  byExercise: Map<string, MuscleExerciseBreakdown>;
}

function emptyAccum(): Accum {
  return { doneWeighted: 0, plannedWeighted: 0, cardioDoneWeighted: 0, byExercise: new Map() };
}

function bumpExercise(
  accum: Accum,
  name: string,
  role: MuscleRoleKind,
  doneSets: number,
  plannedSets: number,
  doneDate: string | null
): void {
  const existing = accum.byExercise.get(name);
  if (existing) {
    existing.doneSets += doneSets;
    existing.plannedSets += plannedSets;
    if (doneDate && (!existing.lastDoneDate || doneDate > existing.lastDoneDate)) {
      existing.lastDoneDate = doneDate;
    }
    return;
  }
  accum.byExercise.set(name, {
    name,
    role,
    doneSets,
    plannedSets,
    lastDoneDate: doneDate,
  });
}

// Sets a row counts for. A row with no sets (a run, a plank logged as a hold)
// counts as one unit so it isn't silently dropped from the volume.
function setsOf(sets: number | undefined): number {
  return sets && sets > 0 ? sets : 1;
}

function isoDaysAgo(now: Date, days: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// Roll logged and planned work up per muscle around `now`.
//
// Done work looks BACK `windowDays` (what has actually been trained); planned
// work also looks FORWARD `windowDays`, since a plan is future-dated — an
// upcoming planned session or programme day is "planned", a completed one is not.
//
// Done: completed sessions' exercise rows performed (entryWasPerformed), weighted
// primary 1.0 / secondary 0.5 × sets. Planned: planned sessions' exercise rows,
// plus programme-cache rows for any date with no session rows at all — so a day's
// plan is never counted twice (a completed session already carries its own rows,
// and a planned session's rows are preferred over the programme's for that date).
export function aggregateMuscleLoad(
  sessions: ExerciseSession[],
  programmes: MuscleProgrammeDay[],
  windowDays: number,
  now: Date = new Date()
): MuscleLoad[] {
  const from = isoDaysAgo(now, windowDays);
  const today = now.toISOString().slice(0, 10);
  const forwardTo = isoDaysAgo(now, -windowDays);
  const inDoneWindow = (date: string) => date >= from && date <= today;
  const inPlannedWindow = (date: string) => date >= from && date <= forwardTo;

  const accums = new Map<string, Accum>();
  const accumFor = (id: string): Accum => {
    let a = accums.get(id);
    if (!a) {
      a = emptyAccum();
      accums.set(id, a);
    }
    return a;
  };

  // Dates that already have session-level exercise rows (planned or completed):
  // the programme fallback must skip these so a day's plan isn't double-counted.
  const datesWithSessionRows = new Set<string>();
  for (const session of sessions) {
    if (inPlannedWindow(session.date) && (session.exercises?.length ?? 0) > 0) {
      datesWithSessionRows.add(session.date);
    }
  }

  const addEntry = (entry: ExerciseEntry, date: string, kind: 'done' | 'planned') => {
    const roles = exerciseMuscles(entry.name);
    if (roles.length === 0) return;
    const cardio = isCardioExercise(normalizeExerciseName(entry.name));
    const sets = setsOf(entry.sets);
    for (const { muscleId, role } of roles) {
      const weighted = ROLE_WEIGHT[role] * sets;
      const accum = accumFor(muscleId);
      if (kind === 'done') {
        accum.doneWeighted += weighted;
        if (cardio) accum.cardioDoneWeighted += weighted;
        bumpExercise(accum, normalizeExerciseName(entry.name), role, sets, 0, date);
      } else {
        accum.plannedWeighted += weighted;
        bumpExercise(accum, normalizeExerciseName(entry.name), role, 0, sets, null);
      }
    }
  };

  for (const session of sessions) {
    const entries = session.exercises ?? [];
    if (session.completed && inDoneWindow(session.date)) {
      for (const entry of entries) {
        if (entryWasPerformed(entry)) addEntry(entry, session.date, 'done');
      }
    }
    if (session.planned && !session.completed && inPlannedWindow(session.date)) {
      for (const entry of entries) addEntry(entry, session.date, 'planned');
    }
  }

  // Programme rows only for dates with no session rows at all.
  for (const day of programmes) {
    if (!inPlannedWindow(day.date) || datesWithSessionRows.has(day.date)) continue;
    for (const row of day.rows) {
      addEntry({ id: '', name: row.name, sets: row.sets }, day.date, 'planned');
    }
  }

  const weeks = Math.max(windowDays / 7, 1 / 7);
  return MUSCLES.map(muscle => {
    const accum = accums.get(muscle.id) ?? emptyAccum();
    const doneSetsPerWeek = accum.doneWeighted / weeks;
    const plannedSetsPerWeek = accum.plannedWeighted / weeks;
    const heat = Math.min(1, doneSetsPerWeek / HEAT_CAP_PER_WEEK);
    const cardioOnly = accum.doneWeighted > 0 && accum.cardioDoneWeighted >= accum.doneWeighted;
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
      heat,
      tier,
      cardioOnly,
      exercises,
      assessment: assess(muscle, {
        doneWeighted: accum.doneWeighted,
        plannedWeighted: accum.plannedWeighted,
        doneSetsPerWeek,
        plannedSetsPerWeek,
        cardioOnly,
        windowDays,
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
  windowDays: number;
}

// One deterministic sentence for the detail panel and tooltip.
function assess(muscle: Muscle, load: AssessInput): string {
  const weeks = Math.round(load.windowDays / 7);
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

// The n coolest muscles by heat (least-worked first), for the "most missed"
// strip. Ties broken by the MUSCLES order.
export function coolestMuscles(loads: MuscleLoad[], n: number): MuscleLoad[] {
  return [...loads].sort((a, b) => a.heat - b.heat || a.doneWeightedSets - b.doneWeightedSets).slice(0, n);
}

export function muscleById(id: string): Muscle | undefined {
  return MUSCLES.find(m => m.id === id);
}
