// Calendar-scheduling state: scheduled Asana tasks, the planner-created prep and
// ritual blocks, remembered meeting-prep decisions, and "done for planning"
// overrides.

import { ScheduledAsanaTask, MeetingPrepDecision } from '@/types';
import { getUserData, saveUserData } from './core';
import type { PrepBlock, RitualBlock } from './core';

// Scheduled Asana Tasks
export async function getScheduledAsanaTasks(): Promise<ScheduledAsanaTask[]> {
  const data = await getUserData();
  // Migration: Add 'id' field to any legacy entries that don't have one
  let needsMigration = false;
  const migratedTasks = data.scheduledAsanaTasks.map(task => {
    if (!task.id) {
      needsMigration = true;
      return { ...task, id: crypto.randomUUID() };
    }
    return task;
  });

  if (needsMigration) {
    data.scheduledAsanaTasks = migratedTasks;
    await saveUserData(data);
  }

  return migratedTasks;
}

export async function scheduleAsanaTask(
  asanaTaskId: string,
  integrationId: string | undefined,
  scheduledDate: string,
  scheduledTime: string,
  duration: number,
  googleEventId?: string,
  googleIntegrationId?: string,
  taskName?: string,
  category?: string
): Promise<ScheduledAsanaTask> {
  const data = await getUserData();

  const scheduled: ScheduledAsanaTask = {
    id: crypto.randomUUID(),
    asanaTaskId,
    integrationId,
    scheduledDate,
    scheduledTime,
    duration,
    googleEventId,
    googleIntegrationId,
    ...(taskName ? { taskName } : {}),
    ...(category ? { category } : {}),
  };

  data.scheduledAsanaTasks.push(scheduled);
  await saveUserData(data);

  return scheduled;
}

export async function updateScheduledAsanaTask(
  scheduleId: string,
  updates: Partial<ScheduledAsanaTask>
): Promise<ScheduledAsanaTask | null> {
  const data = await getUserData();
  const index = data.scheduledAsanaTasks.findIndex(t => t.id === scheduleId);

  if (index === -1) return null;

  data.scheduledAsanaTasks[index] = {
    ...data.scheduledAsanaTasks[index],
    ...updates,
  };

  await saveUserData(data);
  return data.scheduledAsanaTasks[index];
}

export async function updateScheduledAsanaTaskByGoogleEvent(
  googleEventId: string,
  updates: Partial<ScheduledAsanaTask>
): Promise<ScheduledAsanaTask | null> {
  const data = await getUserData();
  const index = data.scheduledAsanaTasks.findIndex(t => t.googleEventId === googleEventId);

  if (index === -1) return null;

  data.scheduledAsanaTasks[index] = {
    ...data.scheduledAsanaTasks[index],
    ...updates,
  };

  await saveUserData(data);
  return data.scheduledAsanaTasks[index];
}

// Update every scheduled-task entry linked to a Google event (a grouped block
// records several tasks against the same event). Returns how many were updated.
export async function updateScheduledAsanaTasksByGoogleEvent(
  googleEventId: string,
  updates: Partial<ScheduledAsanaTask>
): Promise<number> {
  const data = await getUserData();
  let updated = 0;
  data.scheduledAsanaTasks = data.scheduledAsanaTasks.map(t => {
    if (t.googleEventId !== googleEventId) return t;
    updated += 1;
    return { ...t, ...updates };
  });

  if (updated > 0) await saveUserData(data);
  return updated;
}

export async function unscheduleAsanaTask(scheduleId: string): Promise<boolean> {
  const data = await getUserData();
  const filtered = data.scheduledAsanaTasks.filter(t => t.id !== scheduleId);

  if (filtered.length === data.scheduledAsanaTasks.length) return false;

  data.scheduledAsanaTasks = filtered;
  await saveUserData(data);
  return true;
}

export async function unscheduleAllAsanaTaskInstances(asanaTaskId: string): Promise<number> {
  const data = await getUserData();
  const originalLength = data.scheduledAsanaTasks.length;
  data.scheduledAsanaTasks = data.scheduledAsanaTasks.filter(t => t.asanaTaskId !== asanaTaskId);

  const removedCount = originalLength - data.scheduledAsanaTasks.length;
  if (removedCount > 0) {
    await saveUserData(data);
  }

  return removedCount;
}

export async function getScheduledAsanaTasksForDate(date: string): Promise<ScheduledAsanaTask[]> {
  const tasks = await getScheduledAsanaTasks();
  return tasks.filter(task => task.scheduledDate === date);
}

