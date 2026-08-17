/**
 * @jest-environment node
 *
 * The /api/exercise/sync-calendar route over the real in-memory store. The
 * Google layer is stubbed — the pull reads an empty calendar and the push
 * records a fake event id — so the routine MATERIALISATION is exercised end to
 * end against real storage. The route should seed planned routine sessions for
 * the days ahead and, run again, add none (idempotent).
 */
// A stateful in-memory stand-in for the Google calendar, so nothing leaves the
// process and — crucially — an event the push creates is READ BACK by the next
// pull (an empty stub would let the pull retire the just-pushed sessions and hide
// the idempotency the route actually has).
jest.mock('@/lib/google-calendar', () => {
  const { randomUUID } = require('crypto');
  const { format } = require('date-fns');
  const events = new Map<string, { id: string; summary: string; startDate: string }>();
  return {
    __events: events,
    ensureValidCredentials: jest.fn().mockResolvedValue({}),
    listEventsInRange: jest.fn(async () => Array.from(events.values())),
    createCalendarEvent: jest.fn(async (_c, _i, _s, title: string, start: Date) => {
      const id = `evt-${randomUUID()}`;
      events.set(id, { id, summary: title, startDate: format(start, 'yyyy-MM-dd') });
      return { id };
    }),
    updateCalendarEvent: jest.fn(async (_c, _i, _s, eventId: string, start: Date, _e: Date, title?: string) => {
      const existing = events.get(eventId);
      if (existing) {
        events.set(eventId, {
          id: eventId,
          summary: title ?? existing.summary,
          startDate: format(start, 'yyyy-MM-dd'),
        });
      }
      return {};
    }),
    deleteCalendarEvent: jest.fn(async (_c, _i, _s, eventId: string) => {
      events.delete(eventId);
    }),
  };
});

import { POST } from '@/app/api/exercise/sync-calendar/route';

const mockCalendar = jest.requireMock('@/lib/google-calendar') as { __events: Map<string, unknown> };
import { __resetDbForTests } from '@/lib/storage/db';
import { getAllSessions } from '@/lib/storage/exercise';
import { getExerciseLastSyncedAt, setExerciseLastSyncedAt } from '@/lib/storage/exercise-sync';
import { format, subHours } from 'date-fns';
import { NextRequest } from 'next/server';

function postRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/exercise/sync-calendar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/exercise/sync-calendar', () => {
  beforeEach(() => {
    __resetDbForTests();
    mockCalendar.__events.clear();
  });

  it('materialises routine sessions for the days ahead and reports the counts', async () => {
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.materialise.created).toBeGreaterThan(0);
    expect(body.created).toBe(body.materialise.created); // pull created nothing without Google

    const today = format(new Date(), 'yyyy-MM-dd');
    const sessions = await getAllSessions();
    const routineSessions = sessions.filter(s => s.source === 'routine');
    expect(routineSessions.length).toBe(body.materialise.created);
    for (const s of routineSessions) {
      expect(s.planned).toBe(true);
      expect(s.completed).toBe(false);
      expect(s.date >= today).toBe(true);
    }
  });

  it('is idempotent: a second sync creates no further routine sessions', async () => {
    await POST(postRequest());
    const afterFirst = (await getAllSessions()).filter(s => s.source === 'routine').length;

    const res = await POST(postRequest());
    const body = await res.json();
    expect(body.materialise.created).toBe(0);

    const afterSecond = (await getAllSessions()).filter(s => s.source === 'routine').length;
    expect(afterSecond).toBe(afterFirst);
  });

  describe('throttle', () => {
    it('stamps the last-synced time on any run', async () => {
      expect(await getExerciseLastSyncedAt()).toBeNull();
      await POST(postRequest());
      expect(await getExerciseLastSyncedAt()).not.toBeNull();
    });

    it('auto sync skips when a sync ran within the last 6 hours', async () => {
      // A recent sync of any kind stamps the timestamp.
      await POST(postRequest());
      const stamped = await getExerciseLastSyncedAt();

      const res = await POST(postRequest({ auto: true }));
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.lastSyncedAt).toBe(stamped);
      // Skipped: it did no work, so the routine wasn't touched again.
      expect(body.materialise).toBeUndefined();
      // And the timestamp is unchanged.
      expect(await getExerciseLastSyncedAt()).toBe(stamped);
    });

    it('auto sync runs when the last sync was more than 6 hours ago', async () => {
      await setExerciseLastSyncedAt(subHours(new Date(), 7).toISOString());

      const res = await POST(postRequest({ auto: true }));
      const body = await res.json();
      expect(body.skipped).toBeUndefined();
      expect(body.materialise.created).toBeGreaterThan(0);
    });

    it('a manual sync always runs, even within the throttle window', async () => {
      await setExerciseLastSyncedAt(new Date().toISOString());

      const res = await POST(postRequest());
      const body = await res.json();
      expect(body.skipped).toBeUndefined();
      expect(body.materialise.created).toBeGreaterThan(0);
    });
  });
});
