// Turns the raw habit log into the numbers the Wellbeing → Analysis tab shows.
//
// Pure and synchronous: it takes the days already read from storage and returns
// the whole analysis, so it is testable without a database and cheap enough to
// run on every request.
//
// One judgement call runs through all of it: a day with NO record is not the
// same as a day answered "no". Nothing was asked, so nothing is known. Rates are
// therefore over days actually logged, and an unlogged day breaks a streak
// rather than counting against it — with one exception, noted at currentStreak.

import { format, parseISO, startOfWeek } from 'date-fns';

import { HABITS } from './wellbeing-habits';
import type {
  HabitDailyPoint,
  HabitReasonGroup,
  HabitSummary,
  HabitWeekPoint,
  WellbeingAnalysis,
  WellbeingDay,
} from '@/types/wellbeing';

// How much each new day moves the consistency score. Low enough that a single
// miss barely dents it, high enough that consecutive misses compound quickly.
const CONSISTENCY_ALPHA = 0.25;
const ROLLING_WINDOW = 7;

// How many notes the tab shows before it stops being a summary and starts being
// a diary.
const RECENT_NOTES = 10;

// Skip reasons are free text, so "Too tired" and "too tired." must land in the
// same bucket. Anything cleverer (stemming, clustering) would guess at meaning;
// this only claims that punctuation and case don't matter.
function normalizeReason(reason: string): string {
  return reason.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
}

function weekStartOf(date: string): string {
  return format(startOfWeek(parseISO(date), { weekStartsOn: 1 }), 'yyyy-MM-dd');
}

// Consecutive days done, counting back from the end of the window.
//
// `to` is allowed to be unanswered without breaking the streak: the analysis is
// routinely looked at before the day's review has happened, and zeroing a
// 30-day streak at breakfast would be both wrong and demoralising. Any EARLIER
// gap does break it — an unlogged day is genuinely unknown, and carrying a
// streak across it would be a claim the data doesn't support.
function currentStreak(doneByDate: Map<string, boolean>, dates: string[], to: string): number {
  let streak = 0;
  for (let i = dates.length - 1; i >= 0; i--) {
    const answer = doneByDate.get(dates[i]);
    if (answer === undefined) {
      if (dates[i] === to) continue; // today, not reviewed yet
      break;
    }
    if (!answer) break;
    streak++;
  }
  return streak;
}

