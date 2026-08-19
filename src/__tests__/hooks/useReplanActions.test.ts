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
      tasks: [{ gid: 'g1', integrationId: 'gi1' }],
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

describe('useReplanActions — mark-done payload assembly', () => {
  it("routes a 'done' unplaceable row into doneIds + completeAsana", async () => {
    const { result } = renderHook(() => useReplanActions(DATA));

    act(() => {
      result.current.setUnplaceableMode(prev => ({ ...prev, 'evt-x': 'done' }));
    });

    await act(async () => {
      await result.current.confirm();
    });

    const args = confirmReplan.mock.calls[0];
    // doneIds (2nd positional, index 1) carries the block's event id…
    expect(args[1]).toEqual(['evt-x']);
    // …completeAsana (7th, index 6) carries its Asana-backed task.
    expect(args[6]).toEqual([{ gid: 'g1', integrationId: 'gi1' }]);
    // It did not fall through to defer (index 7) or drop (index 15).
    expect(args[7]).toEqual([]);
    expect(args[15]).toBeUndefined();
  });
});

// A make-room analyze result: one couldn't-fit block plus a longer victim block
// elsewhere in the week to displace into.
const MAKE_ROOM_DATA: ReplanAnalyzeResponse = {
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
      tasks: [{ gid: 'g1', integrationId: 'gi1' }],
    },
    {
      googleEventId: 'evt-y',
      googleIntegrationId: 'gi1',
      category: 'Writing',
      titles: ['Second brief'],
      oldDate: '2026-07-20',
      oldStart: '10:00',
      durationMinutes: 60,
      reason: 'missed',
      deferTaskIds: ['g2'],
      tasks: [{ gid: 'g2', integrationId: 'gi1' }],
    },
  ],
  moveCandidates: [
    {
      googleEventId: 'vic1',
      googleIntegrationId: 'gi2',
      category: 'Deep',
      titles: ['Victim block'],
      date: '2026-07-22',
      start: '14:00',
      durationMinutes: 90,
      startMs: new Date('2026-07-22T14:00:00').getTime(),
      taskIds: ['gv1'],
    },
  ],
};

describe('useReplanActions — make-room payload assembly', () => {
  it('pairs a displace (victim) with a move (item into the freed slot)', async () => {
    const { result } = renderHook(() => useReplanActions(MAKE_ROOM_DATA));

    act(() => {
      result.current.setUnplaceableMode(prev => ({ ...prev, 'evt-x': 'makeRoom' }));
      result.current.setMakeRoomVictim(prev => ({ ...prev, 'evt-x': 'vic1' }));
    });

    await act(async () => {
      await result.current.confirm();
    });

    const args = confirmReplan.mock.calls[0];
    // displace (11th positional, index 10): the victim, its tasks deferred.
    expect(args[10]).toEqual([
      {
        googleEventId: 'vic1',
        googleIntegrationId: 'gi2',
        taskIds: ['gv1'],
        mode: 'defer',
        durationMinutes: 90,
        priorityDurationMinutes: 60,
      },
    ]);
    // moves (1st positional, index 0): the item takes the victim's slot.
    expect(args[0]).toEqual([
      {
        googleEventId: 'evt-x',
        googleIntegrationId: 'gi1',
        date: '2026-07-22',
        start: '14:00',
        durationMinutes: 60,
      },
    ]);
  });

  it('honours the leave-unscheduled disposition on the displaced victim', async () => {
    const { result } = renderHook(() => useReplanActions(MAKE_ROOM_DATA));

    act(() => {
      result.current.setUnplaceableMode(prev => ({ ...prev, 'evt-x': 'makeRoom' }));
      result.current.setMakeRoomVictim(prev => ({ ...prev, 'evt-x': 'vic1' }));
      result.current.setMakeRoomDisposition(prev => ({ ...prev, 'evt-x': 'leave' }));
    });

    await act(async () => {
      await result.current.confirm();
    });

    expect(confirmReplan.mock.calls[0][10][0].mode).toBe('leave');
  });

  it('claims a victim only once when two items pick the same block', async () => {
    const { result } = renderHook(() => useReplanActions(MAKE_ROOM_DATA));

    act(() => {
      result.current.setUnplaceableMode(prev => ({ ...prev, 'evt-x': 'makeRoom', 'evt-y': 'makeRoom' }));
      result.current.setMakeRoomVictim(prev => ({ ...prev, 'evt-x': 'vic1', 'evt-y': 'vic1' }));
    });

    await act(async () => {
      await result.current.confirm();
    });

    const args = confirmReplan.mock.calls[0];
    // Only the first item (evt-x) gets the victim; the second is a no-op.
    expect(args[10]).toHaveLength(1);
    expect(args[0]).toHaveLength(1);
    expect(args[0][0].googleEventId).toBe('evt-x');
  });
});

