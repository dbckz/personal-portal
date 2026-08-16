// Auto-derived goal evidence: turns a goal's declared source into an actual
// figure for its period, so progress updates itself instead of relying on a
// self-report.
//
// Every resolver degrades gracefully. A source that can't be read (Asana down,
// a deleted project, no data yet) yields a null actual and says so in the
// label — a goal never disappears because its evidence source is unavailable.
//
// Server-only: reaches into storage and the Asana API.

import { format } from 'date-fns';
import { countCompletedTasks } from './asana';
import { periodRange } from './goal-periods';
import { getEnabledAsanaIntegrations, updateIntegration } from './integration-storage';
import { refreshAsanaToken } from './asana';
import { getAllSessions } from './storage/exercise';
import { getAllWeeklyStats } from './storage/weekly-stats';
import type { ExerciseEntry, ExerciseSession, Goal } from '@/types/life';

export interface ResolvedEvidence {
  actual: number | null;
  label: string;
}

export async function resolveEvidence(goal: Goal): Promise<ResolvedEvidence> {
  const { start, end } = periodRange(goal.periodKind, goal.periodKey);

  try {
    switch (goal.evidence.kind) {
      case 'manual':
        return resolveManual(goal);
      case 'exercise':
        return withManualOverride(goal, await resolveExercise(goal, start, end));
      case 'calendar-category':
        return withManualOverride(goal, await resolveCalendarCategory(goal, start, end));
      case 'asana-project':
      case 'asana-tag':
        return withManualOverride(goal, await resolveAsana(goal, start, end));
      default:
        return { actual: null, label: 'Unknown evidence source' };
    }
  } catch (error) {
    console.error(`Failed to resolve evidence for goal ${goal.id}:`, error);
    return { actual: null, label: 'Evidence source unavailable' };
  }
}

// Resolve a batch in parallel, keyed by goal id. Asana-backed goals each cost a
// round trip, so the Goals tab resolves them concurrently rather than in turn.
export async function resolveEvidenceForGoals(
  goals: Goal[]
): Promise<Record<string, ResolvedEvidence>> {
  const entries = await Promise.all(
    goals.map(async goal => [goal.id, await resolveEvidence(goal)] as const)
  );
  return Object.fromEntries(entries);
}

function resolveManual(goal: Goal): ResolvedEvidence {
  if (typeof goal.manualValue !== 'number') {
    return { actual: null, label: 'No figure reported yet' };
  }
  const last = goal.checkIns.filter(c => typeof c.value === 'number').at(-1);
  return {
    actual: goal.manualValue,
    label: last ? `Self-reported ${format(new Date(last.at), 'd MMM')}` : 'Self-reported',
  };
}

