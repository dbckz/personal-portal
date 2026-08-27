// AI session programming: turn the training history into an ordered plan for
// today's session — what to do, in what order, how hard, and why.
//
// The deterministic builder (exercise-targets.ts) answers "what weight next?"
// one lift at a time from the last note. This asks Claude to program the whole
// session the way a coach would: keep the core lifts identical so they can be
// driven up, rotate the accessories, balance added weight against added reps and
// sets, respect how real gym equipment actually increments, put the run first,
// and finish on something safe to take to failure.
//
// It is the richer path, not the only path: the route serves the deterministic
// targets instantly and swaps in the generated programme once it is cached, so a
// slow or absent Claude never leaves the Today tab empty.
//
// Cached per date against a hash of the plan and the relevant history, so the
// model runs at most once per day-plan and never again unless the history it saw
// has changed.

import { createHash } from 'node:crypto';

import { extractJsonArray, runClaudeText } from './ai-classifier';
import { exerciseKey, type ExerciseProgression, type ProgressionPoint } from './exercise-progression';
import { isCardioName, isHoldName } from './exercise-parse';
import {
  activeGroups,
  classifyExercise,
  describeLast,
  isHomeStrengthExercise,
  isSafeToFailure,
  planCardioName,
  selectPlanProgressions,
  type ExerciseKind,
  type ExerciseTarget,
  type Group,
} from './exercise-targets';

// Whether a vocabulary exercise can be done in a home session: a cardio piece
// (running needs no kit) or a band/bodyweight strength movement (not gym-only by
// name, and never loaded with an external weight in its history). The guard the
// home append paths use so no gym lift is forced into a home session.
function isHomeExercise(e: ProgrammerExercise): boolean {
  return isCardioName(e.name) || isHomeStrengthExercise(e.name, e.recent);
}

// What to aim for on one exercise. Any of the measures may be present: a press
// has sets/reps/weight, a plank sets/holdSeconds, a run duration/distance;
// perSide marks unilateral work as "each side".
export interface ProgrammeTarget {
  sets?: number;
  reps?: number;
  holdSeconds?: number;
  perSide?: boolean;
  weightKg?: number;
  durationMinutes?: number;
  distanceKm?: number;
}

// One row of the generated session, in the order it should be done.
export interface ProgrammeRow {
  name: string;
  key: string;
  kind: ExerciseKind;
  toFailure: boolean;
  // One of the day's FIXED lifts (a routine anchor or staple), matched by key
  // against the routine day. Threaded to the checklist's "Anchor"/"Staple"
  // badge. Absent on rotating accessories.
  fixed?: 'anchor' | 'staple';
  // On a HOME session, the exact name of the routine anchor/staple this row is a
  // home stand-in for (e.g. "Band overhead press" stands in for "Seated DB
  // shoulder press"). Lets validation, ordering and the fixed badge treat the
  // stand-in as the anchor it replaces. Absent on gym rows and non-substitutes.
  standsInFor?: string;
  target: ProgrammeTarget;
  rationale: string;
  // Always concrete: filled from real history server-side, never from the model.
  lastSummary: string;
}

// A weekday of the standing weekly routine, distilled for the programmer. The
// anchors and staples are FIXED (must appear); accessories are the model's to
// rotate from history. `recentAccessories` is the rotation context: the
// accessories logged in the most recent session(s) of this same routine day.
export interface ProgrammerRoutineDay {
  title: string;
  note?: string;
  anchors: string[];
  staples: string[];
  rest?: boolean;
  recentAccessories?: string[];
}

export interface ProgrammerPlan {
  label?: string;
  components: string[];
  // The routine day this session is built from: anchors and staples are fixed,
  // accessories are AI-rotated. Absent for an ad-hoc session with no routine day.
  routineDay?: ProgrammerRoutineDay;
  // Set to 'home' when Dave has swapped this day to a home session: the
  // vocabulary keeps band/bodyweight work and drops gym-only equipment, and the
  // prompt asks the model to substitute a home stand-in for each gym anchor.
  // Absent (the default) is a gym session. Folded into the hash only when set, so
  // existing gym-day hashes are unchanged.
  venue?: 'home';
  // The plan's run distance, threaded in only on a HOME session so the outdoor
  // run keeps the planned distance. Folded into the hash only when defined, so a
  // gym day's hash never moves (it is never passed for a gym plan).
  targetDistanceKm?: number;
}

// One exercise's history as the model sees it: how often it has appeared (the
// frequency signal for core vs rotation) and its last few sessions.
export interface ProgrammerExercise {
  name: string;
  key: string;
  frequency: number;
  totalSessions: number;
  recent: ProgressionPoint[];
  lastSummary: string;
}

// An active exercise-section goal, as the programmer sees it: enough to graduate
// a session's targets toward it (a run-distance ramp sets the run target, a
// strength goal justifies pushing a lift) without the programmer touching the
// goals store itself.
export interface ProgrammerGoal {
  title: string;
  // "10 km", "12 sessions" — the overall target, formatted.
  target?: string;
  // "6 km by 15 Sep" — the next milestone still ahead on the plan.
  nextMilestone?: string;
  // Where the goal sits against its pace: 'ahead' | 'on-track' | 'behind' | …
  pace?: string;
}

export interface ProgrammerInput {
  date: string;
  plan: ProgrammerPlan;
  exercises: ProgrammerExercise[];
  // Active goals for the Exercise section, so this session moves toward them.
  goals?: ProgrammerGoal[];
}

