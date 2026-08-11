/**
 * Round-trip tests for the delegation queue in user-data-storage.ts
 */
import {
  getAllDelegationEntries,
  getDelegationEntry,
  upsertDelegationEntry,
  claimNextDelegationEntry,
  deleteDelegationEntry,
  addDraftComment,
  updateDraftComment,
  removeDraftComment,
} from '@/lib/user-data-storage';
import { __resetDbForTests } from '@/lib/storage/db';

describe('delegation queue storage', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('returns an empty map when no data exists', async () => {
    expect(await getAllDelegationEntries()).toEqual({});
    expect(await getDelegationEntry('nope')).toBeNull();
  });

  it('enqueues with defaults and reads back by GID', async () => {
    const entry = await upsertDelegationEntry('gid-1', 'int-1', { brief: 'Draft a memo', title: 'Memo' });

    expect(entry.asanaTaskGid).toBe('gid-1');
    expect(entry.brief).toBe('Draft a memo');
    expect(entry.state).toBe('queued'); // default on first insert
    expect(entry.mode).toBe('background'); // default
    expect(entry.priority).toBe(0);
    expect(entry.enqueuedAt).toBeTruthy();

    expect((await getDelegationEntry('gid-1'))?.title).toBe('Memo');
  });

  it('merges partial updates without dropping existing fields', async () => {
    await upsertDelegationEntry('gid-2', 'int-1', { brief: 'first', mode: 'now' });
    await upsertDelegationEntry('gid-2', 'int-1', { state: 'done' });

    const entry = await getDelegationEntry('gid-2');
    expect(entry?.brief).toBe('first');
    expect(entry?.mode).toBe('now');
    expect(entry?.state).toBe('done');
  });

  it('claims the oldest highest-priority queued entry and marks it running', async () => {
    await upsertDelegationEntry('a', 'int-1', { enqueuedAt: '2026-07-13T02:00:00.000Z', priority: 0 });
    await upsertDelegationEntry('b', 'int-1', { enqueuedAt: '2026-07-13T01:00:00.000Z', priority: 0 });
    await upsertDelegationEntry('c', 'int-1', { enqueuedAt: '2026-07-13T00:00:00.000Z', priority: 5 });

    // b is oldest among priority 0; c has worse (higher) priority despite being oldest overall.
    const claimed = await claimNextDelegationEntry();
    expect(claimed?.asanaTaskGid).toBe('b');
    expect(claimed?.state).toBe('running');
    expect(claimed?.startedAt).toBeTruthy();

    // b is now running, so the next claim skips it.
    expect((await claimNextDelegationEntry())?.asanaTaskGid).toBe('a');
  });

  it('returns null from claim when nothing is queued', async () => {
    await upsertDelegationEntry('done-1', 'int-1', { state: 'done' });
    expect(await claimNextDelegationEntry()).toBeNull();
  });

  it('persists reviewedAt and reads it back', async () => {
    await upsertDelegationEntry('rev-1', 'int-1', { state: 'done' });
    const reviewedAt = '2026-07-23T10:00:00.000Z';
    await upsertDelegationEntry('rev-1', 'int-1', { reviewedAt });

    const entry = await getDelegationEntry('rev-1');
    expect(entry?.reviewedAt).toBe(reviewedAt);
    expect(entry?.state).toBe('done'); // unchanged by the review write
  });

  it('clears reviewedAt when an entry is re-queued', async () => {
    await upsertDelegationEntry('rev-2', 'int-1', {
      state: 'done',
      reviewedAt: '2026-07-23T10:00:00.000Z',
    });
    // "Continue with AI" / re-delegate sends the entry back to queued.
    await upsertDelegationEntry('rev-2', 'int-1', { state: 'queued' });

    const entry = await getDelegationEntry('rev-2');
    expect(entry?.state).toBe('queued');
    expect(entry?.reviewedAt).toBeUndefined();
  });

  it('persists returnedToAiAt without wiping it on an unrelated write', async () => {
    await upsertDelegationEntry('ret-1', 'int-1', { state: 'done' });
    const returnedToAiAt = '2026-08-05T10:00:00.000Z';
    // "Return to AI queue" stamps returnedToAiAt (+ reviewedAt), NOT state:queued.
    await upsertDelegationEntry('ret-1', 'int-1', { returnedToAiAt, reviewedAt: returnedToAiAt });

    const entry = await getDelegationEntry('ret-1');
    expect(entry?.returnedToAiAt).toBe(returnedToAiAt);
    expect(entry?.state).toBe('done'); // unchanged by the return write
  });

  it('clears returnedToAiAt when an entry is re-queued (delegate again)', async () => {
    await upsertDelegationEntry('ret-2', 'int-1', {
      state: 'done',
      returnedToAiAt: '2026-08-05T10:00:00.000Z',
      reviewedAt: '2026-08-05T10:00:00.000Z',
    });
    // Delegating again sends the entry back to queued; a run in flight belongs
    // out of the AI-runnable queue, so returnedToAiAt is cleared with reviewedAt.
    await upsertDelegationEntry('ret-2', 'int-1', { state: 'queued' });

    const entry = await getDelegationEntry('ret-2');
    expect(entry?.state).toBe('queued');
    expect(entry?.returnedToAiAt).toBeUndefined();
    expect(entry?.reviewedAt).toBeUndefined();
  });

  it('preserves a prior result when re-queued (Continue with AI)', async () => {
    await upsertDelegationEntry('rev-3', 'int-1', {
      state: 'done',
      result: {
        status: 'successful',
        summary: 'first run',
        outputs: [],
        next: '',
        reportMarkdown: '',
        sessionId: null,
        traceFile: null,
        finishedAt: '2026-07-23T09:00:00.000Z',
      },
    });
    await upsertDelegationEntry('rev-3', 'int-1', { state: 'queued', brief: 'follow-up' });

    const entry = await getDelegationEntry('rev-3');
    expect(entry?.state).toBe('queued');
    expect(entry?.brief).toBe('follow-up');
    expect(entry?.result?.summary).toBe('first run'); // last result stays accessible
  });

  it('round-trips claudeAccount and preserves it across an unrelated write', async () => {
    await upsertDelegationEntry('acc-1', 'int-1', { brief: 'go', claudeAccount: 'claude-om' });
    expect((await getDelegationEntry('acc-1'))?.claudeAccount).toBe('claude-om');

    // A later state write must not drop the chosen account.
    await upsertDelegationEntry('acc-1', 'int-1', { state: 'running' });
    const entry = await getDelegationEntry('acc-1');
    expect(entry?.claudeAccount).toBe('claude-om');
    expect(entry?.state).toBe('running');
  });

  it('keeps a legacy/skeleton entry account-less (no default guessed)', async () => {
    // Bulk enqueue / legacy paths create entries with no account.
    await upsertDelegationEntry('legacy-1', 'int-1', { title: 'Old task', state: 'queued' });
    const entry = await getDelegationEntry('legacy-1');
    expect(entry?.claudeAccount).toBeUndefined();
  });

  it('adds a draft comment to an existing entry', async () => {
    await upsertDelegationEntry('draft-1', 'int-1', { title: 'Task', state: 'done' });
    const draft = await addDraftComment('draft-1', 'int-1', 'Proposed reply');

    expect(draft.id).toBeTruthy();
    expect(draft.text).toBe('Proposed reply');

    const entry = await getDelegationEntry('draft-1');
    expect(entry?.draftComments).toHaveLength(1);
    expect(entry?.draftComments?.[0].text).toBe('Proposed reply');
    expect(entry?.state).toBe('done'); // unchanged
  });

  it('creates a skeleton entry when a draft arrives with no existing entry', async () => {
    const draft = await addDraftComment('draft-2', 'int-9', 'Orphan draft');
    const entry = await getDelegationEntry('draft-2');

    expect(entry).not.toBeNull();
    expect(entry?.integrationId).toBe('int-9');
    expect(entry?.draftComments?.[0].id).toBe(draft.id);
  });

  it('appends multiple drafts in order', async () => {
    await addDraftComment('draft-3', 'int-1', 'first');
    await addDraftComment('draft-3', 'int-1', 'second');

    const entry = await getDelegationEntry('draft-3');
    expect(entry?.draftComments?.map(d => d.text)).toEqual(['first', 'second']);
  });

  it('updates a draft comment text and stamps updatedAt', async () => {
    const draft = await addDraftComment('draft-4', 'int-1', 'original');
    const updated = await updateDraftComment('draft-4', draft.id, 'edited');

    expect(updated?.text).toBe('edited');
    const entry = await getDelegationEntry('draft-4');
    expect(entry?.draftComments?.[0].text).toBe('edited');
  });

  it('returns null updating a missing draft or entry', async () => {
    expect(await updateDraftComment('nope', 'x', 'y')).toBeNull();
    await addDraftComment('draft-5', 'int-1', 'a');
    expect(await updateDraftComment('draft-5', 'missing-id', 'y')).toBeNull();
  });

  it('removes a draft comment and reports whether one was removed', async () => {
    const draft = await addDraftComment('draft-6', 'int-1', 'to remove');
    expect(await removeDraftComment('draft-6', draft.id)).toBe(true);

    const entry = await getDelegationEntry('draft-6');
    expect(entry?.draftComments).toHaveLength(0);
    expect(await removeDraftComment('draft-6', draft.id)).toBe(false); // already gone
  });

  it('deletes an entry by GID', async () => {
    await upsertDelegationEntry('gid-3', 'int-1', {});
    expect(await deleteDelegationEntry('gid-3')).toBe(true);
    expect(await getDelegationEntry('gid-3')).toBeNull();
    expect(await deleteDelegationEntry('gid-3')).toBe(false); // already gone
  });
});