// Layer a self-report over an auto-derived figure. For a goal that names a
// tracking source but where Dave has also typed a number in (a check-in figure
// the auto source doesn't yet see — a race he ran that wasn't logged as an
// exercise, say), the higher of the two is the honest actual, and the label
// shows both so the discrepancy is visible rather than silently resolved.
function withManualOverride(goal: Goal, auto: ResolvedEvidence): ResolvedEvidence {
  if (typeof goal.manualValue !== 'number') return auto;
  const manual = round1(goal.manualValue);
  const unit = goal.target?.unit ? ` ${goal.target.unit}` : '';
  // Higher wins; the manual figure wins outright when nothing was auto-derived.
  const actual = auto.actual === null ? manual : Math.max(auto.actual, manual);
  const autoPart = auto.actual === null ? auto.label : lowerFirst(auto.label);
  return { actual, label: `Self-reported ${manual}${unit} (auto: ${autoPart})` };
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

async function resolveExercise(goal: Goal, start: Date, end: Date): Promise<ResolvedEvidence> {
  const from = format(start, 'yyyy-MM-dd');
  const to = format(new Date(end.getTime() - 1), 'yyyy-MM-dd');
  const wanted = goal.evidence.ref?.trim().toLowerCase();

  const inPeriod = (await getAllSessions()).filter(
    s => s.completed && s.date >= from && s.date <= to
  );
  // A ref matches a session either by its type OR by naming an exercise inside
  // it — Dave logs runs as an "Outdoor run" exercise within a mixed session, so
  // the session type ("strength + cardio") never equals "run". When a session
  // matches only through its exercises, its own distance/minutes are ignored and
  // only the matching exercises contribute, so a walk that happens to share a
  // session with nothing runnable never counts toward a run goal.
  const matches = inPeriod
    .map(s => matchSession(s, wanted))
    .filter((m): m is SessionMatch => m !== null);

  const noun = matches.length === 1 ? 'session' : 'sessions';
  const scope = wanted ? `"${goal.evidence.ref}" ${noun}` : noun;
  if (goal.evidence.unit === 'minutes') {
    const minutes = matches.reduce((sum, m) => sum + matchMinutes(m), 0);
    return { actual: minutes, label: `${minutes} min logged across ${matches.length} ${scope}` };
  }
  // Peak metric: the longest single distance covered in the period, so a "run
  // 10K" goal is judged by the best run, not a tally.
  if (goal.evidence.unit === 'max-distance-km') {
    const longest = matches.reduce((max, m) => Math.max(max, matchDistanceKm(m)), 0);
    if (longest <= 0) return { actual: null, label: `No distance logged in ${scope}` };
    const rounded = round1(longest);
    return { actual: rounded, label: `Longest ${rounded} km across ${matches.length} ${scope}` };
  }
  return { actual: matches.length, label: `${matches.length} ${scope} logged` };
}

// A session that counts toward an exercise goal. `matchedExercises` is null when
// the whole session qualifies (no ref, or the ref matched its type), and the
// specific exercises when it qualified only by exercise name — the distinction
// decides whether the session's own figures or just those exercises contribute.
interface SessionMatch {
  session: ExerciseSession;
  matchedExercises: ExerciseEntry[] | null;
}

function matchSession(session: ExerciseSession, wanted?: string): SessionMatch | null {
  if (!wanted || session.type.toLowerCase() === wanted) {
    return { session, matchedExercises: null };
  }
  const named = (session.exercises ?? []).filter(e => e.name.toLowerCase().includes(wanted));
  return named.length > 0 ? { session, matchedExercises: named } : null;
}

function matchMinutes(match: SessionMatch): number {
  if (match.matchedExercises === null) return match.session.durationMinutes ?? 0;
  return match.matchedExercises.reduce((sum, e) => sum + (e.durationMinutes ?? 0), 0);
}

function matchDistanceKm(match: SessionMatch): number {
  if (match.matchedExercises === null) return sessionDistanceKm(match.session);
  return match.matchedExercises.reduce((max, e) => Math.max(max, e.distanceKm ?? 0), 0);
}

// The greatest single distance a session represents: its own distance, or the
// longest distance logged on any exercise inside it, whichever is larger.
function sessionDistanceKm(session: ExerciseSession): number {
  const own = session.distanceKm ?? 0;
  const perExercise = (session.exercises ?? []).reduce(
    (max, e) => Math.max(max, e.distanceKm ?? 0),
    0
  );
  return Math.max(own, perExercise);
}

// Minutes booked against a time-tracking category, read out of the durable
// weekly stats the Analysis tab already maintains. Days are filtered
// individually, so a week straddling a month boundary contributes only the days
// that fall inside the period.
async function resolveCalendarCategory(
  goal: Goal,
  start: Date,
  end: Date
): Promise<ResolvedEvidence> {
  const category = goal.evidence.ref;
  if (!category) return { actual: null, label: 'No category set' };

  const from = format(start, 'yyyy-MM-dd');
  const to = format(new Date(end.getTime() - 1), 'yyyy-MM-dd');
  const stats = await getAllWeeklyStats();

  let minutes = 0;
  let activeDays = 0;
  for (const week of Object.values(stats)) {
    for (const [integrationId, integration] of Object.entries(week.integrations)) {
      if (goal.evidence.integrationId && integrationId !== goal.evidence.integrationId) continue;
      for (const day of Object.values(integration.days)) {
        if (day.date < from || day.date > to) continue;
        const dayMinutes = day.byCategory?.[category] ?? 0;
        if (dayMinutes <= 0) continue;
        minutes += dayMinutes;
        activeDays += 1;
      }
    }
  }

  if (goal.evidence.unit === 'count') {
    return { actual: activeDays, label: `${activeDays} days with "${category}" time` };
  }
  return {
    actual: minutes,
    label: `${Math.round(minutes)} min of "${category}" across ${activeDays} days`,
  };
}

// Tasks completed in an Asana project or under a tag during the period.
async function resolveAsana(goal: Goal, start: Date, end: Date): Promise<ResolvedEvidence> {
  const ref = goal.evidence.ref;
  if (!ref) return { actual: null, label: 'No Asana source set' };

  const integrations = (await getEnabledAsanaIntegrations()).filter(
    i => !!i.credentials && (!goal.evidence.integrationId || i.id === goal.evidence.integrationId)
  );
  if (integrations.length === 0) return { actual: null, label: 'No Asana workspace connected' };

  const source = goal.evidence.kind === 'asana-project' ? { projectGid: ref } : { tagGid: ref };
  const fromIso = start.toISOString();
  const toIso = end.toISOString();

  // A project/tag lives in exactly one workspace, so the others 404 or return
  // nothing; summing tolerates that without needing to know which is which.
  let total = 0;
  let reachedAny = false;
  for (const integration of integrations) {
    try {
      let credentials = integration.credentials!;
      if (credentials.expiresAt && Date.now() >= credentials.expiresAt - 60_000) {
        credentials = await refreshAsanaToken(
          credentials.refreshToken!,
          integration.clientId,
          integration.clientSecret
        );
        await updateIntegration(integration.id, { credentials });
      }
      total += await countCompletedTasks(credentials.accessToken, source, fromIso, toIso);
      reachedAny = true;
    } catch (error) {
      console.error(`Asana evidence lookup failed for ${integration.name}:`, error);
    }
  }

  if (!reachedAny) return { actual: null, label: 'Asana unavailable' };
  const where = goal.evidence.kind === 'asana-project' ? 'in project' : 'tagged';
  return { actual: total, label: `${total} task${total === 1 ? '' : 's'} completed ${where}` };
}
