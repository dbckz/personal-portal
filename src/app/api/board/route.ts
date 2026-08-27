import { NextRequest, NextResponse } from 'next/server';
import { format, startOfWeek } from 'date-fns';

import {
  getBoardTaskStates,
  getScheduledAsanaTasks,
  getAdHocTasks,
  getRitualBlocks,
  getPrepBlocks,
  getAllTaskMetadata,
  getWeeklyStats,
  getBlockDoneOverrides,
  getBoardRolloverState,
} from '@/lib/user-data-storage';
import { getWorkflowConfig } from '@/lib/workflow-config-storage';
import { logicalToday, normalizeRolloverHour } from '@/lib/date-utils';

// Normalise a yyyy-MM-dd date (or undefined → today) to its Monday. Built from
// local parts so a bare date never drifts across a timezone boundary.
function mondayOf(dateStr: string | null): string {
  let base: Date;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, d] = dateStr.split('-').map(Number);
    base = new Date(y, m - 1, d);
  } else {
    base = new Date();
  }
  return format(startOfWeek(base, { weekStartsOn: 1 }), 'yyyy-MM-dd');
}

// GET → the local stores the board needs for a week. Deliberately CHEAP: local
// SQLite only, no Google/Asana round trips (mirrors the week-state route), so
// the client can call it freely. Live Asana tasks + task metadata are fetched
// client-side and combined with this via buildBoardCards.
export async function GET(request: NextRequest) {
  try {
    const weekStart = mondayOf(request.nextUrl.searchParams.get('weekStart'));
    const weekEnd = format(
      new Date(
        Number(weekStart.slice(0, 4)),
        Number(weekStart.slice(5, 7)) - 1,
        Number(weekStart.slice(8, 10)) + 6
      ),
      'yyyy-MM-dd'
    );
    const inWeek = (date?: string) => !!date && date >= weekStart && date <= weekEnd;

    const [states, scheduledAsanaAll, adHocTasks, ritualBlocksAll, prepBlocksAll, metadata, weekStats, blockDone, rolloverState, config] =
      await Promise.all([
        getBoardTaskStates(),
        getScheduledAsanaTasks(),
        getAdHocTasks(),
        getRitualBlocks(),
        getPrepBlocks(),
        getAllTaskMetadata(),
        getWeeklyStats(weekStart),
        getBlockDoneOverrides(),
        getBoardRolloverState(),
        getWorkflowConfig(),
      ]);

    const scheduledAsanaTasks = scheduledAsanaAll.filter(s => inWeek(s.scheduledDate));
    const ritualBlocks = ritualBlocksAll.filter(r => inWeek(r.date));
    const prepBlocks = prepBlocksAll.filter(p => inWeek(p.date));
    const portalDoneGids = Object.entries(metadata)
      .filter(([, m]) => m?.portalDone)
      .map(([gid]) => gid);
    // This week's weekly-stats outcomes, keyed by taskId (gid or adhoc id), with
    // the durable title/category snapshot so a done card (dropped from the live
    // Asana fetch) still shows its type.
    const weeklyOutcomes: Record<
      string,
      { outcome: string; category?: string; title?: string }
    > = weekStats
      ? Object.fromEntries(
          Object.values(weekStats.tasks).map(t => [
            t.taskId,
            {
              outcome: t.outcome,
              ...(t.category ? { category: t.category } : {}),
              ...(t.title ? { title: t.title } : {}),
            },
          ])
        )
      : {};
    const blockDoneGoogleEventIds = Object.entries(blockDone)
      .filter(([, v]) => !!v)
      .map(([eventId]) => eventId);

    // The daily rollover of unfinished one-off tasks hasn't run for the current
    // logical day yet → the client fires POST /api/board/rollover once. Kept a
    // flag here so this route stays read-only.
    const rolloverHour = normalizeRolloverHour(config.scheduling?.dayRolloverHour);
    const needsRollover = rolloverState.lastRolloverDay !== logicalToday(new Date(), rolloverHour);

    return NextResponse.json({
      weekStart,
      states,
      ritualBlocks,
      prepBlocks,
      scheduledAsanaTasks,
      adHocTasks,
      portalDoneGids,
      weeklyOutcomes,
      blockDoneGoogleEventIds,
      needsRollover,
    });
  } catch (error) {
    console.error('Error building board data:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to build board data' },
      { status: 500 }
    );
  }
}