// Gather the model's input from the plan and history: the plan's exercises,
// each with a frequency count and its last three sessions.
export function buildProgrammerInput(
  progressions: ExerciseProgression[],
  plan: ProgrammerPlan,
  date: string,
  totalSessions: number,
  goals: ProgrammerGoal[] = []
): ProgrammerInput {
  const routine = plan.routineDay;
  // A rest day generates nothing: no exercises, so generateProgramme short-
  // circuits and the day stays empty.
  if (routine?.rest) {
    return { date, plan, exercises: [], ...(goals.length > 0 ? { goals } : {}) };
  }

  // The rotation vocabulary: the plan's implied exercises, selected from history.
  // A one-group-plus-core day can carry ~7 pull staples plus ~4 core, right at
  // the old cap of 12; 16 gives the model the full relevant vocabulary.
  // On a GYM session band exercises are excluded inside selectPlanProgressions
  // (a home-workout last resort, never programmed into the gym); on a HOME
  // session it is reversed — band and bodyweight work is kept and gym-only
  // equipment dropped. The routine's fixed anchors/staples (extra) are NOT
  // filtered either way — the model needs them to know what to substitute for.
  const vocab = selectPlanProgressions(progressions, plan.components, 16, {
    venue: plan.venue,
  }).map(p => toProgrammerExercise(p, totalSessions));

  // The routine's fixed anchors and staples MUST be available to the model even
  // when they have no history yet, so validateProgramme can guarantee them.
  const fixed = routine ? [...routine.anchors, ...routine.staples] : [];
  const have = new Set(vocab.map(e => e.key));
  const extra: ProgrammerExercise[] = [];
  for (const name of fixed) {
    const key = exerciseKey(name);
    if (!key || have.has(key)) continue;
    have.add(key);
    extra.push(toProgrammerExerciseFor(name, progressions, totalSessions));
  }

  // A planned run must always have a name in the vocabulary, even when no run is
  // in the history and none of the routine's anchors/staples is a run (a Saturday
  // "Parkrun + core" or "Run (4 km) + core" day). When the plan activates the run
  // group and no cardio-classified name is present yet, inject the run
  // component's exercise name as a no-history stub, so the model has a run to
  // programme and guaranteeGroupCoverage can append one if the model omits it.
  // This adds a key to the hash, so a stale cached programme without a run
  // regenerates — intended.
  const cardioName = planCardioName(plan.components, plan.venue);
  if (cardioName && ![...vocab, ...extra].some(e => isCardioName(e.name))) {
    const cardioKey = exerciseKey(cardioName);
    if (cardioKey && !have.has(cardioKey)) {
      have.add(cardioKey);
      extra.push(toProgrammerExerciseFor(cardioName, progressions, totalSessions));
    }
  }

  // On a HOME day, offer a built-in band/bodyweight vocabulary as no-history
  // stubs so the model can build a full session even though Dave has logged few
  // home workouts. Filtered to the day's active groups (plus unclassifiable
  // band/bodyweight accessories) so the palette stays on the day's muscle focus.
  if (plan.venue === 'home') {
    const groups = activeGroups([...plan.components, ...(routine ? [routine.title] : [])]);
    for (const name of HOME_EXERCISES) {
      const key = exerciseKey(name);
      if (!key || have.has(key)) continue;
      const group = classifyExercise(name);
      if (group !== null && groups.length > 0 && !groups.includes(group)) continue;
      have.add(key);
      extra.push(toProgrammerExerciseFor(name, progressions, totalSessions));
    }
  }

  return { date, plan, exercises: [...vocab, ...extra], ...(goals.length > 0 ? { goals } : {}) };
}

function toProgrammerExercise(p: ExerciseProgression, totalSessions: number): ProgrammerExercise {
  return {
    name: p.name,
    key: p.key,
    frequency: p.sessions,
    totalSessions,
    recent: p.points.slice(-3),
    lastSummary: p.latest ? describeLast(p.latest) : 'no history',
  };
}

// A ProgrammerExercise for a named exercise, carrying its history where there is
// any and a frequency-0, no-history stub where there is not (an anchor/staple
// never logged). Keyed by the canonical name so it matches history spelling.
function toProgrammerExerciseFor(
  name: string,
  progressions: ExerciseProgression[],
  totalSessions: number
): ProgrammerExercise {
  const key = exerciseKey(name);
  const match = progressions.find(p => p.key === key);
  return match
    ? toProgrammerExercise(match, totalSessions)
    : { name, key, frequency: 0, totalSessions, recent: [], lastSummary: 'no history' };
}

