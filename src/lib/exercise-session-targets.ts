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

import { buildProgressions, exerciseKey } from '@/lib/exercise-progression';
import { buildSessionTargets, type ExerciseTarget } from '@/lib/exercise-targets';
import { parsePlannedTitle } from '@/lib/exercise-parse';
import { normalizeExerciseName } from '@/lib/exercise-names';
import {
  buildProgrammerInput,
  enforceToFailure,
  markFixed,
  orderProgrammeRows,
  programmeHash,
  programmeRowToTarget,
  type ProgrammerGoal,
  type ProgrammerInput,
  type ProgrammerRoutineDay,
} from '@/lib/exercise-programmer';
import { getWeeklyRoutine } from '@/lib/storage/weekly-routine';
import { getCachedProgramme } from '@/lib/storage/exercise-programmes';
import { queryGoals } from '@/lib/storage/goals';
import { resolveEvidenceForGoals } from '@/lib/goal-evidence';
import { computeProgress } from '@/lib/goal-progress';
import { describeMilestone } from '@/lib/goal-plan';
import type { ExerciseSession, Goal, GoalProgress, WeeklyRoutineDay } from '@/types/life';

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

  // The routine day for this date, distilled with rotation context. Drives the
  // AI programme (anchors/staples fixed, accessories rotated) and the hash.
  const routineDay = await resolveRoutineDay(date, sessions);

  // When a routine day governs this date, the routine's CURRENT title is the
  // source of truth for the session's components — not the stored plan session,
  // whose components can be stale (e.g. a calendar-sourced session whose event
  // title predates a routine edit). Deriving from the routine keeps selection in
  // step with the anchors the programme already pulls from it, and moves the
  // hash so a stale cached programme for the day regenerates. The plan session
  // is kept only for the plannedSessionId link. Falls back to the plan's
  // components when the routine title doesn't parse as training (a rest day).
  const routineParsed = routineDay ? parsePlannedTitle(`🏋️ ${routineDay.title}`) : null;
  const components = routineParsed?.components ?? plan?.components ?? [];
  const label = routineParsed?.title ?? plan?.label;

  // Exclude the target date so "last time" is the previous workout, not a session
  // already logged today.
  const progressions = buildProgressions(sessions, { before: date });
  const totalSessions = sessions.filter(
    s => s.completed && s.exercises?.length && s.date < date
  ).length;

  // Active exercise goals, so the programme graduates toward them. Part of the
  // hash, so both routes must resolve them to look up the same cache entry.
  const goals = await buildProgrammerGoals(date);

  const input = buildProgrammerInput(
    progressions,
    { label, components, ...(routineDay ? { routineDay } : {}) },
    date,
    totalSessions,
    goals
  );
  const hash = programmeHash(input);
  const cached = getCachedProgramme(date, hash);

  if (cached) {
    // Reorder already-cached rows so days cached before the ordering rule (or by
    // a model that interleaved fixed exercises with accessories) fix themselves
    // without regeneration: cardio, then anchors, then staples, then the rest.
    // Re-apply enforceToFailure afterwards so the single to-failure marker lands
    // on the last safe row of the FINAL order — keeping the cached path identical
    // to what validateProgramme produces for a freshly generated programme.
    // markFixed also re-stamps the anchor/staple provenance so programmes cached
    // before the fixed-badge change gain it without regeneration.
    const ordered = enforceToFailure(orderProgrammeRows(markFixed(cached, routineDay), routineDay));
    return { plan, components, targets: ordered.map(programmeRowToTarget), source: 'ai', input, hash };
  }

  // The deterministic fallback for a cache miss is unchanged: history-driven
  // targets for the plan's components. (Routine anchors/staples with history
  // already surface here through component selection; ones with no history yet
  // are not represented in this fallback — only in the AI path, which guarantees
  // them. Left as-is because building no-history targets here is not cheap.)
  const targets = markFixedTargets(buildSessionTargets(progressions, components), routineDay);
  return { plan, components, targets, source: 'fallback', input, hash };
}

