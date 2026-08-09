'use client';

import { useEffect, useMemo, useState } from 'react';
import { DelegationQueueEntry, OrchestratorStatus } from '@/types';
import { api } from '@/lib/api';
import type { AgentPacingConfig } from '@/lib/workflow-config-storage';
import { estimateQueueEtas } from '@/lib/delegation-eta';
import { claudeAccountLabel } from '@/lib/claude-account';
import type { DelegationStats } from '@/lib/delegation-stats';
import { Bot, CheckCircle2, XCircle, Loader2, Clock, PauseCircle } from 'lucide-react';

interface DelegationWidgetProps {
  // The delegation queue is owned by the page-level useDelegationQueue store and
  // passed in, so a delegate action (which refreshes that store) shows here at
  // once instead of waiting for a separate widget-local poll.
  delegationByGid: Record<string, DelegationQueueEntry>;
  // Clicking a "For review" row opens the task dialog, where triage happens
  // (complete / delegate again / move to backlog).
  onTaskClick?: (taskId: string) => void;
  // GIDs of tasks already completed in Asana — their finished runs are hidden
  // from the inbox (nothing left to triage; auto-marked reviewed elsewhere).
  completedTaskGids?: Set<string>;
}

const REFRESH_MS = 30_000;

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Wall-clock run length, at the granularity worth reading: seconds under a
// minute, whole minutes above it.
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function isFuture(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t > Date.now();
}

function timeUntil(iso: string): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '';
  const mins = Math.round((target - Date.now()) / 60_000);
  if (mins <= 0) return 'shortly';
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

// Compact estimated-start label for a queued row, e.g. "~19:40" today,
// "~tomorrow 02:10" next day, or "~Mon 02:10" further out. The ~ marks it an
// estimate. Day comparison is by local calendar date, so an overnight ETA that
// crosses midnight reads as tomorrow.
function formatEta(eta: Date, now: Date): string {
  const hhmm = `${String(eta.getHours()).padStart(2, '0')}:${String(eta.getMinutes()).padStart(2, '0')}`;
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((dayStart(eta) - dayStart(now)) / (24 * 60 * 60_000));
  if (dayDiff <= 0) return `~${hhmm}`;
  if (dayDiff === 1) return `~tomorrow ${hhmm}`;
  return `~${eta.toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm}`;
}

// Small trailing tag showing which Claude account a task runs on, or an amber
// "needs account" marker when a pre-terminal entry never got one (legacy or
// skeleton enqueue) — those are refused by the runner until re-delegated.
function AccountTag({ entry }: { entry: DelegationQueueEntry }) {
  const label = claudeAccountLabel(entry.claudeAccount);
  if (label) {
    return <span className="ml-1.5 text-xs text-gray-400" title="Claude account this run uses">{label}</span>;
  }
  return (
    <span className="ml-1.5 text-xs text-amber-600" title="No Claude account set — re-delegate to choose one">
      needs account
    </span>
  );
}

