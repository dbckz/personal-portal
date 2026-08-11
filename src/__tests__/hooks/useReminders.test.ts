/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { useReminders } from '@/hooks/useReminders';
import { api } from '@/lib/api';
import { Reminder } from '@/types';

jest.mock('@/lib/api', () => ({
  api: {
    getReminders: jest.fn(),
    updateReminder: jest.fn(),
    addReminder: jest.fn(),
    deleteReminder: jest.fn(),
    archiveReminders: jest.fn(),
  },
}));

const toastMock = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('@/hooks/useToast', () => ({
  useToast: () => toastMock,
}));

const mockApi = api as jest.Mocked<typeof api>;

const reminder: Reminder = {
  id: 'reminder-1',
  text: 'Buy milk',
  completed: false,
  createdAt: '2024-01-01T00:00:00.000Z',
};

describe('useReminders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.getReminders.mockResolvedValue({ reminders: [reminder] });
    mockApi.updateReminder.mockResolvedValue({ reminder: { ...reminder, completed: true } });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('loads reminders on mount', async () => {
    const { result } = renderHook(() => useReminders());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.reminders).toEqual([reminder]);
  });

  it('completes a reminder optimistically and opens the undo window', async () => {
    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.completeReminder(reminder);
    });

    expect(result.current.reminders[0].completed).toBe(true);
    expect(mockApi.updateReminder).toHaveBeenCalledWith('reminder-1', { completed: true });
    expect(result.current.undoState).toMatchObject({ id: 'reminder-1', previousCompleted: false });
  });

  it('undo restores the previous state', async () => {
    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.completeReminder(reminder);
    });
    await act(async () => {
      await result.current.undo();
    });

    expect(result.current.reminders[0].completed).toBe(false);
    expect(result.current.undoState).toBeNull();
    expect(mockApi.updateReminder).toHaveBeenLastCalledWith('reminder-1', { completed: false });
  });

  it('rolls back the optimistic update when the API call fails', async () => {
    mockApi.updateReminder.mockRejectedValueOnce(new Error('boom'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.completeReminder(reminder);
    });

    expect(result.current.reminders[0].completed).toBe(false);
    expect(result.current.undoState).toBeNull();
    expect(toastMock.error).toHaveBeenCalledWith('Failed to complete reminder');
    consoleSpy.mockRestore();
  });

  it('adds a reminder optimistically and swaps in the saved record', async () => {
    const saved: Reminder = {
      id: 'reminder-2',
      text: 'Call dentist',
      completed: false,
      createdAt: '2024-01-02T00:00:00.000Z',
    };
    mockApi.addReminder.mockResolvedValue({ reminder: saved });

    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addReminder('Call dentist');
    });

    expect(mockApi.addReminder).toHaveBeenCalledWith('Call dentist');
    expect(result.current.reminders).toHaveLength(2);
    expect(result.current.reminders[1]).toEqual(saved);
  });

  it('rolls back an added reminder when the API call fails', async () => {
    mockApi.addReminder.mockRejectedValueOnce(new Error('boom'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addReminder('Call dentist');
    });

    expect(result.current.reminders).toHaveLength(1);
    expect(toastMock.error).toHaveBeenCalledWith('Failed to add reminder');
    consoleSpy.mockRestore();
  });

  it('edits reminder text optimistically', async () => {
    mockApi.updateReminder.mockResolvedValue({ reminder: { ...reminder, text: 'Buy oat milk' } });

    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.updateReminderText('reminder-1', 'Buy oat milk');
    });

    expect(mockApi.updateReminder).toHaveBeenCalledWith('reminder-1', { text: 'Buy oat milk' });
    expect(result.current.reminders[0].text).toBe('Buy oat milk');
  });

  it('does not call the API when edited text is unchanged', async () => {
    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.updateReminderText('reminder-1', 'Buy milk');
    });

    expect(mockApi.updateReminder).not.toHaveBeenCalled();
  });

  it('restores reminder text when the edit fails', async () => {
    mockApi.updateReminder.mockRejectedValueOnce(new Error('boom'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.updateReminderText('reminder-1', 'Buy oat milk');
    });

    expect(result.current.reminders[0].text).toBe('Buy milk');
    expect(toastMock.error).toHaveBeenCalledWith('Failed to update reminder');
    consoleSpy.mockRestore();
  });

  it('deletes a reminder optimistically', async () => {
    mockApi.deleteReminder.mockResolvedValue({ success: true });

    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.deleteReminder('reminder-1');
    });

    expect(mockApi.deleteReminder).toHaveBeenCalledWith('reminder-1');
    expect(result.current.reminders).toHaveLength(0);
  });

  it('restores a deleted reminder when the API call fails', async () => {
    mockApi.deleteReminder.mockRejectedValueOnce(new Error('boom'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.deleteReminder('reminder-1');
    });

    expect(result.current.reminders).toEqual([reminder]);
    expect(toastMock.error).toHaveBeenCalledWith('Failed to delete reminder');
    consoleSpy.mockRestore();
  });

  it('archives completed reminders optimistically', async () => {
    const done: Reminder = { ...reminder, id: 'reminder-done', completed: true };
    mockApi.getReminders.mockResolvedValue({ reminders: [reminder, done] });
    mockApi.archiveReminders.mockResolvedValue({ success: true, archivedCount: 1 });

    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.archiveReminders();
    });

    expect(mockApi.archiveReminders).toHaveBeenCalled();
    expect(result.current.reminders).toEqual([reminder]);
  });

  it('does not archive when there are no completed reminders', async () => {
    const { result } = renderHook(() => useReminders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.archiveReminders();
    });

    expect(mockApi.archiveReminders).not.toHaveBeenCalled();
  });

  it('expires the undo window after 10 seconds', async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useReminders());
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.completeReminder(reminder);
    });
    expect(result.current.undoState).not.toBeNull();

    act(() => {
      jest.advanceTimersByTime(10000);
    });

    expect(result.current.undoState).toBeNull();
  });
});
