// Weekly task board types. The board mirrors the calendar: every app-created
// WORK block for a week is one card, filterable by day of the week, in one of
// the status columns. A single-task block is one card; a grouped block (several
// Asana/ad-hoc tasks sharing one calendar event) is one card with its member
// tasks listed underneath. See src/lib/board.ts for how cards are built and
// src/lib/storage/board.ts for the persisted per-card status.

// The board columns, in display order. 'agents_running' is a manual-only column
// (a card lands there only when moved there explicitly); deriveBoardCardStatus
// never derives it.
export type BoardStatus = 'todo' | 'agents_running' | 'in_progress' | 'waiting' | 'done';

export const BOARD_COLUMNS: Array<{ id: BoardStatus; label: string }> = [
  { id: 'todo', label: 'To start' },
  { id: 'agents_running', label: 'Agents running' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'done', label: 'Done' },
];

// Persisted board status for one card (UserData.boardTasks, keyed by `key`).
//
// `key` is the storage key (=== the card key). It is stable across weeks only
// for pinned Asana cards (`asana:<gid>`, which also carry `weekStart`); every
// calendar-backed card is keyed by its Google event id (`block:<id>`), so its
// status is inherently per-occurrence.
export interface BoardTaskState {
  key: string;
  status: BoardStatus;
  // Set when the card was pinned to a week explicitly (added from the board):
  // shows the card in that week even without a calendar block.
  weekStart?: string;
  // Snapshots, so a Done Asana card still renders after it drops out of the
  // live (incomplete-only) task fetch.
  title?: string;
  typeLabel?: string;
  integrationId?: string; // asana only
  updatedAt: string;
}

// What backs a card:
//  * 'task'      — a single-task block (one Asana or ad-hoc task).
//  * 'group'     — a grouped block: several member tasks under one calendar event.
//  * 'ritual'    — a WORK ritual block (emails, kindle notes, grooming, …).
//  * 'prep'      — a meeting-prep block.
//  * 'unplanned' — a task with no block this week (a pinned Asana task, or an
//                  ad-hoc task with no due date).
export type BoardCardSource = 'task' | 'group' | 'ritual' | 'prep' | 'unplanned';

// One member task of a card. A 'task' card has exactly one; a 'group' has two or
// more; ritual/prep cards have none. `key` is a stable React key (the scheduled-
// record id for Asana members, the ad-hoc task id for ad-hoc members).
export interface BoardCardMember {
  key: string;
  source: 'asana' | 'adhoc';
  title: string;
  done: boolean;
  // Portal-done ("waiting on others"): the user's part is finished but the Asana
  // task waits on someone else. Only Asana members can be portal-done.
  portalDone?: boolean;
  gid?: string; // asana
  integrationId?: string; // asana
  adhocId?: string; // ad-hoc
  typeLabel?: string;
  projectName?: string;
}

// The client-side view model for a card, built by buildBoardCards. A card is one
// calendar block (or one task with no block this week), reconstructed from the
// local stores + live Asana tasks.
export interface BoardCard {
  key: string; // block identity (see BoardTaskState.key)
  stateKey: string; // === key
  source: BoardCardSource;
  title: string; // the reconstructed calendar-event title
  typeLabel?: string;
  typeEmoji?: string;
  status: BoardStatus;
  statusSource: 'explicit' | 'derived';
  // The block — a single occurrence, not an array. Absent for unplanned cards.
  date?: string; // yyyy-MM-dd
  // Daily rollover: the date this card's backing task was ORIGINALLY planned for,
  // set once the task first rolls to a later working day; `rolls` counts the
  // rolls. Present only when it differs from the current `date`, so the UI can
  // badge the card ("from Tue"). See src/lib/board-rollover.ts.
  originallyPlannedFor?: string; // yyyy-MM-dd
  rolls?: number;
  start?: string; // HH:mm
  durationMinutes?: number;
  googleEventId?: string;
  // 1 for task blocks, N for groups, 0 for ritual/prep.
  members: BoardCardMember[];
  // Convenience for single-task / pinned-asana cards.
  projectName?: string;
  priority?: 'low' | 'medium' | 'high';
  dueOn?: string;
  gid?: string;
  integrationId?: string;
  adhocId?: string;
}
