'use client';

import { useEffect, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { Check, Plus, RefreshCw } from 'lucide-react';

import { api } from '@/lib/api';
import { AdherenceTrendChart } from '@/components/sections/exercise/AdherenceTrendChart';
import { describeEntry } from '@/components/sections/exercise/ExerciseEntryList';
import { entryWasPerformed } from '@/lib/exercise-entry';
import { formatEntryDuration } from '@/lib/exercise-targets';
import type { ExerciseAnalysis, ExerciseSession, ExerciseWeekSummary } from '@/types/life';
import { pct } from '@/components/analysis/format';
import { FreeformLogCard } from '../components/FreeformLogCard';
import { MobileSessionSheet } from '../components/MobileSessionSheet';
import { RoutineCard } from '../components/RoutineCard';
import { TodayChecklist } from '../components/TodayChecklist';

// The mobile Exercise view — the primary gym surface, fully read/write like the
// desktop. Today's workout leads as an interactive checklist; below it the
// weekly routine, the numbers, and the planned/recent sessions, each of which
// can be added, edited or deleted from here.

// Which session sheet is open, if any: creating (in 'plan' or 'log' mode) or
// editing an existing session.
type SheetState =
  | { kind: 'create'; mode: 'plan' | 'log' }
  | { kind: 'edit'; session: ExerciseSession }
  | null;

export function ExerciseTab({
  planned,
  recent,
  analysis,
  isLoading,
  error,
  onSessionChanged,
}: {
  planned: ExerciseSession[];
  recent: ExerciseSession[];
  analysis: ExerciseAnalysis | null;
  isLoading: boolean;
  error: string | null;
  onSessionChanged?: () => void;
}) {
  const [sheet, setSheet] = useState<SheetState>(null);
  // Optimistically hidden sessions: filtered out the moment a delete is asked
  // for, put back if the delete fails.
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  // Keep the calendar in sync without a tap: fire a throttled auto-sync once on
  // mount, refreshing the sessions only if it changed something. Non-blocking and
  // silent on error — the manual Sync button remains for explicit syncs.
  const autoSyncedRef = useRef(false);
  useEffect(() => {
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    api
      .syncExerciseCalendar({ auto: true })
      .then(result => {
        const changed = !result.skipped && Boolean(result.created || result.updated || result.removed);
        if (changed) onSessionChanged?.();
      })
      .catch(err => console.error('Auto exercise calendar sync failed:', err));
  }, [onSessionChanged]);

  const syncFromCalendar = async () => {
    setSyncing(true);
    setSyncNote(null);
    setActionError(null);
    try {
      const result = await api.syncExerciseCalendar();
      setSyncNote(
        `${result.created} new, ${result.updated} updated${
          result.removed ? `, ${result.removed} removed` : ''
        }.`
      );
      onSessionChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not sync from the calendar.');
    } finally {
      setSyncing(false);
    }
  };

  const deleteSession = async (session: ExerciseSession) => {
    setActionError(null);
    setDeletedIds(ids => [...ids, session.id]);
    try {
      await api.deleteExerciseSession(session.id);
      onSessionChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not delete the session.');
      setDeletedIds(ids => ids.filter(id => id !== session.id));
    }
  };

  const visible = (sessions: ExerciseSession[]) => sessions.filter(s => !deletedIds.includes(s.id));

  return (
    <div className="space-y-5">
      <TodayChecklist onSessionChanged={onSessionChanged} />

      {/* The escape hatch from the checklist: the day the plan didn't happen. */}
      <FreeformLogCard onLogged={onSessionChanged} />

      {/* The standing weekly routine — glance at, and edit, what each day is. */}
      <RoutineCard />

      {isLoading && <p className="text-center text-sm text-gray-500">Loading sessions…</p>}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {actionError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {actionError}
        </div>
      )}

      {analysis && analysis.totalSessions > 0 && (
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Sessions" value={String(analysis.totalSessions)} />
          <Stat label="Per week" value={String(analysis.sessionsPerWeek)} />
          <Stat label="Streak" value={`${analysis.currentStreakWeeks}w`} />
        </div>
      )}

      {analysis && <AdherenceTrend analysis={analysis} />}

      <SessionGroup
        heading="Planned"
        sessions={visible(planned)}
        empty="Nothing planned."
        dateFormat="EEE d MMM"
        onEdit={session => setSheet({ kind: 'edit', session })}
        action={
          <div className="flex items-center gap-1.5">
            <IconButton
              label="Sync calendar"
              busy={syncing}
              onClick={syncFromCalendar}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
              Sync
            </IconButton>
            <IconButton label="Plan a session" onClick={() => setSheet({ kind: 'create', mode: 'plan' })}>
              <Plus className="h-3.5 w-3.5" />
              Plan
            </IconButton>
          </div>
        }
      />
      {syncNote && <p className="-mt-3 text-xs text-gray-500">{syncNote}</p>}

      <SessionGroup
        heading="Recent"
        sessions={visible(recent)}
        empty="Nothing logged recently."
        dateFormat="EEE d MMM"
        onEdit={session => setSheet({ kind: 'edit', session })}
        action={
          <IconButton label="Log a session" onClick={() => setSheet({ kind: 'create', mode: 'log' })}>
            <Plus className="h-3.5 w-3.5" />
            Log
          </IconButton>
        }
      />

      {analysis && analysis.suggestions.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Suggestions
          </h2>
          <ul className="space-y-2">
            {analysis.suggestions.map(suggestion => (
              <li
                key={suggestion}
                className="rounded-lg border border-gray-200 bg-white p-3 text-sm leading-6 text-gray-700 shadow-sm"
              >
                {suggestion}
              </li>
            ))}
          </ul>
        </section>
      )}

      {sheet && (
        <MobileSessionSheet
          mode={sheet.kind === 'create' ? sheet.mode : 'log'}
          session={sheet.kind === 'edit' ? sheet.session : undefined}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            onSessionChanged?.();
          }}
          onDelete={sheet.kind === 'edit' ? () => deleteSession(sheet.session) : undefined}
        />
      )}
    </div>
  );
}

