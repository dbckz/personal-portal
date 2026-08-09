// Resolving "what to aim for this session" from one place, so the checklist and
// the session it seeds never disagree.
//
// Two routes need the same answer: /api/exercise/targets serves it to the
// checklist, and /api/exercise/start seeds the session's entries from it. If they
// resolve it differently the pre-filled "done" numbers stop matching the numbers
// on screen — the user does what the screen says, ticks it, and the record keeps
// the other figures, corrupting the next session's progression.
//
// One source of truth, two sources of data, same shape:
//
//   'ai'       — the cached Claude-programmed session, when one is cached for this
//                exact plan+history (the hash guards that).
//   'fallback' — the instant rule-based targets, when no programme is cached.
//
// This NEVER triggers a fresh AI generation: it reads the cache and, on a miss,
// returns the deterministic targets. Kicking off a background generation is the
// targets route's job (the checklist can poll for it); the start route must stay
// fast and offline-tolerant, so it takes whatever is cached at that moment —
// mirroring exactly what the checklist would have been showing.

import { buildProgressions } from '@/lib/exercise-progression';
import {
  buildPrescribedTargets,
  buildSessionTargets,
  type ExerciseTarget,
} from '@/lib/exercise-targets';
import { hasPrescribedExercises } from '@/lib/exercise-prescription';
import {
  buildProgrammerInput,
  programmeHash,
  programmeRowToTarget,
  type ProgrammeRow,
  type ProgrammerGoal,
  type ProgrammerInput,
} from '@/lib/exercise-programmer';
import { getCachedProgramme } from '@/lib/storage/exercise-programmes';
import { queryGoals } from '@/lib/storage/goals';
import { resolveEvidenceForGoals } from '@/lib/goal-evidence';
import { computeProgress } from '@/lib/goal-progress';
import { describeMilestone } from '@/lib/goal-plan';
import type { ExerciseSession, Goal, GoalProgress } from '@/types/life';

export interface ResolvedSessionTargets {
  // Today's planned session, if one exists — the source of the label and
  // components, and (for the start route) the plan the session is done against.
  plan: ExerciseSession | undefined;
  components: string[];
  // The targets to show and to seed from, whichever source they came from.
  targets: ExerciseTarget[];
  source: 'ai' | 'fallback';
  // The programmer input and its hash. The targets route uses these to kick off a
  // background generation when serving the fallback; the start route ignores them.
  input: ProgrammerInput;
  hash: string;
}

// Resolve the session's targets from the cache-or-deterministic pair, without
// generating anything. `sessions` is passed in so the caller controls the single
// storage read.
export async function resolveSessionTargets(
  date: string,
  sessions: ExerciseSession[]
): Promise<ResolvedSessionTargets> {
  const plan = sessions.find(s => s.date === date && s.planned);
  const components = plan?.components ?? [];
  // Exclude the target date so "last time" is the previous workout, not a session
  // already logged today.
  const progressions = buildProgressions(sessions, { before: date });
  const totalSessions = sessions.filter(
    s => s.completed && s.exercises?.length && s.date < date
  ).length;

  // Active exercise goals, so the programme graduates toward them. Part of the
  // hash, so both routes must resolve them to look up the same cache entry.
  const goals = await buildProgrammerGoals(date);

  const prescription = plan?.prescription;
  const prescribed = hasPrescribedExercises(prescription);

  const input = buildProgrammerInput(
    progressions,
    { label: plan?.label, components, ...(prescribed ? { prescription } : {}) },
    date,
    totalSessions,
    goals
  );
  const hash = programmeHash(input);
  const cached = getCachedProgramme(date, hash);

  // A prescription fixes the exercise list, order and scheme: the deterministic
  // targets ARE the prescribed exercises, and a cached AI programme only refines
  // their loads and rationales (never their membership or order).
  if (prescribed) {
    const deterministic = buildPrescribedTargets(prescription!, progressions);
    const targets = cached ? overlayProgramme(deterministic, cached) : deterministic;
    return { plan, components, targets, source: cached ? 'ai' : 'fallback', input, hash };
  }

  if (cached) {
    return { plan, components, targets: cached.map(programmeRowToTarget), source: 'ai', input, hash };
  }

  const targets = buildSessionTargets(progressions, components);
  return { plan, components, targets, source: 'fallback', input, hash };
}

// Lay a cached AI programme over the deterministic prescribed targets: for each
// prescribed exercise (order and scheme fixed), take the model's chosen load and
// rationale when it programmed that exercise, else keep the deterministic one.
// AI rows naming anything not prescribed are ignored, and any prescribed
// exercise the model skipped keeps its deterministic target — so the list is
// always exactly the prescription.
function overlayProgramme(prescribed: ExerciseTarget[], rows: ProgrammeRow[]): ExerciseTarget[] {
  const byKey = new Map(rows.map(r => [r.key, r]));
  return prescribed.map(target => {
    const row = byKey.get(target.key);
    if (!row) return target;
    return {
      ...target,
      ...(row.target.weightKg !== undefined ? { weightKg: row.target.weightKg } : {}),
      ...(row.rationale ? { rationale: row.rationale } : {}),
    };
  });
}

// The active Exercise-section goals, each resolved to its current pace and next
// milestone, as the compact shape the programmer reasons over. Best-effort: a
// failure here (evidence source down) must never stop the session's targets, so
// it degrades to no goals.
async function buildProgrammerGoals(date: string): Promise<ProgrammerGoal[]> {
  try {
    const goals = await queryGoals({ sectionId: 'exercise', status: 'active' });
    if (goals.length === 0) return [];
    const now = new Date(`${date}T12:00:00`);
    const evidence = await resolveEvidenceForGoals(goals);
    return goals.map(goal => toProgrammerGoal(goal, computeProgress(goal, evidence[goal.id], now)));
  } catch (error) {
    console.error('Failed to load exercise goals for the programmer:', error);
    return [];
  }
}

function toProgrammerGoal(goal: Goal, progress: GoalProgress): ProgrammerGoal {
  const unit = goal.target?.unit ? ` ${goal.target.unit}` : '';
  const nextMilestone = progress.nextMilestone
    ? describeMilestone(progress.nextMilestone, goal.target?.unit)
    : undefined;
  return {
    title: goal.title,
    ...(goal.target ? { target: `${goal.target.value}${unit}` } : {}),
    ...(nextMilestone ? { nextMilestone } : {}),
    ...(progress.pace !== 'no-target' && progress.pace !== 'no-data' ? { pace: progress.pace } : {}),
  };
}
