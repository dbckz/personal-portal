// AI-assisted goal setting. Dave types a goal in free text ("Run 10K by the end
// of the quarter", "3 gym sessions a week"); this turns it into the structured
// Goal the app already knows how to track AND, wherever a path is inferable, a
// progression plan — the intermediate milestones from where he is now to the
// target across the period.
//
// The inference is grounded in his real data: the life-area registry and the
// evidence rules it must pick from, the current date and period keys, and a
// current-state summary (recent training, the Asana project catalogue) so a run
// ramp starts from his actual last run, not from zero.
//
// Suggest-then-confirm: this only proposes. Nothing is written until Dave
// reviews and saves it, so the validation here is about never proposing
// something the editor can't represent — a bad section, an out-of-period
// milestone, an Asana project that doesn't exist — not about being the last line
// of defence. On any failure the whole thing returns null and the editor falls
// back to the blank manual form.
//
// Server-only: reaches into the exercise log and the Asana catalogue. The model
// runner is injectable so tests drive it without spawning Claude.

import { format, subDays } from 'date-fns';

import { runClaudeText } from './ai-classifier';
import { analyseExercise } from './exercise-analysis';
import { buildProgressions } from './exercise-progression';
import { goalSections, isValidSectionId } from './life-sections';
import { isValidPeriodKey, periodKeyFor, periodLabel } from './goal-periods';
import { sanitizeMilestones } from './goal-plan';
import type { AsanaProject } from '@/types';
import type {
  ExerciseSession,
  Goal,
  GoalEvidence,
  GoalEvidenceKind,
  GoalMilestone,
  GoalPeriodKind,
} from '@/types/life';

// The structured proposal the editor prefills from. Deliberately the same shape
// the create form already collects, plus the milestones.
export interface InferredGoal {
  sectionId: string;
  periodKind: GoalPeriodKind;
  periodKey: string;
  title: string;
  detail?: string;
  target?: { value: number; unit?: string };
  evidence: GoalEvidence;
  milestones: GoalMilestone[];
}

export interface InferenceContext {
  now?: Date;
  // The section Dave was looking at when he asked, trusted over the model's guess.
  requestedSectionId?: string;
  sessions: ExerciseSession[];
  projects: AsanaProject[];
  run?: (prompt: string) => Promise<string>;
  timeoutSeconds?: number;
}

const EVIDENCE_KINDS: GoalEvidenceKind[] = [
  'manual',
  'asana-project',
  'asana-tag',
  'calendar-category',
  'exercise',
];

// ---------------------------------------------------------------------------
// Current-state grounding
// ---------------------------------------------------------------------------

