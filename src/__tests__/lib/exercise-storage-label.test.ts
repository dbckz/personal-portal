/**
 * The completion flow retitles a plan-linked session from its actuals. Proves
 * the pure deriveCompletedLabel is wired into the storage chokepoints every
 * client writes through: creating the logged session, then swapping/ticking its
 * entries. History must show what was done, not what was planned.
 */
import {
  createSession,
  updateSessionEntry,
  getAllSessions,
} from '@/lib/storage/exercise';
import { __resetDbForTests } from '@/lib/storage/db';
import type { ExerciseSession } from '@/types/life';

beforeEach(() => {
  __resetDbForTests();
});

// A planned "Parkrun + core" session plus the logged session started against it,
// seeded (nothing ticked yet) exactly as the /start route leaves it.
async function planAndLog(): Promise<{ plan: ExerciseSession; logged: ExerciseSession }> {
  const plan = await createSession({
    date: '2026-08-06',
    type: 'strength + cardio',
    label: 'Parkrun + core',
    components: ['Parkrun', 'core'],
    planned: true,
    completed: false,
  });

  const logged = await createSession({
    date: '2026-08-06',
    type: 'strength + cardio',
    label: 'Parkrun + core',
    components: ['Parkrun', 'core'],
    plannedSessionId: plan.id,
    planned: false,
    completed: true,
    source: 'manual',
    exercises: [
      { name: 'Outdoor run', done: false },
      { name: 'Dead bug', done: false },
      { name: 'Plank', done: false },
    ],
  });

  return { plan, logged };
}

describe('completed-session label derivation (storage)', () => {
  it('keeps the planned label while nothing is ticked', async () => {
    const { logged } = await planAndLog();
    expect(logged.label).toBe('Parkrun + core');
    expect(logged.components).toEqual(['Parkrun', 'core']);
  });

  it('retitles from a cardio swap once the actuals are ticked', async () => {
    const { logged } = await planAndLog();
    const [run, deadBug, plank] = logged.exercises!;

    // Swap the outdoor run for a treadmill run and tick it, then tick the core.
    await updateSessionEntry(logged.id, run.id, {
      name: 'Treadmill run',
      substitutedFor: 'Outdoor run',
      durationMinutes: 20,
      done: true,
    });
    await updateSessionEntry(logged.id, deadBug.id, { done: true });
    const after = await updateSessionEntry(logged.id, plank.id, { done: true });

    expect(after!.label).toBe('Treadmill run + core');
    expect(after!.components).toEqual(['Treadmill run', 'core']);

    // The plan record itself is untouched — derivation reads it, never rewrites it.
    const plan = (await getAllSessions()).find(s => s.planned)!;
    expect(plan.label).toBe('Parkrun + core');
    expect(plan.components).toEqual(['Parkrun', 'core']);
  });

  it('reverts to the planned wording when the swap is undone', async () => {
    const { logged } = await planAndLog();
    const [run, deadBug, plank] = logged.exercises!;
    await updateSessionEntry(logged.id, deadBug.id, { done: true });
    await updateSessionEntry(logged.id, plank.id, { done: true });
    await updateSessionEntry(logged.id, run.id, {
      name: 'Treadmill run',
      substitutedFor: 'Outdoor run',
      done: true,
    });

    // Restore: name back, provenance cleared.
    const restored = await updateSessionEntry(logged.id, run.id, {
      name: 'Outdoor run',
      substitutedFor: null,
    });

    expect(restored!.label).toBe('Parkrun + core');
    expect(restored!.components).toEqual(['Parkrun', 'core']);
  });
});
