'use client';

import { useEffect, useState } from 'react';
import { addWeeks, format, parseISO, subDays } from 'date-fns';

import { coolestMuscles, muscleById } from '@/lib/exercise-muscles';
import { useMuscleLoad } from '@/hooks/useMuscleLoad';
import { BodyMap } from './BodyMap';
import { MuscleDetail } from './MuscleDetail';

// The desktop Muscles tab: a Planned figure beside an Actual figure over the same
// period, a window-length selector, and a draggable time scrubber. Both figures
// share one selection and open the same detail panel. The heavy lifting (mapping,
// aggregation) is server-side via useMuscleLoad; this is layout, selection and
// period scrubbing only.

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: '2 weeks', days: 14 },
  { label: '4 weeks', days: 28 },
  { label: '8 weeks', days: 56 },
];

// Scrubber domain: a year back … a half-year forward, in weeks, 0 = today.
const MIN_WEEK = -52;
const MAX_WEEK = 26;
const FETCH_DEBOUNCE_MS = 250;

export function MusclesTab() {
  const [windowDays, setWindowDays] = useState(28);
  const [selected, setSelected] = useState<string | null>(null);
  const [today] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  // The slider position updates live; the fetched anchor is debounced so dragging
  // doesn't spam the API.
  const [weekOffset, setWeekOffset] = useState(0);
  const [anchor, setAnchor] = useState(today);

  const liveAnchor = format(addWeeks(parseISO(today), weekOffset), 'yyyy-MM-dd');

  useEffect(() => {
    const id = setTimeout(() => setAnchor(liveAnchor), FETCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [liveAnchor]);

  const { muscles, isLoading, error } = useMuscleLoad(windowDays, anchor);

  const selectedLoad = selected ? muscles.find(m => m.muscleId === selected) ?? null : null;
  const missed = coolestMuscles(muscles, 3);
  const isToday = weekOffset === 0;

  // Label reflects the LIVE slider position, not the debounced fetch.
  const liveTo = parseISO(liveAnchor);
  const rangeLabel = `${format(subDays(liveTo, windowDays), 'd MMM')} – ${format(liveTo, 'd MMM')}`;

  const resetToday = () => {
    setWeekOffset(0);
    setAnchor(today);
  };

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-gray-900">Muscles</h2>
          <p className="text-sm text-gray-500">
            What your plan would hit, beside what your training actually hit.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-gray-200 p-0.5">
          {WINDOWS.map(w => (
            <button
              key={w.days}
              onClick={() => setWindowDays(w.days)}
              className={`rounded px-2.5 py-1 text-xs font-semibold ${
                windowDays === w.days ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Time scrubber */}
      <div className="mb-5 rounded-lg border border-gray-200 bg-white px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span
            className={`text-sm font-medium tabular-nums text-gray-700 ${isLoading ? 'animate-pulse text-gray-400' : ''}`}
          >
            {rangeLabel}
          </span>
          {!isToday && (
            <button
              onClick={resetToday}
              className="rounded-md px-2.5 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-50"
            >
              Today
            </button>
          )}
        </div>
        <input
          type="range"
          min={MIN_WEEK}
          max={MAX_WEEK}
          step={1}
          value={weekOffset}
          onChange={e => setWeekOffset(Number(e.target.value))}
          aria-label="Scrub the period"
          className="h-6 w-full cursor-pointer accent-gray-900"
        />
        <div className="flex justify-between text-[11px] text-gray-400">
          <span>1 year ago</span>
          <span>today</span>
          <span>6 months ahead</span>
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <FigurePanel label="Planned" hint="Every planned exercise, done">
          <BodyMap loads={muscles} heatKind="planned" selectedMuscle={selected} onSelect={setSelected} />
        </FigurePanel>
        <FigurePanel label="Actual" hint="What you logged">
          <BodyMap loads={muscles} heatKind="done" selectedMuscle={selected} onSelect={setSelected} />
        </FigurePanel>
      </div>

      <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
        {selectedLoad ? (
          <MuscleDetail load={selectedLoad} />
        ) : (
          <p className="text-sm text-gray-500">
            Hover a muscle for a quick read, or click one on either figure for the full breakdown.
          </p>
        )}
      </div>

      {missed.length > 0 && (
        <section className="mt-6">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Most missed
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {missed.map(load => {
              const muscle = muscleById(load.muscleId);
              return (
                <button
                  key={load.muscleId}
                  onClick={() => setSelected(load.muscleId)}
                  className="rounded-lg border border-gray-200 bg-white p-3 text-left hover:border-gray-300"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-gray-900">{muscle?.label}</span>
                    <span className="text-xs tabular-nums text-gray-500">
                      {load.doneSetsPerWeek}/wk
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-gray-500">{load.assessment}</p>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function FigurePanel({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-gray-900">{label}</span>
        <span className="text-[11px] uppercase tracking-wide text-gray-400">{hint}</span>
      </div>
      {children}
    </div>
  );
}
