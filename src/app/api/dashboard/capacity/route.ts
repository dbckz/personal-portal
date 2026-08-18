import { NextResponse } from 'next/server';
import { format, startOfWeek, endOfWeek } from 'date-fns';

import { getWorkflowConfig } from '@/lib/workflow-config-storage';
import {
  getScheduledAsanaTasks,
  getAdHocTasks,
  getCustomTaskTypes,
  getBlockDoneOverrides,
  getWeeklyStats,
  recordWeeklyTasks,
  setWeeklyTaskOutcomes,
  type WeeklyTaskInput,
} from '@/lib/user-data-storage';
import { summariseWeek, weeklyProgressRows } from '@/lib/weekly-stats';
import { getDailyRecord } from '@/lib/time-tracking-storage';
import { getEnabledAsanaIntegrations, updateIntegration } from '@/lib/integration-storage';
import { getMyTasks, refreshAsanaToken } from '@/lib/asana';
import { getLocalTaskTypes, overlayLocalType } from '@/lib/local-task-types';
import { CapacityQuota, classifyBlockCategoryWithCatchAll } from '@/lib/capacity';
import {
  AsanaIntegration,
  BUILT_IN_TASK_TYPE_LABELS,
  BuiltInTaskType,
  CustomTaskType,
  isCustomTaskType,
  getCustomTaskTypeId,
} from '@/types';

// Build a gid -> { typeValue, completed } map from the user's Asana tasks.
// Includes tasks COMPLETED since `completedSince` (Asana otherwise returns only
// incomplete tasks) so finished work still classifies and counts — completing a
// task must not drop it out of the weekly capacity totals.
// Best-effort: if Asana can't be reached, Asana blocks are left unclassified.
async function buildAsanaTypeMap(
  completedSince: string
): Promise<Map<string, { typeValue: string | null; completed: boolean }>> {
  const map = new Map<string, { typeValue: string | null; completed: boolean }>();
  // Locally-stored Types overlay for workspaces with no writable Asana Type field
  // (e.g. DBC), so those tasks still classify into the capacity categories.
  const localTypes = await getLocalTaskTypes();
  try {
    const integrations = await getEnabledAsanaIntegrations();
    await Promise.all(
      integrations.map(async (integration: AsanaIntegration) => {
        if (!integration.credentials || !integration.workspaceId) return;
        let credentials = integration.credentials;
        if (credentials.expiresAt && Date.now() >= credentials.expiresAt - 60000) {
          credentials = await refreshAsanaToken(
            credentials.refreshToken!,
            integration.clientId,
            integration.clientSecret
          );
          await updateIntegration(integration.id, { credentials });
        }
        const tasks = await getMyTasks(
          credentials.accessToken,
          integration.workspaceId,
          completedSince
        );
        for (const task of tasks) {
          const customFields = overlayLocalType(task.gid, task.customFields, localTypes);
          const typeField = customFields?.find(cf => cf.name.toLowerCase() === 'type');
          map.set(task.gid, {
            typeValue: typeField?.displayValue ?? null,
            completed: task.completed,
          });
        }
      })
    );
  } catch (error) {
    console.error('[Dashboard Capacity] Failed to fetch Asana tasks for type map:', error);
  }
  return map;
}

// Resolve the type signals for an ad-hoc task's taskType (id + human label).
function adHocTypeSignals(taskType: string, customTypes: CustomTaskType[]): string[] {
  const signals = [taskType];
  if (isCustomTaskType(taskType as `custom:${string}`)) {
    const id = getCustomTaskTypeId(taskType as `custom:${string}`);
    const custom = customTypes.find(c => c.id === id);
    if (custom) signals.push(custom.label);
  } else {
    const label = BUILT_IN_TASK_TYPE_LABELS[taskType as BuiltInTaskType];
    if (label) signals.push(label);
  }
  return signals;
}

