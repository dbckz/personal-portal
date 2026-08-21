/**
 * @jest-environment node
 *
 * POST /api/exercise/venue swaps a day's planned session to a home workout (or
 * back to the gym): it sets/clears `venue` on the plan, creates a plan from the
 * routine day when none exists, and kicks off a fresh programme generation (the
 * venue moves the hash) so the Today tab upgrades quickly. Storage, the routine
 * and the programme cache are mocked; generateProgramme is spied so the kick can
 * be asserted without spawning Claude.
 */
import type { ExerciseSession, WeeklyRoutineDay } from '@/types/life';

jest.mock('@/lib/storage/exercise', () => ({
  getAllSessions: jest.fn(),
  createSession: jest.fn(),
  setSessionVenue: jest.fn(),
  pruneUntouchedSeededEntries: jest.fn().mockResolvedValue({ removed: 0 }),
}));

jest.mock('@/lib/storage/weekly-routine', () => ({
  getWeeklyRoutine: jest.fn(),
}));

jest.mock('@/lib/storage/exercise-programmes', () => ({
  getCachedProgramme: jest.fn().mockReturnValue(null),
  saveCachedProgramme: jest.fn(),
}));

jest.mock('@/lib/storage/goals', () => ({
  queryGoals: jest.fn().mockResolvedValue([]),
}));

const mockGenerate = jest.fn().mockResolvedValue(null);
jest.mock('@/lib/exercise-programmer', () => ({
  ...jest.requireActual('@/lib/exercise-programmer'),
  generateProgramme: (...args: unknown[]) => mockGenerate(...args),
}));

import { POST } from '@/app/api/exercise/venue/route';
import {
  getAllSessions,
  createSession,
  setSessionVenue,
  pruneUntouchedSeededEntries,
} from '@/lib/storage/exercise';
import { getWeeklyRoutine } from '@/lib/storage/weekly-routine';
import { NextRequest } from 'next/server';

const mockGetAll = getAllSessions as jest.Mock;
const mockCreate = createSession as jest.Mock;
const mockSetVenue = setSessionVenue as jest.Mock;
const mockPrune = pruneUntouchedSeededEntries as jest.Mock;
const mockRoutine = getWeeklyRoutine as jest.Mock;

// 21 Aug 2026 is a Friday (getDay() === 5): a Push (shoulders) day whose anchor
// is a gym-only DB press, so a home session has to substitute for it.
function routine(): WeeklyRoutineDay[] {
  return [
    {
      dayOfWeek: 5,
      title: 'Push (shoulders)',
      anchors: ['Seated DB shoulder press'],
      staples: ['Band lateral raise'],
    },
  ];
}

function plan(venue?: 'home'): ExerciseSession {
  return {
    id: 'plan1',
    date: '2026-08-21',
    type: 'strength',
    label: 'Push (shoulders)',
    components: ['Push (shoulders)'],
    planned: true,
    completed: false,
    source: 'manual',
    ...(venue ? { venue } : {}),
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

async function post(body: Record<string, unknown>) {
  const req = new NextRequest('http://localhost/api/exercise/venue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRoutine.mockResolvedValue(routine());
  mockCreate.mockImplementation(async (s: Record<string, unknown>) => ({ id: 'new1', ...s }));
  mockSetVenue.mockImplementation(async (id: string, venue: 'home' | undefined) => ({
    ...plan(),
    id,
    ...(venue ? { venue } : {}),
  }));
});

describe('POST /api/exercise/venue', () => {
  it('sets home on an existing plan and kicks off generation', async () => {
    // The plan already reads home after the (mocked) mutation, so the resolve
    // step programmes a home session.
    mockGetAll.mockResolvedValue([plan('home')]);

    const { status, json } = await post({ date: '2026-08-21', venue: 'home' });

    expect(status).toBe(200);
    expect(mockSetVenue).toHaveBeenCalledWith('plan1', 'home');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(json.venue).toBe('home');
    expect(json.session.venue).toBe('home');
    // A home programme generation was kicked (the anchor stub alone makes the
    // vocabulary non-empty).
    expect(mockGenerate).toHaveBeenCalled();
    // Stale seeded rows from the old programme are pruned for the date.
    expect(mockPrune).toHaveBeenCalledWith('2026-08-21');
  });

  it('prunes stale seeded rows when swapping back to the gym too', async () => {
    mockGetAll.mockResolvedValue([plan('home')]);
    await post({ date: '2026-08-21', venue: 'gym' });
    expect(mockPrune).toHaveBeenCalledWith('2026-08-21');
  });

  it('clears the venue when swapping back to the gym', async () => {
    mockGetAll.mockResolvedValue([plan()]);

    const { json } = await post({ date: '2026-08-21', venue: 'gym' });

    expect(mockSetVenue).toHaveBeenCalledWith('plan1', undefined);
    expect(json.venue).toBe('gym');
  });

  it('creates a plan from the routine day when none exists', async () => {
    mockGetAll.mockResolvedValue([]); // no plan for the date

    const { status } = await post({ date: '2026-08-21', venue: 'home' });

    expect(status).toBe(200);
    expect(mockSetVenue).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const created = mockCreate.mock.calls[0][0];
    expect(created.venue).toBe('home');
    expect(created.planned).toBe(true);
    expect(created.label).toBe('Push (shoulders)');
    expect(created.components).toEqual(['Push (shoulders)']);
  });

  it('rejects an invalid venue', async () => {
    mockGetAll.mockResolvedValue([plan()]);
    const { status, json } = await post({ date: '2026-08-21', venue: 'garage' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/venue/);
    expect(mockSetVenue).not.toHaveBeenCalled();
  });
});
