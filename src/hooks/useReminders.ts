'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/useToast';
import { Reminder } from '@/types';

const UNDO_WINDOW_MS = 10000;

interface UndoReminderState {
  id: string;
  text: string;
  previousCompleted: boolean;
  nextCompleted: boolean;
}

interface UseRemindersReturn {
  reminders: Reminder[];
  isLoading: boolean;
  error: string | null;
  updatingIds: Set<string>;
  undoState: UndoReminderState | null;
  isArchiving: boolean;
  refetch: () => Promise<void>;
  completeReminder: (reminder: Reminder) => Promise<void>;
  addReminder: (text: string) => Promise<void>;
  updateReminderText: (id: string, text: string) => Promise<void>;
  deleteReminder: (id: string) => Promise<void>;
  archiveReminders: () => Promise<void>;
  undo: () => Promise<void>;
}

// Reminders list with optimistic completion, a 10-second undo window (surfaced
// via `undoState` and Cmd/Ctrl+Z), and rollback when the API call fails.
export function useReminders(): UseRemindersReturn {
  const toast = useToast();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(() => new Set());
  const [undoState, setUndoState] = useState<UndoReminderState | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const undoTimeoutRef = useRef<number | null>(null);

  const markUpdating = useCallback((id: string) => {
    setUpdatingIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const clearUpdating = useCallback((id: string) => {
    setUpdatingIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getReminders();
      setReminders(data.reminders);
    } catch (err) {
      console.error('Failed to load reminders:', err);
      setError('Unable to load reminders');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const clearUndoState = useCallback(() => {
    if (undoTimeoutRef.current) {
      window.clearTimeout(undoTimeoutRef.current);
      undoTimeoutRef.current = null;
    }
    setUndoState(null);
  }, []);

  const queueUndoState = useCallback((reminder: Reminder, nextCompleted: boolean) => {
    if (undoTimeoutRef.current) {
      window.clearTimeout(undoTimeoutRef.current);
    }

    setUndoState({
      id: reminder.id,
      text: reminder.text,
      previousCompleted: reminder.completed,
      nextCompleted,
    });

    undoTimeoutRef.current = window.setTimeout(() => {
      undoTimeoutRef.current = null;
      setUndoState(null);
    }, UNDO_WINDOW_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (undoTimeoutRef.current) {
        window.clearTimeout(undoTimeoutRef.current);
      }
    };
  }, []);

  const undo = useCallback(async () => {
    if (!undoState) return;

    const state = undoState;
    clearUndoState();
    setReminders(prev => prev.map(reminder => (
      reminder.id === state.id
        ? { ...reminder, completed: state.previousCompleted }
        : reminder
    )));
    markUpdating(state.id);

    try {
      await api.updateReminder(state.id, { completed: state.previousCompleted });
      toast.success(`Reinstated "${state.text}"`);
    } catch (err) {
      console.error('Failed to undo reminder change:', err);
      setReminders(prev => prev.map(reminder => (
        reminder.id === state.id
          ? { ...reminder, completed: state.nextCompleted }
          : reminder
      )));
      toast.error('Failed to undo reminder change');
    } finally {
      clearUpdating(state.id);
    }
  }, [clearUndoState, markUpdating, clearUpdating, toast, undoState]);

  const completeReminder = useCallback(async (reminder: Reminder) => {
    queueUndoState(reminder, true);
    markUpdating(reminder.id);
    setReminders(prev => prev.map(item => item.id === reminder.id ? { ...item, completed: true } : item));
    toast.info('Reminder completed. Press Cmd/Ctrl+Z to undo.');

    try {
      await api.updateReminder(reminder.id, { completed: true });
    } catch (err) {
      console.error('Failed to complete reminder:', err);
      clearUndoState();
      setReminders(prev => prev.map(item => item.id === reminder.id ? reminder : item));
      toast.error('Failed to complete reminder');
    } finally {
      clearUpdating(reminder.id);
    }
  }, [clearUndoState, queueUndoState, markUpdating, clearUpdating, toast]);

  // Add a reminder optimistically under a temporary id, then swap in the saved
  // record (with its real id) once the API returns. Rolls back on failure.
  const addReminder = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const tempId = `temp-${Date.now()}`;
    const optimistic: Reminder = {
      id: tempId,
      text: trimmed,
      completed: false,
      createdAt: new Date().toISOString(),
    };
    markUpdating(tempId);
    setReminders(prev => [...prev, optimistic]);

    try {
      const { reminder } = await api.addReminder(trimmed);
      setReminders(prev => prev.map(item => (item.id === tempId ? reminder : item)));
    } catch (err) {
      console.error('Failed to add reminder:', err);
      setReminders(prev => prev.filter(item => item.id !== tempId));
      toast.error('Failed to add reminder');
    } finally {
      clearUpdating(tempId);
    }
  }, [markUpdating, clearUpdating, toast]);

  // Edit a reminder's text optimistically, restoring the previous text on
  // failure. A no-op when the text is unchanged or empty.
  const updateReminderText = useCallback(async (id: string, text: string) => {
    const trimmed = text.trim();
    const current = reminders.find(item => item.id === id);
    if (!current || !trimmed || trimmed === current.text) return;

    const previousText = current.text;
    markUpdating(id);
    setReminders(prev => prev.map(item => (item.id === id ? { ...item, text: trimmed } : item)));

    try {
      await api.updateReminder(id, { text: trimmed });
    } catch (err) {
      console.error('Failed to update reminder:', err);
      setReminders(prev => prev.map(item => (item.id === id ? { ...item, text: previousText } : item)));
      toast.error('Failed to update reminder');
    } finally {
      clearUpdating(id);
    }
  }, [reminders, markUpdating, clearUpdating, toast]);

  // Delete a reminder optimistically, restoring it in place on failure.
  const deleteReminder = useCallback(async (id: string) => {
    const previous = reminders;
    if (!previous.some(item => item.id === id)) return;

    setReminders(prev => prev.filter(item => item.id !== id));

    try {
      await api.deleteReminder(id);
    } catch (err) {
      console.error('Failed to delete reminder:', err);
      setReminders(previous);
      toast.error('Failed to delete reminder');
    }
  }, [reminders, toast]);

  // Archive every completed reminder in one call, dropping them from the list
  // optimistically and restoring on failure.
  const archiveReminders = useCallback(async () => {
    const previous = reminders;
    if (!previous.some(item => item.completed)) return;

    setIsArchiving(true);
    setReminders(prev => prev.filter(item => !item.completed));

    try {
      await api.archiveReminders();
    } catch (err) {
      console.error('Failed to archive reminders:', err);
      setReminders(previous);
      toast.error('Failed to archive reminders');
    } finally {
      setIsArchiving(false);
    }
  }, [reminders, toast]);

  // Cmd/Ctrl+Z undoes the last completion while the undo window is open, except
  // when typing into a form control.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!undoState) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'z') return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }

      event.preventDefault();
      void undo();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [undo, undoState]);

  return {
    reminders,
    isLoading,
    error,
    updatingIds,
    undoState,
    isArchiving,
    refetch,
    completeReminder,
    addReminder,
    updateReminderText,
    deleteReminder,
    archiveReminders,
    undo,
  };
}
