// Types for the life-areas layer: the sections that sit ABOVE the original
// tabs, the goals that hang off them, and the exercise log that feeds the
// Exercise section.
//
// The original app was work-only, so its tabs (Command Center, Daily Calendar,
// Rituals, Reminders, Analysis) are now the sub-tabs of one section — 'work'.
// Everything here is section-scoped so adding a life area later is data, not
// code.

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

// Section ids are plain strings, not a closed union, so a new life area can be
// added to the registry (lib/life-sections.ts) without a type change rippling
// through storage and the API. The registry is the source of truth for which
// ids are real; storage validates against it.
export type LifeSectionId = string;

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

// Monthly goals nest under quarterly ones. A period key identifies the window:
//   month   -> 'yyyy-MM'   e.g. '2026-08'
//   quarter -> 'yyyy-[Q]q' e.g. '2026-Q3'
export type GoalPeriodKind = 'month' | 'quarter';

// How a goal's progress is measured without Dave typing a number in.
//   asana-project    ref = project gid       -> tasks completed in the period
//   asana-tag        ref = tag gid           -> tasks completed in the period
//   calendar-category ref = category name    -> minutes booked (from weeklyStats)
//   exercise         ref = session type or ''-> sessions (or minutes) logged
//   manual           no ref                  -> whatever Dave last reported
export type GoalEvidenceKind =
  | 'asana-project'
  | 'asana-tag'
  | 'calendar-category'
  | 'exercise'
  | 'manual';

export interface GoalEvidence {
  kind: GoalEvidenceKind;
  ref?: string;
  // For 'calendar-category' and 'exercise', how the target is counted. 'count'
  // and 'minutes' are tallies; 'max-distance-km' (exercise only) is a peak
  // metric — the longest single completed run/session distance in the period,
  // which is how a "run 10K" goal is judged. Ignored by the task-counting kinds.
  unit?: 'count' | 'minutes' | 'max-distance-km';
  // Restrict an asana-* source to one workspace; absent means every workspace.
  integrationId?: string;
}

// A numeric target makes pacing possible ("12 sessions this month"). Goals
// without one are tracked purely by check-in status.
export interface GoalTarget {
  value: number;
  // Free text shown next to the number ('sessions', 'hours', 'posts').
  unit?: string;
}

export type GoalCheckInStatus = 'on-track' | 'slipping' | 'stalled';

export interface GoalCheckIn {
  at: string; // ISO
  status: GoalCheckInStatus;
  note?: string;
  // Optional self-reported figure, used as the actual for manual-evidence goals.
  value?: number;
  // Where the check-in came from, so the weekly-review hook can be told apart
  // from an ad-hoc update in the Goals section.
  source: 'weekly-review' | 'goals-tab' | 'reflection';
}

// Terminal verdicts are only set at reflection time; 'active' is everything
// before that. 'dropped' means abandoned on purpose and is excluded from
// scorecard hit rates.
export type GoalStatus = 'active' | 'hit' | 'partial' | 'missed' | 'dropped';

// One waypoint on the path from where a goal starts to its target, so a big goal
// ("run 10K") is paced against a ramp rather than a single straight line. Ordered
// by `key`, which is a date inside the goal's period:
//   'yyyy-MM-dd'   a specific day  ('2026-09-15')
//   'yyyy-[W]ww'   an ISO week     ('2026-W37', resolved to its Monday)
// A numeric `value` is the figure the goal should be at by then (in the target's
// unit); milestones without one are narrative checkpoints that don't affect
// pacing. `reasoning` is the one line the inference wrote for why this step.
export interface GoalMilestone {
  key: string;
  value?: number;
  label: string;
  reasoning?: string;
}