// Stamp the routine day's anchors/staples onto the deterministic fallback
// targets, matched by key, so the "Anchor"/"Staple" badge shows on the fallback
// path too — not only on the AI programme. A no-op without a routine day.
function markFixedTargets(
  targets: ExerciseTarget[],
  day: ProgrammerRoutineDay | undefined
): ExerciseTarget[] {
  if (!day) return targets;
  const anchorKeys = new Set(day.anchors.map(exerciseKey).filter(Boolean));
  const stapleKeys = new Set(day.staples.map(exerciseKey).filter(Boolean));
  return targets.map(t => {
    if (anchorKeys.has(t.key)) return { ...t, fixed: 'anchor' as const };
    if (stapleKeys.has(t.key)) return { ...t, fixed: 'staple' as const };
    return t;
  });
}

// The distilled routine day for a date: the weekly-routine entry for that
// weekday, its anchors/staples, plus the accessories logged in the most recent
// session(s) of the same routine day as rotation context. Best-effort: a failure
// loading the routine must never stop the session's targets, so it degrades to
// no routine day (the programme then behaves as an ad-hoc plan).
async function resolveRoutineDay(
  date: string,
  sessions: ExerciseSession[]
): Promise<ProgrammerRoutineDay | undefined> {
  try {
    const routine = await getWeeklyRoutine();
    const dayOfWeek = new Date(`${date}T12:00:00`).getDay();

    // A plan moved to another day should be programmed as THAT routine day, not
    // as the weekday it happens to land on. If there is a planned session today
    // whose label matches a routine day's title, use that routine day — so the
    // moved session carries its routine's anchors/staples (and doesn't get
    // programmed as, say, a Rest day just because it was dropped on a Friday).
    // An exact title match wins over the weekday.
    const plan = sessions.find(s => s.date === date && s.planned);
    const planTitle = (parsePlannedTitle(`🏋️ ${plan?.label ?? ''}`)?.title ?? plan?.label ?? '')
      .trim()
      .toLowerCase();
    const byLabel = planTitle
      ? routine.find(d => d.title.trim().toLowerCase() === planTitle)
      : undefined;

    const day = byLabel ?? routine.find(d => d.dayOfWeek === dayOfWeek);
    return day ? distillRoutineDay(day, sessions, date) : undefined;
  } catch (error) {
    console.error('Failed to load the weekly routine for the programmer:', error);
    return undefined;
  }
}

function distillRoutineDay(
  day: WeeklyRoutineDay,
  sessions: ExerciseSession[],
  date: string
): ProgrammerRoutineDay {
  const anchors = day.anchors ?? [];
  const staples = day.staples ?? [];
  const fixedKeys = new Set([...anchors, ...staples].map(exerciseKey));
  const recentAccessories = day.rest
    ? []
    : recentAccessoriesForDay(day, sessions, date, fixedKeys);
  return {
    title: day.title,
    ...(day.note ? { note: day.note } : {}),
    anchors,
    staples,
    ...(day.rest ? { rest: true } : {}),
    ...(recentAccessories.length ? { recentAccessories } : {}),
  };
}

// The accessories (exercises that are neither anchors nor staples) logged in the
// most recent one or two completed sessions of this same routine day, matched by
// weekday or by the routine title appearing in the session label. Normalised and
// de-duplicated, most-recent first.
function recentAccessoriesForDay(
  day: WeeklyRoutineDay,
  sessions: ExerciseSession[],
  date: string,
  fixedKeys: Set<string>
): string[] {
  const title = day.title.trim().toLowerCase();
  const matching = sessions
    .filter(
      s =>
        s.completed &&
        s.exercises?.length &&
        s.date < date &&
        (new Date(`${s.date}T12:00:00`).getDay() === day.dayOfWeek ||
          (!!title && !!s.label && s.label.toLowerCase().includes(title)))
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 2);

  const accessories: string[] = [];
  const seen = new Set<string>();
  for (const session of matching) {
    for (const entry of session.exercises ?? []) {
      const key = exerciseKey(entry.name);
      if (!key || fixedKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      accessories.push(normalizeExerciseName(entry.name));
    }
  }
  return accessories;
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
