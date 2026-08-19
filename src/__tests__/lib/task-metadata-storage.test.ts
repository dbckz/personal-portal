/**
 * Round-trip tests for task metadata storage in user-data-storage.ts
 */
import { getAllTaskMetadata, upsertTaskMetadata } from '@/lib/user-data-storage';
import { __resetDbForTests } from '@/lib/storage/db';

describe('task metadata storage', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('returns an empty map when no data exists', async () => {
    const metadata = await getAllTaskMetadata();
    expect(metadata).toEqual({});
  });

  it('upserts and reads back metadata by GID', async () => {
    const saved = await upsertTaskMetadata('gid-1', 'int-1', {
      energyLevel: 'high',
      aiDelegable: true,
      deadlineType: 'hard',
      effortMinutes: 60,
    });

    expect(saved.asanaTaskGid).toBe('gid-1');
    expect(saved.integrationId).toBe('int-1');
    expect(saved.energyLevel).toBe('high');
    expect(saved.updatedAt).toBeTruthy();

    const all = await getAllTaskMetadata();
    expect(all['gid-1'].aiDelegable).toBe(true);
    expect(all['gid-1'].deadlineType).toBe('hard');
    expect(all['gid-1'].effortMinutes).toBe(60);
  });

  it('merges partial updates without dropping existing fields', async () => {
    await upsertTaskMetadata('gid-2', 'int-1', { energyLevel: 'low' });
    await upsertTaskMetadata('gid-2', 'int-1', { bestTime: 'morning' });

    const all = await getAllTaskMetadata();
    expect(all['gid-2'].energyLevel).toBe('low');
    expect(all['gid-2'].bestTime).toBe('morning');
  });

  it('sets and clears the portal-done flag with its timestamp + title snapshot', async () => {
    await upsertTaskMetadata('gid-pd', 'int-1', {
      portalDone: true,
      portalDoneAt: '2026-08-18T10:00:00.000Z',
      portalDoneTitle: 'Publish the post',
    });
    let all = await getAllTaskMetadata();
    expect(all['gid-pd'].portalDone).toBe(true);
    expect(all['gid-pd'].portalDoneAt).toBe('2026-08-18T10:00:00.000Z');
    expect(all['gid-pd'].portalDoneTitle).toBe('Publish the post');

    // Clear it: false + timestamp/title reset to undefined, other fields intact.
    await upsertTaskMetadata('gid-pd', 'int-1', { energyLevel: 'high' });
    await upsertTaskMetadata('gid-pd', 'int-1', {
      portalDone: false,
      portalDoneAt: undefined,
      portalDoneTitle: undefined,
    });
    all = await getAllTaskMetadata();
    expect(all['gid-pd'].portalDone).toBe(false);
    expect(all['gid-pd'].portalDoneAt).toBeUndefined();
    expect(all['gid-pd'].portalDoneTitle).toBeUndefined();
    expect(all['gid-pd'].energyLevel).toBe('high');
  });
});