export function DelegationWidget({
  delegationByGid,
  onTaskClick,
  completedTaskGids,
}: DelegationWidgetProps) {
  // The queue entries come from the page-level store (prop). The orchestrator
  // status (pacer pause + run history) is polled locally here, and the pacing
  // budget is fetched once — both feed the queued-entry ETA estimate.
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [pacing, setPacing] = useState<AgentPacingConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.getOrchestratorStatus()
        .then(s => { if (!cancelled) setStatus(s); })
        .catch(() => { /* keep last known state on transient errors */ });
    };
    load();
    // Pacing rarely changes; fetch it once (best-effort — no ETA if it fails).
    api.getWorkflowConfig()
      .then(cfg => { if (!cancelled && cfg.agentPacing) setPacing(cfg.agentPacing); })
      .catch(() => { /* ETA simply won't render without a budget */ });
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Run stats, from the orchestrator's own traces. Loaded once — they move only
  // when a run finishes, and the widget already refreshes on that.
  const [stats, setStats] = useState<DelegationStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getDelegationStats()
      .then(res => !cancelled && setStats(res.stats))
      .catch(err => console.error('Failed to load delegation stats:', err));
    return () => {
      cancelled = true;
    };
  }, []);

  const list = useMemo(() => Object.values(delegationByGid), [delegationByGid]);
  const running = useMemo(() => list.filter(e => e.state === 'running'), [list]);
  // Match the pacer's claim order exactly: priority asc, then enqueuedAt asc.
  const queued = useMemo(
    () => list.filter(e => e.state === 'queued').sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.enqueuedAt.localeCompare(b.enqueuedAt);
    }),
    [list]
  );

  // Estimated start time per queued entry, by replaying the pacer forward from
  // now over the pacing budget, seeded with recent real runs + any active
  // pause. Recomputed when the queue, status poll, or pacing changes.
  const etaByGid = useMemo(() => {
    if (!pacing || queued.length === 0) return new Map<string, Date>();
    const now = new Date();
    const recentRunTimes = (status?.history ?? [])
      .filter(h => h.taskGid)
      .map(h => Date.parse(h.ranAt))
      .filter(ms => !Number.isNaN(ms));
    // A currently-running entry occupies this pacer tick, so treat it as a run
    // just now — it delays the first queued estimate honestly.
    if (running.length > 0) recentRunTimes.push(now.getTime());
    return estimateQueueEtas({
      orderedQueued: queued,
      pacing,
      now,
      pausedUntil: status?.pausedUntil,
      recentRunTimes,
    });
  }, [pacing, queued, running, status]);
  // Finished runs the user hasn't triaged yet form the "For review" inbox.
  // Old finished entries predating reviewedAt (no reviewedAt) still show up.
  // Entries whose task is already completed in Asana are excluded — completed
  // elsewhere, nothing left to triage (they're auto-marked reviewed too).
  const forReview = useMemo(
    () => list
      .filter(e => (e.state === 'done' || e.state === 'failed') && !e.reviewedAt && !completedTaskGids?.has(e.asanaTaskGid))
      .sort((a, b) => (b.result?.finishedAt || b.updatedAt).localeCompare(a.result?.finishedAt || a.updatedAt)),
    [list, completedTaskGids]
  );

  const pausedUntil = isFuture(status?.pausedUntil) ? status!.pausedUntil! : null;

  const isEmpty = running.length === 0 && queued.length === 0 && forReview.length === 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 mb-2 flex-shrink-0">
        <Bot className="w-4 h-4 text-indigo-600" />
        <h2 className="text-base font-semibold text-gray-900">Delegation</h2>
      </div>

      {stats && stats.runs > 0 && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-xs text-gray-500 flex-shrink-0"
          title={`Across ${stats.runs} completed runs, from the orchestrator's own traces`}
        >
          <span>
            <span className="font-semibold text-gray-700">
              {Math.round((stats.successRate ?? 0) * 100)}%
            </span>{' '}
            success
          </span>
          {stats.medianDurationMs !== null && (
            <span>
              <span className="font-semibold text-gray-700">
                {formatDuration(stats.medianDurationMs)}
              </span>{' '}
              typical
            </span>
          )}
          {stats.averageCostUsd !== null && (
            <span>
              <span className="font-semibold text-gray-700">
                ${stats.averageCostUsd.toFixed(2)}
              </span>{' '}
              per run
            </span>
          )}
          <span className="text-gray-400">({stats.runs} runs)</span>
        </div>
      )}

      {pausedUntil && (
        <div className="flex items-center gap-1.5 mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 flex-shrink-0">
          <PauseCircle className="w-3.5 h-3.5" /> Paced — paused for {timeUntil(pausedUntil)} (usage limit)
        </div>
      )}

      {isEmpty ? (
        <p className="text-sm text-gray-400 italic">No delegated tasks in flight.</p>
      ) : (
        <div className="space-y-4 overflow-y-auto flex-1 min-h-0">
          {running.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <Loader2 className="w-3.5 h-3.5 text-amber-600 animate-spin" />
                <span className="text-sm font-medium text-amber-600">Running</span>
              </div>
              <ul className="space-y-0.5">
                {running.map(e => (
                  <li
                    key={e.asanaTaskGid}
                    onClick={() => onTaskClick?.(e.asanaTaskGid)}
                    className={`text-sm text-gray-800 px-2 py-1 rounded bg-amber-50 ${onTaskClick ? 'cursor-pointer hover:bg-amber-100' : ''}`}
                  >
                    <span className="truncate block">{e.title || 'Task'}<AccountTag entry={e} /></span>
                    {e.startedAt && (
                      <span className="text-xs text-amber-700/70 flex items-center gap-1 mt-0.5">
                        <Clock className="w-3 h-3" /> started {relativeTime(e.startedAt)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-blue-600">Queued</span>
              <span className="text-xs text-gray-400">{queued.length}</span>
            </div>
            {queued.length > 0 ? (
              <ul className="space-y-0.5">
                {queued.map(e => {
                  const eta = etaByGid.get(e.asanaTaskGid);
                  return (
                    <li
                      key={e.asanaTaskGid}
                      onClick={() => onTaskClick?.(e.asanaTaskGid)}
                      className={`text-sm text-gray-700 px-2 py-1 rounded ${onTaskClick ? 'cursor-pointer hover:bg-gray-50' : ''}`}
                    >
                      <span className="truncate block">
                        {e.title || 'Task'}
                        {e.mode === 'now' && <span className="ml-1.5 text-xs text-indigo-500">run now</span>}
                        <AccountTag entry={e} />
                      </span>
                      {eta && (
                        <span
                          className="text-xs text-gray-400 flex items-center gap-1 mt-0.5"
                          title="Estimated start time (based on the pacing budget)"
                        >
                          <Clock className="w-3 h-3" /> est. start {formatEta(eta, new Date())}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-gray-400 italic px-2">Nothing queued.</p>
            )}
          </div>

          {forReview.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-gray-600">For review</span>
                <span className="text-xs text-gray-400">{forReview.length}</span>
              </div>
              <ul className="space-y-1.5">
                {forReview.map(e => {
                  const ok = e.state === 'done' && e.result?.status !== 'failed';
                  return (
                    <li
                      key={e.asanaTaskGid}
                      onClick={() => onTaskClick?.(e.asanaTaskGid)}
                      className={`flex items-start gap-1.5 px-2 py-1.5 rounded bg-gray-50/60 border border-gray-100 ${onTaskClick ? 'cursor-pointer hover:bg-gray-100/60' : ''}`}
                    >
                      {ok ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 mt-0.5 flex-shrink-0" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm text-gray-700 truncate">{e.title || 'Task'}</span>
                          <span className="text-xs text-gray-400 flex-shrink-0">{relativeTime(e.result?.finishedAt || e.updatedAt)}</span>
                        </div>
                        {e.result?.summary && (
                          <p className="text-xs text-gray-500 line-clamp-2">{e.result.summary}</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