function IconButton({
  label,
  busy,
  onClick,
  children,
}: {
  label: string;
  busy?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      className="flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-700 active:bg-gray-50 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SessionGroup({
  heading,
  sessions,
  empty,
  dateFormat,
  onEdit,
  action,
}: {
  heading: string;
  sessions: ExerciseSession[];
  empty: string;
  dateFormat: string;
  onEdit: (session: ExerciseSession) => void;
  action?: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">{heading}</h2>
        {action}
      </div>
      {sessions.length === 0 ? (
        <p className="text-sm text-gray-400">{empty}</p>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
          <ul className="divide-y divide-gray-100">
            {sessions.map(session => {
              const entries = session.exercises ?? [];
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onEdit(session)}
                    aria-label={`Edit ${session.label || session.type}`}
                    className="w-full px-3 py-2.5 text-left active:bg-gray-50"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900">
                          {session.label || session.type}
                        </p>
                        <p className="text-xs text-gray-500">
                          {format(parseISO(session.date), dateFormat)}
                          {session.intensity ? ` · ${session.intensity}` : ''}
                        </p>
                      </div>
                      <span className="flex-shrink-0 text-xs tabular-nums text-gray-600">
                        {session.durationMinutes ? formatEntryDuration(session.durationMinutes) : ''}
                        {session.distanceKm ? ` · ${session.distanceKm} km` : ''}
                      </span>
                    </div>

                    {/* The exercises are the interesting part on a phone: this is
                        what you check standing in the gym. */}
                    {entries.length > 0 && (
                      <ul className="mt-1.5 space-y-1 border-l-2 border-gray-100 pl-2.5">
                        {entries.map(entry => {
                          // In a logged session a not-done entry is a skipped
                          // exercise; a planned session keeps everything pending.
                          const skipped = session.completed && !entryWasPerformed(entry);
                          const done = session.completed && entryWasPerformed(entry);
                          return (
                            <li key={entry.id} className="flex items-baseline justify-between gap-2">
                              <span
                                className={`flex min-w-0 items-baseline gap-1 text-xs ${
                                  skipped ? 'text-gray-400' : 'text-gray-700'
                                }`}
                              >
                                {done && (
                                  <Check className="h-3 w-3 shrink-0 translate-y-0.5 text-emerald-600" />
                                )}
                                <span className="min-w-0">{entry.name}</span>
                                {skipped && (
                                  <span className="shrink-0 rounded bg-gray-100 px-1 text-[9px] font-medium uppercase tracking-wide text-gray-500">
                                    skipped
                                  </span>
                                )}
                              </span>
                              <span
                                className={`flex-shrink-0 text-[11px] tabular-nums ${
                                  skipped ? 'text-gray-400 line-through' : 'text-gray-500'
                                }`}
                              >
                                {describeEntry(entry)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

// Fewer weeks than the desktop: a phone can't read twelve.
const TREND_WEEKS = 8;

function pctLabel(rate: number | null): string {
  return rate === null ? '—' : `${pct(rate)}%`;
}

// The mobile adherence trend: recent weeks as a two-series line chart (see
// AdherenceTrendChart) — exercise adherence (of a session's planned exercises,
// how many were done) and plan adherence (sessions done vs planned). Both
// aggregates head the card; empty weeks leave a gap, not a 0% failure; only
// shown once two weeks carry a reading.
function AdherenceTrend({ analysis }: { analysis: ExerciseAnalysis }) {
  const recent = analysis.byWeek.slice(-TREND_WEEKS);
  const withData = recent.filter(
    (w: ExerciseWeekSummary) => w.exerciseAdherence !== null || w.sessionAdherence !== null
  );
  if (withData.length < 2) return null;

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Adherence trend
        </h2>
        <span className="text-[11px] tabular-nums text-gray-500">
          {pctLabel(analysis.exerciseAdherence)} exercises · {pctLabel(analysis.planAdherence)} plan
        </span>
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        <AdherenceTrendChart weeks={analysis.byWeek} maxWeeks={TREND_WEEKS} height={150} compact />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 text-center shadow-sm">
      <div className="text-xl font-bold tabular-nums text-gray-900">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}
