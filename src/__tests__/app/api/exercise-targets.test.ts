/**
 * @jest-environment node
 *
 * GET /api/exercise/targets serves the resolved session targets and, on a cache
 * miss (source 'fallback') with history to program from, kicks off a background
 * Claude generation. A rest day (source 'rest') and an already-cached programme
 * (source 'ai') must return as-is and never trigger generation.
 */
import type { ProgrammerInput } from '@/lib/exercise-programmer';
import type { ResolvedSessionTargets } from '@/lib/exercise-session-targets';

jest.mock('@/lib/storage/exercise', () => ({
  getAllSessions: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/lib/exercise-session-targets', () => ({
  resolveSessionTargets: jest.fn(),
}));

jest.mock('@/lib/exercise-prewarm', () => ({
  kickOffGeneration: jest.fn(),
}));

import { GET } from '@/app/api/exercise/targets/route';
import { resolveSessionTargets } from '@/lib/exercise-session-targets';
import { kickOffGeneration } from '@/lib/exercise-prewarm';
import { NextRequest } from 'next/server';

const mockResolve = resolveSessionTargets as jest.Mock;
const mockKick = kickOffGeneration as jest.Mock;

// A programmer input carrying `n` exercises — only its length matters to the route.
function input(n: number): ProgrammerInput {
  return { exercises: Array.from({ length: n }, (_, i) => ({ name: `e${i}` })) } as unknown as ProgrammerInput;
}

function resolved(over: Partial<ResolvedSessionTargets>): ResolvedSessionTargets {
  return {
    plan: undefined,
    components: [],
    targets: [],
    source: 'fallback',
    input: input(0),
    hash: 'h',
    ...over,
  } as ResolvedSessionTargets;
}

async function get(date = '2026-09-02') {
  const req = new NextRequest(`http://localhost/api/exercise/targets?date=${date}`);
  const res = await GET(req);
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/exercise/targets', () => {
  it('returns an empty rest result and does NOT kick off generation', async () => {
    mockResolve.mockResolvedValue(resolved({ source: 'rest', targets: [], input: input(0) }));

    const { status, json } = await get();

    expect(status).toBe(200);
    expect(json.source).toBe('rest');
    expect(json.targets).toEqual([]);
    expect(json.generating).toBe(false);
    expect(mockKick).not.toHaveBeenCalled();
  });

  it('returns the cached AI programme without kicking off generation', async () => {
    mockResolve.mockResolvedValue(resolved({ source: 'ai', input: input(5) }));

    const { json } = await get();

    expect(json.source).toBe('ai');
    expect(json.generating).toBe(false);
    expect(mockKick).not.toHaveBeenCalled();
  });

  it('kicks off generation on a fallback with exercises to program from', async () => {
    mockResolve.mockResolvedValue(resolved({ source: 'fallback', input: input(3), hash: 'h1' }));

    const { json } = await get();

    expect(json.source).toBe('fallback');
    expect(json.generating).toBe(true);
    expect(mockKick).toHaveBeenCalledWith('2026-09-02', 'h1', expect.anything());
  });

  it('does not generate on a fallback with an empty vocabulary', async () => {
    mockResolve.mockResolvedValue(resolved({ source: 'fallback', input: input(0) }));

    const { json } = await get();

    expect(json.source).toBe('fallback');
    expect(json.generating).toBe(false);
    expect(mockKick).not.toHaveBeenCalled();
  });
});
