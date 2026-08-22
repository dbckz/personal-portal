/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from '@testing-library/react';

import { useBoard, type UseBoardOptions } from '@/hooks/useBoard';
import { api } from '@/lib/api';
import type { AdHocTask, BoardStatus, CalendarEvent } from '@/types';

jest.mock('@/lib/api', () => ({
  api: {
    getBoard: jest.fn(),
    setBoardStatus: jest.fn(),
    completeAsanaTask: jest.fn(),
    updateAdHocTask: jest.fn(),
    upsertTaskMetadata: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const WEEK = '2026-08-17';

const asanaEvent: CalendarEvent = {
  id: 'g1',
  title: 'Write the report',
  startTime: new Date(),
  endTime: new Date(),
  source: 'asana',
  integrationId: 'om',
};

const asanaEvent2: CalendarEvent = {
  id: 'g2',
  title: 'Call the partner',
  startTime: new Date(),
  endTime: new Date(),
  source: 'asana',
  integrationId: 'om',
};

const adhocTask: AdHocTask = {
  id: 'a1',
  title: 'Buy milk',
  completed: false,
  priority: 'medium',
  taskType: 'focus',
  dueDate: '2026-08-19',
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
};

function boardResponse(over: Record<string, unknown> = {}) {
  return {
    weekStart: WEEK,
    states: {},
    ritualBlocks: [],
    prepBlocks: [],
    scheduledAsanaTasks: [
      { id: 's1', asanaTaskId: 'g1', scheduledDate: '2026-08-18', scheduledTime: '09:00', duration: 60, integrationId: 'om', googleEventId: 'ev1' },
    ],
    adHocTasks: [],
    portalDoneGids: [],
    weeklyOutcomes: {}, blockDoneGoogleEventIds: [],
    ...over,
  };
}

function opts(over: Partial<UseBoardOptions> = {}): UseBoardOptions {
  return {
    weekStart: WEEK,
    asanaTasks: [asanaEvent],
    adHocTasks: [],
    metadataByGid: {},
    customTypes: [],
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getBoard.mockResolvedValue(boardResponse());
  mockApi.setBoardStatus.mockImplementation(async (args) => ({
    state: {
      key: args.stateKey,
      status: args.status,
      ...(args.weekStart ? { weekStart: args.weekStart } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.typeLabel ? { typeLabel: args.typeLabel } : {}),
      ...(args.integrationId ? { integrationId: args.integrationId } : {}),
      updatedAt: 'now',
    },
  }));
  mockApi.completeAsanaTask.mockResolvedValue({ success: true, completed: true });
  mockApi.updateAdHocTask.mockResolvedValue({ task: adhocTask });
  mockApi.upsertTaskMetadata.mockResolvedValue({
    metadata: { asanaTaskGid: 'g1', integrationId: 'om', updatedAt: 'now' },
  });
});

async function renderBoard(over: Partial<UseBoardOptions> = {}) {
  const hook = renderHook((props: UseBoardOptions) => useBoard(props), {
    initialProps: opts(over),
  });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

describe('useBoard', () => {
  it('loads and builds cards for the week', async () => {
    const { result } = await renderBoard();
    expect(mockApi.getBoard).toHaveBeenCalledWith(WEEK);
    expect(result.current.cards).toHaveLength(1);
    expect(result.current.cards[0].gid).toBe('g1');
    expect(result.current.cards[0].status).toBe('todo');
  });

  it('optimistically moves a card and persists the status', async () => {
    const { result } = await renderBoard();
    const card = result.current.cards[0];

    await act(async () => {
      await result.current.moveCard(card, 'in_progress' as BoardStatus);
    });

    expect(mockApi.setBoardStatus).toHaveBeenCalledWith(
      expect.objectContaining({ stateKey: 'block:ev1', key: 'block:ev1', status: 'in_progress' })
    );
    expect(result.current.cards[0].status).toBe('in_progress');
    expect(result.current.busyKeys.has('block:ev1')).toBe(false);
  });

  it('rolls back and surfaces an error when the write fails', async () => {
    mockApi.setBoardStatus.mockRejectedValueOnce(new Error('offline'));
    const { result } = await renderBoard();
    const card = result.current.cards[0];

    await act(async () => {
      await result.current.moveCard(card, 'in_progress' as BoardStatus);
    });

    expect(result.current.cards[0].status).toBe('todo'); // rolled back
    expect(result.current.error).toBeTruthy();
  });

  it('completes the Asana task when moved to done', async () => {
    const onCompleteAsana = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderBoard({ onCompleteAsana });
    const card = result.current.cards[0];

    await act(async () => {
      await result.current.moveCard(card, 'done' as BoardStatus);
    });

    expect(onCompleteAsana).toHaveBeenCalledWith('g1', 'om', true);
  });

  it('falls back to the api when no complete callback is given', async () => {
    const { result } = await renderBoard();
    const card = result.current.cards[0];

    await act(async () => {
      await result.current.moveCard(card, 'done' as BoardStatus);
    });

    expect(mockApi.completeAsanaTask).toHaveBeenCalledWith('g1', 'om', true);
  });

  it('flags portal-done via saveMetadata when moved to waiting', async () => {
    const saveMetadata = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderBoard({ saveMetadata });
    const card = result.current.cards[0];

    await act(async () => {
      await result.current.moveCard(card, 'waiting' as BoardStatus);
    });

    expect(saveMetadata).toHaveBeenCalledWith(
      'g1',
      'om',
      expect.objectContaining({ portalDone: true, portalDoneTitle: 'Write the report' })
    );
  });

  it('clears portal-done when leaving waiting', async () => {
    mockApi.getBoard.mockResolvedValue(
      boardResponse({
        states: { 'block:ev1': { key: 'block:ev1', status: 'waiting', updatedAt: 'now' } },
      })
    );
    const saveMetadata = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderBoard({ saveMetadata });
    const card = result.current.cards.find(c => c.gid === 'g1')!;
    expect(card.status).toBe('waiting');

    await act(async () => {
      await result.current.moveCard(card, 'todo' as BoardStatus);
    });

    expect(saveMetadata).toHaveBeenCalledWith('g1', 'om', { portalDone: false });
  });

  it('pins a card to the week, defaulting weekStart and status', async () => {
    const { result } = await renderBoard();

    await act(async () => {
      await result.current.pinToWeek({ key: 'asana:g9', title: 'Pinned', integrationId: 'om' });
    });

    expect(mockApi.setBoardStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        stateKey: 'asana:g9',
        key: 'asana:g9',
        status: 'todo',
        weekStart: WEEK,
        title: 'Pinned',
        integrationId: 'om',
      })
    );
    // Pinned Asana card (no live task/block) still renders via the snapshot.
    expect(result.current.cards.find(c => c.key === 'asana:g9')?.title).toBe('Pinned');
    expect(result.current.busyKeys.has('asana:g9')).toBe(false);
  });

  it('rolls a failed pin back out of states', async () => {
    mockApi.setBoardStatus.mockRejectedValueOnce(new Error('offline'));
    const { result } = await renderBoard();

    await act(async () => {
      await result.current.pinToWeek({ key: 'asana:g9', title: 'Pinned' });
    });

    expect(result.current.cards.find(c => c.key === 'asana:g9')).toBeUndefined();
    expect(result.current.error).toBeTruthy();
  });

  it('completes an ad-hoc task through the api when moved to done', async () => {
    mockApi.getBoard.mockResolvedValue(boardResponse({ scheduledAsanaTasks: [] }));
    const { result } = await renderBoard({ asanaTasks: [], adHocTasks: [adhocTask] });
    const card = result.current.cards.find(c => c.adhocId === 'a1')!;

    await act(async () => {
      await result.current.moveCard(card, 'done' as BoardStatus);
    });

    expect(mockApi.updateAdHocTask).toHaveBeenCalledWith('a1', { completed: true });
  });

  function groupResponse() {
    return boardResponse({
      scheduledAsanaTasks: [
        { id: 's1', asanaTaskId: 'g1', scheduledDate: '2026-08-18', scheduledTime: '09:00', duration: 60, integrationId: 'om', googleEventId: 'evg', category: 'Batch' },
        { id: 's2', asanaTaskId: 'g2', scheduledDate: '2026-08-18', scheduledTime: '09:00', duration: 60, integrationId: 'om', googleEventId: 'evg', category: 'Batch' },
      ],
    });
  }

  it('completes every member when a group is moved to done', async () => {
    mockApi.getBoard.mockResolvedValue(groupResponse());
    const onCompleteAsana = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderBoard({ asanaTasks: [asanaEvent, asanaEvent2], onCompleteAsana });
    const card = result.current.cards.find(c => c.source === 'group')!;
    expect(card.members).toHaveLength(2);

    await act(async () => {
      await result.current.moveCard(card, 'done' as BoardStatus);
    });

    expect(onCompleteAsana).toHaveBeenCalledWith('g1', 'om', true);
    expect(onCompleteAsana).toHaveBeenCalledWith('g2', 'om', true);
    expect(onCompleteAsana).toHaveBeenCalledTimes(2);
  });

  it('toggles a single member optimistically', async () => {
    mockApi.getBoard.mockResolvedValue(groupResponse());
    const onCompleteAsana = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderBoard({ asanaTasks: [asanaEvent, asanaEvent2], onCompleteAsana });
    const card = result.current.cards.find(c => c.source === 'group')!;
    const member = card.members.find(m => m.gid === 'g1')!;
    expect(member.done).toBe(false);

    await act(async () => {
      await result.current.toggleMember(card, member);
    });

    expect(onCompleteAsana).toHaveBeenCalledWith('g1', 'om', true);
    const updated = result.current.cards
      .find(c => c.source === 'group')!
      .members.find(m => m.gid === 'g1')!;
    expect(updated.done).toBe(true);
  });

  it('rolls back a member toggle when it fails', async () => {
    mockApi.getBoard.mockResolvedValue(groupResponse());
    const onCompleteAsana = jest.fn().mockRejectedValueOnce(new Error('offline'));
    const { result } = await renderBoard({ asanaTasks: [asanaEvent, asanaEvent2], onCompleteAsana });
    const card = result.current.cards.find(c => c.source === 'group')!;
    const member = card.members.find(m => m.gid === 'g1')!;

    await act(async () => {
      await result.current.toggleMember(card, member);
    });

    const updated = result.current.cards
      .find(c => c.source === 'group')!
      .members.find(m => m.gid === 'g1')!;
    expect(updated.done).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});
