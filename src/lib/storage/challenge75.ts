// Persistence for the "75 Hard" discipline challenge (see ../challenge75 for the
// rules engine). Its own `challenge75` domain in the user-data store (see ./db),
// read and written directly rather than through getUserData(): a dedicated
// module owns the seed-on-empty, the per-attempt validation and the per-action
// tick writes, matching the weekly-routine and rehab modules.
//
// The state is a list of attempts, the LAST one active. Restarting archives the
// active attempt (its ticks are kept for history) and appends a fresh one. Ticks
// and notes are written per action against the active attempt, so a flaky phone
// connection can only ever lose the one tick in flight.
//
// The first attempt is seeded with startDate 2026-09-14 (day 1) on the first
// read of an empty store, then becomes ordinary editable data.

import { readAllDomains, writeAllDomains } from './db';
import {
  CHALLENGE_RULES,
  DEFAULT_START_DATE,
  challengeDates,
  evaluateAttempt,
} from '../challenge75';
import { logicalToday } from '../date-utils';
import type {
  Challenge75Attempt,
  Challenge75DayTicks,
  Challenge75Rule,
  Challenge75State,
} from '@/types/life';

const RULE_IDS = new Set<Challenge75Rule>(CHALLENGE_RULES.map(r => r.id));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateKey(value: string): boolean {
  return DATE_RE.test(value);
}

// Clean one day's ticks: keep only known boolean rule flags set true, plus a
// trimmed note. Kept tolerant so a malformed field can't corrupt the store.
function normaliseDay(raw: unknown): Challenge75DayTicks {
  if (!raw || typeof raw !== 'object') return {};
  const day = raw as Record<string, unknown>;
  const out: Challenge75DayTicks = {};
  for (const rule of RULE_IDS) {
    if (day[rule] === true) out[rule] = true;
  }
  if (typeof day.note === 'string' && day.note.trim()) out.note = day.note.trim();
  return out;
}

// Clean one attempt: require a valid startDate, keep only day entries whose key
// is a date within the attempt's 75-day window, and carry a recorded outcome.
function normaliseAttempt(raw: unknown): Challenge75Attempt | null {
  if (!raw || typeof raw !== 'object') return null;
  const attempt = raw as Partial<Challenge75Attempt>;
  if (typeof attempt.startDate !== 'string' || !isDateKey(attempt.startDate)) return null;

  const valid = new Set(challengeDates(attempt.startDate));
  const days: Record<string, Challenge75DayTicks> = {};
  if (attempt.days && typeof attempt.days === 'object') {
    for (const [date, ticks] of Object.entries(attempt.days)) {
      if (!valid.has(date)) continue;
      const cleaned = normaliseDay(ticks);
      if (Object.keys(cleaned).length) days[date] = cleaned;
    }
  }

  return {
    startDate: attempt.startDate,
    days,
    ...(typeof attempt.endedAt === 'string' ? { endedAt: attempt.endedAt } : {}),
    ...(attempt.outcome === 'failed' || attempt.outcome === 'complete'
      ? { outcome: attempt.outcome }
      : {}),
  };
}

function readState(): Challenge75State | null {
  const raw = readAllDomains().challenge75;
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<Challenge75State>;
  if (!Array.isArray(source.attempts)) return null;
  const attempts = source.attempts
    .map(normaliseAttempt)
    .filter((a): a is Challenge75Attempt => a !== null);
  return attempts.length ? { attempts } : null;
}

function seedState(): Challenge75State {
  return { attempts: [{ startDate: DEFAULT_START_DATE, days: {} }] };
}

// The whole challenge state. Seeds the first attempt on the first read of an
// empty store, persisting it so subsequent reads and edits build on it.
export async function getChallenge75State(): Promise<Challenge75State> {
  const existing = readState();
  if (existing) return existing;
  const seeded = seedState();
  writeAllDomains({ challenge75: seeded });
  return seeded;
}

// The active attempt is the last one in the list (the only one without an
// endedAt in normal operation).
function activeAttempt(state: Challenge75State): Challenge75Attempt {
  return state.attempts[state.attempts.length - 1];
}

