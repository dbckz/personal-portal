/**
 * @jest-environment node
 *
 * Round-trip tests for the weekly-routine storage. The behaviours worth pinning:
 * an empty store seeds the captured default (so the tab is never blank), a save
 * replaces the whole routine, a rest day carries no exercises, and a duplicated
 * weekday is refused.
 */
import { getWeeklyRoutine, saveWeeklyRoutine } from '@/lib/storage/weekly-routine';
import { __resetDbForTests } from '@/lib/storage/db';
import type { WeeklyRoutineDay } from '@/types/life';

describe('weekly routine storage', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('seeds the captured default on first read of an empty store', async () => {
    const routine = await getWeeklyRoutine();
    expect(routine).toHaveLength(7);
    // Mon→Sun display order.
    expect(routine.map(d => d.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 0]);

    const monday = routine.find(d => d.dayOfWeek === 1)!;
    expect(monday.title).toBe('Push (chest & arms)');
    expect(monday.anchors).toEqual(['Incline dumbbell press', 'Flat dumbbell press']);

    const friday = routine.find(d => d.dayOfWeek === 5)!;
    expect(friday.rest).toBe(true);
    expect(friday.anchors).toEqual([]);
  });

  it('persists the seed so a second read returns the same data', async () => {
    const first = await getWeeklyRoutine();
    const second = await getWeeklyRoutine();
    expect(second).toEqual(first);
  });

  it('round-trips a saved routine', async () => {
    const days: WeeklyRoutineDay[] = [
      { dayOfWeek: 1, title: 'Legs', anchors: ['Squat'], staples: ['Calf raise'] },
      { dayOfWeek: 3, title: 'Rest', anchors: [], rest: true },
    ];
    const saved = await saveWeeklyRoutine(days);
    expect(saved.map(d => d.dayOfWeek)).toEqual([1, 3]);

    const read = await getWeeklyRoutine();
    expect(read.find(d => d.dayOfWeek === 1)?.anchors).toEqual(['Squat']);
    expect(read.find(d => d.dayOfWeek === 1)?.staples).toEqual(['Calf raise']);
  });

  it('drops exercises on a rest day and trims/omits blanks', async () => {
    const saved = await saveWeeklyRoutine([
      { dayOfWeek: 2, title: '  Rest  ', anchors: ['Squat'], staples: ['Plank'], rest: true },
      { dayOfWeek: 4, title: 'Push', anchors: ['  Bench  ', '', '   '], note: '  hard  ' },
    ]);

    const rest = saved.find(d => d.dayOfWeek === 2)!;
    expect(rest.rest).toBe(true);
    expect(rest.anchors).toEqual([]);
    expect(rest.staples).toBeUndefined();
    expect(rest.title).toBe('Rest');

    const push = saved.find(d => d.dayOfWeek === 4)!;
    expect(push.anchors).toEqual(['Bench']);
    expect(push.note).toBe('hard');
  });

  it('refuses a routine that is not an array', async () => {
    await expect(saveWeeklyRoutine({ dayOfWeek: 1 } as unknown)).rejects.toThrow(/array/i);
  });

  it('refuses a duplicated weekday', async () => {
    await expect(
      saveWeeklyRoutine([
        { dayOfWeek: 1, title: 'Push', anchors: [] },
        { dayOfWeek: 1, title: 'Pull', anchors: [] },
      ])
    ).rejects.toThrow(/Duplicate day/);
  });

  it('discards a malformed day rather than corrupting the store', async () => {
    const saved = await saveWeeklyRoutine([
      { dayOfWeek: 9, title: 'Bad', anchors: [] }, // out of range
      { dayOfWeek: 1, title: 'Good', anchors: [] },
    ]);
    expect(saved.map(d => d.dayOfWeek)).toEqual([1]);
  });
});
