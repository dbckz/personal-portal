// Freehand session logging: turn a blob of text describing what was actually
// done into a session record.
//
// This exists for the days that go off-plan — a five-a-side game instead of the
// programmed push session, a hike, an hour in a hotel gym with whatever was
// free. Filling the structured form for those is friction enough that they go
// unlogged, and an unlogged session is worse for the history than a roughly
// logged one.
//
// Claude does the reading, because the input is prose ("did 3 sets of 10 on the
// chest press at 40, then knackered so just stretched"). Two rules keep it
// honest:
//
//   1. The ORIGINAL TEXT is always kept on the session (freeformText), so a
//      misreading costs nothing — the source is still there to correct from.
//   2. A figure the model isn't given is left undefined, never guessed. Same
//      rule the spreadsheet parser follows: a wrong weight is worse than none.
//
// When Claude is unavailable the fallback still produces a usable record — the
// text as the session's notes and a keyword-inferred type — so logging never
// depends on the model being up.

import { extractJsonArray, runClaudeText } from './ai-classifier';
import { formatEntryDuration } from './exercise-targets';
import type { ExerciseEntry, ExerciseIntensity, ExerciseSession } from '@/types/life';

// A session as read out of a text blob, before it is given ids and written to
// storage. Deliberately the shape createSession() takes.
export interface FreeformDraft {
  date: string;
  type: string;
  label?: string;
  durationMinutes?: number;
  distanceKm?: number;
  intensity?: ExerciseIntensity;
  notes?: string;
  exercises: Array<Omit<ExerciseEntry, 'id'>>;
}

const PROMPT_HEADER = `Someone has written down, in their own words, the exercise they did on one day. Turn it into a structured record.

Rules:
- Record only what the text says. If it does not give a number, OMIT that field — never estimate, round up from "a few", or infer a weight from an exercise name. A missing figure is fine; an invented one corrupts the training history.
- "type" is a short lowercase description of the session as a whole: "run", "gym", "football", "climbing", "swim", "walk", "yoga". Use "gym" for a mixed strength session.
- "label" is optional, for a session with a name of its own ("five-a-side", "hotel gym", "parkrun").
- "exercises" is one record per distinct movement, in the order they were done. A session with no distinct movements (a run, a football match) has an empty array — the distance and duration belong on the session itself.
- For each exercise: "sets"/"reps" for a normal lift, "sets"/"holdSeconds" for a plank or hang, "weightKg" for the load (the TOTAL, so 20kg dumbbells in each hand is 40 only if the text says so — otherwise record what is written), "bodyweight": true when there is no external load, "perSide": true when the reps are per side, "distanceKm"/"durationMinutes" for a cardio piece.
- "volumeText" and "loadText" hold the person's own phrasing for the sets/reps and the weight ("3 sets of 10", "40kg"), so the original wording survives.
- Per-exercise "notes" is anything said about how it FELT ("could have done more", "form went to pieces on the last set"). Effort notes drive the next session's targets, so keep them.
- Session "notes" is the context that is not about a specific movement — why the plan changed, how the session went overall. Keep it brief and in their words.
- "intensity" is "easy", "moderate" or "hard", only when the text supports it.

Return ONLY a JSON array containing exactly one object, no prose, no code fences:
[{"type":"...","label":"...","durationMinutes":N,"distanceKm":N,"intensity":"easy|moderate|hard","notes":"...","exercises":[{"name":"...","sets":N,"reps":N,"holdSeconds":N,"weightKg":N,"bodyweight":true,"perSide":true,"distanceKm":N,"durationMinutes":N,"volumeText":"...","loadText":"...","notes":"..."}]}]

Include only the fields the text actually supports. Omit the rest.

`;

export function buildFreeformPrompt(text: string, date: string): string {
  return `${PROMPT_HEADER}Date: ${date}

What they wrote:
"""
${text.trim()}
"""`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const INTENSITIES: ExerciseIntensity[] = ['easy', 'moderate', 'hard'];

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function validateEntry(raw: unknown): Omit<ExerciseEntry, 'id'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 120);
  if (!name) return null;

  const sets = num(r.sets);
  const reps = num(r.reps);
  const holdSeconds = num(r.holdSeconds);
  const weightKg = num(r.weightKg);
  const distanceKm = num(r.distanceKm);
  const durationMinutes = num(r.durationMinutes);

  return {
    name,
    ...(sets !== undefined ? { sets: Math.round(sets) } : {}),
    ...(reps !== undefined ? { reps: Math.round(reps) } : {}),
    ...(holdSeconds !== undefined ? { holdSeconds: Math.round(holdSeconds) } : {}),
    ...(weightKg !== undefined ? { weightKg } : {}),
    ...(r.bodyweight === true ? { bodyweight: true } : {}),
    ...(r.perSide === true ? { perSide: true } : {}),
    ...(distanceKm !== undefined ? { distanceKm } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes: Math.round(durationMinutes) } : {}),
    ...(str(r.volumeText, 80) ? { volumeText: str(r.volumeText, 80) } : {}),
    ...(str(r.loadText, 80) ? { loadText: str(r.loadText, 80) } : {}),
    ...(str(r.notes, 400) ? { notes: str(r.notes, 400) } : {}),
    // A freehand log describes what already happened, so every exercise in it
    // is done by definition — it is never a checklist to work through.
    done: true,
  };
}

