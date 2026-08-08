/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTodaySession, isCardioEntry, isHoldEntry } from '@/hooks/useTodaySession';
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

  it('logs distance and time on a cardio row through the shared write path', async () => {
    const existing: ExerciseSession = {
      ...startedSession(),
      exercises: [{ id: 'e1', name: 'Treadmill run', done: false }],
    };
    mockApi.getExerciseSessions.mockResolvedValue({ sessions: [existing] });
    mockApi.getExerciseTargets.mockResolvedValue({
      date: DATE,
      plan: { label: 'Run', components: ['Run'] },
      targets: [target('Treadmill run', { key: 'treadmill run', kind: 'cardio', weightKg: undefined })],
    });

    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const run = result.current.rows.find(r => r.name === 'Treadmill run')!;
    expect(isCardioEntry(run)).toBe(true);

    await act(async () => {
      await result.current.commitField(run, { durationMinutes: 20 });
    });
    expect(mockApi.updateExerciseEntry).toHaveBeenCalledWith('s1', 'e1', { durationMinutes: 20 });

    await act(async () => {
      await result.current.commitField(run, { distanceKm: 3.2 });
    });
    expect(mockApi.updateExerciseEntry).toHaveBeenCalledWith('s1', 'e1', { distanceKm: 3.2 });
  });

  it('carries distance and time through a cardio swap in one save', async () => {
    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.commitSwap(result.current.rows[0], {
        name: 'Treadmill run',
        distanceKm: 3,
        durationMinutes: 20,
      });
    });

    expect(mockApi.updateExerciseEntry).toHaveBeenCalledWith('s1', 'e1', {
      name: 'Treadmill run',
      substitutedFor: 'Bench',
      targetText: null,
      distanceKm: 3,
      durationMinutes: 20,
    });
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

  it('resolves a swapped row with a missing entryId via substitutedFor, not a duplicate', async () => {
    // A session already holding a swapped entry: renamed to the substitute,
    // recording what it stood in for, keyed to the original target's slot.
    const swapped: ExerciseSession = {
      ...startedSession(),
      exercises: [
        { id: 'e1', name: 'Treadmill run', substitutedFor: 'Outdoor run', done: false, distanceKm: 3 },
      ],
    };
    mockApi.getExerciseSessions.mockResolvedValue({ sessions: [swapped] });
    mockApi.getExerciseTargets.mockResolvedValue({
      date: DATE,
      plan: { label: 'Run', components: ['Run'] },
      targets: [target('Outdoor run', { key: 'outdoor run', kind: 'cardio', weightKg: undefined })],
    });
    mockApi.updateExerciseEntry.mockImplementation(async (sid, eid, patch) => {
      const applied = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
      return {
        session: {
          ...swapped,
          exercises: (swapped.exercises ?? []).map(e => (e.id === eid ? { ...e, ...applied } : e)),
        },
      };
    });

    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const row = result.current.rows.find(r => r.key === 'outdoor run')!;
    expect(row.entryId).toBe('e1');

    // Reproduce the production precondition: a write lands on the swapped row
    // with its entryId gone. It must reuse the existing substituted entry.
    await act(async () => {
      await result.current.toggleDone({ ...row, entryId: undefined });
    });

    expect(mockApi.addExerciseEntry).not.toHaveBeenCalled();
    expect(mockApi.updateExerciseEntry).toHaveBeenCalledWith('s1', 'e1', { done: true });
  });

  it('creates the entry on a target-backed row’s first write, then reuses it', async () => {
    // Session started with no seeded entries, so the first write must create
    // one and the row must retain its entryId for the next write.
    const empty: ExerciseSession = { ...startedSession(), exercises: [] };
    mockApi.startExerciseSession.mockResolvedValue({ session: empty, resumed: false });
    let created: ExerciseSession = empty;
    mockApi.addExerciseEntry.mockImplementation(async (_sid, input) => {
      const entry = { id: 'new1', name: input.name, done: false };
      created = { ...empty, exercises: [entry] };
      return { session: created, entry };
    });
    mockApi.updateExerciseEntry.mockImplementation(async (sid, eid, patch) => {
      const applied = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
      return {
        session: {
          ...created,
          exercises: (created.exercises ?? []).map(e => (e.id === eid ? { ...e, ...applied } : e)),
        },
      };
    });

    const { result } = renderHook(() => useTodaySession(DATE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.toggleDone(result.current.rows.find(r => r.name === 'Bench')!);
    });

    expect(mockApi.addExerciseEntry).toHaveBeenCalledTimes(1);
    const bench = result.current.rows.find(r => r.name === 'Bench')!;
    expect(bench.entryId).toBe('new1');

    // Second write reuses the created entry — no duplicate.
    await act(async () => {
      await result.current.commitField(bench, { reps: 10 });
    });
    expect(mockApi.addExerciseEntry).toHaveBeenCalledTimes(1);
    expect(mockApi.updateExerciseEntry).toHaveBeenLastCalledWith('s1', 'new1', { reps: 10 });
  });
});

describe('isCardioEntry', () => {
  it('reads runs as cardio, by name', () => {
    expect(isCardioEntry({ name: 'Treadmill run' })).toBe(true);
    expect(isCardioEntry({ name: 'Outdoor run' })).toBe(true);
    expect(isCardioEntry({ name: 'Parkrun' })).toBe(true);
    expect(isCardioEntry({ name: 'Erg row' })).toBe(true);
  });

  it('reads the cardio kind tag and measured fields as cardio', () => {
    expect(isCardioEntry({ name: 'Intervals', kind: 'cardio' })).toBe(true);
    expect(isCardioEntry({ name: 'Something', distanceKm: 3 })).toBe(true);
    expect(isCardioEntry({ name: 'Something', durationMinutes: 20 })).toBe(true);
  });

  it('does not read strength or timed-hold work as cardio', () => {
    expect(isCardioEntry({ name: 'Side plank' })).toBe(false);
    expect(isCardioEntry({ name: 'Dead bug' })).toBe(false);
    expect(isCardioEntry({ name: 'Bench press' })).toBe(false);
    // A bare strength "row" must not be mistaken for the rowing machine.
    expect(isCardioEntry({ name: 'Seated row' })).toBe(false);
    expect(isCardioEntry({ name: 'Bent-over row' })).toBe(false);
    // Loaded "walk" movements are strength, not cardio.
    expect(isCardioEntry({ name: "Farmer's walk" })).toBe(false);
    expect(isCardioEntry({ name: 'Walking lunge' })).toBe(false);
  });
});

describe('isHoldEntry', () => {
  it('reads holds by tag, by logged seconds, and by name', () => {
    expect(isHoldEntry({ name: 'Anything', kind: 'hold' })).toBe(true);
    expect(isHoldEntry({ name: 'Some plank variant', holdSeconds: 45 })).toBe(true);
    expect(isHoldEntry({ name: 'Side plank' })).toBe(true);
    expect(isHoldEntry({ name: 'Dead hang' })).toBe(true);
    expect(isHoldEntry({ name: 'Wall sit' })).toBe(true);
  });

  it('does not read rep-based or cardio work as a hold', () => {
    expect(isHoldEntry({ name: 'Dead bug' })).toBe(false);
    expect(isHoldEntry({ name: 'Bench press' })).toBe(false);
    // Cardio wins: a run is never a hold, even though neither carries reps.
    expect(isHoldEntry({ name: 'Treadmill run', kind: 'cardio' })).toBe(false);
    expect(isHoldEntry({ name: 'Outdoor run' })).toBe(false);
  });
});
