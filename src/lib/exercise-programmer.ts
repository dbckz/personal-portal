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
  selectPlanProgressions,
  type ExerciseKind,
  type ExerciseTarget,
  type Group,
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
  // One of the day's FIXED lifts (a routine anchor or staple), matched by key
  // against the routine day. Threaded to the checklist's "Anchor"/"Staple"
  // badge. Absent on rotating accessories.
  fixed?: 'anchor' | 'staple';
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

// Resistance-band exercises are a home-workout last resort, not part of a
// planned gym session: they only appear in the log from the occasional home
// fallback. The word boundary keeps "Band rows"/"band-assisted pull-ups" in
// while leaving "broadband" (no boundary) out.
export function isBandExercise(name: string): boolean {
  return /\bband\b/i.test(name);
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
  // Band exercises are filtered out of the derived vocabulary: they exist in the
  // log only as a home-workout last resort, and must never be programmed into a
  // planned gym session. The routine's fixed anchors/staples (extra) are NOT
  // filtered — if Dave explicitly puts a band exercise in the routine, it stays.
  const vocab = selectPlanProgressions(progressions, plan.components, 16)
    .filter(p => !isBandExercise(p.name))
    .map(p => toProgrammerExercise(p, totalSessions));

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
- Resistance band exercises are a home-workout fallback only, never to be included in a planned gym session; do not substitute band variants for gym lifts.
- Treat each part of the day's focus as its own mini-session: on a combined day (e.g. Pull + Legs) programme EACH group properly — a combined day is naturally longer than a single-group day, so do not thin out one group to make room for the other.
- Ordering. If the session includes a run or treadmill piece, put it FIRST. Include at most one run/cardio piece per session. After any cardio, order the rows as the REQUIRED anchors (in the order listed), then the REQUIRED staples, then the accessories — the fixed exercises come before the accessories.
- Treadmill and cardio targets. A treadmill piece is targeted in MINUTES, never distance (a logged number like "9.2" is a speed, not a distance). When you add duration to a cardio piece, add at most 5 minutes over the last logged duration — never back-solve a jump from a calendar title.
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
  const exercises = input.exercises.map(exerciseBlock).join('\n');
  const goals =
    input.goals && input.goals.length > 0
      ? `\n\n${GOALS_HEADER}${input.goals.map(goalBlock).join('\n')}`
      : '';
  return `${PROMPT_HEADER}Session: ${planLabel}
${components}${routine}

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
  // At most one cardio piece per session: the first survives, the rest are
  // dropped so a day never carries two runs.
  let sawCardio = false;
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
    if (kind === 'cardio') {
      if (sawCardio) continue; // second cardio piece — drop it
      sawCardio = true;
    }
    const target = cleanTarget(
      record.target,
      kind === 'cardio' ? { name: known.name, recent: known.recent } : undefined
    );
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

  const covered = guaranteeGroupCoverage(guaranteeFixed(rows, seen, input), seen, input);
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

// The floor for a group. Cardio (the 'run' group) is never floored — the
// single-cardio rule stands — so it returns 0.
function groupMinimum(group: Group): number {
  if (group === 'run') return 0;
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
  input: ProgrammerInput
): ProgrammeRow[] {
  const day = input.plan.routineDay;
  if (!day) return rows;

  // The day's active groups, read from its components and its routine title so a
  // combined "Pull + Legs" surfaces both even when components arrive empty.
  const groups = activeGroups([...input.plan.components, day.title]);
  const out = [...rows];

  for (const group of groups) {
    const min = groupMinimum(group);
    if (min === 0) continue;
    let count = out.filter(r => classifyExercise(r.name) === group).length;
    for (const known of input.exercises) {
      if (count >= min) break;
      if (seen.has(known.key) || classifyExercise(known.name) !== group) continue;
      seen.add(known.key);
      const hasHistory = known.lastSummary !== 'no history';
      out.push({
        name: known.name,
        key: known.key,
        kind: inferKind(known.name),
        toFailure: false,
        target: fallbackTarget(known),
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
  return rows.map(row => {
    if (anchorKeys.has(row.key)) return { ...row, fixed: 'anchor' as const };
    if (stapleKeys.has(row.key)) return { ...row, fixed: 'staple' as const };
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
  const ranked = rows.map((row, index) => {
    if (row.kind === 'cardio') return { row, bucket: 0, rank: index };
    const anchor = anchorRank.get(row.key);
    if (anchor !== undefined) return { row, bucket: 1, rank: anchor };
    const staple = stapleRank.get(row.key);
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
  input: ProgrammerInput
): ProgrammeRow[] {
  const day = input.plan.routineDay;
  if (!day) return rows;
  const byKey = new Map(input.exercises.map(e => [e.key, e]));
  const out = [...rows];

  const appendMissing = (names: string[], anchor: boolean) => {
    for (const name of names) {
      const key = exerciseKey(name);
      if (!key || seen.has(key)) continue;
      const known = byKey.get(key);
      if (!known) continue; // buildProgrammerInput guarantees it, but stay safe
      seen.add(key);
      const hasHistory = known.lastSummary !== 'no history';
      out.push({
        name: known.name,
        key,
        kind: anchor ? 'core' : inferKind(known.name),
        toFailure: false,
        target: fallbackTarget(known),
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
// recent logged session so the row is never blank. Empty when there is no
// history to seed from (a brand-new anchor/staple).
function fallbackTarget(e: ProgrammerExercise): ProgrammeTarget {
  const last = e.recent[e.recent.length - 1];
  if (!last) return {};
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

// Exactly one to-failure marker, on the last safe row. Clears every model-set
// marker, then re-marks the final row that is safe to fail — so the guarantee
// holds however the model tagged things.
export function enforceToFailure(rows: ProgrammeRow[]): ProgrammeRow[] {
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
    ...(row.fixed ? { fixed: row.fixed } : {}),
    ...(row.target.sets !== undefined ? { sets: row.target.sets } : {}),
    ...(row.target.reps !== undefined ? { reps: row.target.reps } : {}),
    ...(row.target.holdSeconds !== undefined ? { holdSeconds: row.target.holdSeconds } : {}),
    ...(row.target.perSide ? { perSide: true } : {}),
    ...(row.target.weightKg !== undefined ? { weightKg: row.target.weightKg } : {}),
    ...(row.target.durationMinutes !== undefined ? { durationMinutes: row.target.durationMinutes } : {}),
    ...(row.target.distanceKm !== undefined ? { distanceKm: row.target.distanceKm } : {}),
  };
}
