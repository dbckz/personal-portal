// When the exercise calendar was last synced (auto or manual). Used to debounce
// the automatic sync the Exercise section fires on load, so opening the section
// repeatedly doesn't hammer Google.

import { getUserData, saveUserData } from './core';

export async function getExerciseLastSyncedAt(): Promise<string | null> {
  const data = await getUserData();
  return data.exerciseSyncState?.lastSyncedAt ?? null;
}

export async function setExerciseLastSyncedAt(iso: string): Promise<void> {
  const data = await getUserData();
  data.exerciseSyncState = { ...(data.exerciseSyncState ?? {}), lastSyncedAt: iso };
  await saveUserData(data);
}