export async function GET() {
  try {
    const now = new Date();
    const weekStartDate = startOfWeek(now, { weekStartsOn: 1 });
    const weekStart = format(weekStartDate, 'yyyy-MM-dd');
    const weekEnd = format(endOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd');
    const today = format(now, 'yyyy-MM-dd');

    const [config, scheduledAsana, adHocTasks, customTypes, doneOverrides, asanaTypeMap] = await Promise.all([
      getWorkflowConfig(),
      getScheduledAsanaTasks(),
      getAdHocTasks(),
      getCustomTaskTypes(),
      getBlockDoneOverrides(),
      // Use the local week-start instant, not the local date stamped as UTC: in
      // BST `${weekStart}T00:00:00.000Z` would exclude tasks completed in the
      // local 00:00–01:00 Monday window.
      buildAsanaTypeMap(weekStartDate.toISOString()),
    ]);

    const quotas: CapacityQuota[] = Object.entries(config.taskQuotas).map(
      ([category, quota]) => ({
        category,
        weeklyCount: quota.weeklyCount,
        targetLength: quota.targetLength,
        types: config.typeMapping?.[category] ?? [],
      })
    );

    // --- This week's TASKS (not blocks) ------------------------------------
    // Weekly progress is task-level: a grouped block contributes one entry per
    // member task (the schedule stores one record per agenda task, so this falls
    // out naturally), a single-task block contributes one. Y is the count of
    // tasks scheduled INTO the week, X the count marked done.
    const scheduledTasks: WeeklyTaskInput[] = [];
    const doneTaskIds: string[] = [];

    for (const s of scheduledAsana) {
      if (s.scheduledDate < weekStart || s.scheduledDate > weekEnd) continue;
      const info = asanaTypeMap.get(s.asanaTaskId);
      // Prefer the category stored at scheduling time; re-derive from the Asana
      // Type only for legacy records without one.
      const category =
        s.category ??
        classifyBlockCategoryWithCatchAll(info?.typeValue ? [info.typeValue] : [], quotas);
      if (!category) continue;
      scheduledTasks.push({
        taskId: s.asanaTaskId,
        category,
        ...(s.taskName ? { title: s.taskName } : {}),
        ...(s.integrationId ? { integrationId: s.integrationId } : {}),
      });
      // Done = complete in Asana, or the block was marked "done for planning".
      const overridden = !!s.googleEventId && !!doneOverrides[s.googleEventId];
      if (info?.completed || overridden) doneTaskIds.push(s.asanaTaskId);
    }
    for (const t of adHocTasks) {
      if (!t.dueDate || t.dueDate < weekStart || t.dueDate > weekEnd) continue;
      const category =
        t.category ??
        classifyBlockCategoryWithCatchAll(adHocTypeSignals(t.taskType, customTypes), quotas);
      if (!category) continue;
      scheduledTasks.push({ taskId: t.id, category, title: t.title });
      const overridden = !!t.googleEventId && !!doneOverrides[t.googleEventId];
      if (t.completed || overridden) doneTaskIds.push(t.id);
    }

    // Reconcile the durable weekly record from what is actually on the calendar.
    // Additive by design: this backfills a week planned before the store existed
    // and self-heals if a write point was missed, while never lowering Y or
    // clobbering a 'carried' / 'dropped' outcome (only 'done' is asserted here).
    await recordWeeklyTasks(weekStart, scheduledTasks);
    if (doneTaskIds.length > 0) {
      await setWeeklyTaskOutcomes(
        weekStart,
        doneTaskIds.map(taskId => ({ taskId, outcome: 'done' as const }))
      );
    }

    const record = await getWeeklyStats(weekStart);
    const weekProgress = weeklyProgressRows(record, quotas.map(q => q.category));
    // "Planned" = the durable record knows about at least one task this week.
    const weekPlanned = weekProgress.some(r => r.scheduledTasks > 0);

    // Minutes worked THIS WEEK per integration, straight from the durable record
    // (it holds a per-day, per-integration split), for the header line.
    const weekWorkedByIntegration = record
      ? summariseWeek(record).minutesWorkedByIntegration.map(i => ({
          integrationId: i.integrationId,
          integrationName: i.integrationName,
          totalMinutes: i.minutes,
        }))
      : [];

    // Client time worked today, per Asana integration, from recorded time tracking
    const dailyRecord = await getDailyRecord(today);
    const clientTime = dailyRecord
      ? Object.values(dailyRecord.integrationTotals).map(t => ({
          integrationId: t.integrationId,
          integrationName: t.integrationName,
          totalMinutes: t.totalMinutes,
        }))
      : [];

    return NextResponse.json({
      weekStart,
      weekEnd,
      weekProgress,
      weekPlanned,
      clientTime,
      weekWorkedByIntegration,
    });
  } catch (error) {
    console.error('Error computing dashboard capacity:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to compute capacity' },
      { status: 500 }
    );
  }
}
