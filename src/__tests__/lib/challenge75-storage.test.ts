/**
 * The 75 Hard storage domain: seed-on-empty, per-action tick and note writes
 * against the active attempt, start-date editing (which drops out-of-window
 * days), and restart (which archives the active attempt with a recorded outcome
 * and appends a fresh one).
 */
import {
  getChallenge75State,
  restartChallenge75,
  setChallenge75Note,
  setChallenge75StartDate,
  setChallenge75Tick,
} from '@/lib/storage/challenge75';
import { DEFAULT_START_DATE } from '@/lib/challenge75';
import { __resetDbForTests } from '@/lib/storage/db';

beforeEach(() => {
  __resetDbForTests();
});

describe('seed', () => {
  it('seeds one active attempt starting 2026-09-14 on an empty store', async () => {
    const state = await getChallenge75State();
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0].startDate).toBe(DEFAULT_START_DATE);
    expect(state.attempts[0].days).toEqual({});
    expect(state.attempts[0].endedAt).toBeUndefined();
  });
});

describe('ticks', () => {
  it('sets and clears a rule on a challenge day', async () => {
    await getChallenge75State();
    let state = await setChallenge75Tick('2026-09-14', 'water', true);
    expect(state.attempts[0].days['2026-09-14']).toEqual({ water: true });

    state = await setChallenge75Tick('2026-09-14', 'read', true);
    expect(state.attempts[0].days['2026-09-14']).toEqual({ water: true, read: true });

    state = await setChallenge75Tick('2026-09-14', 'water', false);
    expect(state.attempts[0].days['2026-09-14']).toEqual({ read: true });
  });

  it('drops a day entry once its last tick is cleared', async () => {
    await getChallenge75State();
    await setChallenge75Tick('2026-09-15', 'photo', true);
    const state = await setChallenge75Tick('2026-09-15', 'photo', false);
    expect(state.attempts[0].days['2026-09-15']).toBeUndefined();
  });

  it('rejects a date outside the active attempt', async () => {
    await getChallenge75State();
    await expect(setChallenge75Tick('2026-09-13', 'water', true)).rejects.toThrow(/outside/);
    await expect(setChallenge75Tick('2026-11-28', 'water', true)).rejects.toThrow(/outside/);
  });

  it('rejects an unknown rule', async () => {
    await getChallenge75State();
    await expect(
      // @ts-expect-error deliberately passing a bad rule
      setChallenge75Tick('2026-09-14', 'sleep', true)
    ).rejects.toThrow(/Unknown rule/);
  });
});

describe('notes', () => {
  it('sets and clears a day note', async () => {
    await getChallenge75State();
    let state = await setChallenge75Note('2026-09-14', '  felt strong  ');
    expect(state.attempts[0].days['2026-09-14']).toEqual({ note: 'felt strong' });

    state = await setChallenge75Note('2026-09-14', '');
    expect(state.attempts[0].days['2026-09-14']).toBeUndefined();
  });

  it('keeps ticks and note side by side', async () => {
    await getChallenge75State();
    await setChallenge75Tick('2026-09-14', 'read', true);
    const state = await setChallenge75Note('2026-09-14', 'good chapter');
    expect(state.attempts[0].days['2026-09-14']).toEqual({ read: true, note: 'good chapter' });
  });
});

describe('start date', () => {
  it('shifts the window and drops days that fall outside it', async () => {
    await getChallenge75State();
    await setChallenge75Tick('2026-09-14', 'water', true); // day 1 of the old window
    const state = await setChallenge75StartDate('2026-09-15');
    expect(state.attempts[0].startDate).toBe('2026-09-15');
    // 2026-09-14 is now before day 1, so its ticks are gone.
    expect(state.attempts[0].days['2026-09-14']).toBeUndefined();
  });

  it('keeps days still inside the shifted window', async () => {
    await getChallenge75State();
    await setChallenge75Tick('2026-09-20', 'water', true);
    const state = await setChallenge75StartDate('2026-09-15');
    expect(state.attempts[0].days['2026-09-20']).toEqual({ water: true });
  });
});

describe('restart', () => {
  it('archives the active attempt and appends a fresh one from the chosen date', async () => {
    await getChallenge75State();
    await setChallenge75Tick('2026-09-14', 'water', true);
    const state = await restartChallenge75('2026-10-01');

    expect(state.attempts).toHaveLength(2);
    const [archived, active] = state.attempts;

    // The archived attempt keeps its ticks and gains an endedAt + outcome.
    expect(archived.days['2026-09-14']).toEqual({ water: true });
    expect(archived.endedAt).toBeDefined();
    expect(archived.outcome).toBeDefined();

    // The new attempt is clean and active.
    expect(active.startDate).toBe('2026-10-01');
    expect(active.days).toEqual({});
    expect(active.endedAt).toBeUndefined();
  });

  it('writes to the newest attempt after a restart', async () => {
    await getChallenge75State();
    await restartChallenge75('2026-10-01');
    const state = await setChallenge75Tick('2026-10-01', 'read', true);
    expect(state.attempts[1].days['2026-10-01']).toEqual({ read: true });
    expect(state.attempts[0].days['2026-10-01']).toBeUndefined();
  });
});
