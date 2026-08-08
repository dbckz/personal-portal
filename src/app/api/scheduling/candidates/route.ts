import { NextRequest, NextResponse } from 'next/server';

import { classifyBlockCategoryWithCatchAll, parseTargetLength, resolveSelectionCap } from '@/lib/capacity';
import { gatherWeekContext } from '@/lib/scheduling/gather';
import { getEnabledAsanaIntegrations } from '@/lib/integration-storage';
import { getAllWeeklyStats } from '@/lib/user-data-storage';
import { calibrateQuotas } from '@/lib/quota-calibration';
import { taskSortKey, compareKeys } from '@/lib/scheduling/engine';
import type { CandidateTask } from '@/lib/scheduling/types';

// POST { weekStart?, priorityGids?: string[], categoryOverrides?: Record<id, category> }
// Return, per quota category, its remaining weekly quota and the ranked list of
// candidate tasks (engine ordering, with pinned priorities first). Feeds the
// wizard's manual task-selection step.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const priorityGids: string[] = Array.isArray(body?.priorityGids) ? body.priorityGids : [];
    const categoryOverrides: Record<string, string> =
      body?.categoryOverrides && typeof body.categoryOverrides === 'object' ? body.categoryOverrides : {};

    const ctx = await gatherWeekContext(typeof body?.weekStart === 'string' ? body.weekStart : undefined);
    const priorityIds = new Set(priorityGids);

    // Map Asana integration id → display name so each candidate can carry a label
    // indicating which workspace/integration it comes from. Ad-hoc tasks (no
    // integrationId) get no name.
    const integrations = await getEnabledAsanaIntegrations();
    const integrationNameById = new Map(integrations.map(i => [i.id, i.name]));

    // Evidence-based calibration from recent complete weeks. Best-effort: a
    // failure to read the history must never break candidate selection, so it
    // degrades to "no calibration" rather than erroring the request.
    const currentQuotas: Record<string, number> = Object.fromEntries(
      ctx.quotas.map(q => [q.category, q.weeklyCount ?? 0])
    );
    let calibration: Record<string, ReturnType<typeof calibrateQuotas>[string]> = {};
    try {
      calibration = calibrateQuotas(await getAllWeeklyStats(), currentQuotas, {
        currentWeekStart: ctx.weekStartStr,
      });
    } catch (err) {
      console.error('[Candidates] Failed to compute quota calibration:', err);
    }

    // Apply priority flags + category overrides, then bucket by category.
    const tasksByCategory = new Map<string, CandidateTask[]>();
    for (const task of ctx.candidateTasks) {
      const id = task.gid ?? task.adhocId ?? '';
      const overrideCategory = categoryOverrides[id];
      const typeSignals = overrideCategory ? [overrideCategory] : task.typeSignals;
      const category = classifyBlockCategoryWithCatchAll(typeSignals, ctx.quotas);
      if (!category) continue;
      const withFlags: CandidateTask = {
        ...task,
        typeSignals,
        isPriority: task.gid ? priorityIds.has(task.gid) : task.isPriority,
      };
      const list = tasksByCategory.get(category) ?? [];
      list.push(withFlags);
      tasksByCategory.set(category, list);
    }

    // Include quota categories (weeklyCount > 0) plus no-quota catch-all
    // categories (e.g. "General Todos"). The latter have no weekly cap, so we
    // flag them with noQuota:true and remainingQuota:null — the UI lets the user
    // pick any number of their candidates rather than "up to N".
    const categories = ctx.quotas
      .filter(q => (q.weeklyCount ?? 0) > 0 || (tasksByCategory.get(q.category)?.length ?? 0) > 0)
      .map(q => {
        const weeklyCount = q.weeklyCount ?? 0;
        const noQuota = weeklyCount <= 0;
        // Grouped categories (e.g. Engagement / Outreach) place a fixed number of
        // blocks but let the user pick ANY number of tasks to spread across them,
        // so — like no-quota catch-alls — they surface uncapped (remainingQuota
        // null) and the wizard renders them "Pick any".
        const grouped = ctx.config.taskQuotas[q.category]?.grouped === true;
        const existing = ctx.existingScheduledCounts[q.category] ?? 0;
        const list = (tasksByCategory.get(q.category) ?? []).slice();
        list.sort((a, b) => compareKeys(taskSortKey(a), taskSortKey(b)));
        // Float carried-over tasks (explicitly carried out of an earlier week)
        // above the rest of their category, behind pinned priorities. A stable
        // sort, so the engine ordering holds within each band.
        const band = (t: CandidateTask) => (t.isPriority || t.mustDo ? 0 : t.carriedOver ? 1 : 2);
        list.sort((a, b) => band(a) - band(b));
        // An explicit maxSelection caps how many tasks the wizard may select,
        // taking precedence over the no-quota / grouped "pick any" behavior (so a
        // grouped category can still be capped, e.g. Deep Work "up to 3").
        const maxSelection = ctx.config.taskQuotas[q.category]?.maxSelection;
        const remainingQuota = resolveSelectionCap({ weeklyCount, grouped, maxSelection, existing });
        return {
          category: q.category,
          noQuota,
          grouped,
          hasMaxSelection: typeof maxSelection === 'number',
          remainingQuota,
          deferredCount: ctx.deferredCountsByCategory[q.category] ?? 0,
          autoSelect: noQuota ? false : ctx.config.taskQuotas[q.category]?.autoSelect === true,
          targetLengthMinutes: parseTargetLength(ctx.config.taskQuotas[q.category]?.targetLength) || 30,
          ...(calibration[q.category]
            ? {
                calibration: {
                  weeksOfData: calibration[q.category].weeksOfData,
                  avgCompletionRate: calibration[q.category].avgCompletionRate,
                  currentQuota: calibration[q.category].currentQuota,
                  ...(calibration[q.category].suggestedQuota != null
                    ? { suggestedQuota: calibration[q.category].suggestedQuota }
                    : {}),
                  ...(calibration[q.category].reason ? { reason: calibration[q.category].reason } : {}),
                  blockSamples: calibration[q.category].blockSamples,
                  ...(calibration[q.category].suggestedBlockMinutes != null
                    ? { suggestedBlockMinutes: calibration[q.category].suggestedBlockMinutes }
                    : {}),
                  ...(calibration[q.category].blockReason
                    ? { blockReason: calibration[q.category].blockReason }
                    : {}),
                },
              }
            : {}),
          candidates: list.map(t => ({
            id: t.gid ?? t.adhocId ?? '',
            gid: t.gid,
            integrationId: t.integrationId,
            integrationName: t.integrationId ? integrationNameById.get(t.integrationId) : undefined,
            title: t.title,
            dueDate: t.dueDate,
            deadlineType: t.deadlineType,
            isPriority: t.isPriority === true,
            ...(t.carriedOver
              ? {
                  carriedOver: true,
                  carriedFromWeek: t.carriedFromWeek,
                  carryStreak: t.carryStreak ?? 1,
                }
              : {}),
            ...(t.mustDo ? { mustDo: true } : {}),
          })),
        };
      });

    return NextResponse.json({ categories });
  } catch (error) {
    console.error('Error building task candidates:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to build candidates' },
      { status: 500 }
    );
  }
}
