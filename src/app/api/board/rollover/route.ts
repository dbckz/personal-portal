import { NextResponse } from 'next/server';

import { runBoardRollover } from '@/lib/user-data-storage';
import { getWorkflowConfig } from '@/lib/workflow-config-storage';
import { normalizeRolloverHour } from '@/lib/date-utils';

// POST → run the daily rollover of unfinished one-off tasks to the next working
// day (see lib/board-rollover). Idempotent per logical day: the runner re-checks
// the last-run stamp, so two clients racing this only roll once. Returns how
// many tasks moved. Never touches Google Calendar — a date-only local move.
export async function POST() {
  try {
    const config = await getWorkflowConfig();
    const rolloverHour = normalizeRolloverHour(config.scheduling?.dayRolloverHour);
    const workingDays = config.scheduling?.workingDays;

    const { rolledCount, removedCount } = await runBoardRollover({ rolloverHour, workingDays });

    return NextResponse.json({ rolledCount, removedCount });
  } catch (error) {
    console.error('Error rolling over the board:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to roll over the board' },
      { status: 500 }
    );
  }
}
