/**
 * @jest-environment node
 *
 * The per-entry PATCH route's field whitelist, focused on the per-exercise swap:
 * a swap sets name + substitutedFor (and, for a cardio swap, distanceKm) and
 * clears the pre-filled targetText; a restore clears substitutedFor with null.
 * updateSessionEntry is mocked so the route runs pure.
 */
import type { ExerciseSession } from '@/types/life';

jest.mock('@/lib/storage/exercise', () => ({
  updateSessionEntry: jest.fn(),
  removeSessionEntry: jest.fn(),
}));

import { PATCH } from '@/app/api/exercise/[id]/entries/[entryId]/route';
import { updateSessionEntry } from '@/lib/storage/exercise';
import { NextRequest } from 'next/server';

const mockUpdate = updateSessionEntry as jest.Mock;

function session(): ExerciseSession {
  return {
    id: 's1',
    date: '2026-08-06',
    type: 'gym',
    planned: false,
    completed: true,
    source: 'manual',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    exercises: [{ id: 'e1', name: 'Parkrun 5K', done: false }],
  };
}

async function patch(body: unknown): Promise<{ status: number; patch: Record<string, unknown> }> {
  const req = new NextRequest('http://localhost/api/exercise/s1/entries/e1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: 's1', entryId: 'e1' }) });
  return { status: res.status, patch: mockUpdate.mock.calls[0]?.[2] ?? {} };
}

describe('PATCH /api/exercise/:id/entries/:entryId — swap fields', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdate.mockResolvedValue(session());
  });

  it('swaps: sets name + substitutedFor + distanceKm and clears targetText', async () => {
    const { status, patch: p } = await patch({
      name: 'Treadmill run',
      substitutedFor: 'Parkrun 5K',
      distanceKm: 3,
      targetText: null,
    });

    expect(status).toBe(200);
    expect(p).toEqual({
      name: 'Treadmill run',
      substitutedFor: 'Parkrun 5K',
      distanceKm: 3,
      targetText: null,
    });
  });

  it('restores: null substitutedFor clears the provenance', async () => {
    const { patch: p } = await patch({ name: 'Parkrun 5K', substitutedFor: null });
    expect(p.name).toBe('Parkrun 5K');
    expect(p.substitutedFor).toBeNull();
  });

  it('treats an empty substitutedFor string as a clear', async () => {
    const { patch: p } = await patch({ substitutedFor: '   ' });
    expect(p.substitutedFor).toBeNull();
  });

  it('allows a distanceKm clear and passes durationMinutes through', async () => {
    const { patch: p } = await patch({ distanceKm: null, durationMinutes: 20 });
    expect(p.distanceKm).toBeNull();
    expect(p.durationMinutes).toBe(20);
  });

  it('ignores fields outside the whitelist', async () => {
    const { patch: p } = await patch({ name: 'Treadmill run', bogus: 'nope', id: 'hacked' });
    expect(p).toEqual({ name: 'Treadmill run' });
  });

  it('404s when the entry is gone', async () => {
    mockUpdate.mockResolvedValue(null);
    const res = await patch({ substitutedFor: null });
    expect(res.status).toBe(404);
  });
});
