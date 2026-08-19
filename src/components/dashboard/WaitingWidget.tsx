'use client';

import { useCallback, useEffect, useState } from 'react';
import { Clock, Check, RotateCcw, Loader2 } from 'lucide-react';

import { api, type WaitingTask } from '@/lib/api';

interface WaitingWidgetProps {
  // Opening a row's task in the task dialog (Asana members only).
  onTaskClick?: (taskId: string) => void;
  // Called after a row action succeeds, so the page can refresh dependent state
  // (task metadata, the calendar) that a completed / reopened task affects.
  onChanged?: () => void;
}

const REFRESH_MS = 60_000;

// Short "since" label from an ISO instant, matching the other widgets' style.
function relativeTime(iso: string | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

type RowState = { busy?: boolean; error?: boolean };

// Tasks Dave marked "done (waiting on others)": his work is finished but the
// Asana task can't be closed yet (awaiting someone else — e.g. a written piece
// awaiting publication). Each row offers "Complete in Asana" (finish it off) and
// "Reopen" (needs more work — return it to scheduling). The list is fetched here
// and refreshed on visibility, so a flag set elsewhere shows up without a prop.
export function WaitingWidget({ onTaskClick, onChanged }: WaitingWidgetProps) {
  const [tasks, setTasks] = useState<WaitingTask[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const load = useCallback(() => {
    api
      .getWaitingTasks()
      .then(res => setTasks(res.tasks))
      .catch(err => console.error('Failed to load waiting tasks:', err));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const runAction = useCallback(
    async (task: WaitingTask, action: 'done' | 'reopenPortalDone') => {
      setRows(prev => ({ ...prev, [task.gid]: { busy: true } }));
      // Optimistically drop the row (both actions take it out of the list).
      setTasks(prev => prev.filter(t => t.gid !== task.gid));
      try {
        await api.updateBlockMember(action, {
          source: 'asana',
          taskId: task.gid,
          gid: task.gid,
          integrationId: task.integrationId,
          title: task.title,
        });
        setRows(prev => {
          const next = { ...prev };
          delete next[task.gid];
          return next;
        });
        onChanged?.();
      } catch {
        // Restore the row and flag the failure.
        setTasks(prev => (prev.some(t => t.gid === task.gid) ? prev : [task, ...prev]));
        setRows(prev => ({ ...prev, [task.gid]: { error: true } }));
      }
    },
    [onChanged]
  );

  if (tasks.length === 0) return null;

  return (
    <div className="flex-shrink-0 min-w-0 bg-white rounded-xl border border-gray-200 p-4 flex flex-col min-h-0 max-h-52">
      <div className="flex items-center gap-2 mb-2 flex-shrink-0">
        <Clock className="w-4 h-4 text-amber-600" />
        <h2 className="text-base font-semibold text-gray-900">Waiting on others</h2>
        <span className="ml-auto text-xs text-gray-400">{tasks.length}</span>
      </div>
      <p className="text-[11px] text-gray-400 mb-2.5 flex-shrink-0">
        Your work is done; these wait on someone else before they close in Asana.
      </p>
      <ul className="space-y-1.5 overflow-y-auto min-h-0">
        {tasks.map(t => {
          const row = rows[t.gid] ?? {};
          const since = relativeTime(t.portalDoneAt);
          return (
            <li key={t.gid} className="flex items-start gap-2">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 bg-amber-400" />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => onTaskClick?.(t.gid)}
                  disabled={!onTaskClick}
                  className={`block w-full truncate text-left text-sm text-gray-800 ${
                    onTaskClick ? 'hover:text-orange-600 cursor-pointer' : 'cursor-default'
                  }`}
                >
                  {t.title}
                </button>
                <div className="text-[11px] text-gray-400">
                  waiting{since && <> · since {since}</>}
                  {row.error && <span className="ml-1 text-red-500">· failed</span>}
                </div>
              </div>
              {row.busy ? (
                <Loader2 className="w-4 h-4 flex-shrink-0 mt-0.5 animate-spin text-gray-400" />
              ) : (
                <div className="flex flex-shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => runAction(t, 'done')}
                    aria-label="Complete in Asana"
                    title="Complete in Asana"
                    className="p-1 rounded text-gray-300 hover:bg-emerald-50 hover:text-emerald-500 transition-colors"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => runAction(t, 'reopenPortalDone')}
                    aria-label="Reopen"
                    title="Reopen — needs more work"
                    className="p-1 rounded text-gray-300 hover:bg-orange-50 hover:text-orange-500 transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
