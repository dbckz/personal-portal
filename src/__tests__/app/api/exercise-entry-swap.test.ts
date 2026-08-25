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
  getAllSessions: jest.fn(),
}));

// prewarmProgramme fires on every successful PATCH; stub it so the route runs
// without reaching the real programme cache / Claude.
jest.mock('@/lib/exercise-prewarm', () => ({
  prewarmProgramme: jest.fn().mockResolvedValue(undefined),
}));

import { PATCH } from '@/app/api/exercise/[id]/entries/[entryId]/route';
import { getAllSessions, updateSessionEntry } from '@/lib/storage/exercise';
import { NextRequest } from 'next/server';

const mockUpdate = updateSessionEntry as jest.Mock;
const mockGetAll = getAllSessions as jest.Mock;

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
    mockGetAll.mockResolvedValue([session()]);
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

describe('PATCH swap — target derivation from the substitute’s own history', () => {
  // A prior loaded session for the substitute exercise, so buildProgressions has
  // real history to derive a target from.
  function withHistory(entries: ExerciseSession['exercises']): ExerciseSession {
    return {
      id: 'hist',
      date: '2026-07-30',
      type: 'gym',
      planned: false,
      completed: true,
      source: 'manual',
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
      exercises: entries,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdate.mockResolvedValue(session());
  });

  it('derives sets/reps/weight and targetText for the substitute, replacing the old numbers', async () => {
    mockGetAll.mockResolvedValue([
      withHistory([
        {
          id: 'h1',
          name: 'Converging shoulder press',
          done: true,
          sets: 3,
          reps: 8,
          weightKg: 25.3,
          notes: 'At limit, make lighter',
        },
      ]),
      session(),
    ]);

    const { patch: p } = await patch({
      name: 'Converging shoulder press',
      substitutedFor: 'Cable crossover',
    });

    expect(p.name).toBe('Converging shoulder press');
    expect(p.substitutedFor).toBe('Cable crossover');
    expect(p.sets).toBe(3);
    expect(p.reps).toBe(8);
    // "make lighter" earns a reduce off 25.3kg → 22.77kg, rounded to a loadable 23kg.
    expect(p.weightKg).toBe(23);
    expect(p.targetText).toBe('3 × 8 · 23kg');
    // Fields the substitute's target doesn't carry are cleared, not left stale.
    expect(p.holdSeconds).toBeNull();
    expect(p.distanceKm).toBeNull();
    expect(p.durationMinutes).toBeNull();
  });

  it('leaves the target blank when the substitute has no history', async () => {
    mockGetAll.mockResolvedValue([session()]);

    const { patch: p } = await patch({
      name: 'Some brand new exercise',
      substitutedFor: 'Cable crossover',
    });

    expect(p.name).toBe('Some brand new exercise');
    expect(p.substitutedFor).toBe('Cable crossover');
    // No derived numbers, no targetText — it renders as a free entry.
    expect(p.sets).toBeUndefined();
    expect(p.targetText).toBeUndefined();
    expect(p.weightKg).toBeUndefined();
  });

  it('lets a client-supplied cardio measure win over the derived one', async () => {
    mockGetAll.mockResolvedValue([
      withHistory([
        { id: 'h1', name: 'Treadmill run', done: true, durationMinutes: 30 },
      ]),
      session(),
    ]);

    const { patch: p } = await patch({
      name: 'Treadmill run',
      substitutedFor: 'Parkrun 5K',
      durationMinutes: 20,
    });

    // The typed 20 min wins; the derived 30 is not applied over it.
    expect(p.durationMinutes).toBe(20);
    // The rest of the target is still derived (targetText reflects the history).
    expect(typeof p.targetText).toBe('string');
  });

  it('does not derive when the client sends an explicit target', async () => {
    mockGetAll.mockResolvedValue([
      withHistory([
        { id: 'h1', name: 'Converging shoulder press', done: true, sets: 3, reps: 8, weightKg: 25.3 },
      ]),
      session(),
    ]);

    const { patch: p } = await patch({
      name: 'Converging shoulder press',
      substitutedFor: 'Cable crossover',
      targetText: null,
    });

    // Explicit targetText suppresses derivation; the whitelist passes it through.
    expect(p.targetText).toBeNull();
    expect(p.sets).toBeUndefined();
    expect(mockGetAll).not.toHaveBeenCalled();
  });
});
