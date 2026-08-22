/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { BoardTab } from '@/components/sections/work/BoardTab';
import { weekStartFor } from '@/lib/board';
import type { AdHocTask, CalendarEvent, ScheduledAsanaTask } from '@/types';

// Dumb api: the board's local stores come back empty, so cards derive purely
// from the props we pass. setBoardStatus is what a move ultimately calls.
const setBoardStatus = jest.fn().mockResolvedValue({
  state: { key: 'asana:g1', status: 'in_progress', updatedAt: '2026-01-01T00:00:00Z' },
});

jest.mock('@/lib/api', () => ({
  api: {
    getBoard: jest.fn().mockResolvedValue({
      weekStart: '2026-08-17',
      states: {},
      ritualBlocks: [],
      scheduledAsanaTasks: [],
      adHocTasks: [],
      portalDoneGids: [],
      startedTaskIds: [],
    }),
    getCustomTaskTypes: jest.fn().mockResolvedValue({ customTypes: [] }),
    setBoardStatus: (...args: unknown[]) => setBoardStatus(...args),
  },
}));

const WEEK = weekStartFor(new Date());
const MONDAY = WEEK;

const asanaTask: CalendarEvent = {
  id: 'g1',
  title: 'Write report',
  startTime: new Date(),
  endTime: new Date(),
  source: 'asana',
  integrationId: 'int-1',
  projects: [{ gid: 'p1', name: 'Proj' }],
};

const scheduled: ScheduledAsanaTask[] = [
  {
    id: 's1',
    asanaTaskId: 'g1',
    integrationId: 'int-1',
    scheduledDate: MONDAY,
    scheduledTime: '09:00',
    duration: 45,
    taskName: 'Write report',
  },
];

const adhoc: AdHocTask[] = [
  {
    id: 'a1',
    title: 'Unplanned todo',
    completed: false,
    priority: 'medium',
    taskType: 'focus',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  },
];

function renderBoard() {
  return render(
    <BoardTab
      asanaTasks={[asanaTask]}
      adHocTasks={adhoc}
      scheduledAsanaTasks={scheduled}
      metadataByGid={{}}
      saveMetadata={jest.fn().mockResolvedValue(undefined)}
      completeAsanaTask={jest.fn().mockResolvedValue(undefined)}
      addTask={jest.fn().mockResolvedValue(null)}
      updateTask={jest.fn().mockResolvedValue(null)}
    />
  );
}

describe('BoardTab', () => {
  beforeEach(() => setBoardStatus.mockClear());

  it('renders the four status columns', async () => {
    renderBoard();
    // Wait for a card so the board (not the loading spinner) is on screen.
    await screen.findByText('Write report');
    for (const status of ['todo', 'in_progress', 'waiting', 'done']) {
      expect(screen.getByTestId(`board-column-${status}`)).toBeInTheDocument();
    }
    // Column headings (the labels also appear as <option>s, so scope to headings).
    const headings = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
    expect(headings).toEqual(['To start', 'In progress', 'Waiting', 'Done']);
  });

  it('shows both cards under All, and narrows to a single day', async () => {
    renderBoard();
    // Both the Monday-scheduled Asana card and the unplanned ad-hoc show first.
    expect(await screen.findByText('Write report')).toBeInTheDocument();
    expect(screen.getByText('Unplanned todo')).toBeInTheDocument();

    // Filtering to Monday keeps the scheduled card, drops the unplanned one.
    fireEvent.click(screen.getByText('Mon'));
    expect(screen.getByText('Write report')).toBeInTheDocument();
    expect(screen.queryByText('Unplanned todo')).not.toBeInTheDocument();
  });

  it('moving a card via the select fallback persists the new status', async () => {
    renderBoard();
    const card = (await screen.findByText('Write report')).closest('[data-testid="board-card"]')!;
    const select = within(card as HTMLElement).getByLabelText('Move card');
    fireEvent.change(select, { target: { value: 'in_progress' } });

    await waitFor(() => expect(setBoardStatus).toHaveBeenCalled());
    expect(setBoardStatus.mock.calls[0][0]).toMatchObject({
      key: 'asana:g1',
      status: 'in_progress',
    });
  });
});
