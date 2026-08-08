// Durable weekly analysis records (see WeeklyStatsRecord in @/types for the
// shape and the rules that make a completed week trustworthy years later).
//
// Everything here is additive: recording a task that is already present updates
// its outcome but never removes it, so the week's "tasks scheduled" figure is a
// high-water mark and survives week resets, purges and re-plans.

import { getUserData, saveUserData } from './core';
import type {
  WeeklyStatsRecord,
  WeeklyTaskOutcome,
  WeeklyTaskOutcomeKind,
} from '@/types';

export async function getAllWeeklyStats(): Promise<Record<string, WeeklyStatsRecord>> {
  const data = await getUserData();
  return data.weeklyStats || {};
}

export async function getWeeklyStats(weekStart: string): Promise<WeeklyStatsRecord | null> {
  const all = await getAllWeeklyStats();
  return all[weekStart] ?? null;
}

function emptyRecord(weekStart: string, now: string): WeeklyStatsRecord {
  return { weekStart, createdAt: now, updatedAt: now, tasks: {}, integrations: {} };
}

// One task entering (or changing outcome within) a week's plan.
export interface WeeklyTaskInput {
  taskId: string;
  category: string;
  title?: string;
  integrationId?: string;
  outcome?: WeeklyTaskOutcomeKind; // defaults to 'scheduled'
  // Minutes the task's block reserved (grouped blocks split evenly). Recorded as
  // estimate-vs-actual evidence; only overwrites a stored value when supplied.
  scheduledMinutes?: number;
}

// Record tasks against a week. New task ids are added as 'scheduled' (or the
// given outcome); existing ones keep their original scheduledAt and are only
// updated when the caller passes an explicit outcome — so re-running a plan
// confirm never resets a task that has since been completed or carried.
export async function recordWeeklyTasks(
  weekStart: string,
  tasks: WeeklyTaskInput[],
  at: string = new Date().toISOString()
): Promise<void> {
  if (tasks.length === 0) return;
  const data = await getUserData();
  const all = { ...(data.weeklyStats || {}) };
  const record: WeeklyStatsRecord = all[weekStart]
    ? { ...all[weekStart], tasks: { ...all[weekStart].tasks } }
    : emptyRecord(weekStart, at);

  for (const t of tasks) {
    const existing = record.tasks[t.taskId];
    if (existing) {
      const next: WeeklyTaskOutcome = { ...existing };
      // Only overwrite what the caller actually asserted.
      if (t.outcome && t.outcome !== existing.outcome) {
        next.outcome = t.outcome;
        next.outcomeAt = at;
      }
      if (t.title) next.title = t.title;
      if (t.integrationId) next.integrationId = t.integrationId;
      // A task re-classified by a later plan keeps its newest category.
      if (t.category) next.category = t.category;
      // A re-scheduled task keeps its newest block length; absent leaves the
      // stored value intact (an outcome-only update never drops it).
      if (t.scheduledMinutes != null) next.scheduledMinutes = t.scheduledMinutes;
      record.tasks[t.taskId] = next;
      continue;
    }
    record.tasks[t.taskId] = {
      taskId: t.taskId,
      category: t.category,
      ...(t.title ? { title: t.title } : {}),
      ...(t.integrationId ? { integrationId: t.integrationId } : {}),
      scheduledAt: at,
      outcome: t.outcome ?? 'scheduled',
      ...(t.outcome && t.outcome !== 'scheduled' ? { outcomeAt: at } : {}),
      ...(t.scheduledMinutes != null ? { scheduledMinutes: t.scheduledMinutes } : {}),
    };
  }

  record.updatedAt = at;
  all[weekStart] = record;
  data.weeklyStats = all;
  await saveUserData(data);
}

