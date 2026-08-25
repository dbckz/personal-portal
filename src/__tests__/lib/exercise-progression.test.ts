/**
 * @jest-environment node
 *
 * buildProgressions is the history the next session's targets are built from.
 * A seeded-but-unticked entry (done:false) records the numbers to AIM for, not
 * what was done — so it must NEVER enter the history, or its pre-filled target
 * becomes the "last time" the next target advances on.
 */
import { buildProgressions } from '@/lib/exercise-progression';
import { buildTarget } from '@/lib/exercise-targets';
import type { ExerciseSession } from '@/types/life';

function session(date: string, exercises: ExerciseSession['exercises']): ExerciseSession {
  return {
    id: `s-${date}`,
    date,
    type: 'gym',
    planned: false,
    completed: true,
    source: 'manual',
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`,
    exercises,
  };
}

describe('buildProgressions done-filtering', () => {
  it('ignores a seeded-but-unticked entry', () => {
    const progressions = buildProgressions([
      // The exercise was actually done once, at 40kg.
      session('2026-07-01', [
        { id: 'a', name: 'Bench press', sets: 3, reps: 8, weightKg: 40, done: true },
      ]),
      // A later session seeded a heavier target from the plan but it was never
      // ticked — done:false. This must not enter the history.
      session('2026-07-08', [
        { id: 'b', name: 'Bench press', sets: 3, reps: 8, weightKg: 45, done: false },
      ]),
    ]);

    const bench = progressions.find(p => p.name === 'Bench press');
    expect(bench).toBeDefined();
    // One real data point, not two — and the latest is the 40kg that was done,
    // not the 45kg that was only seeded.
    expect(bench!.sessions).toBe(1);
    expect(bench!.points).toHaveLength(1);
    expect(bench!.latest?.weightKg).toBe(40);
  });

  it('does not advance the next target off an unticked seeded entry', () => {
    const progressions = buildProgressions([
      session('2026-07-01', [
        {
          id: 'a',
          name: 'Bench press',
          sets: 3,
          reps: 8,
          weightKg: 40,
          done: true,
          notes: 'Could have done 3-4 more per set',
        },
      ]),
      // Seeded next target at 45kg, never performed.
      session('2026-07-08', [
        { id: 'b', name: 'Bench press', sets: 3, reps: 8, weightKg: 45, done: false },
      ]),
    ]);

    const target = buildTarget(progressions.find(p => p.name === 'Bench press')!);
    // The recommendation builds off the 40kg that was actually done (with reps
    // in reserve), so it increases from there — never from the phantom 45kg.
    expect(target.action).toBe('increase');
    expect(target.weightKg).toBeGreaterThan(40);
    expect(target.weightKg).toBeLessThan(45);
  });

  it('keeps legacy entries with no done flag', () => {
    const progressions = buildProgressions([
      // Old data / a manual log: no done flag, but genuinely performed.
      session('2026-07-01', [
        { id: 'a', name: 'Squat', sets: 3, reps: 5, weightKg: 60 },
      ]),
    ]);
    const squat = progressions.find(p => p.name === 'Squat');
    expect(squat?.points).toHaveLength(1);
    expect(squat?.latest?.weightKg).toBe(60);
  });
});
