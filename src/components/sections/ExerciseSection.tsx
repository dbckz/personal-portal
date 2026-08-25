'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format, parseISO, subDays } from 'date-fns';
import { Check, ChevronDown, ChevronRight, Plus, RefreshCw, Trash2, Wand2 } from 'lucide-react';

import { api } from '@/lib/api';
import { parseLoad, parseVolume } from '@/lib/exercise-parse';
import { formatEntryDuration } from '@/lib/exercise-targets';
import type {
  ExerciseAnalysis,
  ExerciseIntensity,
  ExerciseSession,
  ExerciseWeekSummary,
} from '@/types/life';
import { SectionGoals } from '@/components/goals/SectionGoals';
import { AdherenceTrendChart } from './exercise/AdherenceTrendChart';
import { ExerciseEntryList } from './exercise/ExerciseEntryList';
import { ExerciseToday } from './exercise/ExerciseToday';
import { FreeformLog } from './exercise/FreeformLog';
import { ProgressionTab } from './exercise/ProgressionTab';
import { RoutineTab } from './exercise/RoutineTab';
import { TodayTargets } from './exercise/TodayTargets';

interface ExerciseSectionProps {
  subTab: string;
}

export function ExerciseSection({ subTab }: ExerciseSectionProps) {
  if (subTab === 'goals') {
    return (
      <SectionGoals
        sectionId="exercise"
        emptyHint="No exercise goals yet. Set one here, or run a monthly planning session from the Goals section."
      />
    );
  }
  if (subTab === 'today') return <ExerciseToday />;
  if (subTab === 'routine') return <RoutineTab />;
  if (subTab === 'analysis') return <ExerciseAnalysisTab />;
  if (subTab === 'progress') return <ProgressionTab />;
  // 'plan' and 'history' are the same log viewed forwards and backwards, so
  // they share one component and differ only in filter and affordances.
  return <ExerciseLog mode={subTab === 'plan' ? 'plan' : 'history'} />;
}

// ---------------------------------------------------------------------------
// Plan / history
// ---------------------------------------------------------------------------

const TODAY = () => format(new Date(), 'yyyy-MM-dd');

// Did a sync response actually change any sessions? Used to avoid a needless
// reload after a throttled/no-op auto sync.
function syncChangedSomething(result: Awaited<ReturnType<typeof api.syncExerciseCalendar>>): boolean {
  if (result.skipped) return false;
  return Boolean(result.created || result.updated || result.removed);
}

