/**
 * @jest-environment node
 *
 * The /api/exercise/routine route over the real in-memory store: GET seeds and
 * returns the seven-day routine, PUT replaces it and returns the saved days, and
 * a malformed body is rejected with 400.
 */
import { GET, PUT } from '@/app/api/exercise/routine/route';
import { POST as ACTIVATE } from '@/app/api/exercise/routine/activate/route';
import { DELETE as LIB_DELETE, POST as LIB_POST } from '@/app/api/exercise/routine/library/route';
import { __resetDbForTests } from '@/lib/storage/db';
import { NextRequest } from 'next/server';

function putRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/exercise/routine', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(name?: string): NextRequest {
  const query = name ? `?name=${encodeURIComponent(name)}` : '';
  return new NextRequest(`http://localhost/api/exercise/routine${query}`);
}

function jsonRequest(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// materialiseRoutineSessions touches Google Calendar; the activate route already
// swallows its failures, but stub it so the test never reaches out.
jest.mock('@/lib/exercise-calendar', () => ({
  materialiseRoutineSessions: jest.fn().mockResolvedValue({ created: 0, updated: 0, removed: 0 }),
}));

describe('/api/exercise/routine', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('GET seeds and returns the seven-day routine Mon→Sun, with library metadata', async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routine).toHaveLength(7);
    expect(body.routine.map((d: { dayOfWeek: number }) => d.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    // On first read the library is bootstrapped with the migrated split, active.
    expect(body.names).toEqual(['Split (6-day)']);
    expect(body.active).toBe('Split (6-day)');
  });

  it('PUT replaces the active routine and GET reads it back', async () => {
    const putRes = await PUT(
      putRequest({ routine: [{ dayOfWeek: 1, title: 'Legs', anchors: ['Squat'] }] })
    );
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.routine).toHaveLength(1);
    expect(putBody.routine[0].anchors).toEqual(['Squat']);

    const getBody = await (await GET(getRequest())).json();
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

  it('creates a routine, activates it, and edits a non-active one by name', async () => {
    await GET(getRequest()); // bootstrap the library

    // Duplicate the active split into a second routine.
    const created = await LIB_POST(
      jsonRequest('http://localhost/api/exercise/routine/library', 'POST', {
        name: 'Full body (3-day)',
        copyFrom: 'Split (6-day)',
      })
    );
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.names).toContain('Full body (3-day)');
    // Creating does not activate.
    expect(createdBody.active).toBe('Split (6-day)');

    // The non-active routine can be viewed and edited without activating it.
    const viewed = await (await GET(getRequest('Full body (3-day)'))).json();
    expect(viewed.active).toBe('Split (6-day)');
    const putRes = await PUT(
      putRequest({ name: 'Full body (3-day)', routine: [{ dayOfWeek: 1, title: 'Full body A', anchors: [] }] })
    );
    expect(putRes.status).toBe(200);
    // The active routine is untouched by the named edit.
    expect((await putRes.json()).active).toBe('Split (6-day)');

    // Activate it.
    const activated = await ACTIVATE(
      jsonRequest('http://localhost/api/exercise/routine/activate', 'POST', {
        name: 'Full body (3-day)',
      })
    );
    expect(activated.status).toBe(200);
    expect((await activated.json()).active).toBe('Full body (3-day)');
  });

  it('activate refuses an unknown routine name', async () => {
    await GET(getRequest());
    const res = await ACTIVATE(
      jsonRequest('http://localhost/api/exercise/routine/activate', 'POST', { name: 'Nope' })
    );
    expect(res.status).toBe(400);
  });

  it('delete refuses the active routine and unknown names', async () => {
    await GET(getRequest());
    const activeDelete = await LIB_DELETE(
      new NextRequest('http://localhost/api/exercise/routine/library?name=Split%20(6-day)', {
        method: 'DELETE',
      })
    );
    expect(activeDelete.status).toBe(400);

    const unknownDelete = await LIB_DELETE(
      new NextRequest('http://localhost/api/exercise/routine/library?name=Nope', { method: 'DELETE' })
    );
    expect(unknownDelete.status).toBe(400);
  });
});
