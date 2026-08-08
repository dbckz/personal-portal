// Turns the exercise log into the numbers and the suggestions the Exercise
// section's Analysis tab renders.
//
// Suggestions are rule-based rather than AI-generated: the tab then loads
// instantly, costs nothing, and says the same thing twice for the same data —
// which matters when the point is noticing a trend, not being entertained.

import { differenceInCalendarDays, format, parseISO, startOfWeek } from 'date-fns';
import type {
  ExerciseAnalysis,
  ExerciseSession,
  ExerciseTypeSummary,
  ExerciseWeekSummary,
} from '@/types/life';

function weekStartKey(date: string): string {
  return format(startOfWeek(parseISO(date), { weekStartsOn: 1 }), 'yyyy-MM-dd');
}

export function analyseExercise(
  sessions: ExerciseSession[],
  from: string,
  to: string
): ExerciseAnalysis {
  const inRange = sessions.filter(s => s.date >= from && s.date <= to);
  const done = inRange.filter(s => s.completed);
  const planned = inRange.filter(s => s.planned);

  const totalExercisesDone = done.reduce((sum, s) => sum + exercisesDone(s), 0);
  const totalDistanceKm = done.reduce((sum, s) => sum + sessionDistanceKm(s), 0);

  // Windows shorter than a week still divide by one week, so a three-day window
  // can't report an implausible sessions-per-week figure.
  const days = Math.max(1, differenceInCalendarDays(parseISO(to), parseISO(from)) + 1);
  const weeks = Math.max(1, days / 7);

  const byType = summariseByType(done);
  const byWeek = summariseByWeek(done, planned);

  const analysis: ExerciseAnalysis = {
    from,
    to,
    totalSessions: done.length,
    totalExercisesDone,
    totalDistanceKm: round1(totalDistanceKm),
    sessionsPerWeek: round1(done.length / weeks),
    planAdherence: adherenceByPlan(planned, done),
    currentStreakWeeks: currentStreakWeeks(byWeek, to),
    byType,
    byWeek,
    suggestions: [],
  };

  analysis.suggestions = buildSuggestions(analysis, hardSessionShare(done));
  return analysis;
}

// The distance a session covered, in km. A run records it at the session level;
// a gym session with a treadmill (or rowing) entry records it on the entry
// instead — so per-entry distances have to be folded in or run-distance goals
// under-report.
//
// The two can overlap (a session-level total that already includes an entry's
// distance), so they are NOT added: the larger of the session figure and the
// summed entry figures is taken, which counts the distance once whichever way it
// was logged.
function sessionDistanceKm(session: ExerciseSession): number {
  const entryKm = (session.exercises ?? []).reduce((sum, e) => sum + (e.distanceKm ?? 0), 0);
  return Math.max(session.distanceKm ?? 0, entryKm);
}

// Exercises ticked done in a session. Strictly done===true: sheet-imported
// sessions carry done:true on every entry (they record what was actually done),
// so anything still unticked is genuinely not done and doesn't count.
function exercisesDone(session: ExerciseSession): number {
  return (session.exercises ?? []).filter(e => e.done).length;
}

// Share of completed sessions marked 'hard', out of those where intensity was
// recorded at all. Null when nothing was, so the rule stays quiet rather than
// reading absence as easy.
function hardSessionShare(done: ExerciseSession[]): number | null {
  const rated = done.filter(s => !!s.intensity);
  if (rated.length === 0) return null;
  return rated.filter(s => s.intensity === 'hard').length / rated.length;
}

// A planned session and the session actually logged are separate records — the
// plan comes from a calendar event, the log from what was done.
//
// A session started from the plan carries `plannedSessionId`, which is the
// reliable answer. Falling back to a date match covers imported history, where
// the two sides were never linked: counting `planned && completed` would read 0%
// however much training happened.
function adherenceByPlan(
  planned: ExerciseSession[],
  done: ExerciseSession[]
): number | null {
  if (planned.length === 0) return null;

  const linkedPlanIds = new Set(done.map(s => s.plannedSessionId).filter(Boolean));
  const doneDates = new Set(done.map(s => s.date));

  const wasMet = (plan: ExerciseSession) =>
    linkedPlanIds.has(plan.id) || doneDates.has(plan.date);

  // Counted in distinct DAYS, so two plans on one day aren't double-counted.
  const plannedDays = new Set(planned.map(s => s.date)).size;
  const metDays = new Set(planned.filter(wasMet).map(p => p.date)).size;
  return metDays / plannedDays;
}

