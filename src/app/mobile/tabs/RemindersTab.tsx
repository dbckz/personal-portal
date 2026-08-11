'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Check, CheckCircle2, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Reminder } from '@/types';

export function RemindersTab({
  reminders,
  updatingIds,
  hasUndo,
  isArchiving,
  error,
  onComplete,
  onAdd,
  onEdit,
  onDelete,
  onArchive,
  onUndo,
}: {
  reminders: Reminder[];
  updatingIds: Set<string>;
  hasUndo: boolean;
  isArchiving: boolean;
  error: string | null;
  onComplete: (reminder: Reminder) => void;
  onAdd: (text: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onArchive: () => void;
  onUndo: () => void;
}) {
  const activeReminders = useMemo(
    () => reminders.filter(reminder => !reminder.completed),
    [reminders]
  );
  const completedCount = reminders.length - activeReminders.length;

  const [newText, setNewText] = useState('');

  const handleAddSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = newText.trim();
    if (!text) return;
    onAdd(text);
    setNewText('');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Reminders</h2>
        <div className="flex items-center gap-2">
          {completedCount > 0 && (
            <button
              type="button"
              onClick={onArchive}
              disabled={isArchiving}
              className="flex h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-gray-600 transition-colors active:bg-gray-100 disabled:opacity-50"
            >
              {isArchiving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
              Archive {completedCount}
            </button>
          )}
          <span className="text-sm text-gray-500">{activeReminders.length}</span>
        </div>
      </div>

      <form onSubmit={handleAddSubmit} className="flex gap-2">
        <input
          type="text"
          value={newText}
          onChange={event => setNewText(event.target.value)}
          placeholder="Add a reminder..."
          className="h-12 min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={!newText.trim()}
          className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white active:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Add reminder"
        >
          <Plus className="h-5 w-5" />
        </button>
      </form>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {hasUndo && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          <span className="min-w-0">
            Reminder completed. Press Cmd/Ctrl+Z to undo.
          </span>
          <button
            type="button"
            onClick={onUndo}
            className="flex-shrink-0 rounded px-2 py-1 font-medium text-blue-700 hover:bg-blue-100"
          >
            Undo
          </button>
        </div>
      )}

      {activeReminders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-10 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-gray-400" />
          <p className="mt-3 text-sm font-medium text-gray-700">No active reminders</p>
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
          <div className="space-y-1">
            {activeReminders.map(reminder => (
              <ReminderRow
                key={reminder.id}
                reminder={reminder}
                updating={updatingIds.has(reminder.id)}
                onComplete={onComplete}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReminderRow({
  reminder,
  updating,
  onComplete,
  onEdit,
  onDelete,
}: {
  reminder: Reminder;
  updating: boolean;
  onComplete: (reminder: Reminder) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(reminder.text);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  const startEditing = () => {
    setEditText(reminder.text);
    setIsEditing(true);
  };

  const commitEdit = () => {
    if (!isEditing) return;
    setIsEditing(false);
    onEdit(reminder.id, editText);
  };

  if (isEditing) {
    return (
      <form
        onSubmit={event => {
          event.preventDefault();
          commitEdit();
        }}
        className="flex items-center gap-2 py-1"
      >
        <input
          ref={inputRef}
          type="text"
          value={editText}
          onChange={event => setEditText(event.target.value)}
          onBlur={commitEdit}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              setEditText(reminder.text);
              setIsEditing(false);
            }
          }}
          className="h-11 min-w-0 flex-1 rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-blue-600 transition-colors active:bg-blue-50"
          aria-label="Save reminder"
        >
          <Check className="h-5 w-5" />
        </button>
      </form>
    );
  }

  if (confirmingDelete) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-red-50 py-1 pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate text-sm text-red-800">Delete this reminder?</span>
        <button
          type="button"
          onClick={() => onDelete(reminder.id)}
          className="flex h-11 items-center rounded-md px-3 text-sm font-medium text-red-700 transition-colors active:bg-red-100"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={() => setConfirmingDelete(false)}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors active:bg-gray-100"
          aria-label="Cancel delete"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <button
        type="button"
        onClick={() => onComplete(reminder)}
        disabled={updating}
        className="mt-0.5 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-emerald-600 transition-colors active:bg-emerald-50 disabled:opacity-50"
        aria-label={`Mark ${reminder.text} done`}
      >
        {updating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <CheckCircle2 className="h-5 w-5" />
        )}
      </button>
      <button
        type="button"
        onClick={startEditing}
        className="min-w-0 flex-1 py-2.5 text-left"
      >
        <p className="text-sm leading-6 text-gray-800">{reminder.text}</p>
        {reminder.due && (
          <p className="mt-0.5 text-xs text-gray-500">Due {reminder.due}</p>
        )}
      </button>
      <button
        type="button"
        onClick={startEditing}
        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors active:bg-gray-100"
        aria-label={`Edit ${reminder.text}`}
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => setConfirmingDelete(true)}
        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors active:bg-red-50 active:text-red-500"
        aria-label={`Delete ${reminder.text}`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
