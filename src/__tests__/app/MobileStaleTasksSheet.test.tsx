/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { MobileStaleTasksSheet } from '@/app/mobile/command-center/MobileStaleTasksSheet';
import type { CalendarEvent } from '@/types';

jest.mock('@/lib/api', () => ({
  api: {
    triageStaleTasks: jest.fn(),
    keepTaskActive: jest.fn(),
  },
}));

import { api } from '@/lib/api';

const mockTriage = api.triageStaleTasks as jest.Mock;
const mockKeep = api.keepTaskActive as jest.Mock;

const TASKS: CalendarEvent[] = [
  { id: 't1', title: 'Old planning doc', source: 'asana', integrationId: 'i1', integrationName: 'Acme', completed: false, createdAt: '2025-01-01', allDay: true } as CalendarEvent,
  { id: 't2', title: 'Fresh task', source: 'asana', integrationId: 'i1', integrationName: 'Acme', completed: false, createdAt: '2026-08-01', allDay: true } as CalendarEvent,
];

beforeEach(() => {
  jest.clearAllMocks();
  mockTriage.mockResolvedValue({ total: 2, assessed: 2, staleTasks: [{ gid: 't1', reason: 'Untouched for months' }] });
  mockKeep.mockResolvedValue({ success: true, keptUntil: '2026-11-09' });
});

describe('MobileStaleTasksSheet', () => {
  it('runs triage on open and lists flagged tasks', async () => {
    render(<MobileStaleTasksSheet tasks={TASKS} onClose={jest.fn()} onDeleteTask={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Old planning doc')).toBeInTheDocument());
    expect(screen.getByText('Untouched for months')).toBeInTheDocument();
    expect(mockTriage).toHaveBeenCalledTimes(1);
  });

  it('keeps a task active and drops it from the list', async () => {
    render(<MobileStaleTasksSheet tasks={TASKS} onClose={jest.fn()} onDeleteTask={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Old planning doc')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep active' }));
    });

    await waitFor(() => expect(mockKeep).toHaveBeenCalledWith('t1'));
    expect(screen.queryByText('Old planning doc')).not.toBeInTheDocument();
  });

  it('deletes only after a two-tap confirm', async () => {
    const onDelete = jest.fn().mockResolvedValue(true);
    render(<MobileStaleTasksSheet tasks={TASKS} onClose={jest.fn()} onDeleteTask={onDelete} />);

    await waitFor(() => expect(screen.getByText('Old planning doc')).toBeInTheDocument());

    // First tap reveals the confirm without deleting.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    });
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('t1', 'i1'));
    expect(screen.queryByText('Old planning doc')).not.toBeInTheDocument();
  });

  it('shows an all-clear state when nothing is stale', async () => {
    mockTriage.mockResolvedValue({ total: 2, assessed: 2, staleTasks: [] });
    render(<MobileStaleTasksSheet tasks={TASKS} onClose={jest.fn()} onDeleteTask={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(/Nothing looks stale/i)).toBeInTheDocument());
  });
});
