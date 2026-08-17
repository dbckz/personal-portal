/**
 * @jest-environment jsdom
 *
 * The replan "plan view" payload assembly for the couldn't-fit section's
 * "Delete task" (drop) mode: choosing 'drop' on an unplaceable row must route it
 * into the confirm payload's `drop` array (and out of `defer` / `leaveUnscheduled`).
 */
import { renderHook, act } from '@testing-library/react';

import { useReplanActions } from '@/components/dashboard/useReplanActions';
import { api, type ReplanAnalyzeResponse } from '@/lib/api';

jest.mock('@/lib/api', () => ({
  api: { confirmReplan: jest.fn() },
}));

const confirmReplan = api.confirmReplan as jest.Mock;

// A minimal mid-week analyze result with a single unplaceable, task-backed block.
const DATA: ReplanAnalyzeResponse = {
  weekStart: '2026-07-20',
  weekEnd: '2026-07-26',
  kept: [],
  moves: [],
  stale: [],
  additions: [],
  deletions: [],
  unplaceable: [
    {
      googleEventId: 'evt-x',
      googleIntegrationId: 'gi1',
      category: 'Writing',
      titles: ['Draft the brief'],
      oldDate: '2026-07-20',
      oldStart: '09:00',
      durationMinutes: 60,
      reason: 'missed',
      deferTaskIds: ['g1'],
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  confirmReplan.mockResolvedValue({
    results: [],
    doneResults: [],
    deferResults: [],
    carryResults: [],
    displaceResults: [],
    dropResults: [{ googleEventId: 'evt-x', success: true }],
    additionResults: [],
  });
});

describe('useReplanActions — drop payload assembly', () => {
  it("routes a 'drop' unplaceable row into the confirm payload's drop array", async () => {
    const { result } = renderHook(() => useReplanActions(DATA));

    // Default is 'defer'; switch the row to 'drop'.
    act(() => {
      result.current.setUnplaceableMode(prev => ({ ...prev, 'evt-x': 'drop' }));
    });

    await act(async () => {
      await result.current.confirm();
    });

    expect(confirmReplan).toHaveBeenCalledTimes(1);
    const args = confirmReplan.mock.calls[0];
    // Trailing `drop` argument (16th positional) carries the block + its task ids.
    expect(args[15]).toEqual([
      { googleEventId: 'evt-x', googleIntegrationId: 'gi1', taskIds: ['g1'] },
    ]);
    // …and it did NOT fall through to defer (8th) or leaveUnscheduled (9th).
    expect(args[7]).toEqual([]);
    expect(args[8]).toEqual([]);
  });

  it("leaves the drop argument undefined when no row is set to 'drop'", async () => {
    const { result } = renderHook(() => useReplanActions(DATA));

    // Row stays on its 'defer' default.
    await act(async () => {
      await result.current.confirm();
    });

    const args = confirmReplan.mock.calls[0];
    expect(args[15]).toBeUndefined();
    // The block instead flows through defer.
    expect(args[7]).toEqual([{ taskIds: ['g1'], googleEventId: 'evt-x' }]);
  });
});

// Free space remaining: nothing is scheduled until the user ticks a todo. Ticked
// todos fill the free slots (earliest first) and ride the backfill confirm path.
const FREE_SPACE_DATA: ReplanAnalyzeResponse = {
  weekStart: '2026-07-20',
  weekEnd: '2026-07-26',
  kept: [],
  moves: [],
  stale: [],
  additions: [],
  deletions: [],
  unplaceable: [],
  backfill: [],
  freeSlots: [
    { date: '2026-07-22', start: '09:00', durationMinutes: 30 },
    { date: '2026-07-22', start: '09:30', durationMinutes: 30 },
  ],
  todoCandidates: [
    { gid: 'todo1', title: 'Reply to X', category: 'General Todos' },
    { gid: 'todo2', title: 'File the form', category: 'General Todos' },
  ],
};

describe('useReplanActions — free-space todo selection', () => {
  it('schedules nothing until a todo is ticked', () => {
    const { result } = renderHook(() => useReplanActions(FREE_SPACE_DATA));
    expect(result.current.actionCount).toBe(0);
  });

  it('assigns a ticked todo to the earliest free slot via the backfill payload', async () => {
    const { result } = renderHook(() => useReplanActions(FREE_SPACE_DATA));

    act(() => {
      result.current.toggleTodo('todo1');
    });
    expect(result.current.actionCount).toBe(1);

    await act(async () => {
      await result.current.confirm();
    });

    // Backfill is the last positional argument (17th, index 16).
    const args = confirmReplan.mock.calls[0];
    expect(args[16]).toEqual([
      {
        id: 'todo-2026-07-22-09:00-todo1',
        category: 'General Todos',
        task: { gid: 'todo1', adhocId: undefined, title: 'Reply to X', integrationId: undefined },
        date: '2026-07-22',
        start: '09:00',
        durationMinutes: 30,
        reason: 'General Todos block — selected to fill free space.',
      },
    ]);
  });
});
