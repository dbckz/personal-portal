// Weekly task board status store (UserData.boardTasks).
//
// One entry per card that has an EXPLICIT status, keyed by BoardTaskState.key
// (the week-suffixed key for rituals, the plain card key for asana/adhoc). A
// card with no entry falls back to a derived status (see lib/board). Writes go
// through the board PATCH route; the board GET route reads the whole map.

import { getUserData, saveUserData } from './core';
import type { BoardTaskState } from '@/types';

export async function getBoardTaskStates(): Promise<Record<string, BoardTaskState>> {
  const data = await getUserData();
  return data.boardTasks || {};
}

// Upsert one card's status. Keyed by `state.key`; the caller supplies the full
// state (with title/typeLabel snapshots so a Done card still renders once it
// drops out of the live task fetch). `updatedAt` is stamped when omitted.
export async function upsertBoardTaskState(state: BoardTaskState): Promise<BoardTaskState> {
  const data = await getUserData();
  const all = { ...(data.boardTasks || {}) };
  const next: BoardTaskState = {
    ...state,
    updatedAt: state.updatedAt || new Date().toISOString(),
  };
  all[state.key] = next;
  data.boardTasks = all;
  await saveUserData(data);
  return next;
}

export async function deleteBoardTaskState(key: string): Promise<boolean> {
  const data = await getUserData();
  const all = { ...(data.boardTasks || {}) };
  if (!(key in all)) return false;
  delete all[key];
  data.boardTasks = all;
  await saveUserData(data);
  return true;
}
