'use client';

import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { FlaskConical, HeartPulse, Pencil, Plus, Trash2 } from 'lucide-react';

import { api } from '@/lib/api';
import { TrendLineChart } from '@/components/charts/TrendLineChart';
import { useToast } from '@/hooks/useToast';
import type {
  Experiment,
  ExperimentStatus,
  ExperimentVerdict,
  WellbeingAnalysis,
} from '@/types/wellbeing';
import { MobileHabitCheckCard } from '../components/MobileHabitCheckCard';
import { MobileExperimentSheet } from '../components/MobileExperimentSheet';

// Same colourblind-validated pair as desktop: consistency emerald, 7-day rate
// indigo.
const CONSISTENCY_COLOUR = '#059669';
const ROLLING_COLOUR = '#6366f1';

// Mobile Wellbeing is read/write, matching desktop: today's habits are answered
// in the card up top, and experiments can be created, checked in on, edited and
// deleted from here.
export function WellbeingTab({
  analysis,
  experiments,
  isLoading,
  error,
  onChanged,
}: {
  analysis: WellbeingAnalysis | null;
  experiments: Experiment[];
  isLoading: boolean;
  error: string | null;
  onChanged: () => void;
}) {
  if (isLoading) {
    return <p className="py-10 text-center text-sm text-gray-500">Loading…</p>;
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Today&apos;s habits
        </h2>
        <MobileHabitCheckCard onSaved={onChanged} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Trends</h2>
        {!analysis || analysis.daysLogged === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-8 text-center">
            <HeartPulse className="mx-auto h-8 w-8 text-gray-400" />
            <p className="mt-3 text-sm font-medium text-gray-700">Nothing logged yet</p>
            <p className="mt-1 text-xs text-gray-500">Answer today&apos;s habits to start the record.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {analysis.habits.map(habit => (
              <div
                key={habit.habitId}
                className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-gray-900">{habit.label}</p>
                  <span className="text-sm tabular-nums text-gray-600">
                    {habit.rate === null ? '—' : `${Math.round(habit.rate * 100)}%`}
                  </span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-emerald-500"
                    style={{ width: `${(habit.rate ?? 0) * 100}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-gray-500">
                  {habit.currentStreak > 0
                    ? `${habit.currentStreak}-day streak`
                    : 'No current streak'}
                  {' · '}
                  {habit.daysDone}/{habit.daysLogged} logged days
                  {habit.reasons[0] ? ` · usually: ${habit.reasons[0].reason}` : ''}
                </p>
                {habit.daily.length >= 2 && (
                  <div className="mt-3">
                    <TrendLineChart
                      labels={habit.daily.map(d => format(parseISO(d.date), 'd MMM'))}
                      series={[
                        {
                          label: 'Consistency',
                          color: CONSISTENCY_COLOUR,
                          values: habit.daily.map(d => d.consistency * 100),
                        },
                        {
                          label: '7-day rate',
                          color: ROLLING_COLOUR,
                          values: habit.daily.map(d => d.rolling7 * 100),
                        },
                      ]}
                      height={120}
                      compact
                    />
                    <p className="mt-1 text-[10px] text-gray-400">
                      Consistency weights recent days most — consecutive misses compound, a single
                      miss recovers fast.
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <ExperimentsSection experiments={experiments} onChanged={onChanged} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

const STATUS_STYLE: Record<ExperimentStatus, { label: string; className: string }> = {
  planned: { label: 'Planned', className: 'bg-gray-100 text-gray-600' },
  running: { label: 'Running', className: 'bg-blue-100 text-blue-700' },
  complete: { label: 'Complete', className: 'bg-emerald-100 text-emerald-700' },
  abandoned: { label: 'Abandoned', className: 'bg-gray-100 text-gray-500' },
};

const VERDICT_STYLE: Record<ExperimentVerdict, { label: string; className: string }> = {
  worked: { label: 'Worked', className: 'bg-emerald-500 text-white' },
  mixed: { label: 'Mixed', className: 'bg-amber-500 text-white' },
  'no-effect': { label: 'No effect', className: 'bg-gray-500 text-white' },
  inconclusive: { label: 'Inconclusive', className: 'bg-indigo-500 text-white' },
};

function ExperimentsSection({
  experiments,
  onChanged,
}: {
  experiments: Experiment[];
  onChanged: () => void;
}) {
  const toast = useToast();
  // Local mirror so a check-in / start / delete can show immediately and roll
  // back on failure; re-synced whenever the hook hands down fresh data.
  const [items, setItems] = useState(experiments);
  useEffect(() => setItems(experiments), [experiments]);

  // null = closed, 'new' = create, otherwise the experiment being edited.
  const [sheet, setSheet] = useState<'new' | Experiment | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const runWrite = async (
    id: string,
    optimistic: (list: Experiment[]) => Experiment[],
    action: () => Promise<unknown>
  ) => {
    const prev = items;
    setBusyId(id);
    setItems(optimistic(prev));
    try {
      await action();
      onChanged();
    } catch (err) {
      console.error('Experiment write failed:', err);
      setItems(prev);
      toast.error('That didn’t save — check your connection.');
    } finally {
      setBusyId(null);
    }
  };

  const checkIn = (experiment: Experiment, rating: number) =>
    runWrite(
      experiment.id,
      list =>
        list.map(e =>
          e.id === experiment.id
            ? { ...e, checkIns: [...e.checkIns, { at: new Date().toISOString(), rating }] }
            : e
        ),
      () => api.checkInExperiment(experiment.id, { rating })
    );

  const start = (experiment: Experiment) =>
    runWrite(
      experiment.id,
      list => list.map(e => (e.id === experiment.id ? { ...e, status: 'running' } : e)),
      () => api.updateExperiment(experiment.id, { status: 'running' })
    );

  const remove = (experiment: Experiment) =>
    runWrite(
      experiment.id,
      list => list.filter(e => e.id !== experiment.id),
      () => api.deleteExperiment(experiment.id)
    );

  const groups = [
    { title: 'Running', items: items.filter(e => e.status === 'running') },
    { title: 'Planned', items: items.filter(e => e.status === 'planned') },
    {
      title: 'Finished',
      items: items.filter(e => e.status === 'complete' || e.status === 'abandoned'),
    },
  ].filter(g => g.items.length > 0);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Experiments</h2>
        <button
          type="button"
          onClick={() => setSheet('new')}
          className="inline-flex items-center gap-1 rounded-md bg-orange-500 px-2.5 py-1.5 text-xs font-medium text-white"
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-8 text-center">
          <FlaskConical className="mx-auto h-8 w-8 text-gray-400" />
          <p className="mt-3 text-sm font-medium text-gray-700">Nothing running</p>
          <p className="mt-1 text-xs text-gray-500">
            Tap New to set up your first experiment.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map(group => (
            <div key={group.title}>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                {group.title}
              </h3>
              <div className="space-y-2">
                {group.items.map(experiment => (
                  <ExperimentCard
                    key={experiment.id}
                    experiment={experiment}
                    busy={busyId === experiment.id}
                    onCheckIn={rating => checkIn(experiment, rating)}
                    onStart={() => start(experiment)}
                    onEdit={() => setSheet(experiment)}
                    onDelete={() => remove(experiment)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {sheet && (
        <MobileExperimentSheet
          experiment={sheet === 'new' ? undefined : sheet}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function ExperimentCard({
  experiment,
  busy,
  onCheckIn,
  onStart,
  onEdit,
  onDelete,
}: {
  experiment: Experiment;
  busy: boolean;
  onCheckIn: (rating: number) => void;
  onStart: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const status = STATUS_STYLE[experiment.status];
  const active = experiment.status === 'running' || experiment.status === 'planned';

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-medium text-gray-900">{experiment.title}</p>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}>
              {status.label}
            </span>
            {experiment.verdict && (
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  VERDICT_STYLE[experiment.verdict].className
                }`}
              >
                {VERDICT_STYLE[experiment.verdict].label}
              </span>
            )}
          </div>
          {experiment.protocol && (
            <p className="mt-1 text-xs text-gray-600">{experiment.protocol}</p>
          )}
          <p className="mt-1 text-[11px] text-gray-400">
            {experiment.endDate
              ? `Until ${format(parseISO(experiment.endDate), 'd MMM')}`
              : 'No end date'}
            {experiment.checkIns.length > 0 &&
              ` · ${experiment.checkIns.length} check-in${
                experiment.checkIns.length === 1 ? '' : 's'
              }`}
          </p>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            aria-label="Edit experiment"
            className="p-1.5 text-gray-400"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
            aria-label="Delete experiment"
            className="p-1.5 text-gray-300 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {confirmingDelete && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-2">
          <span className="text-xs text-rose-700">Delete this experiment?</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded-md px-2 py-1 text-xs font-medium text-gray-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
              className="rounded-md bg-rose-500 px-2.5 py-1 text-xs font-medium text-white"
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {experiment.status === 'planned' && (
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          className="mt-2 w-full rounded-md border border-gray-200 py-2 text-xs font-medium text-gray-600 disabled:opacity-50"
        >
          Start it
        </button>
      )}

      {active && (
        <div className="mt-2.5 border-t border-gray-100 pt-2.5">
          <p className="text-[11px] font-medium text-gray-500">How&apos;s it going? Tap to log.</p>
          <div className="mt-1.5 grid grid-cols-5 gap-1.5" role="group" aria-label="Check in">
            {[1, 2, 3, 4, 5].map(n => (
              <button
                key={n}
                type="button"
                onClick={() => onCheckIn(n)}
                disabled={busy}
                aria-label={`Log ${n} out of 5`}
                className="rounded-md border border-gray-200 bg-white py-2 text-sm font-medium tabular-nums text-gray-700 transition-colors active:bg-blue-500 active:text-white disabled:opacity-50"
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
