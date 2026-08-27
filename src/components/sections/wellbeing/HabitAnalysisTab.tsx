'use client';

import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';

import { api } from '@/lib/api';
import { TrendLineChart } from '@/components/charts/TrendLineChart';
import type { HabitSummary, WellbeingAnalysis } from '@/types/wellbeing';

// Consistency in emerald, the 7-day rolling done-rate in indigo — the same
// colourblind-validated pair the exercise adherence chart uses.
const CONSISTENCY_COLOUR = '#059669';
const ROLLING_COLOUR = '#6366f1';

// The windows offered above the analysis. 90 days matches the API default.
const WINDOWS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'A year' },
];

export function HabitAnalysisTab() {
  const [analysis, setAnalysis] = useState<WellbeingAnalysis | null>(null);
  const [windowDays, setWindowDays] = useState(90);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The window buttons set `isLoading` themselves rather than the effect doing
  // it on every run — a synchronous setState in an effect body just costs an
  // extra render pass, and the initial state already covers the first load.
  const changeWindow = (days: number) => {
    if (days === windowDays) return;
    setIsLoading(true);
    setWindowDays(days);
  };

  useEffect(() => {
    let cancelled = false;
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - (windowDays - 1));
    api
      .getWellbeingAnalysis(format(from, 'yyyy-MM-dd'), format(to, 'yyyy-MM-dd'))
      .then(res => {
        if (cancelled) return;
        setAnalysis(res.analysis);
        setError(null);
      })
      .catch(err => {
        console.error('Failed to load wellbeing analysis:', err);
        if (!cancelled) setError('Could not load the analysis.');
      })
      .finally(() => !cancelled && setIsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [windowDays]);

  if (isLoading && !analysis) {
    return <p className="max-w-3xl mx-auto p-6 text-sm text-gray-500">Analysing…</p>;
  }
  if (error) return <p className="max-w-3xl mx-auto p-6 text-sm text-red-600">{error}</p>;
  if (!analysis) return null;

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          {format(parseISO(analysis.from), 'd MMM yyyy')} – {format(parseISO(analysis.to), 'd MMM yyyy')}
          {' · '}
          {analysis.daysLogged} day{analysis.daysLogged === 1 ? '' : 's'} logged
        </p>
        <div className="inline-flex rounded-md border border-gray-200 overflow-hidden text-xs font-medium">
          {WINDOWS.map(w => (
            <button
              key={w.days}
              type="button"
              onClick={() => changeWindow(w.days)}
              aria-pressed={windowDays === w.days}
              className={`px-2.5 py-1 transition-colors ${
                windowDays === w.days
                  ? 'bg-orange-500 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {analysis.daysLogged === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center">
          <p className="text-sm font-medium text-gray-700">Nothing logged in this window.</p>
          <p className="mt-1 text-xs text-gray-400">
            The habit questions are asked at the end of the daily review — answer them there and the
            record builds itself.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {analysis.habits.map(habit => (
            <HabitCard key={habit.habitId} habit={habit} />
          ))}
        </div>
      )}

      {analysis.suggestions.length > 0 && (
        <section className="mt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">
            What the numbers say
          </h3>
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
        </section>
      )}

      {analysis.recentNotes.length > 0 && (
        <section className="mt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">
            Recent notes
          </h3>
          <ul className="space-y-2">
            {analysis.recentNotes.map(note => (
              <li key={note.date} className="bg-white rounded-lg border border-gray-200 p-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-400">
                  {format(parseISO(note.date), 'EEE d MMM')}
                </div>
                <p className="mt-1 text-sm text-gray-700 whitespace-pre-wrap">{note.note}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function HabitCard({ habit }: { habit: HabitSummary }) {
  const peak = Math.max(1, ...habit.byWeek.map(w => w.logged));

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-gray-900">{habit.label}</h3>
        <span className="text-sm text-gray-500 tabular-nums">
          {habit.daysDone} of {habit.daysLogged} logged days
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <Stat
          label="Hit rate"
          value={habit.rate === null ? '—' : `${Math.round(habit.rate * 100)}%`}
        />
        <Stat label="Current streak" value={String(habit.currentStreak)} />
        <Stat label="Longest streak" value={String(habit.longestStreak)} />
      </div>

      <HabitDailyChart habit={habit} />

      {habit.byWeek.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">By week</h4>
          <div className="space-y-1.5">
            {habit.byWeek.map(week => (
              <div key={week.weekStart} className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-xs text-gray-500 tabular-nums">
                  {format(parseISO(week.weekStart), 'd MMM')}
                </span>
                {/* Two-layer bar: the pale track is the days actually logged
                    that week, the solid fill the days done. A short pale bar
                    therefore reads as "barely reviewed", not "barely done". */}
                <div className="flex-1 h-3 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full bg-emerald-100"
                    style={{ width: `${(week.logged / peak) * 100}%` }}
                  >
                    <div
                      className="h-full bg-emerald-500 rounded-r-full"
                      style={{ width: week.logged ? `${(week.done / week.logged) * 100}%` : '0%' }}
                    />
                  </div>
                </div>
                <span className="w-20 shrink-0 text-right text-xs text-gray-600 tabular-nums">
                  {week.done}/{week.logged}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {habit.reasons.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">
            Why it didn’t happen
          </h4>
          <ul className="space-y-1">
            {habit.reasons.map(reason => (
              <li
                key={reason.reason}
                className="flex items-baseline justify-between gap-3 text-sm text-gray-700"
              >
                <span>{reason.reason}</span>
                <span className="shrink-0 text-xs text-gray-400 tabular-nums">
                  ×{reason.count} · {format(parseISO(reason.lastOn), 'd MMM')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// The daily consistency chart. Needs at least two past days to draw a line —
// a single point is not a trend.
function HabitDailyChart({ habit }: { habit: HabitSummary }) {
  if (habit.daily.length < 2) return null;

  const labels = habit.daily.map(d => format(parseISO(d.date), 'd MMM'));
  const series = [
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
  ];

  return (
    <div className="mt-4">
      <h4 className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">Daily consistency</h4>
      <TrendLineChart labels={labels} series={series} height={168} />
      <p className="mt-1.5 text-[11px] text-gray-400">
        Consistency weights recent days most — consecutive misses compound, a single miss recovers
        fast. An unlogged past day counts as a miss.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3 text-center">
      <div className="text-2xl font-bold text-gray-900 tabular-nums">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}
