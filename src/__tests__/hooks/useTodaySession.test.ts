/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTodaySession } from '@/hooks/useTodaySession';
import { api } from '@/lib/api';
import type { ExerciseTarget } from '@/lib/exercise-targets';
import type { ExerciseSession } from '@/types/life';

jest.mock('@/lib/api', () => ({
  api: {
    getExerciseTargets: jest.fn(),
    getExerciseSessions: jest.fn(),
    startExerciseSession: jest.fn(),
    updateExerciseEntry: jest.fn(),
    addExerciseEntry: jest.fn(),
    removeExerciseEntry: jest.fn(),
    getExerciseProgressions: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;
const DATE = '2026-08-06';

function target(name: string, over: Partial<ExerciseTarget> = {}): ExerciseTarget {
  return {
    name,
    key: name.toLowerCase(),
    action: 'increase',
    rationale: `Try heavier on ${name}.`,
    sets: 3,
    reps: 8,
    weightKg: 40,
    last: { date: '2026-07-30', sets: 3, reps: 8, weightKg: 37.5 },
    ...over,
  };
}

function startedSession(): ExerciseSession {
  return {
    id: 's1',
    date: DATE,
    type: 'gym',
    planned: false,
    completed: true,
    source: 'manual',
    createdAt: `${DATE}T00:00:00.000Z`,
    updatedAt: `${DATE}T00:00:00.000Z`,
    exercises: [
      { id: 'e1', name: 'Bench', done: false, sets: 3, reps: 8, weightKg: 40 },
      { id: 'e2', name: 'Squat', done: false, sets: 3, reps: 8, weightKg: 60 },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getExerciseTargets.mockResolvedValue({
    date: DATE,
    plan: { label: 'Push', components: ['Push'] },
    targets: [target('Bench'), target('Squat', { key: 'squat', weightKg: 60 })],
  });
  mockApi.getExerciseSessions.mockResolvedValue({ sessions: [] });
  mockApi.getExerciseProgressions.mockResolvedValue({
    progressions: [
      { name: 'Bench', key: 'bench', sessions: 3, points: [] },
      { name: 'Treadmill run', key: 'treadmill run', sessions: 2, points: [] },
    ],
  });
  mockApi.startExerciseSession.mockResolvedValue({ session: startedSession(), resumed: false });
  mockApi.updateExerciseEntry.mockImplementation(async (sid, eid, patch) => {
    const s = startedSession();
    // A null in the patch is an explicit clear; drop those keys so the mocked
    // entry stays a valid ExerciseEntry, mirroring the storage layer.
    const applied = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
    return {
      session: {
        ...s,
        exercises: (s.exercises ?? []).map(e => (e.id === eid ? { ...e, ...applied } : e)),
      },
    };
  });
});

describe('useTodaySession', () => {
  it('shows the checklist from targets, with guidance, without creating a session', async () => {
    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.rows).toHaveLength(2);
    expect(result.current.rows[0]).toMatchObject({
      name: 'Bench',
      done: false,
      action: 'increase',
      rationale: 'Try heavier on Bench.',
    });
    expect(result.current.rows[0].last?.date).toBe('2026-07-30');
    // Lazy: opening the tab writes nothing.
    expect(mockApi.startExerciseSession).not.toHaveBeenCalled();
  });

  it('creates the session on the first tick and keeps the guidance', async () => {
    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.toggleDone(result.current.rows[0]);
    });

    expect(mockApi.startExerciseSession).toHaveBeenCalledTimes(1);
    expect(mockApi.updateExerciseEntry).toHaveBeenCalledWith('s1', 'e1', { done: true });
    const bench = result.current.rows.find(r => r.name === 'Bench')!;
    expect(bench.done).toBe(true);
    expect(bench.entryId).toBe('e1');
    // Guidance survives the write.
    expect(bench.action).toBe('increase');
    expect(bench.rationale).toBe('Try heavier on Bench.');
  });

  it('creates exactly one session when two ticks fire together', async () => {
    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await Promise.all([
        result.current.toggleDone(result.current.rows[0]),
        result.current.toggleDone(result.current.rows[1]),
      ]);
    });

    expect(mockApi.startExerciseSession).toHaveBeenCalledTimes(1);
    expect(mockApi.updateExerciseEntry).toHaveBeenCalledTimes(2);
  });

  it('merges an existing session on load and ticks it without a new /start', async () => {
    const existing: ExerciseSession = {
      ...startedSession(),
      exercises: [
        { id: 'e1', name: 'Bench', done: true, sets: 3, reps: 8, weightKg: 42.5, notes: 'felt good' },
        { id: 'e2', name: 'Squat', done: false, sets: 3, reps: 8, weightKg: 60 },
      ],
    };
    mockApi.getExerciseSessions.mockResolvedValue({ sessions: [existing] });

    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const bench = result.current.rows.find(r => r.name === 'Bench')!;
    expect(bench.done).toBe(true);
    expect(bench.entryId).toBe('e1');
    expect(bench.weightKg).toBe(42.5);
    expect(bench.notes).toBe('felt good');
    // Guidance still present alongside the logged state.
    expect(bench.action).toBe('increase');

    await act(async () => {
      await result.current.toggleDone(result.current.rows.find(r => r.name === 'Squat')!);
    });
    // Session already existed — no new one created.
    expect(mockApi.startExerciseSession).not.toHaveBeenCalled();
    expect(mockApi.updateExerciseEntry).toHaveBeenCalledWith('s1', 'e2', { done: true });
  });

  it('exposes known exercise names for the swap autocomplete', async () => {
    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.knownNames).toContain('Treadmill run'));
    expect(result.current.knownNames).toContain('Bench');
  });

  it('swaps a planned exercise, recording provenance and dropping the old guidance', async () => {
    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.commitSwap(result.current.rows[0], {
        name: 'Treadmill run',
        distanceKm: 3,
      });
    });

    expect(mockApi.updateExerciseEntry).toHaveBeenCalledWith('s1', 'e1', {
      name: 'Treadmill run',
      substitutedFor: 'Bench',
      targetText: null,
      distanceKm: 3,
    });
    const swapped = result.current.rows.find(r => r.key === 'bench')!;
    expect(swapped.name).toBe('Treadmill run');
    expect(swapped.substitutedFor).toBe('Bench');
    expect(swapped.distanceKm).toBe(3);
    // The original's guidance no longer describes the substitute.
    expect(swapped.action).toBeUndefined();
    expect(swapped.rationale).toBeUndefined();
  });

  it('keeps the un-done state through a swap', async () => {
    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.commitSwap(result.current.rows[0], { name: 'Treadmill run' });
    });

    expect(result.current.rows.find(r => r.key === 'bench')!.done).toBe(false);
  });

  it('restores the original exercise and brings its guidance back', async () => {
    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.commitSwap(result.current.rows[0], { name: 'Treadmill run' });
    });
    await act(async () => {
      await result.current.restoreSwap(result.current.rows.find(r => r.key === 'bench')!);
    });

    expect(mockApi.updateExerciseEntry).toHaveBeenLastCalledWith(
      's1',
      'e1',
      expect.objectContaining({ name: 'Bench', substitutedFor: null })
    );
    const restored = result.current.rows.find(r => r.key === 'bench')!;
    expect(restored.name).toBe('Bench');
    expect(restored.substitutedFor).toBeUndefined();
    // Guidance from the original target is back.
    expect(restored.action).toBe('increase');
    expect(restored.rationale).toBe('Try heavier on Bench.');
  });
});
