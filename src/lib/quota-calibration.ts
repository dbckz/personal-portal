// Evidence-based quota + block-size calibration.
//
// Reads the durable weekly records (see WeeklyStatsRecord) and, per quota
// category, turns the recent history into two suggestions the plan-week wizard
// can surface — never auto-apply:
//   * a quota suggestion: a category that persistently under-completes what it
//     schedules is over-quota; one that runs maxed out may have room for more;
//   * a block-size suggestion: how long the tasks that actually get DONE in a
//     category tend to be scheduled for, so blocks can be sized from evidence.
//
// Pure over its inputs. Everything is optional / additive: a category with too
// little history simply carries no suggestion, and records written before
// scheduledMinutes existed contribute no sizing evidence.

import { summariseWeek } from '@/lib/weekly-stats';
import type { WeeklyStatsRecord, WeeklyTaskOutcome } from '@/types';

// How many complete weeks back to weigh. Older weeks are dropped so a quota
// changed a couple of months ago isn't judged against ancient behaviour.
const DEFAULT_LOOKBACK_WEEKS = 8;
// A suggestion needs a real run of evidence, not one bad week.
const MIN_WEEKS_FOR_SUGGESTION = 3;
// Below this average completion, a category that keeps filling its quota is
// over-scheduled.
const UNDER_COMPLETION_THRESHOLD = 0.6;
// At/above this, and consistently scheduling the full quota, it runs maxed out.
const MAXED_COMPLETION_THRESHOLD = 0.95;
// Minimum terminal-outcome samples before a block-size hint is trustworthy.
const MIN_BLOCK_SAMPLES = 5;
// Standard block lengths (minutes) a size suggestion snaps to, matching the
// wizard's block-length options so a hint always names a real selectable value.
const DEFAULT_BLOCK_LENGTH_OPTIONS = [15, 30, 45, 60, 90, 120, 180];

export interface CategoryCalibration {
  category: string;
  // Weeks (within the lookback) that actually scheduled this category.
  weeksOfData: number;
  // Mean of each week's per-category completion rate = (done + started) /
  // scheduled, matching summariseWeek's headline definition (partial progress on
  // a long task counts). 0..1.
  avgCompletionRate: number;
  // Mean tasks scheduled into the category per week with data.
  avgScheduled: number;
  // The category's configured weekly quota now (weeklyCount), 0 if none.
  currentQuota: number;
  // Present only when the evidence supports moving the quota. Always ≥ 1.
  suggestedQuota?: number;
  // Human explanation for the quota suggestion (absent when none).
  reason?: string;
  // Terminal-outcome tasks (with a known block length) seen in the lookback.
  blockSamples: number;
  // Suggested block length in minutes for the category: the median length of the
  // tasks that got DONE, snapped to a standard option. Present only with enough
  // samples and at least one done task.
  suggestedBlockMinutes?: number;
  // Human explanation for the block-size suggestion (absent when none).
  blockReason?: string;
}

export interface CalibrationOptions {
  // Monday (yyyy-MM-dd) of the week being planned. It's still in progress, so it
  // is excluded from the evidence; any later week is dropped too.
  currentWeekStart?: string;
  lookbackWeeks?: number;
  blockLengthOptions?: number[];
}