describe('useReplanActions — done-waiting (portal-done) payload assembly', () => {
  it("routes a 'doneWaiting' unplaceable row into the portalDone array with its block id", async () => {
    const { result } = renderHook(() => useReplanActions(DATA));

    act(() => {
      result.current.setUnplaceableMode(prev => ({ ...prev, 'evt-x': 'doneWaiting' }));
    });

    await act(async () => {
      await result.current.confirm();
    });

    const args = confirmReplan.mock.calls[0];
    // portalDone (19th positional, index 18): the task + its block id.
    expect(args[18]).toEqual([{ gid: 'g1', integrationId: 'gi1', googleEventId: 'evt-x' }]);
    // It did NOT also mark the block done (index 1) or defer it (index 7).
    expect(args[1]).toEqual([]);
    expect(args[7]).toEqual([]);
  });
});

// End-of-week analyze with a portal-done task waiting on others.
const WAITING_DATA: ReplanAnalyzeResponse = {
  weekStart: '2026-07-20',
  weekEnd: '2026-07-26',
  kept: [],
  moves: [],
  stale: [],
  additions: [],
  deletions: [],
  unplaceable: [],
  endOfWeek: true,
  carryBlocks: [],
  waiting: [{ gid: 'w1', integrationId: 'gi1', title: 'Blog post', portalDoneAt: '2026-07-18T10:00:00.000Z' }],
};

describe('useReplanActions — end-of-week waiting-on-others assembly', () => {
  it('does nothing while a waiting row stays on its leave default', () => {
    const { result } = renderHook(() => useReplanActions(WAITING_DATA));
    expect(result.current.actionCount).toBe(0);
  });

  it("'complete' completes in Asana AND clears the flag (no outcome)", async () => {
    const { result } = renderHook(() => useReplanActions(WAITING_DATA));

    act(() => {
      result.current.setWaitingMode(prev => ({ ...prev, w1: 'complete' }));
    });

    await act(async () => {
      await result.current.confirm();
    });

    const args = confirmReplan.mock.calls[0];
    // completeAsana (index 6) records the 'done'; clearPortalDone (index 19)
    // just clears the flag, carrying no outcome of its own.
    expect(args[6]).toEqual([{ gid: 'w1', integrationId: 'gi1' }]);
    expect(args[19]).toEqual([{ gid: 'w1', integrationId: 'gi1' }]);
  });

  it("'reopen' clears the flag and records a scheduled outcome", async () => {
    const { result } = renderHook(() => useReplanActions(WAITING_DATA));

    act(() => {
      result.current.setWaitingMode(prev => ({ ...prev, w1: 'reopen' }));
    });

    await act(async () => {
      await result.current.confirm();
    });

    const args = confirmReplan.mock.calls[0];
    // Nothing to complete in Asana, so completeAsana is omitted entirely.
    expect(args[6]).toBeUndefined();
    expect(args[19]).toEqual([{ gid: 'w1', integrationId: 'gi1', outcome: 'scheduled' }]);
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