export async function getScheduleByGoogleEventId(googleEventId: string): Promise<ScheduledAsanaTask | null> {
  const tasks = await getScheduledAsanaTasks();
  return tasks.find(t => t.googleEventId === googleEventId) || null;
}

// Remembered "does this meeting need a prep block?" decisions, keyed by a
// normalized meeting title. User decisions are permanent (AI never overwrites);
// AI decisions are re-used when the content hash + prompt version still match.
export async function getMeetingPrepDecisions(): Promise<Record<string, MeetingPrepDecision>> {
  const data = await getUserData();
  return data.meetingPrepDecisions || {};
}

export async function setMeetingPrepDecision(key: string, decision: MeetingPrepDecision): Promise<void> {
  const data = await getUserData();
  data.meetingPrepDecisions = { ...(data.meetingPrepDecisions || {}), [key]: decision };
  await saveUserData(data);
}

// Meeting-prep blocks (calendar blocks the planner created for meeting prep).
export async function getPrepBlocks(): Promise<PrepBlock[]> {
  const data = await getUserData();
  return data.prepBlocks || [];
}

export async function addPrepBlock(
  block: Omit<PrepBlock, 'id' | 'done' | 'createdAt'>
): Promise<PrepBlock> {
  const data = await getUserData();
  if (!data.prepBlocks) data.prepBlocks = [];

  const newBlock: PrepBlock = {
    ...block,
    id: crypto.randomUUID(),
    done: false,
    createdAt: new Date().toISOString(),
  };

  data.prepBlocks.push(newBlock);
  await saveUserData(data);
  return newBlock;
}

export async function updatePrepBlock(id: string, updates: Partial<PrepBlock>): Promise<PrepBlock | null> {
  const data = await getUserData();
  if (!data.prepBlocks) return null;
  const index = data.prepBlocks.findIndex(b => b.id === id);
  if (index === -1) return null;

  data.prepBlocks[index] = { ...data.prepBlocks[index], ...updates };
  await saveUserData(data);
  return data.prepBlocks[index];
}

export async function deletePrepBlock(id: string): Promise<boolean> {
  const data = await getUserData();
  if (!data.prepBlocks) return false;
  const filtered = data.prepBlocks.filter(b => b.id !== id);
  if (filtered.length === data.prepBlocks.length) return false;

  data.prepBlocks = filtered;
  await saveUserData(data);
  return true;
}

// Ritual blocks (daily lunch/emails blocks the planner created on the calendar).
export async function getRitualBlocks(): Promise<RitualBlock[]> {
  const data = await getUserData();
  return data.ritualBlocks || [];
}

export async function addRitualBlock(
  block: Omit<RitualBlock, 'id' | 'createdAt'>
): Promise<RitualBlock> {
  const data = await getUserData();
  if (!data.ritualBlocks) data.ritualBlocks = [];

  const newBlock: RitualBlock = {
    ...block,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  data.ritualBlocks.push(newBlock);
  await saveUserData(data);
  return newBlock;
}

export async function updateRitualBlock(id: string, updates: Partial<RitualBlock>): Promise<RitualBlock | null> {
  const data = await getUserData();
  if (!data.ritualBlocks) return null;
  const index = data.ritualBlocks.findIndex(b => b.id === id);
  if (index === -1) return null;

  data.ritualBlocks[index] = { ...data.ritualBlocks[index], ...updates };
  await saveUserData(data);
  return data.ritualBlocks[index];
}

export async function deleteRitualBlock(id: string): Promise<boolean> {
  const data = await getUserData();
  if (!data.ritualBlocks) return false;
  const filtered = data.ritualBlocks.filter(b => b.id !== id);
  if (filtered.length === data.ritualBlocks.length) return false;

  data.ritualBlocks = filtered;
  await saveUserData(data);
  return true;
}

// Block "done for planning" overrides (keyed by Google event id). Used for
// Asana-backed replan blocks the user marked done without completing the Asana
// task itself.
export async function getBlockDoneOverrides(): Promise<Record<string, true>> {
  const data = await getUserData();
  return data.blockDoneOverrides || {};
}

export async function setBlockDoneOverride(googleEventId: string): Promise<void> {
  const data = await getUserData();
  data.blockDoneOverrides = { ...(data.blockDoneOverrides || {}), [googleEventId]: true };
  await saveUserData(data);
}

export async function removeBlockDoneOverride(googleEventId: string): Promise<boolean> {
  const data = await getUserData();
  if (!data.blockDoneOverrides || !data.blockDoneOverrides[googleEventId]) return false;
  delete data.blockDoneOverrides[googleEventId];
  await saveUserData(data);
  return true;
}
