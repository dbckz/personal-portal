/**
 * @jest-environment node
 *
 * The venue field on a planned session: set and cleared through setSessionVenue,
 * and — crucially — left ALONE by a calendar/routine re-sync. A venue Dave set by
 * hand is an unasserted field to the upsert, so re-importing the same event must
 * keep it rather than wipe it.
 */
import {
  createSession,
  getAllSessions,
  isUntouchedSeededEntry,
  pruneUntouchedSeededEntries,
  setSessionVenue,
  updateSessionEntry,
  upsertSessionByImportKey,
} from '@/lib/storage/exercise';
import { __resetDbForTests } from '@/lib/storage/db';
import type { ExerciseEntry } from '@/types/life';

beforeEach(() => {
  __resetDbForTests();
});

describe('setSessionVenue', () => {
  it('sets and then clears the venue', async () => {
    const plan = await createSession({
      date: '2026-08-21',
      type: 'strength',
      label: 'Push (shoulders)',
      components: ['Push (shoulders)'],
      planned: true,
      completed: false,
    });
    expect(plan.venue).toBeUndefined();

    const home = await setSessionVenue(plan.id, 'home');
    expect(home?.venue).toBe('home');

    const gym = await setSessionVenue(plan.id, undefined);
    expect(gym?.venue).toBeUndefined();
    // And the field is genuinely gone, not just undefined-valued.
    expect('venue' in (gym as object)).toBe(false);
  });

  it('returns null for an unknown session', async () => {
    expect(await setSessionVenue('nope', 'home')).toBeNull();
  });
});

describe('a re-sync does not clobber a hand-set venue', () => {
  it('keeps venue when the same import key is upserted without one', async () => {
    // A routine-materialised planned session, imported from a calendar event.
    const { session } = await upsertSessionByImportKey('gcal:evt1', {
      date: '2026-08-21',
      type: 'strength',
      label: 'Push (shoulders)',
      components: ['Push (shoulders)'],
      planned: true,
      completed: false,
      source: 'routine',
    });
    // Dave swaps it to a home session in the portal.
    await setSessionVenue(session.id, 'home');

    // The nightly sync re-imports the same event — the upsert asserts the event's
    // fields but says nothing about venue (a portal-only annotation).
    await upsertSessionByImportKey('gcal:evt1', {
      date: '2026-08-21',
      type: 'strength',
      label: 'Push (shoulders)',
      components: ['Push (shoulders)'],
      planned: true,
      completed: false,
      source: 'routine',
    });

    const [only] = await getAllSessions();
    // Exactly one session, and its home venue survived the re-sync.
    expect((await getAllSessions())).toHaveLength(1);
    expect(only.venue).toBe('home');
  });
});

describe('isUntouchedSeededEntry', () => {
  const base: ExerciseEntry = { id: 'e', name: 'Press-ups' };
  it('is untouched when not done, unnoted, unrated and not swapped', () => {
    expect(isUntouchedSeededEntry({ ...base, sets: 3, reps: 12 })).toBe(true);
  });
  it('is touched once ticked, noted, rated or swapped', () => {
    expect(isUntouchedSeededEntry({ ...base, done: true })).toBe(false);
    expect(isUntouchedSeededEntry({ ...base, notes: 'felt good' })).toBe(false);
    expect(isUntouchedSeededEntry({ ...base, rir: 2 })).toBe(false);
    expect(isUntouchedSeededEntry({ ...base, substitutedFor: 'Treadmill run' })).toBe(false);
  });
});

describe('pruneUntouchedSeededEntries', () => {
  // A logged, in-progress session seeded from the old programme, with one row
  // ticked done. It carries a treadmill run seeded on what is now a home day.
  async function seededSession() {
    return createSession({
      date: '2026-08-21',
      type: 'strength + cardio',
      label: 'Push (shoulders)',
      planned: false,
      completed: true,
      source: 'manual',
      exercises: [
        { name: 'Treadmill run', durationMinutes: 20, done: false },
        { name: 'Band overhead press', sets: 3, reps: 12, done: false },
        { name: 'Press-ups', sets: 3, reps: 12, done: true }, // the user ticked this
      ],
    });
  }

  it('drops untouched seeded rows (incl. a treadmill run) but keeps ticked ones', async () => {
    await seededSession();
    const { removed } = await pruneUntouchedSeededEntries('2026-08-21');
    expect(removed).toBe(2);

    const [session] = await getAllSessions();
    const names = (session.exercises ?? []).map(e => e.name);
    expect(names).toEqual(['Press-ups']); // only the ticked row survives
    // A home day can never keep an untouched treadmill row.
    expect(names).not.toContain('Treadmill run');
  });

  it('keeps a noted or rated row even when not ticked', async () => {
    const s = await createSession({
      date: '2026-08-21',
      type: 'strength',
      planned: false,
      completed: true,
      source: 'manual',
      exercises: [
        { name: 'Band overhead press', sets: 3, reps: 12, done: false },
        { name: 'Pike press-ups', sets: 3, reps: 8, done: false },
      ],
    });
    // Annotate the first row (a note), leave the second untouched.
    const firstId = s.exercises![0].id;
    await updateSessionEntry(s.id, firstId, { notes: 'shoulder twinge' });

    const { removed } = await pruneUntouchedSeededEntries('2026-08-21');
    expect(removed).toBe(1);
    const [session] = await getAllSessions();
    expect((session.exercises ?? []).map(e => e.name)).toEqual(['Band overhead press']);
  });

  it('with keepNames, drops only untouched rows the new programme no longer has', async () => {
    // The 29 Aug 2026 duplicate: a session seeded before the programme
    // regenerated carries a treadmill run; the new programme has a parkrun
    // instead but still contains the press. Only the treadmill goes.
    await seededSession();
    const { removed } = await pruneUntouchedSeededEntries('2026-08-21', [
      'Parkrun',
      'Band overhead press',
    ]);
    expect(removed).toBe(1);

    const [session] = await getAllSessions();
    const names = (session.exercises ?? []).map(e => e.name);
    expect(names).toEqual(['Band overhead press', 'Press-ups']);
    expect(names).not.toContain('Treadmill run');
  });

  it('is a no-op when there is no in-progress manual session for the date', async () => {
    await createSession({
      date: '2026-08-21',
      type: 'strength',
      planned: true, // a plan, not an in-progress logged session
      completed: false,
    });
    expect(await pruneUntouchedSeededEntries('2026-08-21')).toEqual({ removed: 0 });
  });
});