// The complete weeks to weigh: everything strictly before the current week (or
// all of it when no current week is given), most recent first, capped at N.
function completeWeeks(
  records: Record<string, WeeklyStatsRecord>,
  currentWeekStart: string | undefined,
  lookbackWeeks: number
): WeeklyStatsRecord[] {
  return Object.values(records)
    .filter(r => !currentWeekStart || r.weekStart < currentWeekStart)
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
    .slice(0, lookbackWeeks);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((n, v) => n + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function snapToOption(minutes: number, options: number[]): number {
  return options.reduce(
    (best, o) => (Math.abs(o - minutes) < Math.abs(best - minutes) ? o : best),
    options[0]
  );
}

function pct(rate: number): number {
  return Math.round(rate * 100);
}

// One category's calibration from its per-week summary rows and its raw terminal
// task outcomes across the lookback.
function calibrateCategory(
  category: string,
  currentQuota: number,
  weekRows: Array<{ scheduled: number; completed: number; started: number }>,
  terminalTasks: WeeklyTaskOutcome[],
  blockOptions: number[]
): CategoryCalibration {
  const withData = weekRows.filter(r => r.scheduled > 0);
  const weeksOfData = withData.length;
  const avgCompletionRate = mean(
    withData.map(r => (r.completed + r.started) / r.scheduled)
  );
  const avgScheduled = mean(withData.map(r => r.scheduled));

  const cal: CategoryCalibration = {
    category,
    weeksOfData,
    avgCompletionRate,
    avgScheduled,
    currentQuota,
    blockSamples: terminalTasks.length,
  };

  // --- Quota suggestion --------------------------------------------------
  // Only categories that carry a quota and have a real run of history qualify.
  if (currentQuota > 0 && weeksOfData >= MIN_WEEKS_FOR_SUGGESTION) {
    // "scheduled ≈ quota": the category is genuinely filling its quota, so a low
    // completion rate is over-scheduling rather than simply not planning the work.
    const schedulingFullQuota = avgScheduled >= currentQuota - 0.5;
    if (schedulingFullQuota && avgCompletionRate < UNDER_COMPLETION_THRESHOLD) {
      cal.suggestedQuota = Math.max(1, currentQuota - 1);
      cal.reason =
        `completed ${pct(avgCompletionRate)}% of what it scheduled over ` +
        `${weeksOfData} weeks — try ${cal.suggestedQuota}/wk instead of ${currentQuota}`;
    } else if (schedulingFullQuota && avgCompletionRate >= MAXED_COMPLETION_THRESHOLD) {
      cal.suggestedQuota = currentQuota + 1;
      cal.reason =
        `finished ${pct(avgCompletionRate)}% of a full quota over ` +
        `${weeksOfData} weeks — room for ${cal.suggestedQuota}/wk`;
    }
  }

  // --- Block-size suggestion --------------------------------------------
  // The tasks that actually got done tell you how long work in this category
  // really takes; the median, snapped to a standard block, is the hint.
  if (terminalTasks.length >= MIN_BLOCK_SAMPLES) {
    const doneMinutes = terminalTasks
      .filter(t => t.outcome === 'done')
      .map(t => t.scheduledMinutes!)
      .filter((m): m is number => typeof m === 'number');
    if (doneMinutes.length > 0) {
      cal.suggestedBlockMinutes = snapToOption(median(doneMinutes), blockOptions);
      cal.blockReason = `done tasks here usually got ${cal.suggestedBlockMinutes}m`;
    }
  }

  return cal;
}

// Per-category calibration keyed by category, over the recent complete weeks.
// `currentQuotas` maps category → configured weeklyCount (0 / absent = no quota).
export function calibrateQuotas(
  records: Record<string, WeeklyStatsRecord>,
  currentQuotas: Record<string, number>,
  options: CalibrationOptions = {}
): Record<string, CategoryCalibration> {
  const lookbackWeeks = options.lookbackWeeks ?? DEFAULT_LOOKBACK_WEEKS;
  const blockOptions = options.blockLengthOptions ?? DEFAULT_BLOCK_LENGTH_OPTIONS;
  const weeks = completeWeeks(records, options.currentWeekStart, lookbackWeeks);

  // Per category: each week's summary row, and every terminal task with a known
  // block length (estimate-vs-actual sizing evidence).
  const rowsByCategory = new Map<
    string,
    Array<{ scheduled: number; completed: number; started: number }>
  >();
  const terminalByCategory = new Map<string, WeeklyTaskOutcome[]>();

  for (const week of weeks) {
    for (const row of summariseWeek(week).categories) {
      const list = rowsByCategory.get(row.category) ?? [];
      list.push({ scheduled: row.scheduled, completed: row.completed, started: row.started });
      rowsByCategory.set(row.category, list);
    }
    for (const task of Object.values(week.tasks ?? {})) {
      // Terminal = settled this week (not still merely 'scheduled') and carrying a
      // known block length. These are the estimate-vs-actual data points.
      if (task.outcome === 'scheduled' || task.scheduledMinutes == null) continue;
      const list = terminalByCategory.get(task.category) ?? [];
      list.push(task);
      terminalByCategory.set(task.category, list);
    }
  }

  // Every category that has either quota history or scheduling history.
  const categories = new Set<string>([
    ...Object.keys(currentQuotas),
    ...rowsByCategory.keys(),
    ...terminalByCategory.keys(),
  ]);

  const out: Record<string, CategoryCalibration> = {};
  for (const category of categories) {
    out[category] = calibrateCategory(
      category,
      currentQuotas[category] ?? 0,
      rowsByCategory.get(category) ?? [],
      terminalByCategory.get(category) ?? [],
      blockOptions
    );
  }
  return out;
}
