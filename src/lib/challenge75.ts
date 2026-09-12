// The pure rules engine for Dave's self-designed "75 Hard" discipline
// challenge: 75 consecutive days, five daily rules, and two failure conditions.
// I/O-free and free of React so the storage layer, the API route and both the
// desktop and mobile UIs evaluate an attempt with exactly the same logic — the
// only difference between them is where "today" comes from.
//
// The rules, verbatim from the brief:
//   1. exercise — do the planned exercise (Sunday is a rest day: long walk + yoga).
//   2. walk     — a 45-minute walk, required Mon–Sat only (Sunday's long walk IS
//                 the exercise, so the box is auto-satisfied and not tickable).
//   3. water    — 3 litres of water.
//   4. read     — read a good chunk of a book (deliberately no page count).
//   5. photo    — a progress photo (checkbox only, no upload).
//
// Pass/fail:
//   - A day PASSES only if every REQUIRED box is ticked; otherwise it is a MISS.
//   - Days after today are PENDING; today is PENDING until it passes (an unticked
//     day counts as a miss only once the date is in the past).
//   - Rolling rule: every window of up to 7 challenge days ending on a resolved
//     day must hold at most 1 miss (i.e. at least 6 of the last 7 are passes;
//     before 7 days have elapsed, at most 1 miss among the days so far).
//   - Cap: at most 5 misses in total across the 75 days.
//   - Breaching either rule fails the attempt.

import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';

import type {
  Challenge75Attempt,
  Challenge75DayTicks,
  Challenge75Rule,
} from '@/types/life';

export const CHALLENGE_LENGTH = 75;
export const MAX_TOTAL_MISSES = 5;
export const ROLLING_WINDOW = 7;
// At least this many of the last ROLLING_WINDOW days must be passes.
export const ROLLING_MIN_PASSES = 6;
// The first attempt's start date — Monday 14 September 2026 is day 1.
export const DEFAULT_START_DATE = '2026-09-14';

// The five rules in display order, with their labels and descriptions.
export const CHALLENGE_RULES: Array<{
  id: Challenge75Rule;
  label: string;
  description: string;
}> = [
  { id: 'exercise', label: 'Exercise', description: 'Do the planned exercise' },
  { id: 'walk', label: '45-minute walk', description: 'A 45-minute walk (Mon–Sat)' },
  { id: 'water', label: '3 litres of water', description: 'Drink 3 litres of water' },
  { id: 'read', label: 'Read', description: 'Read a good chunk of a book' },
  { id: 'photo', label: 'Progress photo', description: 'Take a progress photo' },
];

export type Challenge75DayStatus = 'pass' | 'miss' | 'pending';
export type Challenge75AttemptState = 'active' | 'failed' | 'complete';
export type Challenge75FailReason = 'rolling' | 'cap';

// A single day of the challenge, with everything the UI needs to render its cell
// and its checklist.
export interface Challenge75Day {
  date: string; // yyyy-MM-dd
  dayNumber: number; // 1-based, 1..75
  status: Challenge75DayStatus;
  isToday: boolean;
  // Which rules are required on this day (walk drops out on Sundays).
  requiredRules: Challenge75Rule[];
  ticks: Challenge75DayTicks;
}

export interface Challenge75RollingStatus {
  windowSize: number; // how many days the current window covers (≤ 7)
  passes: number; // passes within that window
  misses: number; // misses within that window
  ok: boolean; // misses ≤ 1
  label: string; // e.g. "6 of last 7"
}

export interface Challenge75Summary {
  startDate: string;
  today: string;
  totalDays: number; // always CHALLENGE_LENGTH
  // The current challenge day number (1..75); 0 before the start date.
  currentDay: number;
  daysRemaining: number; // 75 − currentDay, never negative
  passes: number;
  misses: number;
  missesRemaining: number; // max(0, 5 − misses)
  rolling: Challenge75RollingStatus;
  state: Challenge75AttemptState;
  // Set only when state is 'failed' and the attempt failed live (not archived
  // with an outcome already recorded).
  failReason?: Challenge75FailReason;
  days: Challenge75Day[];
}

// Sunday is JS getDay() === 0. On Sundays the 45-minute walk is not required —
// the long walk is that day's exercise instead.
export function isWalkRequired(date: string): boolean {
  return parseISO(date).getDay() !== 0;
}

// The rules that must be ticked for the given date to pass.
export function requiredRulesFor(date: string): Challenge75Rule[] {
  return CHALLENGE_RULES.map(r => r.id).filter(id => id !== 'walk' || isWalkRequired(date));
}

// The 75 calendar dates of an attempt, day 1 first.
export function challengeDates(startDate: string): string[] {
  const start = parseISO(startDate);
  return Array.from({ length: CHALLENGE_LENGTH }, (_, i) => format(addDays(start, i), 'yyyy-MM-dd'));
}

// The challenge day number for a date (1-based), or null if the date is outside
// the 75-day window.
export function dayNumberFor(startDate: string, date: string): number | null {
  const diff = differenceInCalendarDays(parseISO(date), parseISO(startDate));
  if (diff < 0 || diff >= CHALLENGE_LENGTH) return null;
  return diff + 1;
}