function save(state: Challenge75State): Challenge75State {
  writeAllDomains({ challenge75: state });
  return state;
}

// A date must be one of the active attempt's 75 challenge days to be written to.
function assertChallengeDate(attempt: Challenge75Attempt, date: string): void {
  if (typeof date !== 'string' || !isDateKey(date)) {
    throw new Error('date must be yyyy-MM-dd');
  }
  if (!challengeDates(attempt.startDate).includes(date)) {
    throw new Error('date is outside the current attempt');
  }
}

function replaceActiveDay(
  state: Challenge75State,
  date: string,
  update: (ticks: Challenge75DayTicks) => Challenge75DayTicks
): Challenge75State {
  const attempts = [...state.attempts];
  const active = { ...attempts[attempts.length - 1] };
  const nextDay = update({ ...(active.days[date] ?? {}) });
  const days = { ...active.days };
  if (Object.keys(nextDay).length) days[date] = nextDay;
  else delete days[date];
  active.days = days;
  attempts[attempts.length - 1] = active;
  return { attempts };
}

// Tick or untick one rule on one date of the active attempt. Idempotent.
export async function setChallenge75Tick(
  date: string,
  rule: Challenge75Rule,
  value: boolean
): Promise<Challenge75State> {
  if (!RULE_IDS.has(rule)) throw new Error(`Unknown rule: ${rule}`);
  const state = await getChallenge75State();
  assertChallengeDate(activeAttempt(state), date);

  return save(
    replaceActiveDay(state, date, ticks => {
      if (value) ticks[rule] = true;
      else delete ticks[rule];
      return ticks;
    })
  );
}

// Set or clear the free-text note on one date of the active attempt.
export async function setChallenge75Note(
  date: string,
  note: string
): Promise<Challenge75State> {
  const state = await getChallenge75State();
  assertChallengeDate(activeAttempt(state), date);
  const trimmed = typeof note === 'string' ? note.trim() : '';

  return save(
    replaceActiveDay(state, date, ticks => {
      if (trimmed) ticks.note = trimmed;
      else delete ticks.note;
      return ticks;
    })
  );
}

// Change the active attempt's start date. Day entries that fall outside the new
// 75-day window are dropped (the window has moved), matching normaliseAttempt.
export async function setChallenge75StartDate(startDate: string): Promise<Challenge75State> {
  if (typeof startDate !== 'string' || !isDateKey(startDate)) {
    throw new Error('startDate must be yyyy-MM-dd');
  }
  const state = await getChallenge75State();
  const attempts = [...state.attempts];
  const active = { ...attempts[attempts.length - 1], startDate };
  const valid = new Set(challengeDates(startDate));
  const days: Record<string, Challenge75DayTicks> = {};
  for (const [date, ticks] of Object.entries(active.days)) {
    if (valid.has(date)) days[date] = ticks;
  }
  active.days = days;
  attempts[attempts.length - 1] = active;
  return save({ attempts });
}

// Restart from day 1: archive the active attempt (recording how it ended, and
// keeping its ticks) and append a fresh attempt from the chosen start date
// (default: today, in the app's logical timezone).
export async function restartChallenge75(startDate?: string): Promise<Challenge75State> {
  const start = typeof startDate === 'string' && isDateKey(startDate) ? startDate : logicalToday();
  const state = await getChallenge75State();
  const attempts = [...state.attempts];
  const active = { ...attempts[attempts.length - 1] };

  // Record the terminal outcome so history reads honestly: a live-failed attempt
  // archives as 'failed', a finished one as 'complete', anything else abandoned
  // mid-flight is treated as failed (restart is the fail path).
  const summary = evaluateAttempt(active, logicalToday());
  active.endedAt = new Date().toISOString();
  active.outcome = summary.state === 'complete' ? 'complete' : 'failed';
  attempts[attempts.length - 1] = active;

  attempts.push({ startDate: start, days: {} });
  return save({ attempts });
}
