// Weekly task board types. A kanban-style view over the same tasks the
// calendar schedules — every task is a card in one of four status columns,
// filterable by day of the week. See src/lib/board.ts for how cards are built
// and src/lib/storage/board.ts for the persisted per-task status.

// The four board columns, in display order.
export type BoardStatus = 'todo' | 'in_progress' | 'waiting' | 'done';

export const BOARD_COLUMNS: Array<{ id: BoardStatus; label: string }> = [
  { id: 'todo', label: 'To start' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'done', label: 'Done' },
];

// Persisted board status for one card (UserData.boardTasks, keyed by `key`).
//
// `key` is the storage key: for rituals it carries the week suffix
// (`ritual:<base>:<weekStart>`) because a recurring card's status is per week;
// for asana/adhoc it is the plain card key (`asana:<gid>` / `adhoc:<id>`), so
// the status follows the task across weeks.
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

// A block backing a card — a planned occurrence on a day.
export interface BoardCardBlock {
  date: string; // yyyy-MM-dd
  start?: string; // HH:mm
  durationMinutes?: number;
  googleEventId?: string;
}

// The client-side view model for a card, built by buildBoardCards.
export interface BoardCard {
  key: string; // BoardCardKey (without week suffix)
  stateKey: string; // key used in boardTasks (with week suffix for rituals)
  source: 'asana' | 'adhoc' | 'ritual';
  title: string;
  typeLabel?: string; // 'Writing/Deep Work', 'Email', 'Batch' …
  typeEmoji?: string;
  status: BoardStatus;
  statusSource: 'explicit' | 'derived';
  recurring: boolean; // ritual cards
  cadence?: 'daily' | 'weekly';
  // Planned dates, sorted by date then start.
  blocks: BoardCardBlock[];
  plannedDates: string[]; // distinct dates from blocks (sorted)
  totalMinutes: number;
  // identity for actions
  gid?: string;
  integrationId?: string;
  adhocId?: string;
  projectName?: string; // asana first project
  priority?: 'low' | 'medium' | 'high'; // adhoc
  dueOn?: string; // asana due date
}
