/**
 * @jest-environment node
 *
 * Round-trip tests for the weekly-routine storage. The behaviours worth pinning:
 * an empty store seeds the captured default (so the tab is never blank), a save
 * replaces the whole routine, a rest day carries no exercises, and a duplicated
 * weekday is refused.
 */
import {
  deleteRoutine,
  getRoutine,
  getWeeklyRoutine,
  listRoutines,
  LEGACY_ROUTINE_NAME,
  saveRoutine,
  saveWeeklyRoutine,
  setActiveRoutine,
} from '@/lib/storage/weekly-routine';
import { readAllDomains } from '@/lib/storage/db';
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

describe('the routine library', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('migrates the legacy routine into the library under the split name, active', async () => {
    const routine = await getWeeklyRoutine();
    expect(routine).toHaveLength(7);
    const { names, active } = await listRoutines();
    expect(names).toEqual([LEGACY_ROUTINE_NAME]);
    expect(active).toBe(LEGACY_ROUTINE_NAME);
    // The legacy row is left in place as a migration source.
    expect(Array.isArray(readAllDomains().weeklyRoutine)).toBe(true);
  });

  it('falls back to the seed unchanged when the library is empty', async () => {
    // No writes yet — the first read seeds and migrates in one step.
    const routine = await getWeeklyRoutine();
    const monday = routine.find(d => d.dayOfWeek === 1)!;
    expect(monday.title).toBe('Push (chest & arms)');
  });

  it('saveWeeklyRoutine edits the active entry (and mirrors the legacy row for the split)', async () => {
    await getWeeklyRoutine(); // migrate
    await saveWeeklyRoutine([{ dayOfWeek: 1, title: 'Edited', anchors: ['X'] }]);
    const active = await getRoutine(LEGACY_ROUTINE_NAME);
    expect(active?.[0].title).toBe('Edited');
    // The legacy row mirrors the active split so nothing reading it regresses.
    const legacy = readAllDomains().weeklyRoutine as WeeklyRoutineDay[];
    expect(legacy[0].title).toBe('Edited');
  });

  it('creates a named routine and edits it without changing the active one', async () => {
    await getWeeklyRoutine();
    await saveRoutine('Full body', [{ dayOfWeek: 1, title: 'Full body A', anchors: ['Leg press'] }]);
    const { names, active } = await listRoutines();
    expect(names).toContain('Full body');
    expect(active).toBe(LEGACY_ROUTINE_NAME); // creating does not activate
    const fb = await getRoutine('Full body');
    expect(fb?.[0].title).toBe('Full body A');
  });

  it('setActiveRoutine switches the active routine and refuses an unknown name', async () => {
    await getWeeklyRoutine();
    await saveRoutine('Full body', [{ dayOfWeek: 1, title: 'Full body A', anchors: [] }]);
    await setActiveRoutine('Full body');
    expect(await getActiveName()).toBe('Full body');
    await expect(setActiveRoutine('Nope')).rejects.toThrow(/Unknown routine/);
  });

  it('deleteRoutine refuses the active routine and an unknown name', async () => {
    await getWeeklyRoutine();
    await saveRoutine('Full body', [{ dayOfWeek: 1, title: 'Full body A', anchors: [] }]);
    await expect(deleteRoutine(LEGACY_ROUTINE_NAME)).rejects.toThrow(/active/i);
    await expect(deleteRoutine('Nope')).rejects.toThrow(/Unknown routine/);
    // A non-active routine deletes cleanly.
    await deleteRoutine('Full body');
    const { names } = await listRoutines();
    expect(names).not.toContain('Full body');
  });
});

async function getActiveName(): Promise<string> {
  return (await listRoutines()).active;
}

describe('normaliseDay — the v2 fields', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('keeps venue, valid pairs, alternatives, fixed and prescriptions, and cardioAfter', async () => {
    const saved = await saveWeeklyRoutine([
      {
        dayOfWeek: 2,
        title: 'Full body A (push + pull + legs) + Treadmill run',
        anchors: ['Leg press', 'Seated leg curl', 'Incline DB press', 'Chest-supported DB row'],
        staples: ['Calf press'],
        pairs: [
          ['Leg press', 'Seated leg curl'],
          ['Incline DB press', 'Chest-supported DB row'],
        ],
        alternatives: { 'Chest-supported DB row': ['Single-arm DB row'] },
        cardioAfter: true,
      } as unknown as WeeklyRoutineDay,
      {
        dayOfWeek: 3,
        title: 'Home core + mobility',
        anchors: [],
        staples: ['Couch stretch', 'Glute bridge'],
        venue: 'home',
        fixed: true,
        prescriptions: { 'Couch stretch': '90 s per side', 'Glute bridge': '2 × 15' },
      } as unknown as WeeklyRoutineDay,
    ]);

    const gym = saved.find(d => d.dayOfWeek === 2)!;
    expect(gym.pairs).toEqual([
      ['Leg press', 'Seated leg curl'],
      ['Incline DB press', 'Chest-supported DB row'],
    ]);
    expect(gym.alternatives).toEqual({ 'Chest-supported DB row': ['Single-arm DB row'] });
    expect(gym.cardioAfter).toBe(true);

    const home = saved.find(d => d.dayOfWeek === 3)!;
    expect(home.venue).toBe('home');
    expect(home.fixed).toBe(true);
    expect(home.prescriptions).toEqual({ 'Couch stretch': '90 s per side', 'Glute bridge': '2 × 15' });
  });

  it('drops a malformed pair and an alternative for an unknown exercise', async () => {
    const saved = await saveWeeklyRoutine([
      {
        dayOfWeek: 1,
        title: 'Legs',
        anchors: ['Squat', 'Leg curl'],
        pairs: [
          ['Squat', 'Leg curl'], // valid
          ['Squat', 'Bench press'], // Bench press is not in the day — dropped
          ['Squat'], // malformed length — dropped
        ],
        alternatives: {
          Squat: ['Leg press'], // kept
          'Bench press': ['Push-up'], // key not in the day — dropped
        },
      } as unknown as WeeklyRoutineDay,
    ]);
    const day = saved[0];
    expect(day.pairs).toEqual([['Squat', 'Leg curl']]);
    expect(day.alternatives).toEqual({ Squat: ['Leg press'] });
  });

  it('strips the v2 fields from a rest day', async () => {
    const saved = await saveWeeklyRoutine([
      {
        dayOfWeek: 5,
        title: 'Rest',
        rest: true,
        anchors: ['Squat'],
        venue: 'home',
        fixed: true,
        cardioAfter: true,
        pairs: [['Squat', 'Squat']],
      } as unknown as WeeklyRoutineDay,
    ]);
    const day = saved[0];
    expect(day.rest).toBe(true);
    expect(day.venue).toBeUndefined();
    expect(day.fixed).toBeUndefined();
    expect(day.cardioAfter).toBeUndefined();
    expect(day.pairs).toBeUndefined();
  });
});