function ExerciseLog({ mode }: { mode: 'plan' | 'history' }) {
  const [sessions, setSessions] = useState<ExerciseSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The two ways to log after the fact: the structured form, and a blob of text
  // for the day that went off-plan. Only one is open at a time.
  const [formOpen, setFormOpen] = useState<'structured' | 'freeform' | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // The plan looks forward from today; history looks back six months, which
      // covers the analysis window twice over without loading everything.
      const res =
        mode === 'plan'
          ? await api.getExerciseSessions(TODAY())
          : await api.getExerciseSessions(format(subDays(new Date(), 183), 'yyyy-MM-dd'), TODAY());
      setSessions(res.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions.');
    } finally {
      setIsLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the calendar in sync without a button press: fire a throttled auto-sync
  // once on mount, and refresh the list only if it actually changed something.
  // Non-blocking and silent on error — the manual button remains for explicit
  // syncs and error surfacing.
  const autoSyncedRef = useRef(false);
  useEffect(() => {
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    api
      .syncExerciseCalendar({ auto: true })
      .then(result => {
        if (syncChangedSomething(result)) load();
      })
      .catch(err => console.error('Auto exercise calendar sync failed:', err));
  }, [load]);

  const visible = useMemo(() => {
    const filtered =
      mode === 'plan'
        ? sessions.filter(s => s.planned && !s.completed)
        : sessions.filter(s => s.completed);
    // Plans read soonest-first; history reads most-recent-first.
    return [...filtered].sort((a, b) =>
      mode === 'plan' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)
    );
  }, [sessions, mode]);

  const complete = async (session: ExerciseSession) => {
    try {
      await api.updateExerciseSession(session.id, { completed: true });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the session.');
    }
  };

  const syncFromCalendar = async () => {
    setIsSyncing(true);
    setSyncNote(null);
    try {
      const result = await api.syncExerciseCalendar();
      setSyncNote(
        `${result.created} new, ${result.updated} updated${
          result.removed ? `, ${result.removed} removed` : ''
        }.`
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync from the calendar.');
    } finally {
      setIsSyncing(false);
    }
  };

  const remove = async (session: ExerciseSession) => {
    try {
      await api.deleteExerciseSession(session.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete the session.');
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-semibold text-gray-900">
            {mode === 'plan' ? 'Planned sessions' : 'Session history'}
          </h2>
          <p className="text-sm text-gray-500">
            {mode === 'plan'
              ? 'What you intend to do from today onwards.'
              : 'Everything logged in the last six months.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {mode === 'plan' && (
            <button
              onClick={syncFromCalendar}
              disabled={isSyncing}
              title="Read planned sessions from the all-day events on your personal calendar"
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
              Sync calendar
            </button>
          )}
          {mode === 'history' && (
            <button
              onClick={() => setFormOpen(open => (open === 'freeform' ? null : 'freeform'))}
              title="Describe what you did in your own words and have it read into the log"
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              <Wand2 className="w-4 h-4" />
              Log freehand
            </button>
          )}
          <button
            onClick={() => setFormOpen(open => (open === 'structured' ? null : 'structured'))}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-white bg-gray-900 rounded-md hover:bg-gray-800"
          >
            <Plus className="w-4 h-4" />
            {mode === 'plan' ? 'Plan a session' : 'Log a session'}
          </button>
        </div>
      </div>

      {formOpen === 'structured' && (
        <SessionForm
          mode={mode}
          onCancel={() => setFormOpen(null)}
          onSaved={() => {
            setFormOpen(null);
            load();
          }}
          onError={setError}
        />
      )}

      {formOpen === 'freeform' && (
        <FreeformLog
          date={TODAY()}
          onCancel={() => setFormOpen(null)}
          onSaved={() => {
            setFormOpen(null);
            load();
          }}
        />
      )}

      {mode === 'plan' && <TodayTargets />}

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {syncNote && <p className="mb-3 text-sm text-gray-500">{syncNote}</p>}
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}

      {!isLoading && visible.length === 0 && (
        <p className="text-sm text-gray-500">
          {mode === 'plan' ? 'Nothing planned yet.' : 'Nothing logged yet.'}
        </p>
      )}

      <div className="space-y-2">
        {visible.map(session => {
          const entries = session.exercises ?? [];
          const isOpen = expandedId === session.id;
          return (
            <div key={session.id} className="bg-white rounded-lg border border-gray-200">
              <div className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {(entries.length > 0 || session.freeformText) && (
                      <button
                        onClick={() => setExpandedId(isOpen ? null : session.id)}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? 'Hide exercises' : 'Show exercises'}
                        className="p-0.5 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                      >
                        {isOpen ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </button>
                    )}
                    <span className="font-medium text-gray-900">
                      {session.label || session.type}
                    </span>
                    {session.intensity && (
                      <span className="px-1.5 py-0.5 text-[11px] rounded bg-gray-100 text-gray-600 capitalize">
                        {session.intensity}
                      </span>
                    )}
                    {session.source === 'calendar' && (
                      <span className="px-1.5 py-0.5 text-[11px] rounded bg-blue-100 text-blue-700">
                        calendar
                      </span>
                    )}
                    {session.source === 'freeform' && (
                      <span className="px-1.5 py-0.5 text-[11px] rounded bg-violet-100 text-violet-700">
                        freehand
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500">
                    {format(parseISO(session.date), 'EEE d MMM')}
                    {session.durationMinutes ? ` · ${formatEntryDuration(session.durationMinutes)}` : ''}
                    {session.distanceKm ? ` · ${session.distanceKm} km` : ''}
                    {entries.length > 0
                      ? ` · ${entries.length} exercise${entries.length === 1 ? '' : 's'}`
                      : ''}
                  </div>
                  {session.notes && <p className="mt-0.5 text-sm text-gray-600">{session.notes}</p>}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {mode === 'plan' && (
                    <button
                      onClick={() => complete(session)}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-md hover:bg-emerald-100"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Done
                    </button>
                  )}
                  <button
                    onClick={() => remove(session)}
                    className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
                    aria-label="Delete session"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="border-t border-gray-100 px-3 pb-2">
                  <ExerciseEntryList entries={entries} completed={session.completed} />
                  {/* What was actually written, for a session logged freehand.
                      The parse above is a reading of this, not a replacement
                      for it. */}
                  {session.freeformText && (
                    <p className="mt-2 whitespace-pre-wrap border-l-2 border-violet-200 pl-2.5 text-xs leading-5 text-gray-500">
                      {session.freeformText}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const INTENSITIES: ExerciseIntensity[] = ['easy', 'moderate', 'hard'];

// One in-progress exercise row in the log form.
interface DraftEntry {
  key: string;
  name: string;
  volume: string;
  load: string;
  notes: string;
}

function SessionForm({
  mode,
  onCancel,
  onSaved,
  onError,
}: {
  mode: 'plan' | 'history';
  onCancel: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [date, setDate] = useState(TODAY);
  const [type, setType] = useState('');
  const [duration, setDuration] = useState('');
  const [distance, setDistance] = useState('');
  const [intensity, setIntensity] = useState<ExerciseIntensity | ''>('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  // Per-exercise rows, for logging what was actually done. Entered as free text
  // in the same shorthand as the training log ("3*8", "27kg") and parsed
  // server-side, so logging is as quick as writing it down.
  const [entries, setEntries] = useState<DraftEntry[]>([]);

  const addEntry = () =>
    setEntries(prev => [...prev, { key: `${prev.length}-${prev.length}`, name: '', volume: '', load: '', notes: '' }]);
  const updateEntry = (key: string, patch: Partial<DraftEntry>) =>
    setEntries(prev => prev.map(e => (e.key === key ? { ...e, ...patch } : e)));
  const removeEntry = (key: string) => setEntries(prev => prev.filter(e => e.key !== key));

  const save = async () => {
    if (!type.trim()) {
      onError('Give the session a type (run, gym, climbing…).');
      return;
    }
    setSaving(true);
    try {
      const named = entries.filter(e => e.name.trim());
      await api.createExerciseSession({
        date,
        type: type.trim(),
        ...(duration.trim() ? { durationMinutes: Number(duration) } : {}),
        ...(distance.trim() ? { distanceKm: Number(distance) } : {}),
        ...(intensity ? { intensity } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(named.length
          ? {
              exercises: named.map(e => ({
                name: e.name.trim(),
                ...parseVolume(e.volume),
                ...parseLoad(e.load),
                ...(e.volume.trim() ? { volumeText: e.volume.trim() } : {}),
                ...(e.load.trim() ? { loadText: e.load.trim() } : {}),
                ...(e.notes.trim() ? { notes: e.notes.trim() } : {}),
              })),
            }
          : {}),
        planned: mode === 'plan',
        completed: mode === 'history',
      });
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save the session.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-4 p-4 rounded-lg bg-white border border-gray-200">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs font-semibold text-gray-600 mb-1">Date</span>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-semibold text-gray-600 mb-1">Type</span>
          <input
            value={type}
            onChange={e => setType(e.target.value)}
            placeholder="run, gym, climbing"
            autoFocus
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-semibold text-gray-600 mb-1">Minutes (optional)</span>
          <input
            type="number"
            min="1"
            value={duration}
            onChange={e => setDuration(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-semibold text-gray-600 mb-1">Distance (km, optional)</span>
          <input
            type="number"
            min="0"
            step="0.1"
            value={distance}
            onChange={e => setDistance(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-semibold text-gray-600 mb-1">Intensity</span>
          <select
            value={intensity}
            onChange={e => setIntensity(e.target.value as ExerciseIntensity | '')}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
          >
            <option value="">Not recorded</option>
            {INTENSITIES.map(i => (
              <option key={i} value={i} className="capitalize">
                {i}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-semibold text-gray-600 mb-1">Notes</span>
          <input
            value={notes}
            onChange={e => setNotes(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
          />
        </label>
      </div>

      {mode === 'history' && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-600">Exercises</span>
            <span className="text-[11px] text-gray-400">
              Same shorthand as your log: 3*8 · 27kg · 3*30 secs each side · 2 km · 20 mins
            </span>
          </div>

          <div className="space-y-2">
            {entries.map(entry => (
              <div key={entry.key} className="flex flex-wrap items-start gap-2">
                <input
                  value={entry.name}
                  onChange={e => updateEntry(entry.key, { name: e.target.value })}
                  placeholder="Exercise"
                  className="flex-1 min-w-40 px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                />
                <input
                  value={entry.volume}
                  onChange={e => updateEntry(entry.key, { volume: e.target.value })}
                  placeholder="3*8 · 3*30 secs · 2 km"
                  className="min-w-40 flex-1 px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                />
                <input
                  value={entry.load}
                  onChange={e => updateEntry(entry.key, { load: e.target.value })}
                  placeholder="27kg / bodyweight"
                  className="w-40 px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                />
                <input
                  value={entry.notes}
                  onChange={e => updateEntry(entry.key, { notes: e.target.value })}
                  placeholder="How did it feel?"
                  className="flex-1 min-w-40 px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                />
                <button
                  onClick={() => removeEntry(entry.key)}
                  className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
                  aria-label="Remove exercise"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={addEntry}
            className="mt-2 flex w-full items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 border border-dashed border-gray-300 rounded-md hover:bg-gray-50"
          >
            <Plus className="w-4 h-4" />
            Add exercise
          </button>
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-2 text-sm font-medium text-gray-700 rounded-md hover:bg-gray-100"
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 text-sm font-semibold text-white bg-gray-900 rounded-md hover:bg-gray-800 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

// The most recent stretch shown as a line chart: a longer training record would
// squeeze into unreadable slivers, and twelve weeks is enough to read a trend.
const TREND_WEEKS = 12;

// Adherence across recent weeks, oldest on the left, as a two-series line chart
// (see AdherenceTrendChart): exercise adherence — of a session's planned
// exercises, how many were done — and plan adherence — sessions done vs planned.
// Weeks with no reading leave a gap rather than reading as a 0% failure. Only
// shown once at least two weeks carry a reading — a single point is a data
// point, not a trend.
function AdherenceTrend({ weeks }: { weeks: ExerciseWeekSummary[] }) {
  const recent = weeks.slice(-TREND_WEEKS);
  const withData = recent.filter(
    w => w.exerciseAdherence !== null || w.sessionAdherence !== null
  );
  if (withData.length < 2) return null;

  return (
    <section className="mb-6">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">
        Adherence trend
      </h3>
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <AdherenceTrendChart weeks={weeks} maxWeeks={TREND_WEEKS} height={180} />
      </div>
    </section>
  );
}

function ExerciseAnalysisTab() {
  const [analysis, setAnalysis] = useState<ExerciseAnalysis | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getExerciseAnalysis()
      .then(res => !cancelled && setAnalysis(res.analysis))
      .catch(err => console.error('Failed to load exercise analysis:', err))
      .finally(() => !cancelled && setIsLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading) return <p className="max-w-3xl mx-auto p-6 text-sm text-gray-500">Analysing…</p>;
  if (!analysis) return <p className="max-w-3xl mx-auto p-6 text-sm text-gray-500">No analysis available.</p>;

  const peakSessions = Math.max(1, ...analysis.byWeek.map(w => w.sessions));

  return (
    <div className="max-w-3xl mx-auto p-6">
      <p className="text-sm text-gray-500 mb-4">
        {format(parseISO(analysis.from), 'd MMM yyyy')} – {format(parseISO(analysis.to), 'd MMM yyyy')}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <Stat label="Sessions" value={String(analysis.totalSessions)} />
        <Stat label="Exercises done" value={String(analysis.totalExercisesDone)} />
        <Stat label="Per week" value={String(analysis.sessionsPerWeek)} />
        <Stat
          label="Plan adherence"
          value={analysis.planAdherence === null ? '—' : `${Math.round(analysis.planAdherence * 100)}%`}
        />
        <Stat
          label="Exercise adherence"
          value={
            analysis.exerciseAdherence === null
              ? '—'
              : `${Math.round(analysis.exerciseAdherence * 100)}%`
          }
        />
      </div>

      {analysis.currentStreakWeeks > 0 && (
        <p className="mb-6 text-sm text-gray-700">
          Current streak: <strong>{analysis.currentStreakWeeks}</strong> consecutive week
          {analysis.currentStreakWeeks === 1 ? '' : 's'} with at least one session.
        </p>
      )}

      <AdherenceTrend weeks={analysis.byWeek} />

      {analysis.byWeek.length > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">
            Sessions per week
          </h3>
          <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-1.5">
            {analysis.byWeek.map(week => (
              <div key={week.weekStart} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-xs text-gray-500 tabular-nums">
                  {format(parseISO(week.weekStart), 'd MMM')}
                </span>
                <div className="flex-1 h-3 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full"
                    style={{ width: `${(week.sessions / peakSessions) * 100}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right text-xs text-gray-600 tabular-nums">
                  {week.sessions} session{week.sessions === 1 ? '' : 's'}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {analysis.byType.length > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">By type</h3>
          <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 font-semibold">Type</th>
                  <th className="px-4 py-2 font-semibold">Sessions</th>
                  <th className="px-4 py-2 font-semibold">Exercises</th>
                  <th className="px-4 py-2 font-semibold">Distance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {analysis.byType.map(row => (
                  <tr key={row.type}>
                    <td className="px-4 py-2 font-medium text-gray-900">{row.type}</td>
                    <td className="px-4 py-2 text-gray-600 tabular-nums">{row.sessions}</td>
                    <td className="px-4 py-2 text-gray-600 tabular-nums">{row.exercisesDone}</td>
                    <td className="px-4 py-2 text-gray-600 tabular-nums">
                      {row.distanceKm ? `${row.distanceKm} km` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Suggestions</h3>
        {analysis.suggestions.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing worth flagging — volume, spread and adherence all look reasonable.
          </p>
        ) : (
          <ul className="space-y-2">
            {analysis.suggestions.map(suggestion => (
              <li
                key={suggestion}
                className="bg-white rounded-lg border border-gray-200 p-3 text-sm text-gray-700"
              >
                {suggestion}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3 text-center">
      <div className="text-2xl font-bold text-gray-900 tabular-nums">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}
