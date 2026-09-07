import { NextRequest, NextResponse } from 'next/server';

import {
  getScheduledAsanaTasks,
  getAdHocTasks,
  getPrepBlocks,
  updateScheduledAsanaTask,
  updateAdHocTask,
  updatePrepBlock,
} from '@/lib/user-data-storage';
import { planBoardDateMove } from '@/lib/board-move';

// PATCH → change the day a board card sits on. The board's `date` is a
// projection of its backing record(s); this dispatches by card key to move the
// right ScheduledAsanaTask / AdHocTask / PrepBlock(s) — a group moves all its
// members. Shared by desktop and mobile so the per-source decision (in
// board-move) lives server-side and is testable.
//
// A manual move is NOT a rollover: originallyPlannedFor / rolls are cleared on
// every record written, so the card is not badged "from <day>". The Google
// Calendar event is deliberately NOT touched (mirrors the daily rollover) — only
// the local date changes.
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { key, date } = body;

    if (!key || typeof key !== 'string') {
      return NextResponse.json({ error: 'key is required' }, { status: 400 });
    }
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'date must be yyyy-MM-dd' }, { status: 400 });
    }

    const [scheduledAsanaTasks, adHocTasks, prepBlocks] = await Promise.all([
      getScheduledAsanaTasks(),
      getAdHocTasks(),
      getPrepBlocks(),
    ]);

    const plan = planBoardDateMove({ key, scheduledAsanaTasks, adHocTasks, prepBlocks });
    if (!plan.movable) {
      return NextResponse.json({ error: 'This card has no day to change.' }, { status: 400 });
    }

    // Clear the roll bookkeeping so a manual move never shows the "rolled" badge.
    const clearRoll = { originallyPlannedFor: undefined, rolls: undefined };

    for (const id of plan.scheduledIds) {
      await updateScheduledAsanaTask(id, { scheduledDate: date, ...clearRoll });
    }
    for (const id of plan.adhocIds) {
      await updateAdHocTask(id, { dueDate: date, ...clearRoll });
    }
    for (const id of plan.prepIds) {
      await updatePrepBlock(id, { date, ...clearRoll });
    }

    const moved = plan.scheduledIds.length + plan.adhocIds.length + plan.prepIds.length;
    return NextResponse.json({ moved, date });
  } catch (error) {
    console.error('Error changing board card date:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to change card date' },
      { status: 500 }
    );
  }
}
