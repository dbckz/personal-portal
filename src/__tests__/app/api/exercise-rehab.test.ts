/**
 * @jest-environment node
 *
 * The /api/exercise/rehab route over the real in-memory store: GET seeds and
 * returns the six-exercise block, PUT replaces the exercise list, PATCH
 * ticks/unticks a day, and malformed bodies are rejected with 400.
 */
import { GET, PUT, PATCH } from '@/app/api/exercise/rehab/route';
import { __resetDbForTests } from '@/lib/storage/db';
import { NextRequest } from 'next/server';

function req(method: 'PUT' | 'PATCH', body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/exercise/rehab', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/exercise/rehab', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('GET seeds and returns the six-exercise block', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routine.exercises).toHaveLength(6);
    expect(body.routine.exercises[0].id).toBe('couch-stretch');
    expect(body.routine.ticks).toEqual({});
  });

  it('PUT replaces the exercise list and mints ids for new ones', async () => {
    const putRes = await PUT(
      req('PUT', { exercises: [{ name: 'Hip flexor stretch', prescription: '60 s' }] })
    );
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.routine.exercises).toHaveLength(1);
    expect(putBody.routine.exercises[0].id).toBe('hip-flexor-stretch');

    const getBody = await (await GET()).json();
    expect(getBody.routine.exercises).toHaveLength(1);
    expect(getBody.routine.exercises[0].name).toBe('Hip flexor stretch');
  });

  it('PATCH ticks and unticks an exercise for a day', async () => {
    await GET(); // seed

    const tickBody = await (
      await PATCH(req('PATCH', { date: '2026-08-26', exerciseId: 'glute-bridge', done: true }))
    ).json();
    expect(tickBody.routine.ticks['2026-08-26']).toEqual(['glute-bridge']);

    const untickBody = await (
      await PATCH(req('PATCH', { date: '2026-08-26', exerciseId: 'glute-bridge', done: false }))
    ).json();
    expect(untickBody.routine.ticks['2026-08-26']).toBeUndefined();
  });

  it('PATCH is idempotent when ticking the same id twice', async () => {
    await GET();
    await PATCH(req('PATCH', { date: '2026-08-26', exerciseId: 'dead-bug', done: true }));
    const body = await (
      await PATCH(req('PATCH', { date: '2026-08-26', exerciseId: 'dead-bug', done: true }))
    ).json();
    expect(body.routine.ticks['2026-08-26']).toEqual(['dead-bug']);
  });

  it('PUT preserves ticks for ids that survive the edit', async () => {
    await GET();
    await PATCH(req('PATCH', { date: '2026-08-26', exerciseId: 'couch-stretch', done: true }));

    const putBody = await (
      await PUT(
        req('PUT', {
          exercises: [
            { id: 'couch-stretch', name: 'Couch stretch', prescription: '90 s per side' },
            { name: 'New move', prescription: '10 reps' },
          ],
        })
      )
    ).json();
    expect(putBody.routine.ticks['2026-08-26']).toEqual(['couch-stretch']);
  });

  it('PUT rejects a body without an exercises array', async () => {
    const res = await PUT(req('PUT', { nope: true }));
    expect(res.status).toBe(400);
  });

  it('PATCH rejects a malformed date', async () => {
    await GET();
    const res = await PATCH(req('PATCH', { date: '26-08-2026', exerciseId: 'dead-bug', done: true }));
    expect(res.status).toBe(400);
  });

  it('PATCH rejects an unknown exercise id', async () => {
    await GET();
    const res = await PATCH(req('PATCH', { date: '2026-08-26', exerciseId: 'nope', done: true }));
    expect(res.status).toBe(400);
  });
});