function longestStreak(doneByDate: Map<string, boolean>, dates: string[]): number {
  let best = 0;
  let run = 0;
  for (const date of dates) {
    if (doneByDate.get(date) === true) {
      run++;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best;
}

// Every calendar date from `from` to `to` inclusive. Streaks are about calendar
// days, so the gaps have to be present rather than inferred from the log.
function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = parseISO(from);
  const end = parseISO(to);
  while (cursor <= end) {
    dates.push(format(cursor, 'yyyy-MM-dd'));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

// The day before `to` — "yesterday". Today (`to`) is excluded from the daily
// series because it may be legitimately unanswered, exactly as the streak logic
// forgives it.
function dayBefore(date: string): string {
  const d = parseISO(date);
  d.setDate(d.getDate() - 1);
  return format(d, 'yyyy-MM-dd');
}

// Per-day series for one habit, running from its first logged day to yesterday.
// The habits are daily, so an unlogged past day is a MISS, not "unknown" (unlike
// the streak/rate logic, which is deliberately agnostic about unlogged days).
//
// The consistency score is an EWMA `s_t = s_{t-1} + alpha*(x_t - s_{t-1})`
// seeded at the first day's outcome. It weights recent days most: consecutive
// misses compound (each further miss multiplies the drop), while a single miss
// followed by a done day recovers fast — the behaviour we want for habits.
function dailySeries(doneByDate: Map<string, boolean>, to: string): HabitDailyPoint[] {
  if (doneByDate.size === 0) return [];
  const logged = [...doneByDate.keys()].sort();
  const first = logged[0];
  const end = dayBefore(to);
  if (first > end) return []; // only logged today — no past history yet

  const dates = eachDate(first, end);
  const out: HabitDailyPoint[] = [];
  const outcomes: number[] = [];
  let consistency = 0;

  dates.forEach((date, i) => {
    const answer = doneByDate.get(date);
    const isLogged = answer !== undefined;
    const done = answer === true;
    // Done → 1; answered-no OR unlogged-past-day → 0.
    const x = done ? 1 : 0;
    outcomes.push(x);

    consistency = i === 0 ? x : consistency + CONSISTENCY_ALPHA * (x - consistency);

    const window = outcomes.slice(-ROLLING_WINDOW);
    const rolling7 = window.reduce((a, b) => a + b, 0) / window.length;

    out.push({ date, done, logged: isLogged, consistency, rolling7 });
  });

  return out;
}

function summariseHabit(
  habitId: string,
  label: string,
  days: WellbeingDay[],
  dates: string[],
  to: string
): HabitSummary {
  const doneByDate = new Map<string, boolean>();
  const reasons = new Map<string, HabitReasonGroup>();
  const weeks = new Map<string, HabitWeekPoint>();

  for (const day of days) {
    const log = day.habits.find(h => h.habitId === habitId);
    if (!log) continue;
    doneByDate.set(day.date, log.done);

    const weekStart = weekStartOf(day.date);
    const week = weeks.get(weekStart) ?? { weekStart, done: 0, logged: 0 };
    week.logged++;
    if (log.done) week.done++;
    weeks.set(weekStart, week);

    if (!log.done && log.reason) {
      const key = normalizeReason(log.reason);
      const group = reasons.get(key);
      // The most recent occurrence supplies the wording, so the list reads in
      // the phrasing last used rather than whatever was typed first.
      if (group) {
        group.count++;
        if (day.date >= group.lastOn) {
          group.reason = log.reason.trim();
          group.lastOn = day.date;
        }
      } else {
        reasons.set(key, { reason: log.reason.trim(), count: 1, lastOn: day.date });
      }
    }
  }

  const daysLogged = doneByDate.size;
  const daysDone = [...doneByDate.values()].filter(Boolean).length;

  return {
    habitId,
    label,
    daysLogged,
    daysDone,
    rate: daysLogged === 0 ? null : daysDone / daysLogged,
    currentStreak: currentStreak(doneByDate, dates, to),
    longestStreak: longestStreak(doneByDate, dates),
    byWeek: [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    daily: dailySeries(doneByDate, to),
    reasons: [...reasons.values()].sort(
      (a, b) => b.count - a.count || b.lastOn.localeCompare(a.lastOn)
    ),
  };
}

// Plain observations from the numbers — no AI call, so the tab is instant and
// works offline. Each one is phrased as something to act on rather than a score.
function buildSuggestions(habits: HabitSummary[], daysLogged: number, windowDays: number): string[] {
  const out: string[] = [];

  if (daysLogged === 0) {
    return ['No days logged yet — the daily review is where these get recorded.'];
  }
  // Coverage is about the review habit itself, not the habits being reviewed,
  // so it is worth saying separately: thin data makes everything below shakier.
  if (daysLogged / windowDays < 0.5) {
    out.push(
      `Only ${daysLogged} of the last ${windowDays} days were logged — the rates below are based on a thin record.`
    );
  }

  for (const habit of habits) {
    if (habit.daysLogged === 0) {
      out.push(`${habit.label} hasn't been logged yet.`);
      continue;
    }
    if (habit.rate !== null && habit.rate >= 0.8) {
      out.push(
        `${habit.label} is holding at ${Math.round(habit.rate * 100)}% — closer to automatic than not.`
      );
    } else if (habit.rate !== null && habit.rate < 0.4) {
      out.push(
        `${habit.label} is at ${Math.round(habit.rate * 100)}%. Worth making it smaller or moving when it happens, rather than trying harder.`
      );
    }
    const top = habit.reasons[0];
    if (top && top.count >= 3) {
      out.push(`"${top.reason}" has blocked ${habit.label} ${top.count} times — that's the thing to fix.`);
    }
  }

  return out;
}

export function computeWellbeingAnalysis(
  days: WellbeingDay[],
  from: string,
  to: string
): WellbeingAnalysis {
  const inWindow = days
    .filter(d => d.date >= from && d.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
  const dates = eachDate(from, to);

  const habits = HABITS.map(h => summariseHabit(h.id, h.label, inWindow, dates, to));

  const recentNotes = inWindow
    .filter(d => !!d.notes)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, RECENT_NOTES)
    .map(d => ({ date: d.date, note: d.notes as string }));

  return {
    from,
    to,
    daysLogged: inWindow.length,
    habits,
    recentNotes,
    suggestions: buildSuggestions(habits, inWindow.length, dates.length),
  };
}
