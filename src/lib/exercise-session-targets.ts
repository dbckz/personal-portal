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
import { entryWasPerformed } from '@/lib/exercise-entry';
import {
  buildProgrammerInput,
  dropExclusiveDuplicates,
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
import { getRoutineOverrides } from '@/lib/storage/routine-overrides';
import { routineDayForDate } from '@/lib/exercise-routine-day';
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
  source: 'ai' | 'fallback' | 'rest';
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
  // The venue Dave set on the plan (absent = gym). Flows into the programmer
  // input (and therefore the hash) and the deterministic fallback so a home day
  // is programmed from band/bodyweight work, not gym lifts.
  const venue = plan?.venue;
  // The run distance, threaded in only on a HOME session so the outdoor run keeps
  // the planned distance (and never on a gym plan, so gym hashes don't move). The
  // routine title's distance wins when it parses one, else the plan's stored one.
  const targetDistanceKm =
    venue === 'home'
      ? (routineParsed?.targetDistanceKm ?? plan?.targetDistanceKm)
      : undefined;

  // Exclude the target date so "last time" is the previous workout, not a session
  // already logged today.
  const progressions = buildProgressions(sessions, { before: date });
  // The denominator for the programmer's "done in X/Y sessions" frequency: only
  // sessions with at least one PERFORMED exercise count, so a seeded session
  // that was never actually done doesn't inflate Y (and match the numerator,
  // which counts performed entries only — see buildProgressions).
  const totalSessions = sessions.filter(
    s => s.completed && s.date < date && (s.exercises ?? []).some(entryWasPerformed)
  ).length;

  // Active exercise goals, so the programme graduates toward them. Part of the
  // hash, so both routes must resolve them to look up the same cache entry.
  const goals = await buildProgrammerGoals(date);

  const input = buildProgrammerInput(
    progressions,
    {
      label,
      components,
      ...(routineDay ? { routineDay } : {}),
      ...(venue ? { venue } : {}),
      ...(targetDistanceKm !== undefined ? { targetDistanceKm } : {}),
    },
    date,
    totalSessions,
    goals
  );
  const hash = programmeHash(input);

  // A rest day with no plan of its own has nothing to train: return an empty
  // 'rest' result so the checklist shows nothing and the targets route neither
  // serves the deterministic fallback list nor kicks off a Claude generation. A
  // MOVED plan (a session dropped onto a rest weekday) has a plan and falls
  // through to normal resolution.
  if (!plan && routineDay?.rest) {
    return { plan, components: [], targets: [], source: 'rest', input, hash };
  }

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
    // dropExclusiveDuplicates runs BEFORE enforceToFailure so a programme cached
    // before the one-variant-per-session rule (a second calf-raise the legs-
    // balance padding appended) loses the duplicate here — and if the dropped row
    // carried the to-failure marker, enforceToFailure re-marks a valid finisher.
    const ordered = enforceToFailure(
      orderProgrammeRows(dropExclusiveDuplicates(markFixed(cached, routineDay)), routineDay)
    );
    return { plan, components, targets: ordered.map(programmeRowToTarget), source: 'ai', input, hash };
  }

  // The deterministic fallback for a cache miss is unchanged: history-driven
  // targets for the plan's components. (Routine anchors/staples with history
  // already surface here through component selection; ones with no history yet
  // are not represented in this fallback — only in the AI path, which guarantees
  // them. Left as-is because building no-history targets here is not cheap.)
  // The one-variant-per-session rule applies here too: the fallback is built
  // straight from history, which can carry both spellings of a movement.
  const targets = dropExclusiveDuplicates(
    markFixedTargets(
      buildSessionTargets(progressions, components, 8, venue ? { venue } : {}),
      routineDay
    )
  );
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
    const overrides = await getRoutineOverrides();

    // A plan moved to another day should be programmed as THAT routine day, not
    // as the weekday it happens to land on. If there is a planned session today
    // whose label matches a routine day's title, use that routine day — so the
    // moved session carries its routine's anchors/staples (and doesn't get
    // programmed as, say, a Rest day just because it was dropped on a Friday).
    // An exact title match wins over the override/weekday.
    const plan = sessions.find(s => s.date === date && s.planned);
    const planTitle = (parsePlannedTitle(`🏋️ ${plan?.label ?? ''}`)?.title ?? plan?.label ?? '')
      .trim()
      .toLowerCase();
    const byLabel = planTitle
      ? routine.find(d => d.title.trim().toLowerCase() === planTitle)
      : undefined;

    // No title match — fall back to the override for the date (a shifted plan or
    // a rest day), then the plain weekday routine entry.
    const day = byLabel ?? routineDayForDate(routine, overrides, date);
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
        // At least one exercise actually performed — a session of seeded,
        // never-ticked entries carries no real accessory history.
        (s.exercises ?? []).some(entryWasPerformed) &&
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
      if (!entryWasPerformed(entry)) continue;
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
