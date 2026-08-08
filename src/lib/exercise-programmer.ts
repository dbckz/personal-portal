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
import {
  describeLast,
  selectPlanProgressions,
  type ExerciseKind,
  type ExerciseTarget,
} from './exercise-targets';

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
  target: ProgrammeTarget;
  rationale: string;
  // Always concrete: filled from real history server-side, never from the model.
  lastSummary: string;
}

export interface ProgrammerPlan {
  label?: string;
  components: string[];
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
  const relevant = selectPlanProgressions(progressions, plan.components, 12);
  const exercises: ProgrammerExercise[] = relevant.map(p => ({
    name: p.name,
    key: p.key,
    frequency: p.sessions,
    totalSessions,
    recent: p.points.slice(-3),
    lastSummary: p.latest ? describeLast(p.latest) : 'no history',
  }));
  return { date, plan, exercises, ...(goals.length > 0 ? { goals } : {}) };
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
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
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
- Ordering. If the session includes a run or treadmill piece, put it FIRST.
- Finish to failure — safely. Mark exactly ONE exercise as the last set to failure, and make it the final row. It MUST be an exercise that is safe to push to failure alone: a machine, cable or bodyweight movement. Never a barbell or heavy dumbbell exercise where failing means dropping a weight.
- Always state last time concretely. Every rationale must reference what was actually done last time with real numbers (weights and reps, seconds for a hold, or minutes/distance for cardio).

Return ONLY a JSON array, in the order the exercises should be done, no prose, no code fences:
[{"name":"<exact exercise name from the input>","kind":"core|rotation|cardio|hold","toFailure":true|false,"target":{"sets":N,"reps":N,"holdSeconds":N,"perSide":true,"weightKg":N,"durationMinutes":N,"distanceKm":N},"rationale":"<one sentence, cites last time's numbers>"}]

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

// Build the full prompt from the gathered input.
export function buildProgrammerPrompt(input: ProgrammerInput): string {
  const planLabel = input.plan.label || input.plan.components.join(' + ') || 'session';
  const components = input.plan.components.length
    ? `Components: ${input.plan.components.join(', ')}`
    : 'Components: (none recorded)';
  const exercises = input.exercises.map(exerciseBlock).join('\n');
  const goals =
    input.goals && input.goals.length > 0
      ? `\n\n${GOALS_HEADER}${input.goals.map(goalBlock).join('\n')}`
      : '';
  return `${PROMPT_HEADER}Session: ${planLabel}
${components}

Exercises available (with recent history):
${exercises}${goals}`;
}

// Names that make an exercise unsafe to take to failure unsupported — dropping a
// loaded barbell or heavy dumbbell alone is how people get hurt.
const UNSAFE_TO_FAILURE = /\b(barbell|bench press|dumbbell|db |overhead press|deadlift|squat)\b/i;

function isSafeToFailure(name: string): boolean {
  return !UNSAFE_TO_FAILURE.test(name);
}

const KINDS: ExerciseKind[] = ['core', 'rotation', 'cardio', 'hold'];

function cleanTarget(raw: unknown): ProgrammeTarget {
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
  return out;
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

  const rows: ProgrammeRow[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    const key = exerciseKey(name);
    const known = byKey.get(key);
    if (!known || seen.has(key)) continue; // unknown or duplicate exercise
    seen.add(key);

    const kind = KINDS.includes(record.kind as ExerciseKind)
      ? (record.kind as ExerciseKind)
      : 'rotation';
    const target = cleanTarget(record.target);
    const rationale =
      typeof record.rationale === 'string' && record.rationale.trim()
        ? record.rationale.trim().slice(0, 200)
        : `Last time: ${known.lastSummary}.`;

    rows.push({
      name: known.name,
      key,
      kind,
      toFailure: record.toFailure === true,
      target,
      rationale,
      lastSummary: known.lastSummary,
    });
  }

  return enforceToFailure(rows);
}

// Exactly one to-failure marker, on the last safe row. Clears every model-set
// marker, then re-marks the final row that is safe to fail — so the guarantee
// holds however the model tagged things.
function enforceToFailure(rows: ProgrammeRow[]): ProgrammeRow[] {
  const cleared = rows.map(r => ({ ...r, toFailure: false }));
  for (let i = cleared.length - 1; i >= 0; i--) {
    if (isSafeToFailure(cleared[i].name)) {
      cleared[i].toFailure = true;
      break;
    }
  }
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
    ...(row.target.sets !== undefined ? { sets: row.target.sets } : {}),
    ...(row.target.reps !== undefined ? { reps: row.target.reps } : {}),
    ...(row.target.holdSeconds !== undefined ? { holdSeconds: row.target.holdSeconds } : {}),
    ...(row.target.perSide ? { perSide: true } : {}),
    ...(row.target.weightKg !== undefined ? { weightKg: row.target.weightKg } : {}),
    ...(row.target.durationMinutes !== undefined ? { durationMinutes: row.target.durationMinutes } : {}),
    ...(row.target.distanceKm !== undefined ? { distanceKm: row.target.distanceKm } : {}),
  };
}