export interface Goal {
  id: string;
  sectionId: LifeSectionId;
  periodKind: GoalPeriodKind;
  periodKey: string;
  title: string;
  detail?: string;
  // Monthly goals may nest under a quarterly goal. The parent must be a
  // quarterly goal in the same section whose quarter contains this month.
  parentGoalId?: string;
  target?: GoalTarget;
  evidence: GoalEvidence;
  // The progression plan: intermediate milestones from the current state to the
  // target across the period. Consumed by pacing (the expected curve bends
  // through these instead of running straight) and by the life areas — the
  // exercise programmer reads an exercise goal's ramp to set today's target.
  plan?: GoalMilestone[];
  // Where the plan came from: drafted by the inference ('ai') or hand-entered
  // ('manual'). Absent when there is no plan.
  planSource?: 'ai' | 'manual';
  // Latest self-reported figure for manual goals (also written by a check-in
  // that carries a value).
  manualValue?: number;
  checkIns: GoalCheckIn[];
  status: GoalStatus;
  // Written when the goal is closed out in a reflection session.
  reflection?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

// ---------------------------------------------------------------------------
// Goal progress (computed, never stored)
// ---------------------------------------------------------------------------

export type GoalPace = 'ahead' | 'on-track' | 'behind' | 'no-target' | 'no-data';

export interface GoalProgress {
  goalId: string;
  // Fraction of the period elapsed, 0-1.
  periodElapsed: number;
  // Where the goal should be by now if progress were linear.
  expected: number | null;
  actual: number | null;
  // actual / target, 0-1+ (null without a target).
  completion: number | null;
  pace: GoalPace;
  // Human-readable provenance of `actual` ('4 tasks completed in Policy').
  evidenceLabel: string;
  // True when nothing at all has been recorded this period — what the mid-period
  // nudge keys off.
  noEvidence: boolean;
  lastCheckIn?: GoalCheckIn;
  // The next milestone still ahead on the plan (if any), so nudges, check-in
  // copy and the pacing bar can say "next: 6 km by 15 Sep" without re-deriving it.
  nextMilestone?: GoalMilestone;
}

export interface GoalWithProgress {
  goal: Goal;
  progress: GoalProgress;
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

export type ScorecardVerdict = 'hit' | 'partial' | 'missed' | 'dropped' | 'unknown';

export interface ScorecardRow {
  goal: Goal;
  progress: GoalProgress;
  // What the evidence says the outcome was; the reflection session can override.
  suggestedVerdict: ScorecardVerdict;
}

export interface Scorecard {
  periodKind: GoalPeriodKind;
  periodKey: string;
  rows: ScorecardRow[];
  // Counts by suggested verdict, 'dropped' excluded from the denominator.
  hit: number;
  partial: number;
  missed: number;
  dropped: number;
  scored: number;
}

// ---------------------------------------------------------------------------
// Exercise
// ---------------------------------------------------------------------------

import type { PrescribedSection } from '@/lib/exercise-prescription';

export type ExerciseIntensity = 'easy' | 'moderate' | 'hard';

// One exercise performed inside a session — the granularity the training log is
// actually kept at ("Converging chest press machine, 3*8, 32kg").
//
// The raw `volumeText` / `loadText` are ALWAYS retained beside the parsed
// numbers. The source is hand-written and inconsistent, so the parse is
// best-effort; keeping the original means a figure the parser couldn't read is
// still visible, and a better parser can be re-run later without data loss.
export interface ExerciseEntry {
  id: string;
  name: string;
  volumeText?: string; // "3*8 each side", "10 mins", "2km"
  loadText?: string; // "27kg", "Bodyweight", "30kg (15 each side)"
  sets?: number;
  reps?: number; // per set
  holdSeconds?: number; // for planks and hangs, where reps make no sense
  perSide?: boolean; // "each side" — sets/reps are per side, not total
  weightKg?: number;
  bodyweight?: boolean;
  distanceKm?: number;
  durationMinutes?: number;
  notes?: string;
  // Explicit reps-in-reserve for the exercise, 0-5: 0 means nothing left in the
  // tank, 5 means it was comfortably light. Set from the Today checklist's RIR
  // control. When present it drives the next session's target directly, in
  // preference to the reps-in-reserve the recommender otherwise parses out of
  // `notes` (see exercise-targets).
  rir?: number;
  // Provenance for a per-exercise swap: the name of the ORIGINAL planned
  // exercise this entry replaced ("Parkrun 5K" when a shorter treadmill run was
  // done instead). Set when a planned exercise is swapped for another mid-session
  // and cleared (null in the patch) when the original is restored. The entry's
  // own `name`/numbers are the substitute's, so progression files under the
  // substitute; this only records what it stood in for.
  substitutedFor?: string;
  // Ticked off during the session itself. An entry seeded from a target starts
  // false and is set when the exercise is actually done, so a session can be
  // logged set-by-set in the gym rather than written up afterwards.
  done?: boolean;
  // What the target said to aim for, kept alongside what was actually done.
  // Makes "did I hit it?" answerable later without re-deriving the target from
  // a log that has since moved on.
  targetText?: string;
}

// Where a session came from, so an import can be re-run without duplicating
// hand-entered work.
export type ExerciseSource = 'manual' | 'sheet' | 'calendar' | 'freeform';

// One session, planned or done. A planned session is created ahead of time with
// completed=false; logging it after the fact flips completed and fills in the
// actuals. A session logged without a plan is simply created completed=true.
export interface ExerciseSession {
  id: string;
  date: string; // yyyy-MM-dd
  // Free text so Dave isn't boxed into a fixed list ('run', 'climbing', 'gym').
  type: string;
  // Optional: a session imported from the training log has per-exercise detail
  // but no overall duration, and inventing one would be a lie.
  durationMinutes?: number;
  // Set to 'calendar' when `durationMinutes` was filled in from a same-day timed
  // exercise event on the Google calendar (see exercise-calendar). Lets a resync
  // refresh a duration it set itself while never overwriting one a human logged
  // (which has no durationSource). Absent means the duration, if any, is manual.
  durationSource?: 'calendar';
  distanceKm?: number;
  intensity?: ExerciseIntensity;
  notes?: string;
  planned: boolean;
  completed: boolean;
  // A name for the session as a whole ("Home workout").
  label?: string;
  // The exercises done, in the order they were done.
  exercises?: ExerciseEntry[];
  // Planned sessions mirror an all-day event on the personal Google calendar.
  // Held so the portal can update or remove the event it created rather than
  // piling up duplicates.
  googleEventId?: string;
  googleCalendarId?: string;
  // The plan's parts, as written on the calendar: ['Push (shoulders)', 'Run'].
  components?: string[];
  targetDistanceKm?: number;
  // A planned session's calendar event can carry a full PRESCRIPTION in its
  // description — sectioned lists of exactly what to do, with rep/hold ranges.
  // `planDescription` is the raw text (so a re-sync can tell whether it changed);
  // `prescription` is the parsed sections; `prescriptionNote` is the leading
  // free-text line. All absent on a plan whose event has no description, which
  // behaves exactly as before.
  planDescription?: string;
  prescription?: PrescribedSection[];
  prescriptionNote?: string;
  source?: ExerciseSource;
  // For a session logged freehand: exactly what was written, kept verbatim
  // alongside whatever the parse made of it. The parse is a convenience; this
  // is the record. Anything read wrongly can be corrected from here later.
  freeformText?: string;
  // Stable key for de-duplicating repeat imports (source + its natural id).
  importKey?: string;
  // On a LOGGED session: the planned session it was done against. Set when a
  // session is started from the plan, so "did I do what I planned?" is answered
  // by an explicit link rather than inferred from two records sharing a date.
  // Absent on sessions logged without a plan, and on imported history.
  plannedSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

// A session as read out of the training-log spreadsheet, before it is given ids
// and written to storage.
export interface SheetSession {
  date: string;
  label?: string;
  exercises: Array<Omit<ExerciseEntry, 'id'>>;
}

// A planned session as read off a calendar title.
export interface ParsedPlannedSession {
  title: string;
  components: string[];
  targetDistanceKm?: number;
  type: string;
}

export interface ExerciseTypeSummary {
  type: string;
  sessions: number;
  // Exercises ticked done across the sessions of this type. Replaces a minutes
  // total, which was always zero for gym sessions logged exercise-by-exercise.
  exercisesDone: number;
  distanceKm: number;
}

export interface ExerciseWeekSummary {
  weekStart: string; // yyyy-MM-dd Monday
  sessions: number;
  exercisesDone: number;
  distanceKm: number;
  plannedSessions: number;
}

export interface ExerciseAnalysis {
  // The window analysed, inclusive.
  from: string;
  to: string;
  totalSessions: number;
  // Exercises ticked done across every completed session in the window — the
  // count-based measure of volume that replaced session minutes.
  totalExercisesDone: number;
  totalDistanceKm: number;
  // Sessions per week averaged over the window.
  sessionsPerWeek: number;
  // Fraction of planned sessions that were actually completed, 0-1 (null when
  // nothing was planned).
  planAdherence: number | null;
  // Longest run of consecutive weeks with at least one session, ending at the
  // most recent week in the window.
  currentStreakWeeks: number;
  byType: ExerciseTypeSummary[];
  byWeek: ExerciseWeekSummary[];
  // Generated from the numbers above — no AI call, so the tab is instant and
  // works offline.
  suggestions: string[];
}
