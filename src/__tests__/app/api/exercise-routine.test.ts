/**
 * @jest-environment node
 *
 * The /api/exercise/routine route over the real in-memory store: GET seeds and
 * returns the seven-day routine, PUT replaces it and returns the saved days, and
 * a malformed body is rejected with 400.
 */
import { GET, PUT } from '@/app/api/exercise/routine/route';
import { __resetDbForTests } from '@/lib/storage/db';
import { NextRequest } from 'next/server';

function putRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/exercise/routine', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/exercise/routine', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('GET seeds and returns the seven-day routine Mon→Sun', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routine).toHaveLength(7);
    expect(body.routine.map((d: { dayOfWeek: number }) => d.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it('PUT replaces the routine and GET reads it back', async () => {
    const putRes = await PUT(
      putRequest({ routine: [{ dayOfWeek: 1, title: 'Legs', anchors: ['Squat'] }] })
    );
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.routine).toHaveLength(1);
    expect(putBody.routine[0].anchors).toEqual(['Squat']);

    const getBody = await (await GET()).json();
    expect(getBody.routine).toHaveLength(1);
    expect(getBody.routine[0].title).toBe('Legs');
  });

  it('PUT rejects a body without a routine array', async () => {
    const res = await PUT(putRequest({ nope: true }));
    expect(res.status).toBe(400);
  });

  it('PUT rejects a duplicated weekday', async () => {
    const res = await PUT(
      putRequest({
        routine: [
          { dayOfWeek: 1, title: 'Push', anchors: [] },
          { dayOfWeek: 1, title: 'Pull', anchors: [] },
        ],
      })
    );
    expect(res.status).toBe(400);
  });
});
