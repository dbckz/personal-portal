// Delegation queue (app-owned, keyed by Asana task GID). Mirrors the taskMetadata
// map idiom. All writes funnel through the single Next.js process (the pacer and
// the detached "Run now" child mutate via HTTP), so no file locking is needed.

import { randomUUID } from 'crypto';
import { DelegationDraftComment, DelegationQueueEntry } from '@/types';
import { getUserData, saveUserData } from './core';

export async function getAllDelegationEntries(): Promise<Record<string, DelegationQueueEntry>> {
  const data = await getUserData();
  return data.delegationQueue || {};
}

export async function getDelegationEntry(asanaTaskGid: string): Promise<DelegationQueueEntry | null> {
  const data = await getUserData();
  return data.delegationQueue?.[asanaTaskGid] || null;
}

export async function upsertDelegationEntry(
  asanaTaskGid: string,
  integrationId: string,
  updates: Partial<Omit<DelegationQueueEntry, 'asanaTaskGid' | 'integrationId' | 'updatedAt'>>
): Promise<DelegationQueueEntry> {
  const data = await getUserData();
  if (!data.delegationQueue) {
    data.delegationQueue = {};
  }

  const now = new Date().toISOString();
  // Defaults applied only on first insert; existing values win over them.
  const base: DelegationQueueEntry = data.delegationQueue[asanaTaskGid] ?? {
    asanaTaskGid,
    integrationId,
    title: '',
    brief: '',
    mode: 'background',
    state: 'queued',
    priority: 0,
    enqueuedAt: now,
    updatedAt: now,
  };
  const merged: DelegationQueueEntry = {
    ...base,
    ...updates,
    asanaTaskGid,
    integrationId,
    updatedAt: now,
  };

  // Re-queueing a task (e.g. "Continue with AI", a fresh delegation, or a
  // usage-limit backoff) clears any prior triage, so the next finished run
  // re-enters the "For review" inbox instead of staying hidden as reviewed.
  // It also clears returnedToAiAt: a task with a run in flight belongs out of
  // the AI-runnable queue, exactly as when it was first delegated.
  if (updates.state === 'queued') {
    delete merged.reviewedAt;
    delete merged.returnedToAiAt;
  }

  data.delegationQueue[asanaTaskGid] = merged;
  await saveUserData(data);
  return merged;
}

// Atomically (within the single app process) pick the next queued entry by
// (priority asc, enqueuedAt asc), mark it running, and return it. Returns null
// when the queue has nothing to drain.
export async function claimNextDelegationEntry(): Promise<DelegationQueueEntry | null> {
  const data = await getUserData();
  const queue = data.delegationQueue || {};
  const queued = Object.values(queue)
    .filter(entry => entry.state === 'queued')
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.enqueuedAt.localeCompare(b.enqueuedAt);
    });

  const next = queued[0];
  if (!next) return null;

  const now = new Date().toISOString();
  const claimed: DelegationQueueEntry = {
    ...next,
    state: 'running',
    startedAt: now,
    updatedAt: now,
  };
  queue[next.asanaTaskGid] = claimed;
  data.delegationQueue = queue;
  await saveUserData(data);
  return claimed;
}

// Append a draft comment to a task's entry, for Dave to review before it is
// ever posted to Asana. A draft only ever originates from a run, which implies
// an entry already exists; but if none does, a minimal skeleton entry is created
// so the draft is never lost. Returns the created draft.
export async function addDraftComment(
  asanaTaskGid: string,
  integrationId: string,
  text: string
): Promise<DelegationDraftComment> {
  const data = await getUserData();
  if (!data.delegationQueue) {
    data.delegationQueue = {};
  }

  const now = new Date().toISOString();
  const entry: DelegationQueueEntry = data.delegationQueue[asanaTaskGid] ?? {
    asanaTaskGid,
    integrationId,
    title: '',
    brief: '',
    mode: 'background',
    state: 'queued',
    priority: 0,
    enqueuedAt: now,
    updatedAt: now,
  };

  const draft: DelegationDraftComment = {
    id: randomUUID(),
    text,
    createdAt: now,
    updatedAt: now,
  };

  entry.draftComments = [...(entry.draftComments ?? []), draft];
  entry.updatedAt = now;
  data.delegationQueue[asanaTaskGid] = entry;
  await saveUserData(data);
  return draft;
}

// Edit a pending draft's text (Dave tweaking it before posting). Returns the
// updated draft, or null when the entry or draft no longer exists.
export async function updateDraftComment(
  asanaTaskGid: string,
  draftId: string,
  text: string
): Promise<DelegationDraftComment | null> {
  const data = await getUserData();
  const entry = data.delegationQueue?.[asanaTaskGid];
  if (!entry?.draftComments) return null;

  const draft = entry.draftComments.find(d => d.id === draftId);
  if (!draft) return null;

  const now = new Date().toISOString();
  draft.text = text;
  draft.updatedAt = now;
  entry.updatedAt = now;
  await saveUserData(data);
  return draft;
}

// Remove a pending draft (Dave discarded it, or it has just been posted).
// Returns true when a draft was removed.
export async function removeDraftComment(
  asanaTaskGid: string,
  draftId: string
): Promise<boolean> {
  const data = await getUserData();
  const entry = data.delegationQueue?.[asanaTaskGid];
  if (!entry?.draftComments) return false;

  const remaining = entry.draftComments.filter(d => d.id !== draftId);
  if (remaining.length === entry.draftComments.length) return false;

  entry.draftComments = remaining;
  entry.updatedAt = new Date().toISOString();
  await saveUserData(data);
  return true;
}

export async function deleteDelegationEntry(asanaTaskGid: string): Promise<boolean> {
  const data = await getUserData();
  if (!data.delegationQueue || !data.delegationQueue[asanaTaskGid]) {
    return false;
  }
  delete data.delegationQueue[asanaTaskGid];
  await saveUserData(data);
  return true;
}
