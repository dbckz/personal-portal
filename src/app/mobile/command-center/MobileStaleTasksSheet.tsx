'use client';

import { useCallback, useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { Archive, CheckCircle2, Loader2, Trash2 } from 'lucide-react';

import { CalendarEvent } from '@/types';
import { api } from '@/lib/api';
import { MobileSheet } from '../components/MobileSheet';

interface StaleRow {
  task: CalendarEvent;
  reason: string;
}

function fmt(iso?: string): string {
  if (!iso) return '—';
  try {
    return format(parseISO(iso), 'dd MMM yyyy');
  } catch {
    return '—';
  }
}

// Touch rebuild of the desktop StaleTasksModal: runs the (cached) staleness
// classifier over incomplete tasks on open, then lets you Keep-active or Delete
// each flagged task. Delete is behind a two-tap confirm. Both actions are
// remembered server-side so re-triaging won't re-surface them.
export function MobileStaleTasksSheet({
  tasks,
  onClose,
  onOpenTask,
  onDeleteTask,
}: {
  tasks: CalendarEvent[]; // incomplete Asana tasks
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
  // Optimistic delete in the parent (removes from the store with rollback).
  onDeleteTask: (taskId: string, integrationId: string) => Promise<boolean>;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<StaleRow[]>([]);
  const [busyGid, setBusyGid] = useState<string | null>(null);
  const [confirmGid, setConfirmGid] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const byId = new Map(tasks.map(t => [t.id, t]));
    const payload = tasks
      .filter(t => !t.completed && t.integrationId)
      .map(t => ({
        gid: t.id,
        integrationId: t.integrationId as string,
        title: t.title,
        description: t.description,
        createdAt: t.createdAt,
        dueOn: t.dueOn,
        startOn: t.startOn,
        integrationName: t.integrationName,
      }));

    api.triageStaleTasks(payload)
      .then(({ staleTasks }) => {
        if (cancelled) return;
        setRows(staleTasks
          .map(s => ({ task: byId.get(s.gid), reason: s.reason }))
          .filter((r): r is StaleRow => Boolean(r.task)));
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Triage failed.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tasks]);

  const removeRow = useCallback((gid: string) => setRows(prev => prev.filter(r => r.task.id !== gid)), []);

  const handleKeep = async (task: CalendarEvent) => {
    setBusyGid(task.id);
    try {
      await api.keepTaskActive(task.id);
      removeRow(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to keep task.');
    } finally {
      setBusyGid(null);
    }
  };

  const handleDelete = async (task: CalendarEvent) => {
    if (confirmGid !== task.id) { setConfirmGid(task.id); return; }
    if (!task.integrationId) return;
    setBusyGid(task.id);
    try {
      await onDeleteTask(task.id, task.integrationId);
      removeRow(task.id);
      setConfirmGid(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task.');
    } finally {
      setBusyGid(null);
    }
  };

  return (
    <MobileSheet onClose={onClose}>
      <div className="flex flex-shrink-0 items-center gap-2 px-4 pb-3">
        <Archive className="h-5 w-5 text-amber-600" />
        <h2 className="text-base font-semibold text-gray-900">Possibly stale tasks</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4">
        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Reviewing your tasks for stale ones…
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-sm text-gray-500">
            <CheckCircle2 className="h-6 w-6 text-emerald-500" />
            Nothing looks stale. You&apos;re all clear.
          </div>
        ) : (
          <ul className="space-y-2">
            {rows.map(({ task, reason }) => {
              const busy = busyGid === task.id;
              const confirming = confirmGid === task.id;
              return (
                <li key={task.id} className="rounded-lg border border-gray-200 p-3">
                  <button
                    type="button"
                    onClick={() => onOpenTask?.(task.id)}
                    disabled={!onOpenTask}
                    className={`block w-full text-left text-sm font-medium text-gray-900 ${onOpenTask ? 'active:text-indigo-600' : ''}`}
                  >
                    {task.title}
                  </button>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    {task.integrationName && <span className="mr-2">{task.integrationName}</span>}
                    created {fmt(task.createdAt)} · due {task.dueOn ? fmt(task.dueOn) : 'none'}
                  </p>
                  <p className="mt-1 text-[11px] italic text-amber-700">{reason}</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleKeep(task)}
                      disabled={busy}
                      className="h-10 flex-1 rounded-md border border-gray-300 text-xs font-medium text-gray-700 active:bg-gray-50 disabled:opacity-50"
                    >
                      Keep active
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(task)}
                      disabled={busy}
                      className={`flex h-10 flex-1 items-center justify-center gap-1 rounded-md text-xs font-medium text-white disabled:opacity-50 ${
                        confirming ? 'bg-red-700 active:bg-red-800' : 'bg-red-600 active:bg-red-700'
                      }`}
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      {confirming ? 'Confirm delete' : 'Delete'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex-shrink-0 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2 text-[11px] text-gray-400">
        Results are cached; “Keep active” hides a task here for ~90 days. Delete moves it to Asana’s trash.
      </div>
    </MobileSheet>
  );
}