// Turn the model's record into a draft, dropping anything malformed. The date
// is ours, not the model's: it is the day being logged, and letting the model
// restate it is one more thing to get wrong.
export function validateFreeform(
  records: Record<string, unknown>[],
  text: string,
  date: string
): FreeformDraft | null {
  const record = records[0];
  if (!record) return null;

  const exercises = Array.isArray(record.exercises)
    ? record.exercises.map(validateEntry).filter((e): e is Omit<ExerciseEntry, 'id'> => e !== null)
    : [];

  const type = str(record.type, 40)?.toLowerCase() ?? inferType(text);
  const intensity = INTENSITIES.includes(record.intensity as ExerciseIntensity)
    ? (record.intensity as ExerciseIntensity)
    : undefined;
  const durationMinutes = num(record.durationMinutes);
  const distanceKm = num(record.distanceKm);

  return {
    date,
    type,
    ...(str(record.label, 80) ? { label: str(record.label, 80) } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes: Math.round(durationMinutes) } : {}),
    ...(distanceKm !== undefined ? { distanceKm } : {}),
    ...(intensity ? { intensity } : {}),
    ...(str(record.notes, 1000) ? { notes: str(record.notes, 1000) } : {}),
    exercises,
  };
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

// First match wins, so the more specific words come first ("parkrun" before
// "run", which would otherwise catch it).
const TYPE_WORDS: Array<[RegExp, string]> = [
  [/\bparkrun\b/i, 'run'],
  [/\b(five-a-side|5-a-side|footy|football|soccer)\b/i, 'football'],
  [/\b(climb|climbed|climbing|boulder|bouldered|bouldering)\b/i, 'climbing'],
  [/\b(swim|swam|swimming|pool|lengths)\b/i, 'swim'],
  [/\b(cycle|cycled|cycling|bike|biked|ride|rode)\b/i, 'cycle'],
  [/\b(yoga|pilates|stretch|stretched|stretching|mobility)\b/i, 'yoga'],
  [/\b(walk|walked|walking|hike|hiked|hiking)\b/i, 'walk'],
  [/\b(run|ran|running|jog|jogged|jogging|treadmill|track)\b/i, 'run'],
  [/\b(gym|lift|lifted|lifting|weights|press|squat|deadlift|curl|row)\b/i, 'gym'],
  [/\b(tennis|padel|squash|badminton)\b/i, 'racket sport'],
];

// The type the text most obviously describes, or 'other'. Used by the fallback,
// and as the backstop when the model returns no type of its own.
export function inferType(text: string): string {
  for (const [pattern, type] of TYPE_WORDS) {
    if (pattern.test(text)) return type;
  }
  return 'other';
}

// The draft to save when Claude cannot be reached. No exercises are invented:
// the whole text becomes the session's notes, which — with the original blob
// also stored on the session — means nothing written down is lost.
export function fallbackDraft(text: string, date: string): FreeformDraft {
  return { date, type: inferType(text), notes: text.trim().slice(0, 1000), exercises: [] };
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

export interface FreeformResult {
  draft: FreeformDraft;
  // False when the fallback produced this draft, so the UI can say the text was
  // logged but not broken down.
  parsed: boolean;
}

// Read the text into a draft. Never throws and never returns nothing usable:
// a failed or unavailable model yields the fallback draft. `run` is injectable
// so tests drive it without spawning Claude.
export async function parseFreeform(
  text: string,
  date: string,
  opts: { run?: (prompt: string) => Promise<string>; timeoutSeconds?: number } = {}
): Promise<FreeformResult> {
  if (!text.trim()) throw new Error('Nothing to log — describe what you did.');
  const run =
    opts.run ??
    ((prompt: string) => runClaudeText(prompt, { timeoutSeconds: opts.timeoutSeconds ?? 120 }));

  try {
    const output = await run(buildFreeformPrompt(text, date));
    const draft = validateFreeform(extractJsonArray(output), text, date);
    if (draft) return { draft, parsed: true };
  } catch (error) {
    console.error('Freehand exercise parse failed:', error);
  }
  return { draft: fallbackDraft(text, date), parsed: false };
}

// A one-line summary of what a draft amounts to, for the confirmation step.
export function describeDraft(draft: Pick<ExerciseSession, 'type' | 'label'> & FreeformDraft): string {
  const parts: string[] = [draft.label || draft.type];
  if (draft.durationMinutes) parts.push(formatEntryDuration(draft.durationMinutes));
  if (draft.distanceKm) parts.push(`${draft.distanceKm} km`);
  if (draft.exercises.length) {
    parts.push(`${draft.exercises.length} exercise${draft.exercises.length === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}
