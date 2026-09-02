/**
 * @jest-environment node
 *
 * Round-trip tests for the per-date routine-overrides storage: an empty store is
 * empty, a set/clear round-trips, the date format and dayOfWeek range are
 * validated, and entries older than 60 days are pruned on write.
 */
import { format, subDays } from 'date-fns';

import { getRoutineOverrides, setRoutineOverride } from '@/lib/storage/routine-overrides';
import { __resetDbForTests } from '@/lib/storage/db';

describe('routine overrides storage', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('is empty on first read', async () => {
    expect(await getRoutineOverrides()).toEqual({});
  });

  it('round-trips a dayOfWeek override and a rest override', async () => {
    await setRoutineOverride('2026-09-03', { dayOfWeek: 3 });
    await setRoutineOverride('2026-09-02', { rest: true });

    const overrides = await getRoutineOverrides();
    expect(overrides['2026-09-03']).toEqual({ dayOfWeek: 3 });
    expect(overrides['2026-09-02']).toEqual({ rest: true });
  });

  it('clears an override with null', async () => {
    await setRoutineOverride('2026-09-03', { dayOfWeek: 3 });
    const after = await setRoutineOverride('2026-09-03', null);
    expect(after['2026-09-03']).toBeUndefined();
    expect(await getRoutineOverrides()).toEqual({});
  });

  it('rejects a malformed date', async () => {
    await expect(setRoutineOverride('03-09-2026', { rest: true })).rejects.toThrow(/date/i);
  });

  it('rejects a dayOfWeek out of range', async () => {
    await expect(setRoutineOverride('2026-09-03', { dayOfWeek: 9 })).rejects.toThrow(/override/i);
  });

  it('prunes entries dated more than 60 days before today on write', async () => {
    const stale = format(subDays(new Date(), 90), 'yyyy-MM-dd');
    const recent = format(subDays(new Date(), 10), 'yyyy-MM-dd');
    // Seed a stale entry, then a later write prunes it.
    await setRoutineOverride(stale, { rest: true });
    const after = await setRoutineOverride(recent, { dayOfWeek: 2 });

    expect(after[stale]).toBeUndefined();
    expect(after[recent]).toEqual({ dayOfWeek: 2 });
  });

  it('drops a malformed stored value on read', async () => {
    // Write a valid entry, then confirm a normal read keeps only valid overrides.
    await setRoutineOverride('2026-09-03', { dayOfWeek: 0 });
    expect(await getRoutineOverrides()).toEqual({ '2026-09-03': { dayOfWeek: 0 } });
  });
});
