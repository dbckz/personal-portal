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
  setSessionVenue,
  upsertSessionByImportKey,
} from '@/lib/storage/exercise';
import { __resetDbForTests } from '@/lib/storage/db';

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