function summariseByType(done: ExerciseSession[]): ExerciseTypeSummary[] {
  const map = new Map<string, ExerciseTypeSummary>();
  for (const s of done) {
    const key = s.type.toLowerCase();
    const row = map.get(key) ?? { type: s.type, sessions: 0, exercisesDone: 0, distanceKm: 0 };
    row.sessions += 1;
    row.exercisesDone += exercisesDone(s);
    row.distanceKm += sessionDistanceKm(s);
    map.set(key, row);
  }
  return [...map.values()]
    .map(r => ({ ...r, distanceKm: round1(r.distanceKm) }))
    .sort((a, b) => b.sessions - a.sessions || a.type.localeCompare(b.type));
}

function summariseByWeek(done: ExerciseSession[], planned: ExerciseSession[]): ExerciseWeekSummary[] {
  const map = new Map<string, ExerciseWeekSummary>();
  const row = (weekStart: string) =>
    map.get(weekStart) ?? { weekStart, sessions: 0, exercisesDone: 0, distanceKm: 0, plannedSessions: 0 };

  for (const s of done) {
    const key = weekStartKey(s.date);
    const r = row(key);
    r.sessions += 1;
    r.exercisesDone += exercisesDone(s);
    r.distanceKm += sessionDistanceKm(s);
    map.set(key, r);
  }
  for (const s of planned) {
    const key = weekStartKey(s.date);
    const r = row(key);
    r.plannedSessions += 1;
    map.set(key, r);
  }

  return [...map.values()]
    .map(r => ({ ...r, distanceKm: round1(r.distanceKm) }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// Consecutive weeks with at least one session, counted back from the week the
// window ends in. A gap week (present with zero sessions, or missing entirely)
// breaks the streak.
function currentStreakWeeks(byWeek: ExerciseWeekSummary[], to: string): number {
  const active = new Set(byWeek.filter(w => w.sessions > 0).map(w => w.weekStart));
  if (active.size === 0) return 0;

  let cursor = startOfWeek(parseISO(to), { weekStartsOn: 1 });
  let streak = 0;
  // The current week counts as a grace period: mid-week with nothing logged
  // yet shouldn't read as a broken streak, so step back one week and continue.
  if (!active.has(format(cursor, 'yyyy-MM-dd'))) {
    cursor = new Date(cursor.getTime() - 7 * 86_400_000);
  }
  while (active.has(format(cursor, 'yyyy-MM-dd'))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 7 * 86_400_000);
  }
  return streak;
}

// Each rule fires on a specific, checkable condition; nothing is emitted just to
// fill the list. An empty suggestions array is a legitimate "nothing to say".
function buildSuggestions(a: ExerciseAnalysis, hardShare: number | null): string[] {
  const out: string[] = [];

  if (a.totalSessions === 0) {
    out.push('Nothing logged in this window. Log a session (or plan one) to start building a baseline.');
    return out;
  }

  if (a.sessionsPerWeek < 2) {
    out.push(
      `Averaging ${a.sessionsPerWeek} sessions a week. Two or three is the usual floor for consistency — consider planning sessions ahead rather than fitting them in.`
    );
  } else if (a.sessionsPerWeek >= 5) {
    out.push(
      `Averaging ${a.sessionsPerWeek} sessions a week. That's a high volume — check there's at least one genuinely easy day in there.`
    );
  }

  if (a.planAdherence !== null && a.planAdherence < 0.6) {
    out.push(
      `Only ${Math.round(a.planAdherence * 100)}% of planned sessions happened. Either the plan is too ambitious or the slots are landing at the wrong time.`
    );
  } else if (a.planAdherence !== null && a.planAdherence >= 0.9 && a.sessionsPerWeek < 4) {
    out.push(
      `${Math.round(a.planAdherence * 100)}% of planned sessions happened — the plan is working, so there's room to add one.`
    );
  }

  if (a.byType.length === 1) {
    out.push(
      `Everything logged is "${a.byType[0].type}". Adding a second type spreads the load and reduces injury risk.`
    );
  }

  if (hardShare !== null && hardShare > 0.5) {
    out.push(
      `${Math.round(hardShare * 100)}% of sessions are marked hard. Most training plans keep hard days under a third.`
    );
  }

  const trend = recentTrend(a.byWeek);
  if (trend === 'declining') {
    out.push('Weekly volume has fallen for three weeks running. Worth deciding whether that is deliberate.');
  } else if (trend === 'rising') {
    out.push('Weekly volume has risen for three weeks running. Keep the increases modest to avoid overreaching.');
  }

  if (a.currentStreakWeeks >= 4) {
    out.push(`${a.currentStreakWeeks}-week streak of at least one session. Worth protecting.`);
  }

  return out;
}

// Three consecutive weeks moving the same way, counted in sessions — the
// count-based signal that replaced weekly minutes.
function recentTrend(byWeek: ExerciseWeekSummary[]): 'rising' | 'declining' | 'flat' {
  const recent = byWeek.slice(-3);
  if (recent.length < 3) return 'flat';
  const [a, b, c] = recent.map(w => w.sessions);
  if (a > b && b > c) return 'declining';
  if (a < b && b < c) return 'rising';
  return 'flat';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
