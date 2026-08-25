/**
 * Tests for the pure reconcile decision — which stored records point at a
 * calendar event that has been deleted and should therefore be purged.
 */
import {
  selectStaleRecords,
  selectMovedRecords,
  type ReconcileRecord,
  type ReconcileMoveRecord,
  type LivePlacement,
} from '@/lib/scheduling/reconcile';

const WEEK_START = '2026-07-13';
const WEEK_END = '2026-07-19';

function record(o: Partial<ReconcileRecord> & { id: string }): ReconcileRecord {
  return {
    kind: 'asana',
    googleEventId: `evt-${o.id}`,
    googleIntegrationId: 'g1',
    date: '2026-07-15',
    ...o,
  };
}

function run(o: {
  records: ReconcileRecord[];
  present?: string[];
  fetched?: string[];
}) {
  return selectStaleRecords({
    records: o.records,
    presentEventIds: new Set(o.present ?? []),
    fetchedIntegrationIds: new Set(o.fetched ?? ['g1']),
    weekStartStr: WEEK_START,
    weekEndStr: WEEK_END,
  });
}

describe('selectStaleRecords', () => {
  it('purges a record whose event is gone from a fully-fetched integration', () => {
    const rec = record({ id: 'a' }); // evt-a, on g1, in-week
    const stale = run({ records: [rec], present: [], fetched: ['g1'] });
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe('a');
  });

  it('keeps a record whose event is still present on the calendar', () => {
    const rec = record({ id: 'b' });
    const stale = run({ records: [rec], present: ['evt-b'], fetched: ['g1'] });
    expect(stale).toHaveLength(0);
  });

  it('skips a record on an integration whose fetch did not succeed', () => {
    // Event absent, but its integration (g2) is not in the fetched set — a
    // failed/partial fetch must never be read as "deleted".
    const rec = record({ id: 'c', googleIntegrationId: 'g2' });
    const stale = run({ records: [rec], present: [], fetched: ['g1'] });
    expect(stale).toHaveLength(0);
  });

  it('skips a record with no integration id (cannot verify)', () => {
    const rec = record({ id: 'd', googleIntegrationId: undefined });
    const stale = run({ records: [rec], present: [], fetched: ['g1'] });
    expect(stale).toHaveLength(0);
  });

  it('skips a record whose date falls outside the fetched week', () => {
    const rec = record({ id: 'e', date: '2026-07-06' }); // last week
    const stale = run({ records: [rec], present: [], fetched: ['g1'] });
    expect(stale).toHaveLength(0);
  });

  it('skips a record with no googleEventId', () => {
    const rec = record({ id: 'f', googleEventId: '' });
    const stale = run({ records: [rec], present: [], fetched: ['g1'] });
    expect(stale).toHaveLength(0);
  });

  it('purges across kinds and only the deleted ones', () => {
    const records = [
      record({ id: 'asana-gone', kind: 'asana' }),
      record({ id: 'adhoc-gone', kind: 'adhoc' }),
      record({ id: 'prep-gone', kind: 'prep' }),
      record({ id: 'present', googleEventId: 'evt-present' }),
    ];
    const stale = run({ records, present: ['evt-present'], fetched: ['g1'] });
    expect(stale.map(r => r.id).sort()).toEqual(['adhoc-gone', 'asana-gone', 'prep-gone']);
  });
});

function moveRecord(
  o: Partial<ReconcileMoveRecord> & { id: string }
): ReconcileMoveRecord {
  return {
    kind: 'asana',
    googleEventId: `evt-${o.id}`,
    googleIntegrationId: 'g1',
    date: '2026-07-15',
    time: '09:00',
    durationMinutes: 60,
    ...o,
  };
}

function placement(o: Partial<LivePlacement> = {}): LivePlacement {
  return { date: '2026-07-15', time: '09:00', durationMinutes: 60, allDay: false, ...o };
}

function runMove(o: {
  records: ReconcileMoveRecord[];
  live?: Record<string, LivePlacement>;
  fetched?: string[];
}) {
  return selectMovedRecords({
    records: o.records,
    livePlacements: new Map(Object.entries(o.live ?? {})),
    fetchedIntegrationIds: new Set(o.fetched ?? ['g1']),
    weekStartStr: WEEK_START,
    weekEndStr: WEEK_END,
  });
}

describe('selectMovedRecords', () => {
  it('flags a block moved within the same day (time changed)', () => {
    const rec = moveRecord({ id: 'a' });
    const moved = runMove({ records: [rec], live: { 'evt-a': placement({ time: '14:00' }) } });
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ date: '2026-07-15', time: '14:00', durationMinutes: 60 });
    expect(moved[0].record.id).toBe('a');
  });

  it('flags a block dragged across days', () => {
    const rec = moveRecord({ id: 'b' });
    const moved = runMove({ records: [rec], live: { 'evt-b': placement({ date: '2026-07-17' }) } });
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ date: '2026-07-17', time: '09:00', durationMinutes: 60 });
  });

  it('flags a resized block (duration changed)', () => {
    const rec = moveRecord({ id: 'c' });
    const moved = runMove({ records: [rec], live: { 'evt-c': placement({ durationMinutes: 90 }) } });
    expect(moved).toHaveLength(1);
    expect(moved[0].durationMinutes).toBe(90);
  });

  it('leaves an unchanged block untouched', () => {
    const rec = moveRecord({ id: 'd' });
    const moved = runMove({ records: [rec], live: { 'evt-d': placement() } });
    expect(moved).toHaveLength(0);
  });

  it('ignores a record whose event is missing (deletion reconciler owns that)', () => {
    const rec = moveRecord({ id: 'e' });
    const moved = runMove({ records: [rec], live: {} });
    expect(moved).toHaveLength(0);
  });

  it('skips an event that turned all-day', () => {
    const rec = moveRecord({ id: 'f' });
    const moved = runMove({
      records: [rec],
      live: { 'evt-f': placement({ date: '2026-07-16', time: '00:00', allDay: true }) },
    });
    expect(moved).toHaveLength(0);
  });

  it('skips a record on an integration whose fetch did not succeed', () => {
    const rec = moveRecord({ id: 'g', googleIntegrationId: 'g2' });
    const moved = runMove({ records: [rec], live: { 'evt-g': placement({ time: '11:00' }) }, fetched: ['g1'] });
    expect(moved).toHaveLength(0);
  });

  it('skips a record whose stored date falls outside the fetched week', () => {
    const rec = moveRecord({ id: 'h', date: '2026-07-06' });
    const moved = runMove({ records: [rec], live: { 'evt-h': placement({ time: '11:00' }) } });
    expect(moved).toHaveLength(0);
  });

  it('flags moves across kinds and only the changed ones', () => {
    const records = [
      moveRecord({ id: 'asana-moved', kind: 'asana' }),
      moveRecord({ id: 'adhoc-moved', kind: 'adhoc' }),
      moveRecord({ id: 'prep-moved', kind: 'prep' }),
      moveRecord({ id: 'ritual-still', kind: 'ritual' }),
    ];
    const moved = runMove({
      records,
      live: {
        'evt-asana-moved': placement({ time: '10:00' }),
        'evt-adhoc-moved': placement({ date: '2026-07-18' }),
        'evt-prep-moved': placement({ durationMinutes: 30 }),
        'evt-ritual-still': placement(),
      },
    });
    expect(moved.map(m => m.record.id).sort()).toEqual(['adhoc-moved', 'asana-moved', 'prep-moved']);
  });
});