// Are all of a day's required rules ticked?
export function isDayComplete(date: string, ticks: Challenge75DayTicks | undefined): boolean {
  const t = ticks ?? {};
  return requiredRulesFor(date).every(rule => t[rule] === true);
}

// A day's status given "today": future days are pending; today is pending until
// complete; past days pass if complete, else miss.
export function dayStatusFor(
  date: string,
  ticks: Challenge75DayTicks | undefined,
  today: string
): Challenge75DayStatus {
  const complete = isDayComplete(date, ticks);
  if (date > today) return 'pending';
  if (date === today) return complete ? 'pass' : 'pending';
  return complete ? 'pass' : 'miss';
}

// Evaluate a whole attempt against "today", returning everything the UI shows.
// `today` is passed in (never read from the clock here) so the result is
// deterministic and testable, and so server and client agree.
export function evaluateAttempt(attempt: Challenge75Attempt, today: string): Challenge75Summary {
  const startDate = attempt.startDate;
  const dates = challengeDates(startDate);

  const days: Challenge75Day[] = dates.map((date, i) => {
    const ticks = attempt.days[date] ?? {};
    return {
      date,
      dayNumber: i + 1,
      status: dayStatusFor(date, ticks, today),
      isToday: date === today,
      requiredRules: requiredRulesFor(date),
      ticks,
    };
  });

  const passes = days.filter(d => d.status === 'pass').length;
  const misses = days.filter(d => d.status === 'miss').length;

  // The rolling breach: any window of up to 7 challenge days ending on a
  // RESOLVED day (pass or miss) that holds 2+ misses. Pending days can't end a
  // window, and — being later than every resolved day — never sit inside one.
  const statuses = days.map(d => d.status);
  const lastResolved = lastResolvedIndex(statuses);
  let rollingBreached = false;
  for (let i = 0; i <= lastResolved; i++) {
    const from = Math.max(0, i - (ROLLING_WINDOW - 1));
    const windowMisses = countMisses(statuses, from, i);
    if (windowMisses >= 2) {
      rollingBreached = true;
      break;
    }
  }

  const capBreached = misses > MAX_TOTAL_MISSES;

  // The CURRENT rolling window: the up-to-7 days ending on the latest resolved
  // day. Before anything has resolved it reports a clean full window.
  const rolling = currentRollingStatus(statuses, lastResolved);

  const currentDay = clampDay(dayNumberFor(startDate, today), today, startDate);
  const daysRemaining = Math.max(0, CHALLENGE_LENGTH - currentDay);

  // State: an archived attempt keeps its recorded outcome; otherwise compute it
  // live. A live breach fails it; reaching the end without a breach completes it.
  let state: Challenge75AttemptState;
  let failReason: Challenge75FailReason | undefined;
  if (attempt.outcome === 'failed') {
    state = 'failed';
  } else if (attempt.outcome === 'complete') {
    state = 'complete';
  } else if (rollingBreached || capBreached) {
    state = 'failed';
    // Report the cap only when it alone was breached; otherwise the rolling
    // rule is the more immediate, more informative reason.
    failReason = rollingBreached ? 'rolling' : 'cap';
  } else if (today > dates[dates.length - 1]) {
    state = 'complete';
  } else {
    state = 'active';
  }

  return {
    startDate,
    today,
    totalDays: CHALLENGE_LENGTH,
    currentDay,
    daysRemaining,
    passes,
    misses,
    missesRemaining: Math.max(0, MAX_TOTAL_MISSES - misses),
    rolling,
    state,
    ...(failReason ? { failReason } : {}),
    days,
  };
}

// The clamped current day number for the header: 0 before the start, 75 after
// the end, else the real day number.
function clampDay(raw: number | null, today: string, startDate: string): number {
  if (raw !== null) return raw;
  return today < startDate ? 0 : CHALLENGE_LENGTH;
}

function lastResolvedIndex(statuses: Challenge75DayStatus[]): number {
  for (let i = statuses.length - 1; i >= 0; i--) {
    if (statuses[i] !== 'pending') return i;
  }
  return -1;
}

function countMisses(statuses: Challenge75DayStatus[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i <= to; i++) if (statuses[i] === 'miss') n++;
  return n;
}

function currentRollingStatus(
  statuses: Challenge75DayStatus[],
  lastResolved: number
): Challenge75RollingStatus {
  if (lastResolved < 0) {
    return {
      windowSize: ROLLING_WINDOW,
      passes: ROLLING_WINDOW,
      misses: 0,
      ok: true,
      label: `${ROLLING_MIN_PASSES} of last ${ROLLING_WINDOW}`,
    };
  }
  const from = Math.max(0, lastResolved - (ROLLING_WINDOW - 1));
  const windowSize = lastResolved - from + 1;
  const misses = countMisses(statuses, from, lastResolved);
  const passes = windowSize - misses;
  return {
    windowSize,
    passes,
    misses,
    ok: misses <= 1,
    label: `${passes} of last ${windowSize}`,
  };
}