// Set the outcome of tasks already known to the week. Task ids the week has
// never seen are IGNORED: an outcome with no prior scheduling would inflate the
// denominator with work that was never planned into the week.
export async function setWeeklyTaskOutcomes(
  weekStart: string,
  outcomes: Array<{ taskId: string; outcome: WeeklyTaskOutcomeKind }>,
  at: string = new Date().toISOString()
): Promise<number> {
  if (outcomes.length === 0) return 0;
  const data = await getUserData();
  const all = { ...(data.weeklyStats || {}) };
  const existing = all[weekStart];
  if (!existing) return 0;
  const record: WeeklyStatsRecord = { ...existing, tasks: { ...existing.tasks } };

  let changed = 0;
  for (const { taskId, outcome } of outcomes) {
    const task = record.tasks[taskId];
    if (!task) continue;
    if (task.outcome === outcome) continue;
    // 'done' is a positive terminal outcome. A later 'started' — e.g. a task
    // re-seeded as 'started' in a subsequent review and confirmed unchanged —
    // must never downgrade a done task back to started.
    if (outcome === 'started' && task.outcome === 'done') continue;
    record.tasks[taskId] = { ...task, outcome, outcomeAt: at };
    changed++;
  }
  if (changed === 0) return 0;

  record.updatedAt = at;
  all[weekStart] = record;
  data.weeklyStats = all;
  await saveUserData(data);
  return changed;
}

// Mark (or unmark) one working day of a week as out of office.
//
// Deliberately the one assertion here that is not additive: the reconcile
// rebuilds a past day from the calendar as it stands NOW, so a holiday that was
// cancelled has to stop counting. Everything else in this record is a
// high-water mark; this tracks the calendar.
export async function recordOutOfOfficeDay(
  weekStart: string,
  date: string,
  outOfOffice: boolean,
  at: string = new Date().toISOString()
): Promise<void> {
  const data = await getUserData();
  const all = { ...(data.weeklyStats || {}) };
  const existing = all[weekStart];
  // Nothing to unmark on a week with no record — don't create one to say so.
  if (!existing && !outOfOffice) return;

  const record: WeeklyStatsRecord = existing ? { ...existing } : emptyRecord(weekStart, at);
  const current = new Set(record.outOfOfficeDays ?? []);
  if (outOfOffice === current.has(date)) return; // already correct

  if (outOfOffice) current.add(date);
  else current.delete(date);

  record.outOfOfficeDays = [...current].sort();
  record.updatedAt = at;
  all[weekStart] = record;
  data.weeklyStats = all;
  await saveUserData(data);
}

// Record a day's per-integration time. Absolute values (not deltas): the client
// re-reports the running totals for the day, so the latest report wins.
export async function recordWeeklyTime(
  weekStart: string,
  date: string,
  entries: Array<{
    integrationId: string;
    integrationName: string;
    minutesScheduled: number;
    minutesWorked: number;
    // Worked minutes split by category; must sum to minutesWorked.
    byCategory?: Record<string, number>;
  }>,
  at: string = new Date().toISOString()
): Promise<void> {
  if (entries.length === 0) return;
  const data = await getUserData();
  const all = { ...(data.weeklyStats || {}) };
  const existing = all[weekStart];
  const record: WeeklyStatsRecord = existing
    ? { ...existing, integrations: { ...existing.integrations } }
    : emptyRecord(weekStart, at);

  for (const e of entries) {
    const prev = record.integrations[e.integrationId];
    record.integrations[e.integrationId] = {
      integrationName: e.integrationName || prev?.integrationName || 'Unknown',
      days: {
        ...(prev?.days ?? {}),
        [date]: {
          date,
          minutesScheduled: Math.max(0, Math.round(e.minutesScheduled)),
          minutesWorked: Math.max(0, Math.round(e.minutesWorked)),
          ...(e.byCategory && Object.keys(e.byCategory).length > 0
            ? {
                byCategory: Object.fromEntries(
                  Object.entries(e.byCategory).map(([c, m]) => [c, Math.max(0, Math.round(m))])
                ),
              }
            : {}),
        },
      },
    };
  }

  record.updatedAt = at;
  all[weekStart] = record;
  data.weeklyStats = all;
  await saveUserData(data);
}
