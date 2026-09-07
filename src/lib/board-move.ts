// Pure decision for a MANUAL "change the day" of a board card: given a card's
// key and the local stores, work out which backing dated records must move.
//
// The board's `date` is a projection: the writable date lives on the backing
// record(s), by the card's key shape:
//   * sched:<id>     → one ScheduledAsanaTask (its scheduledDate)
//   * adhoc:<id>     → one AdHocTask (its dueDate)
//   * block:<eventId>→ a calendar-backed block: every ScheduledAsanaTask and/or
//                      AdHocTask carrying that googleEventId (a group moves all
//                      its members), OR a PrepBlock with that event id.
//   * asana:<gid>    → a pinned Asana card, state-only, no writable date → not
//                      movable.
// A ritual block (also a block:<eventId> key) has no dated task/prep record, so
// it matches nothing and is reported not-movable.
//
// Kept I/O-free and deterministic so the route stays thin and the decision is
// unit-tested; every input is passed in. A manual move must NOT be badged as a
// roll, so the caller clears originallyPlannedFor / rolls on the records it
// writes (see the /api/board/date route).

import type { AdHocTask, BoardCard, ScheduledAsanaTask } from '@/types';
import type { PrepBlock } from '@/lib/storage/core';

export interface BoardDateMovePlan {
  // False when the card has no writable date (a ritual, or a pinned Asana card).
  movable: boolean;
  // ScheduledAsanaTask ids whose scheduledDate moves.
  scheduledIds: string[];
  // AdHocTask ids whose dueDate moves.
  adhocIds: string[];
  // PrepBlock ids whose date moves.
  prepIds: string[];
}

const NOT_MOVABLE: BoardDateMovePlan = {
  movable: false,
  scheduledIds: [],
  adhocIds: [],
  prepIds: [],
};

export interface PlanBoardDateMoveInput {
  key: string;
  scheduledAsanaTasks: ScheduledAsanaTask[];
  adHocTasks: AdHocTask[];
  prepBlocks: PrepBlock[];
}

export function planBoardDateMove(input: PlanBoardDateMoveInput): BoardDateMovePlan {
  const { key, scheduledAsanaTasks, adHocTasks, prepBlocks } = input;

  if (key.startsWith('sched:')) {
    const id = key.slice('sched:'.length);
    return scheduledAsanaTasks.some(s => s.id === id)
      ? { movable: true, scheduledIds: [id], adhocIds: [], prepIds: [] }
      : NOT_MOVABLE;
  }

  if (key.startsWith('adhoc:')) {
    const id = key.slice('adhoc:'.length);
    return adHocTasks.some(t => t.id === id)
      ? { movable: true, scheduledIds: [], adhocIds: [id], prepIds: [] }
      : NOT_MOVABLE;
  }

  if (key.startsWith('block:')) {
    const eventId = key.slice('block:'.length);
    const prepIds = prepBlocks.filter(p => p.googleEventId === eventId).map(p => p.id);
    if (prepIds.length > 0) return { movable: true, scheduledIds: [], adhocIds: [], prepIds };

    const scheduledIds = scheduledAsanaTasks
      .filter(s => s.googleEventId === eventId)
      .map(s => s.id);
    const adhocIds = adHocTasks.filter(t => t.googleEventId === eventId).map(t => t.id);
    if (scheduledIds.length > 0 || adhocIds.length > 0) {
      return { movable: true, scheduledIds, adhocIds, prepIds: [] };
    }
    // A ritual block (or an orphaned event id) — nothing dated to move.
    return NOT_MOVABLE;
  }

  // asana:<gid> (pinned, state-only) or an unknown key shape.
  return NOT_MOVABLE;
}

// Whether the "Move to day" action should be offered for a card. Rituals and
// pinned Asana cards (state-only, no writable date) can't be moved; everything
// else — dated or unplanned task/group/prep — can.
export function canChangeCardDate(card: Pick<BoardCard, 'source' | 'key'>): boolean {
  if (card.source === 'ritual') return false;
  if (card.key.startsWith('asana:')) return false;
  return true;
}