// A compact description of where Dave is now, so the model ramps from reality.
// Training volume, his recent and longest runs, and his most-trained lifts with
// their current loads — the raw material for "sessions/week" or "run distance"
// goals.
export function summariseCurrentState(sessions: ExerciseSession[], now: Date): string {
  if (sessions.length === 0) return 'No exercise history logged yet.';

  const to = format(now, 'yyyy-MM-dd');
  const from = format(subDays(now, 56), 'yyyy-MM-dd');
  const analysis = analyseExercise(sessions, from, to);

  const lines: string[] = [
    `Training (last 8 weeks): ${analysis.totalSessions} sessions, about ${round1(
      analysis.sessionsPerWeek
    )}/week; current streak ${analysis.currentStreakWeeks} week(s).`,
  ];

  const runs = sessions
    .filter(s => s.completed && distanceOf(s) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (runs.length > 0) {
    const recent = runs.slice(-4).map(s => `${round1(distanceOf(s))}km`);
    const longest = round1(Math.max(...runs.map(distanceOf)));
    lines.push(`Runs: recent ${recent.join(', ')}; longest ever ${longest}km.`);
  }

  const lifts = buildProgressions(sessions.filter(s => s.completed))
    .filter(p => p.latest?.weightKg !== undefined)
    .slice(0, 6)
    .map(p => `${p.name} ${p.latest!.weightKg}kg`);
  if (lifts.length > 0) lines.push(`Key lifts (latest load): ${lifts.join('; ')}.`);

  return lines.join('\n');
}

function distanceOf(session: ExerciseSession): number {
  const own = session.distanceKm ?? 0;
  const inner = (session.exercises ?? []).reduce((m, e) => Math.max(m, e.distanceKm ?? 0), 0);
  return Math.max(own, inner);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function buildInferencePrompt(text: string, ctx: InferenceContext): string {
  const now = ctx.now ?? new Date();
  const today = format(now, 'yyyy-MM-dd');
  const monthKey = periodKeyFor('month', now);
  const quarterKey = periodKeyFor('quarter', now);

  const sections = goalSections()
    .map(s => `"${s.id}" (${s.label})`)
    .join(', ');

  const projectCatalogue =
    ctx.projects.length > 0
      ? ctx.projects.map(p => `  - gid ${p.gid}: ${p.name} (${p.integrationName})`).join('\n')
      : '  (no Asana projects available)';

  return `You are turning a person's free-text goal into a structured goal for their personal portal, and — where a sensible path exists — a progression plan of milestones from where they are now to the target.

Today is ${today}. The current month period key is "${monthKey}" (${periodLabel(
    'month',
    monthKey
  )}); the current quarter is "${quarterKey}" (${periodLabel('quarter', quarterKey)}).

Life areas (choose the sectionId that fits): ${sections}.

Choose ONE way progress is measured (evidence.kind), and follow its rule:
- "manual": the person types the figure in. No ref. Use when nothing else fits.
- "exercise": counts logged sessions. Set evidence.unit to "count" (number of sessions), "minutes" (total minutes) or "max-distance-km" (the single longest run/session distance — use this for a target distance like "run 10K"). evidence.ref optionally names a session type ("run", "gym"); leave blank for all.
- "calendar-category": time booked against a time-tracking category. evidence.ref is the category name; evidence.unit is "count" or "minutes".
- "asana-project": tasks completed in a project. evidence.ref MUST be one of the gids in the catalogue below.
Asana project catalogue:
${projectCatalogue}

Rules for the structured goal:
- periodKind is "month" or "quarter"; periodKey must be exactly the current key for that kind above. Pick quarter for anything spanning more than a month.
- target is a number and unit when the goal is quantifiable ("10" / "km", "3" / "sessions/week"), otherwise omit it.
- title is a short imperative restatement; detail is optional extra context.

Rules for milestones (the progression plan):
- Only include milestones when there is a real ramp to lay out (a distance to build up to, a count to accumulate). For a simple "do X once" goal, return an empty array.
- Each milestone: "key" is a date INSIDE the period in "yyyy-MM-dd" form; "value" is the numeric figure to be at by then (same unit as the target); "label" is a short human phrase ("6 km long run"); "reasoning" is one line grounded in their current state.
- Milestones must step monotonically from the current state toward the target, spaced across the period, ending at or near the target by the end of the period.
- Ground the first milestone in where they ARE now (see current state), not zero.

Current state:
${summariseCurrentState(ctx.sessions, now)}

The person's goal, verbatim:
"""
${text.trim()}
"""

Return ONLY a JSON object, no prose, no code fences:
{"sectionId":"<id>","periodKind":"month|quarter","periodKey":"<key>","title":"<short>","detail":"<optional>","target":{"value":<number>,"unit":"<unit>"},"evidence":{"kind":"<kind>","ref":"<optional>","unit":"<optional>"},"milestones":[{"key":"yyyy-MM-dd","value":<number>,"label":"<short>","reasoning":"<one line>"}]}`;
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

// Recover the first JSON object from the model's (possibly fenced/prose-wrapped)
// text. Object, not array — inference proposes a single goal.
function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Turn a raw record into a validated proposal, or null when it can't be trusted.
// Hard checks: a real section, a period key that is the current one for its kind,
// an evidence kind from the whitelist with its ref/unit rules honoured, and
// milestones that sit inside the period and ramp toward the target.
export function validateInference(
  raw: Record<string, unknown>,
  ctx: InferenceContext
): InferredGoal | null {
  const now = ctx.now ?? new Date();

  const title = str(raw.title);
  if (!title) return null;

  // Section: the area Dave was in wins; otherwise the model's, if it's real.
  const sectionId = firstValidSection(ctx.requestedSectionId, str(raw.sectionId));
  if (!sectionId) return null;

  const periodKind: GoalPeriodKind = raw.periodKind === 'quarter' ? 'quarter' : 'month';
  // Coerce to the current key for the kind rather than trusting the model's — it
  // occasionally keys the wrong month, and an out-of-period key would strand the
  // milestones. isValidPeriodKey stays as a guard for the coerced value.
  const periodKey = periodKeyFor(periodKind, now);
  if (!isValidPeriodKey(periodKind, periodKey)) return null;

  const target = validateTarget(raw.target);
  const evidence = validateEvidence(raw.evidence, ctx);

  const milestones = sanitizeMilestones(raw.milestones, {
    periodKind,
    periodKey,
    target: target?.value,
    unit: target?.unit,
  });

  return {
    sectionId,
    periodKind,
    periodKey,
    title,
    ...(str(raw.detail) ? { detail: str(raw.detail) } : {}),
    ...(target ? { target } : {}),
    evidence,
    milestones,
  };
}

// The first candidate that names a real life-area section, or null when none do.
function firstValidSection(...candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && isValidSectionId(candidate)) return candidate;
  }
  return null;
}

function validateTarget(raw: unknown): { value: number; unit?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const value = typeof t.value === 'number' && Number.isFinite(t.value) && t.value > 0 ? t.value : null;
  if (value === null) return undefined;
  const unit = str(t.unit);
  return { value, ...(unit ? { unit } : {}) };
}

// Resolve the evidence source, degrading to self-reported when the model's choice
// can't be grounded — an Asana project that isn't in the catalogue, or a missing
// kind. A goal is more useful tracked manually than not proposed at all.
function validateEvidence(raw: unknown, ctx: InferenceContext): GoalEvidence {
  const manual: GoalEvidence = { kind: 'manual' };
  if (!raw || typeof raw !== 'object') return manual;
  const e = raw as Record<string, unknown>;
  const kind = e.kind as GoalEvidenceKind;
  if (!EVIDENCE_KINDS.includes(kind)) return manual;

  if (kind === 'asana-project') {
    const project = ctx.projects.find(p => p.gid === str(e.ref));
    if (!project) return manual;
    return { kind, ref: project.gid, integrationId: project.integrationId };
  }

  if (kind === 'asana-tag') {
    const ref = str(e.ref);
    return ref ? { kind, ref } : manual;
  }

  if (kind === 'exercise') {
    const unit = pickUnit(e.unit, ['count', 'minutes', 'max-distance-km'] as const);
    return { kind, ...(str(e.ref) ? { ref: str(e.ref) } : {}), unit };
  }

  if (kind === 'calendar-category') {
    const ref = str(e.ref);
    if (!ref) return manual;
    return { kind, ref, unit: pickUnit(e.unit, ['count', 'minutes'] as const) };
  }

  return manual;
}

function pickUnit<T extends string>(raw: unknown, allowed: readonly T[]): T {
  return allowed.includes(raw as T) ? (raw as T) : allowed[0];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// Infer a structured goal + plan from free text, or null when the model is
// unavailable or returns nothing usable. `run` is injectable so tests drive it
// without spawning Claude.
export async function inferGoal(text: string, ctx: InferenceContext): Promise<InferredGoal | null> {
  if (!text.trim()) return null;
  const run =
    ctx.run ??
    ((prompt: string) => runClaudeText(prompt, { timeoutSeconds: ctx.timeoutSeconds ?? 120 }));
  try {
    const record = parseJsonObject(await run(buildInferencePrompt(text, ctx)));
    return record ? validateInference(record, ctx) : null;
  } catch (error) {
    console.error('Goal inference failed:', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Suggest a tracking source for an existing goal
// ---------------------------------------------------------------------------

// A proposal to move a manually-tracked goal onto an auto-derived source, so a
// goal Dave has been self-reporting ("Run a 10k") can start reading its progress
// from the data he already logs.
export interface InferredEvidence {
  evidence: GoalEvidence;
  target?: { value: number; unit?: string };
  rationale: string;
}

export interface EvidenceInferenceContext {
  sessions: ExerciseSession[];
  projects: AsanaProject[];
  // Calendar categories seen in the weekly stats, offered as calendar-category refs.
  categories: string[];
  run?: (prompt: string) => Promise<string>;
  timeoutSeconds?: number;
}

// The distinct session types and exercise names in the log, so a suggested
// exercise ref names something that actually appears (as a session type or
// inside a session) rather than a guess.
function exerciseVocabulary(sessions: ExerciseSession[]): { types: string[]; names: string[] } {
  const types = new Set<string>();
  const names = new Set<string>();
  for (const s of sessions) {
    if (s.type?.trim()) types.add(s.type.trim());
    for (const e of s.exercises ?? []) {
      if (e.name?.trim()) names.add(e.name.trim());
    }
  }
  return { types: [...types].sort(), names: [...names].sort() };
}

export function buildEvidencePrompt(goal: Goal, ctx: EvidenceInferenceContext): string {
  const { types, names } = exerciseVocabulary(ctx.sessions);
  const projectCatalogue =
    ctx.projects.length > 0
      ? ctx.projects.map(p => `  - gid ${p.gid}: ${p.name} (${p.integrationName})`).join('\n')
      : '  (no Asana projects available)';
  const list = (items: string[]) => (items.length > 0 ? items.join(', ') : '(none logged)');

  return `A person tracks this goal by typing the figure in by hand. Propose a way to derive its progress automatically from data they already keep, OR return null if none fits well.

The goal:
- title: "${goal.title}"${goal.detail ? `\n- detail: "${goal.detail}"` : ''}
- section: ${goal.sectionId}
- target: ${goal.target ? `${goal.target.value}${goal.target.unit ? ` ${goal.target.unit}` : ''}` : '(none set)'}

Choose ONE evidence.kind and follow its rule:
- "exercise": progress from the exercise log. evidence.unit is "count" (sessions), "minutes" (total minutes) or "max-distance-km" (the single longest run/session distance — use for a target distance like "run 10K"). evidence.ref optionally narrows to a session type or an exercise name (a session counts if its type matches OR it contains an exercise whose name contains the ref); leave ref blank for all sessions.
  Session types logged: ${list(types)}.
  Exercise names logged: ${list(names)}.
- "calendar-category": time booked against a time-tracking category. evidence.ref MUST be one of: ${list(ctx.categories)}. evidence.unit is "count" or "minutes".
- "asana-project": tasks completed in a project. evidence.ref MUST be one of the gids below.
Asana project catalogue:
${projectCatalogue}

Also propose a numeric "target" ({value, unit}) when the goal implies one and none is set, or to correct an unit mismatch; otherwise omit it.
Give a one-line "rationale" for why this source fits.

Only propose a source you are confident maps to the goal. If nothing fits (the goal is genuinely subjective), return {"evidence":null}.

Return ONLY a JSON object, no prose, no code fences:
{"evidence":{"kind":"<kind>","ref":"<optional>","unit":"<optional>"},"target":{"value":<number>,"unit":"<unit>"},"rationale":"<one line>"}`;
}

// Validate a raw evidence proposal, returning null on anything the app can't act
// on: a missing/unknown kind, a manual kind (no auto source proposed), an Asana
// ref that isn't in the catalogue, or a calendar-category with no ref. Unlike
// the create-flow validator this never degrades to manual — a suggestion that
// can't be trusted is simply not offered.
export function validateEvidenceProposal(
  raw: Record<string, unknown>,
  ctx: EvidenceInferenceContext
): InferredEvidence | null {
  const rawEvidence = raw.evidence;
  if (!rawEvidence || typeof rawEvidence !== 'object') return null;
  const e = rawEvidence as Record<string, unknown>;
  const kind = e.kind as GoalEvidenceKind;
  if (!EVIDENCE_KINDS.includes(kind) || kind === 'manual') return null;

  let evidence: GoalEvidence;
  if (kind === 'asana-project') {
    const project = ctx.projects.find(p => p.gid === str(e.ref));
    if (!project) return null;
    evidence = { kind, ref: project.gid, integrationId: project.integrationId };
  } else if (kind === 'asana-tag') {
    // No tag catalogue is grounded here, so a tag suggestion can't be verified.
    return null;
  } else if (kind === 'exercise') {
    const unit = pickUnit(e.unit, ['count', 'minutes', 'max-distance-km'] as const);
    evidence = { kind, ...(str(e.ref) ? { ref: str(e.ref) } : {}), unit };
  } else if (kind === 'calendar-category') {
    const ref = str(e.ref);
    if (!ref || !ctx.categories.includes(ref)) return null;
    evidence = { kind, ref, unit: pickUnit(e.unit, ['count', 'minutes'] as const) };
  } else {
    return null;
  }

  const target = validateTarget(raw.target);
  const rationale = str(raw.rationale) || 'Derived from your existing data.';
  return { evidence, ...(target ? { target } : {}), rationale };
}

// Propose an auto-tracking source for a manual goal, or null when the model is
// unavailable, the goal isn't manual, or nothing usable comes back. `run` is
// injectable so tests drive it without spawning Claude.
export async function inferEvidence(
  goal: Goal,
  ctx: EvidenceInferenceContext
): Promise<InferredEvidence | null> {
  if (goal.evidence.kind !== 'manual') return null;
  const run =
    ctx.run ??
    ((prompt: string) => runClaudeText(prompt, { timeoutSeconds: ctx.timeoutSeconds ?? 120 }));
  try {
    const record = parseJsonObject(await run(buildEvidencePrompt(goal, ctx)));
    return record ? validateEvidenceProposal(record, ctx) : null;
  } catch (error) {
    console.error('Evidence inference failed:', error);
    return null;
  }
}
