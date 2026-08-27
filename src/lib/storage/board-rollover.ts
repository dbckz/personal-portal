// Daily board-rollover storage + orchestration (UserData.boardRollover).
//
// Holds the idempotence stamp (the logical day the rollover last ran for) and
// the runner that reads the local stores, computes the plan (lib/board-rollover)
// and applies it — moving each stale, unfinished one-off task forward to the
// next working day. The pure decision logic lives in lib/board-rollover; this
// module is the I/O around it.

import { getUserData, saveUserData } from './core';
import { getScheduledAsanaTasks, updateScheduledAsanaTask, unscheduleAsanaTask, getBlockDoneOverrides } from './schedule';
import { getAdHocTasks, updateAdHocTask, deleteAdHocTask } from './ad-hoc-tasks';
import { getBoardTaskStates } from './board';
import { getAllTaskMetadata } from './attributions';
import { getAllWeeklyStats } from './weekly-stats';
import { getTaskDeferrals } from './deferrals';
import type { BoardRolloverState } from './core';
import { planBoardRollover } from '@/lib/board-rollover';
import { logicalToday } from '@/lib/date-utils';

export type { BoardRolloverState };

export async function getBoardRolloverState(): Promise<BoardRolloverState> {
  const data = await getUserData();
  return data.boardRollover || {};
}

// Stamp the logical day the rollover last ran for.
export async function setBoardRolloverLastDay(day: string): Promise<void> {
  const data = await getUserData();
  data.boardRollover = { ...(data.boardRollover || {}), lastRolloverDay: day };
  await saveUserData(data);
}

export interface RunBoardRolloverResult {
  rolledCount: number;
  // Duplicate overdue records deleted (see planBoardRollover dedupe).
  removedCount: number;
  logicalDay: string;
  // True when the rollover had already run for this logical day and was skipped.
  alreadyRan: boolean;
}

// Run the rollover for the current logical day, once. Idempotent: if it has
// already run for this logical day it is a no-op (two clients may race the POST,
// so the stamp is re-checked here, not only in the route). Returns how many
// tasks were moved.
export async function runBoardRollover(opts: {
  now?: Date;
  rolloverHour: number;
  workingDays?: string[];
}): Promise<RunBoardRolloverResult> {
  const { now = new Date(), rolloverHour, workingDays } = opts;
  const day = logicalToday(now, rolloverHour);

  const state = await getBoardRolloverState();
  if (state.lastRolloverDay === day) {
    return { rolledCount: 0, removedCount: 0, logicalDay: day, alreadyRan: true };
  }

  const [scheduledAsanaTasks, adHocTasks, states, metadata, blockDone, weeklyStats, deferrals] =
    await Promise.all([
      getScheduledAsanaTasks(),
      getAdHocTasks(),
      getBoardTaskStates(),
      getAllTaskMetadata(),
      getBlockDoneOverrides(),
      getAllWeeklyStats(),
      getTaskDeferrals(),
    ]);

  const portalDoneGids = new Set(
    Object.entries(metadata)
      .filter(([, m]) => m?.portalDone)
      .map(([gid]) => gid)
  );
  const blockDoneEventIds = new Set(
    Object.entries(blockDone)
      .filter(([, v]) => !!v)
      .map(([eventId]) => eventId)
  );
  const doneTaskIds = new Set<string>();
  for (const record of Object.values(weeklyStats)) {
    for (const t of Object.values(record.tasks)) {
      if (t.outcome === 'done') doneTaskIds.add(t.taskId);
    }
  }

  const plan = planBoardRollover({
    logicalToday: day,
    workingDays,
    scheduledAsanaTasks,
    adHocTasks,
    states,
    portalDoneGids,
    blockDoneEventIds,
    doneTaskIds,
    deferrals,
  });

  for (const entry of plan.scheduled) {
    await updateScheduledAsanaTask(entry.id, {
      scheduledDate: entry.date,
      originallyPlannedFor: entry.originallyPlannedFor,
      rolls: entry.rolls,
    });
  }
  for (const entry of plan.adhoc) {
    await updateAdHocTask(entry.id, {
      dueDate: entry.date,
      originallyPlannedFor: entry.originallyPlannedFor,
      rolls: entry.rolls,
    });
  }

  // Delete the duplicate overdue records the dedupe collapsed (mirrors the
  // single-record removal path: unscheduleAsanaTask / deleteAdHocTask).
  for (const id of plan.removeScheduledIds) {
    await unscheduleAsanaTask(id);
  }
  for (const id of plan.removeAdhocIds) {
    await deleteAdHocTask(id);
  }

  await setBoardRolloverLastDay(day);

  return {
    rolledCount: plan.scheduled.length + plan.adhoc.length,
    removedCount: plan.removeScheduledIds.length + plan.removeAdhocIds.length,
    logicalDay: day,
    alreadyRan: false,
  };
}
