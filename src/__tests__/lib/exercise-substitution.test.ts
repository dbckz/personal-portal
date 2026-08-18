/**
 * @jest-environment node
 *
 * A per-exercise swap files the session's data point under the SUBSTITUTE, not
 * the original planned exercise: the entry's name is the substitute's, so
 * buildProgressions groups it there and buildTarget reads the substitute's
 * history. The swapped-out exercise simply gets no data point that day, so its
 * own progression is untouched.
 */
import { buildProgressions } from '@/lib/exercise-progression';
import { buildTarget } from '@/lib/exercise-targets';
import type { ExerciseSession } from '@/types/life';

function session(date: string, exercises: ExerciseSession['exercises']): ExerciseSession {
  return {
    id: `s-${date}`,
    date,
    type: 'run',
    planned: false,
    completed: true,
    source: 'manual',
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`,
    exercises,
  };
}

describe('per-exercise substitution and progression', () => {
  const sessions = [
    // A real Parkrun a few weeks back.
    session('2026-07-04', [
      { id: 'a1', name: 'Parkrun 5K', distanceKm: 5, durationMinutes: 28, done: true },
    ]),
    // Today the Parkrun entry was swapped for a shorter treadmill run.
    session('2026-08-06', [
      {
        id: 'b1',
        name: 'Treadmill run',
        substitutedFor: 'Parkrun 5K',
        distanceKm: 3,
        durationMinutes: 20,
        done: true,
      },
    ]),
  ];

  const progressions = buildProgressions(sessions);
  const parkrun = progressions.find(p => p.key === 'parkrun 5k');
  const treadmill = progressions.find(p => p.key === 'treadmill run');

  it('files the swapped session under the substitute exercise', () => {
    expect(treadmill).toBeDefined();
    expect(treadmill!.sessions).toBe(1);
    expect(treadmill!.latest?.distanceKm).toBe(3);
  });

  it('leaves the swapped-out exercise’s history untouched', () => {
    expect(parkrun).toBeDefined();
    // Only the original 4 July session — the swap did not add a point here.
    expect(parkrun!.sessions).toBe(1);
    expect(parkrun!.latest?.distanceKm).toBe(5);
  });

  it('builds the target from the substitute’s own history, not the original’s', () => {
    const target = buildTarget(treadmill!);
    expect(target.kind).toBe('cardio');
    // A treadmill piece is time-only, so its own logged 20 min carries through
    // (the parkrun's would differ) and the ambiguous distance is dropped.
    expect(target.durationMinutes).toBe(20);
    expect(target.distanceKm).toBeUndefined();
  });
});