// A stable fingerprint of everything the model reasons over. When it is
// unchanged, the cached programme still applies; when the plan or the history
// moves, the hash moves and the programme is regenerated.
export function programmeHash(input: ProgrammerInput): string {
  const canonical = JSON.stringify({
    components: [...input.plan.components].sort(),
    label: input.plan.label ?? '',
    exercises: input.exercises
      .map(e => ({
        key: e.key,
        frequency: e.frequency,
        recent: e.recent.map(pointFingerprint),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    // Goals move the targets, so a changed goal (or its next milestone) must
    // regenerate the programme.
    goals: (input.goals ?? [])
      .map(g => `${g.title}|${g.target ?? ''}|${g.nextMilestone ?? ''}|${g.pace ?? ''}`)
      .sort(),
    // A changed routine day (anchors, staples, title, note edited in the portal)
    // must regenerate the programme.
    routineDay: routineFingerprint(input.plan.routineDay),
    // Swapping the day to a home session (or back to the gym) must regenerate.
    // Included ONLY when set, so every existing gym-day hash is byte-identical to
    // before this field existed and its cached programme still applies. The run
    // distance rides along (home-only, defined-only) so a change to it regenerates
    // the home programme without touching any gym hash.
    ...(input.plan.venue ? { venue: input.plan.venue } : {}),
    ...(input.plan.targetDistanceKm !== undefined
      ? { targetDistanceKm: input.plan.targetDistanceKm }
      : {}),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// The routine day reduced to a stable string. Anchors and staples keep their
// order (a reorder is an edit); the derived rotation context is sorted. Empty
// when there is no routine day.
function routineFingerprint(day: ProgrammerRoutineDay | undefined): string {
  if (!day) return '';
  return JSON.stringify({
    title: day.title,
    note: day.note ?? '',
    anchors: day.anchors,
    staples: day.staples,
    rest: !!day.rest,
    recentAccessories: [...(day.recentAccessories ?? [])].sort(),
  });
}

function pointFingerprint(p: ProgressionPoint): string {
  return [
    p.date,
    p.sets ?? '',
    p.reps ?? '',
    p.holdSeconds ?? '',
    p.weightKg ?? '',
    p.durationMinutes ?? '',
    p.distanceKm ?? '',
    (p.notes ?? '').trim(),
  ].join('|');
}

// A compact, model-readable line for one past session of one exercise.
function pointLine(p: ProgressionPoint): string {
  const parts: string[] = [p.date];
  if (p.sets && p.reps) parts.push(`${p.sets}x${p.reps}`);
  if (p.sets && p.holdSeconds) parts.push(`${p.sets}x${p.holdSeconds}s`);
  if (p.weightKg !== undefined) parts.push(`${p.weightKg}kg`);
  if (p.durationMinutes !== undefined) parts.push(`${p.durationMinutes}min`);
  if (p.distanceKm !== undefined) parts.push(`${p.distanceKm}km`);
  if (p.notes) parts.push(`note: "${p.notes.replace(/\s+/g, ' ').trim().slice(0, 160)}"`);
  return parts.join(' · ');
}

function exerciseBlock(e: ProgrammerExercise): string {
  const history = e.recent.map(p => `    - ${pointLine(p)}`).join('\n');
  return `- ${e.name} (done in ${e.frequency}/${e.totalSessions} of these sessions)\n${history}`;
}

const PROMPT_HEADER = `You are programming one strength-and-cardio session for someone who logs every set. Below is the session's plan and, for each exercise in it, how often it appears and its last few sessions with the person's own notes (which read as effort to spare: "could have done 3-4 more", "held it 20s longer", "at limit", "struggled").

Program the session as a coach would. Apply this judgement:

- Core vs rotation. Some exercises are kept identical session to session so they can be driven up progressively; others are accessories that rotate in and out. Infer which is which from how often each exercise appears in these sessions — one present in most of them is a core lift; an occasional one is rotation. Tag each row "core", "rotation", "cardio" or "hold".
- Progressive loading, balancing weight AND volume. Do not only add weight. For a loaded lift decide whether to add weight, add reps, or add a set; for a timed hold add seconds per set or an extra set; for cardio add distance, duration or pace. Aim over time at a sensible mix that builds balanced fitness. Use the person's last effort notes: room to spare means room to progress; "at limit" or "struggled" means consolidate. Trust your judgement on the mix.
- How each kind progresses and reads. A loaded lift or rep-based bodyweight movement progresses by reps and weight, and its effort reads as reps in reserve. A timed HOLD (plank, hang, wall sit) progresses by seconds held per set or an added set, and its effort reads as "could have held it longer" — never in reps or weight. CARDIO progresses by distance, duration or pace, and its effort reads as perceived exertion (RPE), never as reps in reserve.
- Each side. Where a movement is worked one side at a time (side plank, single-arm/leg work, Pallof press, step-ups, split squats, lunges), set "perSide": true so the target reads "each side".
- Equipment practicality. Only suggest a load the equipment can actually make. Dumbbells and fixed weights jump in whole steps, not 0.5kg; machine stacks move about 2.5-5kg; barbells/plates change in 1.25 or 2.5kg. Consider the practicalities of typical gym equipment rather than a fine mathematical increment.
- Some exercises are variants of the same movement — in particular calf raises with and without a step ("Standing calf raise", "Standing calf raise (step)", "Standing calf raise (no step)"), and pull-up variants ("Pull-ups", "Neutral-grip pull-up", "Band-assisted pull-ups"). A session must include at most one variant of a movement: pick one, never both.
- Resistance band exercises are a home-workout tool: in a planned GYM session never include them or substitute band variants for gym lifts. (If a HOME SESSION block appears below, that rule is reversed — follow the home block.)
- Treat each part of the day's focus as its own mini-session: on a combined day (e.g. Pull + Legs) programme EACH group properly — a combined day is naturally longer than a single-group day, so do not thin out one group to make room for the other.
- Ordering. If the session includes a run or treadmill piece, put it FIRST. Include at most one run/cardio piece per session. After any cardio, order the rows as the REQUIRED anchors (in the order listed), then the REQUIRED staples, then the accessories — the fixed exercises come before the accessories.
- Treadmill and cardio targets. A treadmill piece is targeted in MINUTES, never distance (a logged number like "9.2" is a speed, not a distance). When you add duration to a cardio piece, add at most 5 minutes over the last logged duration — never back-solve a jump from a calendar title.
- Finish on a to-failure accessory. Every session ends with exactly ONE accessory finisher taken to failure, placed LAST. It MUST be safe to push to failure alone: a machine, cable or bodyweight movement — never cardio, and never a barbell or heavy dumbbell exercise (or a heavy compound anchor) where failing means dropping a weight.
- Always state last time concretely. Every rationale must reference what was actually done last time with real numbers (weights and reps, seconds for a hold, or minutes/distance for cardio).

Return ONLY a JSON array, in the order the exercises should be done, no prose, no code fences:
[{"name":"<exact exercise name from the input>","kind":"core|rotation|cardio|hold","toFailure":true|false,"target":{"sets":N,"reps":N,"holdSeconds":N,"perSide":true,"weightKg":N,"durationMinutes":N,"distanceKm":N},"standsInFor":"<the exact routine anchor/staple name this is a HOME stand-in for, only on a home session>","rationale":"<one sentence, cites last time's numbers>"}]

Include in "target" only the measures that fit the exercise: sets/reps/weightKg for a loaded lift, sets/reps for rep-based bodyweight, sets/holdSeconds for a timed hold (plank, hang, wall sit), durationMinutes/distanceKm for cardio. Add "perSide": true for anything worked one side at a time. Omit the rest.

`;

function goalBlock(g: ProgrammerGoal): string {
  const parts = [
    g.target ? `target ${g.target}` : '',
    g.nextMilestone ? `next milestone ${g.nextMilestone}` : '',
    g.pace ? `currently ${g.pace}` : '',
  ].filter(Boolean);
  return `- ${g.title}${parts.length ? ` (${parts.join('; ')})` : ''}`;
}

const GOALS_HEADER = `Active goals for this person's training. Where an exercise in this session maps to a goal — a run-distance goal to the run/treadmill piece, a strength goal to that lift — steer this session's target toward the goal's next milestone: enough to make progress toward it, never a reckless jump past what the history and effort notes support. If the person is behind on a goal, lean into it; if ahead, hold steady.

`;

// The equipment a home session has to work with. Exported so the copy is written
// once and reused by the prompt (and available to tests / the UI if needed).
export const HOME_EQUIPMENT = 'resistance bands, a pull-up bar and bodyweight only';

// A band/bodyweight stand-in for a gym lift: the movement plus a sensible home
// target (sets and reps, or seconds for a hold; perSide for unilateral work).
export interface HomeStandIn {
  name: string;
  sets: number;
  reps?: number;
  holdSeconds?: number;
  perSide?: boolean;
}

// The canonical home stand-ins for the common gym lifts, as rules mapping one or
// more gym-lift spellings to a single stand-in. This is the single source of
// truth: it drives the prompt's suggestions AND the server-side guarantee that
// every routine anchor/staple is covered on a home day (see guaranteeFixed).
const STAND_IN_RULES: Array<{ gym: string[]; standIn: HomeStandIn }> = [
  { gym: ['Seated DB shoulder press'], standIn: { name: 'Band overhead press', sets: 3, reps: 12 } },
  { gym: ['Incline DB press'], standIn: { name: 'Pike press-ups', sets: 3, reps: 8 } },
  {
    gym: ['Flat DB press', 'Converging chest press', 'Chest press'],
    standIn: { name: 'Press-ups', sets: 3, reps: 12 },
  },
  {
    gym: ['Wide-grip lat pulldown', 'Neutral-grip lat pulldown', 'Lat pulldown'],
    standIn: { name: 'Pull-ups or band-assisted pull-ups', sets: 3, reps: 6 },
  },
  {
    gym: ['Chest-supported DB row', 'Seated cable row', 'Cable row'],
    standIn: { name: 'Band rows', sets: 3, reps: 12 },
  },
  // Bodyweight squats, not a lunge: the reverse lunge was near-identical to the
  // Bulgarian split squat anchor it sat next to on home Pull + Legs days
  // (Dave, 27 Aug 2026).
  { gym: ['Leg press'], standIn: { name: 'Bodyweight squat', sets: 3, reps: 15 } },
  { gym: ['Seated leg curl'], standIn: { name: 'Glute bridge', sets: 3, reps: 15 } },
  {
    gym: ['Cable lateral raise', 'DB lateral raise'],
    standIn: { name: 'Band lateral raise', sets: 3, reps: 15 },
  },
  {
    gym: ['Cable pushdown', 'Cable tricep pushdown'],
    standIn: { name: 'Band tricep pressdowns or overhead extensions', sets: 3, reps: 12 },
  },
];

// The stand-in map keyed by the exerciseKey of each gym lift, so a routine
// anchor/staple (however spelled) can be looked up and covered. Exported for the
// prompt, the guarantee and tests.
export const HOME_STAND_INS: Record<string, HomeStandIn> = STAND_IN_RULES.reduce(
  (acc, rule) => {
    for (const gym of rule.gym) {
      const key = exerciseKey(gym);
      if (key) acc[key] = rule.standIn;
    }
    return acc;
  },
  {} as Record<string, HomeStandIn>
);

// A built-in band/bodyweight vocabulary offered as no-history stubs on home days,
// so the model has enough to build a full session even though Dave has logged few
// home workouts. The stand-in movements plus a spread of common band/bodyweight
// and core work; 'Outdoor run' so a home run has a name to use.
export const HOME_EXERCISES: string[] = [
  ...STAND_IN_RULES.map(r => r.standIn.name),
  'Band face pulls',
  'Band pull-aparts',
  'Band front raise',
  'Band curls',
  'Dead hang',
  'Plank',
  'Side plank',
  'Dead bug',
  'Press-ups',
  'Slow push-ups',
  'Diamond press-ups',
  'Pike press-ups',
  'Bulgarian split squat',
  'Bodyweight squat',
  'Glute bridge',
  'Reverse lunge',
  'Calf raise',
  'Outdoor run',
];

// The stand-in suggestion lines for the prompt, rendered from the canonical map.
function standInSuggestions(): string {
  return STAND_IN_RULES.map(r => {
    const vol = r.standIn.holdSeconds
      ? `${r.standIn.sets}×${r.standIn.holdSeconds}s`
      : `${r.standIn.sets}×${r.standIn.reps}`;
    const side = r.standIn.perSide ? ' each side' : '';
    return `    - ${r.gym[0]} → ${r.standIn.name} (${vol}${side})`;
  }).join('\n');
}

// The home-session block: appended to the prompt when the day has been swapped to
// a home workout. It reverses the band rule, fixes the equipment, gives the
// canonical stand-ins, moves cardio outdoors, and asks for a full session that
// holds the day's muscle focus.
function buildHomeBlock(
  day: ProgrammerRoutineDay | undefined,
  targetDistanceKm: number | undefined
): string {
  const anchors = day ? [...day.anchors, ...day.staples] : [];
  const runTarget = targetDistanceKm
    ? `target ${targetDistanceKm} km as the run's distanceKm`
    : "match the plan's distance";
  const lines: string[] = [
    `HOME SESSION — this session is done at home. Equipment is ${HOME_EQUIPMENT}. This overrides the band rule above: bands and bodyweight are now your PRIMARY tools.`,
    'Never programme a machine, cable, dumbbell or barbell lift — none of that exists here.',
    "For each REQUIRED routine anchor/staple that needs gym equipment, programme the closest home stand-in and set \"standsInFor\" to that anchor's exact name. Canonical stand-ins:",
    standInSuggestions(),
    'Band and bodyweight targets use sets and reps (or holdSeconds for a hold) — no weightKg.',
    `Cardio is done outdoors — name the run "Outdoor run" (never "Treadmill run") and ${runTarget}.`,
    "Keep the day's muscle focus (a Push day stays push — do not bolt on core unless the routine day already has core staples).",
    'Build a FULL session — aim for the same number of rows a gym session of this day would have, typically 6–8, all within the day’s muscle focus.',
    'Still finish on exactly ONE safe to-failure row.',
  ];
  if (anchors.length) {
    lines.push(`Anchors/staples to stand in for: ${anchors.join(', ')}.`);
  }
  return lines.join('\n');
}

// The routine block: the standing week's shape for this day. Anchors and staples
// are REQUIRED and must appear; accessories are the model's to rotate from the
// history below, keeping the day's muscle-group focus.
function buildRoutineBlock(day: ProgrammerRoutineDay): string {
  const lines: string[] = [
    day.note ? `Day focus: ${day.title} — ${day.note}` : `Day focus: ${day.title}`,
  ];
  if (day.anchors.length) {
    lines.push(
      `REQUIRED anchors — these MUST appear, and are driven up progressively (beat last time): ${day.anchors.join(', ')}.`
    );
  }
  if (day.staples.length) {
    lines.push(`REQUIRED staples — always include these: ${day.staples.join(', ')}.`);
  }
  lines.push(
    `Then ADD about 3–5 accessories chosen from the exercise history below, keeping this day's muscle-group focus. You may order the anchors and staples within the session as a coach would. Vary the accessories week to week, but revisit them within a training cycle rather than never repeating one.`
  );
  if (day.recentAccessories?.length) {
    lines.push(
      `Accessories used in the most recent session(s) of this day: ${day.recentAccessories.join(', ')} — prefer rotating to different ones this week.`
    );
  }
  return lines.join('\n');
}

// Build the full prompt from the gathered input.
export function buildProgrammerPrompt(input: ProgrammerInput): string {
  const planLabel = input.plan.label || input.plan.components.join(' + ') || 'session';
  const components = input.plan.components.length
    ? `Components: ${input.plan.components.join(', ')}`
    : 'Components: (none recorded)';
  const routine = input.plan.routineDay ? `\n\n${buildRoutineBlock(input.plan.routineDay)}` : '';
  const home =
    input.plan.venue === 'home'
      ? `\n\n${buildHomeBlock(input.plan.routineDay, input.plan.targetDistanceKm)}`
      : '';
  const exercises = input.exercises.map(exerciseBlock).join('\n');
  const goals =
    input.goals && input.goals.length > 0
      ? `\n\n${GOALS_HEADER}${input.goals.map(goalBlock).join('\n')}`
      : '';
  // Name the cardio row for the model on a run day, so it emits (say) "Parkrun"
  // rather than a generic run — the guaranteed cardio stub uses the same name, so
  // the two agree whether the model programmes the run or the coverage floor does.
  const cardioName = planCardioName(input.plan.components, input.plan.venue);
  const cardio = cardioName
    ? `\n\nThis session includes a run — name the cardio row exactly "${cardioName}" (kind "cardio", placed first).`
    : '';
  return `${PROMPT_HEADER}Session: ${planLabel}
${components}${routine}${home}${cardio}

Exercises available (with recent history):
${exercises}${goals}`;
}

const KINDS: ExerciseKind[] = ['core', 'rotation', 'cardio', 'hold'];

// The most recent logged duration for an exercise, read newest-first out of its
// recent history. Undefined when nothing timed has been logged.
function lastLoggedDurationMinutes(recent: ProgressionPoint[]): number | undefined {
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].durationMinutes !== undefined) return recent[i].durationMinutes;
  }
  return undefined;
}

// `cardio`, when passed, is the row's exercise name and history — supplied only
// for a cardio row so its target can be corrected against reality: a treadmill
// piece is time-only (distance stripped, a missing duration filled from
// history), and any cardio duration is capped at +5 minutes over the last one
// logged so the model can't back-solve a wild jump. The cap is upward-only, so a
// deliberate deload survives.
function cleanTarget(raw: unknown, cardio?: { name: string; recent: ProgressionPoint[] }): ProgrammeTarget {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  const out: ProgrammeTarget = {};
  const sets = num(t.sets);
  const reps = num(t.reps);
  const holdSeconds = num(t.holdSeconds);
  const weightKg = num(t.weightKg);
  const durationMinutes = num(t.durationMinutes);
  const distanceKm = num(t.distanceKm);
  if (sets !== undefined) out.sets = Math.round(sets);
  if (reps !== undefined) out.reps = Math.round(reps);
  if (holdSeconds !== undefined) out.holdSeconds = Math.round(holdSeconds);
  if (weightKg !== undefined) out.weightKg = weightKg;
  if (durationMinutes !== undefined) out.durationMinutes = durationMinutes;
  if (distanceKm !== undefined) out.distanceKm = distanceKm;
  if (t.perSide === true) out.perSide = true;

  if (cardio) {
    const lastDuration = lastLoggedDurationMinutes(cardio.recent);
    if (/treadmill/i.test(cardio.name)) {
      delete out.distanceKm;
      if (out.durationMinutes === undefined && lastDuration !== undefined) {
        out.durationMinutes = lastDuration;
      }
    }
    if (out.durationMinutes !== undefined && lastDuration !== undefined) {
      out.durationMinutes = Math.min(out.durationMinutes, lastDuration + 5);
    }
  }
  return out;
}

// Mutually-exclusive exercise variants: exercises that are variants of the same
// movement, of which a session must contain at most ONE. Dave's rules, 27 Aug
// 2026: never a step and a no-step calf raise in the same session, and never
// two pull-up rows (his 27 Aug home session paired "Pull-ups or band-assisted
// pull-ups" — the lat-pulldown stand-in — with a "Neutral-grip pull-up"
// accessory; on a home bar those are the same movement). The variant spellings
// stay distinct exercises with separate histories, but only one may be
// programmed on any given day. "Lat pulldown" and "Face pull" don't match the
// pull-up pattern, so a gym Pull day keeps its pulldown alongside nothing worse.
//
// Each rule maps a name-matcher to a group id; the first row whose name belongs
// to a group survives, later ones in that group are dropped (like the single-
// cardio rule). To add a new exclusion, append a rule here — nothing else changes.
const EXCLUSIVE_VARIANT_RULES: Array<{ match: (name: string) => boolean; group: string }> = [
  { match: name => /calf raise/i.test(name), group: 'calf-raise' },
  { match: name => /pull[- ]?ups?\b/i.test(name), group: 'pull-up' },
];

// The exclusive-variant group an exercise belongs to, or undefined if it belongs
// to none. Exported for tests and any caller that needs to reason about variants.
export function exclusiveGroup(name: string): string | undefined {
  return EXCLUSIVE_VARIANT_RULES.find(rule => rule.match(name))?.group;
}

// Claim an exercise's exclusive-variant group: true when it may be included
// (it belongs to no group, or to one not yet taken — which this call then
// takes), false when its group is already spoken for. Every path that appends
// a row shares one `seenVariantGroups` set, so the first variant wins wherever
// it came from.
function claimVariantGroup(name: string, seenVariantGroups: Set<string>): boolean {
  const group = exclusiveGroup(name);
  if (!group) return true;
  if (seenVariantGroups.has(group)) return false;
  seenVariantGroups.add(group);
  return true;
}

// Keep the first row of each exclusive-variant group, drop any later ones (a
// second calf-raise). A pure pass over already-built rows: used on the cached
// read path to fix programmes cached before the exclusion rule, which re-runs
// post-processing without regenerating. Rows in no group are always kept.
export function dropExclusiveDuplicates(rows: ProgrammeRow[]): ProgrammeRow[] {
  const seenVariantGroups = new Set<string>();
  return rows.filter(row => claimVariantGroup(row.name, seenVariantGroups));
}

// Turn the model's raw records into validated rows. Drops anything malformed or
// naming an exercise not in the input, overrides lastSummary with real history
// (so the numbers are never hallucinated), and enforces the safety rules on the
// to-failure marker: at most one, on the final row, never on an unsafe lift.
export function validateProgramme(
  records: Record<string, unknown>[],
  input: ProgrammerInput
): ProgrammeRow[] {
  const byKey = new Map(input.exercises.map(e => [e.key, e]));

  // The day's FIXED lifts, so a "standsInFor" the model returns is only honoured
  // when it names a real anchor or staple (a stray value is dropped). Home only.
  const day = input.plan.routineDay;
  const fixedKeyToName = new Map<string, string>();
  if (input.plan.venue === 'home' && day) {
    for (const name of [...day.anchors, ...day.staples]) {
      const key = exerciseKey(name);
      if (key && !fixedKeyToName.has(key)) fixedKeyToName.set(key, name);
    }
  }

  const home = input.plan.venue === 'home';

  const rows: ProgrammeRow[] = [];
  const seen = new Set<string>();
  // The exclusive-variant groups already present: at most one variant per group
  // (e.g. one calf-raise spelling), the first survives, the rest are dropped —
  // shared with the append paths so padding never adds a second variant either.
  const seenVariantGroups = new Set<string>();
  // At most one cardio piece per session: the first survives, the rest are
  // dropped so a day never carries two runs.
  let sawCardio = false;
  for (const record of records) {
    let name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    // At home there is no treadmill: any treadmill row is the outdoor run, so
    // rename it (and recompute its key) before looking it up.
    if (home && /treadmill/i.test(name)) name = 'Outdoor run';
    const key = exerciseKey(name);
    const known = byKey.get(key);
    if (!known || seen.has(key)) continue; // unknown or duplicate exercise
    // A second variant of an exclusive group (a second calf-raise) — drop it.
    if (!claimVariantGroup(known.name, seenVariantGroups)) continue;
    seen.add(key);

    const kind = KINDS.includes(record.kind as ExerciseKind)
      ? (record.kind as ExerciseKind)
      : 'rotation';
    if (kind === 'cardio') {
      if (sawCardio) continue; // second cardio piece — drop it
      sawCardio = true;
    }
    const target = cleanTarget(
      record.target,
      kind === 'cardio' ? { name: known.name, recent: known.recent } : undefined
    );
    // A home run keeps the plan's distance when the model omitted one.
    if (
      home &&
      kind === 'cardio' &&
      input.plan.targetDistanceKm !== undefined &&
      target.distanceKm === undefined
    ) {
      target.distanceKm = input.plan.targetDistanceKm;
    }
    const rationale =
      typeof record.rationale === 'string' && record.rationale.trim()
        ? record.rationale.trim().slice(0, 200)
        : `Last time: ${known.lastSummary}.`;

    // A home stand-in: honoured only when it names a real anchor/staple and the
    // row is not itself that fixed lift (a fixed lift already covers itself).
    const standsInForKey =
      typeof record.standsInFor === 'string' ? exerciseKey(record.standsInFor) : '';
    const standsInFor =
      standsInForKey && standsInForKey !== key && fixedKeyToName.has(standsInForKey)
        ? fixedKeyToName.get(standsInForKey)
        : undefined;

    rows.push({
      name: known.name,
      key,
      kind,
      toFailure: record.toFailure === true,
      ...(standsInFor ? { standsInFor } : {}),
      target,
      rationale,
      lastSummary: known.lastSummary,
    });
  }

  const covered = guaranteeGroupCoverage(
    guaranteeFixed(rows, seen, seenVariantGroups, input),
    seen,
    seenVariantGroups,
    input
  );
  return enforceToFailure(
    orderProgrammeRows(markFixed(covered, input.plan.routineDay), input.plan.routineDay)
  );
}

// Per-group minimum row counts, ENFORCED here rather than merely suggested in the
// prompt (the model reliably ignores the instruction and thins one group). On a
// combined day — Pull + Legs returning ~8 lopsided rows with one group starved —
// each active strength group is floored at MIN_STRENGTH_ROWS and core at
// MIN_CORE_ROWS, matching Dave's own history (combined days at 10–11 exercises,
// single-group days 5–6).
const MIN_STRENGTH_ROWS = 5;
const MIN_CORE_ROWS = 3;

// The floor for a group. The 'run' group is floored at ONE so a planned run
// always yields a cardio row even when the model omits it; the single-cardio
// rule in validateProgramme still caps it at one, so the floor never produces a
// second run.
function groupMinimum(group: Group): number {
  if (group === 'run') return 1;
  return group === 'core' ? MIN_CORE_ROWS : MIN_STRENGTH_ROWS;
}

// Enforce each active group's minimum row count. For every strength/core group
// the day activates, count its rows and, while short of the floor, append the
// group's most-trained UNUSED vocabulary exercises (input.exercises is
// most-trained first) with a deterministic fallback target — exactly as
// guaranteeFixed appends a dropped anchor. Capped by what the vocabulary holds:
// a group with only four known exercises tops out at four, never invents one.
// Runs before ordering and the to-failure marker so both apply to the final set.
function guaranteeGroupCoverage(
  rows: ProgrammeRow[],
  seen: Set<string>,
  seenVariantGroups: Set<string>,
  input: ProgrammerInput
): ProgrammeRow[] {
  const day = input.plan.routineDay;
  if (!day) return rows;

  // The day's active groups, read from its components and its routine title so a
  // combined "Pull + Legs" surfaces both even when components arrive empty.
  const groups = activeGroups([...input.plan.components, day.title]);
  const out = [...rows];
  // Home: never pad a group with gym-only equipment (a machine/cable/barbell/
  // dumbbell lift) — the vocabulary carries the routine's gym anchors as no-history
  // stubs so the model can substitute for them, but they must not be appended.
  const home = input.plan.venue === 'home';

  for (const group of groups) {
    const min = groupMinimum(group);
    if (min === 0) continue;
    let count = out.filter(r => classifyExercise(r.name) === group).length;
    for (const known of input.exercises) {
      if (count >= min) break;
      if (seen.has(known.key) || classifyExercise(known.name) !== group) continue;
      if (home && !isHomeExercise(known)) continue;
      // Skip a candidate whose exclusive-variant group is already present (a
      // second calf-raise), so padding never adds one.
      if (!claimVariantGroup(known.name, seenVariantGroups)) continue;
      seen.add(known.key);
      const hasHistory = known.lastSummary !== 'no history';
      out.push({
        name: known.name,
        key: known.key,
        kind: inferKind(known.name),
        toFailure: false,
        target: fallbackTarget(known, input.plan.targetDistanceKm),
        rationale: hasHistory
          ? `Added for ${group} balance — last time ${known.lastSummary}.`
          : `Added for ${group} balance — no history yet, log a baseline.`,
        lastSummary: known.lastSummary,
      });
      count += 1;
    }
  }
  return out;
}

// Stamp the FIXED provenance on rows that are the routine day's anchors or
// staples, matched by exerciseKey. Applied to the whole row set (model-returned
// and guaranteeFixed-appended alike) so the checklist can badge every fixed lift
// "Anchor"/"Staple", however it reached the programme. Exported so the cached
// path can stamp older programmes without regenerating them.
export function markFixed(rows: ProgrammeRow[], day?: ProgrammerRoutineDay): ProgrammeRow[] {
  if (!day) return rows;
  const anchorKeys = new Set(day.anchors.map(exerciseKey).filter(Boolean));
  const stapleKeys = new Set(day.staples.map(exerciseKey).filter(Boolean));
  // A home stand-in is badged as the anchor/staple it stands in for, matched by
  // its `standsInFor` key when the row itself is not a fixed lift.
  return rows.map(row => {
    const standInKey = row.standsInFor ? exerciseKey(row.standsInFor) : '';
    if (anchorKeys.has(row.key) || (standInKey && anchorKeys.has(standInKey)))
      return { ...row, fixed: 'anchor' as const };
    if (stapleKeys.has(row.key) || (standInKey && stapleKeys.has(standInKey)))
      return { ...row, fixed: 'staple' as const };
    return row;
  });
}

// Deterministic row order for the checklist, independent of the order the model
// returned: cardio rows first (keeping their relative order — there is at most
// one after the single-cardio rule), then the day's anchors in routine order,
// then its staples in routine order, then everything else in its original order.
// Anchors and staples are matched to rows by exerciseKey(). Without a routine day
// there is no fixed order to impose, so the rows are returned unchanged.
export function orderProgrammeRows(
  rows: ProgrammeRow[],
  day?: ProgrammerRoutineDay
): ProgrammeRow[] {
  if (!day) return rows;

  const rankOf = (names: string[]): Map<string, number> => {
    const rank = new Map<string, number>();
    names.forEach((name, i) => {
      const key = exerciseKey(name);
      if (key && !rank.has(key)) rank.set(key, i);
    });
    return rank;
  };
  const anchorRank = rankOf(day.anchors);
  const stapleRank = rankOf(day.staples);

  // Bucket each row (0 cardio, 1 anchor, 2 staple, 3 the rest); within a bucket
  // the rank is the routine order for anchors/staples and the original index for
  // cardio and the rest. A stable sort by (bucket, rank) is the whole rule.
  // A home stand-in orders in the bucket of the anchor/staple it replaces, so it
  // sits where that fixed lift would have — matched by key, or by standsInFor.
  const ranked = rows.map((row, index) => {
    if (row.kind === 'cardio') return { row, bucket: 0, rank: index };
    const standInKey = row.standsInFor ? exerciseKey(row.standsInFor) : '';
    const anchor = anchorRank.get(row.key) ?? (standInKey ? anchorRank.get(standInKey) : undefined);
    if (anchor !== undefined) return { row, bucket: 1, rank: anchor };
    const staple = stapleRank.get(row.key) ?? (standInKey ? stapleRank.get(standInKey) : undefined);
    if (staple !== undefined) return { row, bucket: 2, rank: staple };
    return { row, bucket: 3, rank: index };
  });
  ranked.sort((a, b) => a.bucket - b.bucket || a.rank - b.rank);
  return ranked.map(r => r.row);
}

// The routine's anchors and staples are FIXED: whatever the model returned, any
// the model dropped are appended here (anchors first, then staples) with a
// deterministic fallback target read from history, so the guarantee holds
// however the model behaved. Each carries the exercise's real last summary.
function guaranteeFixed(
  rows: ProgrammeRow[],
  seen: Set<string>,
  seenVariantGroups: Set<string>,
  input: ProgrammerInput
): ProgrammeRow[] {
  const day = input.plan.routineDay;
  if (!day) return rows;
  const byKey = new Map(input.exercises.map(e => [e.key, e]));
  const out = [...rows];
  const home = input.plan.venue === 'home';
  // On a home session a fixed lift is already satisfied by a row that stands in
  // for it, so it must not be appended a second time.
  const standInKeys = new Set(
    rows.map(r => (r.standsInFor ? exerciseKey(r.standsInFor) : '')).filter(Boolean)
  );

  const appendMissing = (names: string[], anchor: boolean) => {
    for (const name of names) {
      const key = exerciseKey(name);
      if (!key || seen.has(key)) continue;
      const known = byKey.get(key);
      if (!known) continue; // buildProgrammerInput guarantees it, but stay safe
      // A fixed lift that is a second variant of an exclusive group (a second
      // calf-raise) is skipped, so a session never carries two variants. The
      // group is only claimed once the row is actually appended below — the
      // home paths between here and there can still bail out.
      const variantGroup = exclusiveGroup(known.name);
      if (variantGroup && seenVariantGroups.has(variantGroup)) continue;

      if (home) {
        // Already covered by a model stand-in — nothing to add.
        if (standInKeys.has(key)) continue;
        const canDoAtHome = isHomeExercise(known);
        // A gym lift that can't be done at home: cover it with its canonical home
        // stand-in (badged as the fixed lift by markFixed). This GUARANTEES every
        // anchor/staple is covered on a home day, however the model behaved.
        if (!canDoAtHome) {
          const mapping = HOME_STAND_INS[key];
          if (!mapping) continue; // no stand-in known — the only case we skip
          const standKey = exerciseKey(mapping.name);
          seen.add(key);
          if (!standKey || seen.has(standKey)) continue;
          seen.add(standKey);
          out.push({
            name: mapping.name,
            key: standKey,
            kind: 'core',
            toFailure: false,
            standsInFor: name,
            target: {
              sets: mapping.sets,
              ...(mapping.reps !== undefined ? { reps: mapping.reps } : {}),
              ...(mapping.holdSeconds !== undefined ? { holdSeconds: mapping.holdSeconds } : {}),
              ...(mapping.perSide ? { perSide: true } : {}),
            },
            rationale: `Home stand-in for ${name}.`,
            lastSummary: 'no history',
          });
          continue;
        }
        // Otherwise it is a band/bodyweight fixed lift — append it as normal below.
      }

      seen.add(key);
      if (variantGroup) seenVariantGroups.add(variantGroup);
      const hasHistory = known.lastSummary !== 'no history';
      out.push({
        name: known.name,
        key,
        kind: anchor ? 'core' : inferKind(known.name),
        toFailure: false,
        target: fallbackTarget(known, input.plan.targetDistanceKm),
        rationale: hasHistory
          ? `Fixed ${anchor ? 'anchor' : 'staple'} — last time ${known.lastSummary}.`
          : `Fixed ${anchor ? 'anchor' : 'staple'} — no history yet, log a baseline.`,
        lastSummary: known.lastSummary,
      });
    }
  };

  appendMissing(day.anchors, true);
  appendMissing(day.staples, false);
  return out;
}

// The kind of a fixed exercise the model dropped, inferred from its name for the
// checklist's grouping and badges. Anchors are always 'core'; staples fall here.
function inferKind(name: string): ExerciseKind {
  if (isCardioName(name)) return 'cardio';
  if (isHoldName(name)) return 'hold';
  return 'core';
}

// A deterministic target for a dropped fixed exercise, taken from its most
// recent logged session so the row is never blank. With no history to seed from
// (a brand-new anchor/staple, or a first planned run), a cardio run still takes
// the plan's distance when one is known so the guaranteed run row isn't blank —
// mirroring validateProgramme's home-run distance fill; otherwise empty.
function fallbackTarget(e: ProgrammerExercise, targetDistanceKm?: number): ProgrammeTarget {
  const last = e.recent[e.recent.length - 1];
  if (!last) {
    if (targetDistanceKm !== undefined && isCardioName(e.name)) {
      return { distanceKm: targetDistanceKm };
    }
    return {};
  }
  return cleanTarget({
    sets: last.sets,
    reps: last.reps,
    holdSeconds: last.holdSeconds,
    weightKg: last.weightKg,
    durationMinutes: last.durationMinutes,
    distanceKm: last.distanceKm,
    perSide: last.perSide,
  });
}

// A row the session can safely finish on: never cardio (a run is no finisher),
// never a lift unsafe to fail alone.
function isSafeFinisher(row: ProgrammeRow): boolean {
  return row.kind !== 'cardio' && isSafeToFailure(row.name);
}

function lastIndexWhere(rows: ProgrammeRow[], pick: (row: ProgrammeRow) => boolean): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (pick(rows[i])) return i;
  }
  return -1;
}

// Exactly one finisher: an accessory taken to failure, as the LAST row. Clears
// every model-set marker, chooses one suitable finisher (never cardio, never a
// lift unsafe to fail alone, and — where one is available — not a heavy compound
// anchor), moves it to the end and marks it. So the guarantee (one finisher,
// last) holds however the model tagged or ordered things.
export function enforceToFailure(rows: ProgrammeRow[]): ProgrammeRow[] {
  const cleared = rows.map(r => ({ ...r, toFailure: false }));
  // Prefer an accessory over a heavy compound anchor; fall back to any safe row.
  let idx = lastIndexWhere(cleared, r => isSafeFinisher(r) && r.fixed !== 'anchor');
  if (idx === -1) idx = lastIndexWhere(cleared, isSafeFinisher);
  if (idx === -1) return cleared; // nothing safe to finish on (e.g. a pure run)
  const [finisher] = cleared.splice(idx, 1);
  finisher.toFailure = true;
  cleared.push(finisher);
  return cleared;
}

// Generate the programme, or null if the model is unavailable or returns nothing
// usable. `run` is injectable so tests drive it without spawning Claude.
export async function generateProgramme(
  input: ProgrammerInput,
  opts: { run?: (prompt: string) => Promise<string>; timeoutSeconds?: number } = {}
): Promise<ProgrammeRow[] | null> {
  if (input.exercises.length === 0) return null;
  const run = opts.run ?? ((prompt: string) => runClaudeText(prompt, { timeoutSeconds: opts.timeoutSeconds ?? 180 }));
  try {
    const text = await run(buildProgrammerPrompt(input));
    const rows = validateProgramme(extractJsonArray(text), input);
    return rows.length > 0 ? rows : null;
  } catch (error) {
    console.error('Exercise programme generation failed:', error);
    return null;
  }
}

// A generated programme row rendered as an ExerciseTarget, so the Today
// checklist consumes AI rows and deterministic targets through one shape.
export function programmeRowToTarget(row: ProgrammeRow): ExerciseTarget {
  return {
    name: row.name,
    key: row.key,
    kind: row.kind,
    toFailure: row.toFailure,
    rationale: row.rationale,
    lastSummary: row.lastSummary,
    ...(row.fixed ? { fixed: row.fixed } : {}),
    ...(row.standsInFor ? { standsInFor: row.standsInFor } : {}),
    ...(row.target.sets !== undefined ? { sets: row.target.sets } : {}),
    ...(row.target.reps !== undefined ? { reps: row.target.reps } : {}),
    ...(row.target.holdSeconds !== undefined ? { holdSeconds: row.target.holdSeconds } : {}),
    ...(row.target.perSide ? { perSide: true } : {}),
    ...(row.target.weightKg !== undefined ? { weightKg: row.target.weightKg } : {}),
    ...(row.target.durationMinutes !== undefined ? { durationMinutes: row.target.durationMinutes } : {}),
    ...(row.target.distanceKm !== undefined ? { distanceKm: row.target.distanceKm } : {}),
  };
}
