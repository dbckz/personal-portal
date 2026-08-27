// Types for the Wellbeing section: the daily habits tracked through the daily
// review, and the experiments run to find out what actually helps.
//
// The two halves are deliberately separate. Habits are a fixed, small set asked
// about every day — the point is an unbroken record, so the questions never
// change shape. Experiments are open-ended and short-lived: something read
// about, tried deliberately for a few weeks, then judged.

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

// A habit is defined in code (lib/wellbeing-habits.ts), not stored, so the
// daily-review questions and the analysis can never disagree about what is
// being tracked. Adding one is a registry entry; history simply starts empty.
export interface HabitDefinition {
  id: string;
  label: string;
  // The question asked in the daily review ("Did you meditate today?").
  question: string;
}

// One habit's answer for one day. A `false` answer always carries a reason —
// the whole point of asking is to learn what gets in the way — and the storage
// layer rejects a skip without one rather than saving a blank.
export interface HabitLog {
  habitId: string;
  done: boolean;
  reason?: string;
}

// A day's wellbeing record. Written by the daily review; a day that was never
// reviewed simply has no record, which is different from a day answered "no".
export interface WellbeingDay {
  date: string; // yyyy-MM-dd
  habits: HabitLog[];
  // Open-ended context for the day — anything worth having later when looking
  // for what correlates with a good or bad stretch.
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Analysis (computed, never stored)
// ---------------------------------------------------------------------------

export interface HabitWeekPoint {
  weekStart: string; // yyyy-MM-dd Monday
  done: number;
  logged: number;
}

// One calendar day of a habit's daily series, over the window from its first
// logged day up to yesterday (today is excluded — it may be legitimately
// unanswered). A day with no log that is in the past counts as a miss: the
// habits are daily, so silence is a miss rather than "unknown" here.
export interface HabitDailyPoint {
  date: string; // yyyy-MM-dd
  // The day's outcome: true only when a log exists answered done.
  done: boolean;
  // Whether a log exists for the day at all (false = unlogged past day).
  logged: boolean;
  // Streak-aware EWMA (alpha 0.25), 0-1. Consecutive misses compound; a single
  // miss followed by a done day recovers fast.
  consistency: number;
  // Mean of the last up-to-7 daily outcomes, 0-1.
  rolling7: number;
}

// Free-text skip reasons grouped by their normalised form, so "too tired" and
// "Too tired." count as the same obstacle. The original spelling of the most
// recent occurrence is what gets shown.
export interface HabitReasonGroup {
  reason: string;
  count: number;
  lastOn: string; // yyyy-MM-dd
}

export interface HabitSummary {
  habitId: string;
  label: string;
  daysLogged: number;
  daysDone: number;
  // daysDone / daysLogged, 0-1. Null when nothing has been logged at all —
  // distinct from 0, which means asked and answered no every time.
  rate: number | null;
  // Consecutive days done, counting back from the end of the window. Today is
  // allowed to be unanswered without breaking it (the review may not have
  // happened yet); any earlier gap does break it.
  currentStreak: number;
  longestStreak: number;
  byWeek: HabitWeekPoint[];
  // Per-day outcome, consistency and rolling done-rate over the window (first
  // logged day to yesterday). Empty until there is at least one past logged day.
  daily: HabitDailyPoint[];
  reasons: HabitReasonGroup[];
}

export interface WellbeingAnalysis {
  // The window analysed, inclusive.
  from: string;
  to: string;
  daysLogged: number;
  habits: HabitSummary[];
  // The most recent free-text notes, newest first — the raw material for
  // spotting what a good or bad run had in common.
  recentNotes: Array<{ date: string; note: string }>;
  // Generated from the numbers above — no AI call, so the tab is instant and
  // works offline.
  suggestions: string[];
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

// 'planned' is written down but not started; 'running' is in progress;
// 'complete' has been judged; 'abandoned' was dropped without a verdict.
export type ExperimentStatus = 'planned' | 'running' | 'complete' | 'abandoned';

// The judgement at the end. 'inconclusive' is a real, common outcome — it
// deserves its own answer rather than being hidden inside "no effect".
export type ExperimentVerdict = 'worked' | 'mixed' | 'no-effect' | 'inconclusive';

// A single observation while an experiment runs. `rating` is a coarse 1-5 "how
// is this going" so a run of check-ins can be read as a trend; the note carries
// whatever the number can't.
export interface ExperimentCheckIn {
  at: string; // ISO
  rating?: number; // 1-5
  note?: string;
}

// One thing being tried deliberately, for a fixed period, with the criteria for
// judging it written down BEFORE it starts. The fields mirror how an experiment
// actually fails: no protocol means it was never really done, no measure means
// the result can't be called either way.
export interface Experiment {
  id: string;
  title: string;
  // What is expected to change, and why it might.
  hypothesis?: string;
  // Exactly what will be done, concretely enough to follow on a bad day.
  protocol?: string;
  // How the result will be judged — the thing that stops an experiment ending
  // in a vague feeling.
  measure?: string;
  startDate?: string; // yyyy-MM-dd
  endDate?: string; // yyyy-MM-dd
  status: ExperimentStatus;
  checkIns: ExperimentCheckIn[];
  verdict?: ExperimentVerdict;
  // What was concluded, written at the end.
  reflection?: string;
  createdAt: string;
  updatedAt: string;
}
