'use client';

import { useState } from 'react';
import { addDays, format, parseISO, subDays } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { coolestMuscles, muscleById } from '@/lib/exercise-muscles';
import { useMuscleLoad } from '@/hooks/useMuscleLoad';
import { BodyMap } from './BodyMap';
import { MuscleDetail } from './MuscleDetail';

// The desktop Muscles tab: a Planned figure beside an Actual figure over the same
// period, a window-length selector, and ◀/▶ time navigation. Both figures share
// one selection and open the same detail panel. The heavy lifting (mapping,
// aggregation) is server-side via useMuscleLoad; this is layout, selection and
// period stepping only.

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: '2 weeks', days: 14 },
  { label: '4 weeks', days: 28 },
  { label: '8 weeks', days: 56 },
];

const TODAY = () => format(new Date(), 'yyyy-MM-dd');

export function MusclesTab() {
  const [windowDays, setWindowDays] = useState(28);
  const [anchor, setAnchor] = useState(TODAY);
  const [selected, setSelected] = useState<string | null>(null);
  const { muscles, range, isLoading, error } = useMuscleLoad(windowDays, anchor);

  const selectedLoad = selected ? muscles.find(m => m.muscleId === selected) ?? null : null;
  const missed = coolestMuscles(muscles, 3);
  const isToday = anchor === TODAY();

  const stepBack = () => setAnchor(format(subDays(parseISO(anchor), windowDays), 'yyyy-MM-dd'));
  const stepForward = () => setAnchor(format(addDays(parseISO(anchor), windowDays), 'yyyy-MM-dd'));

  const rangeLabel = range
    ? `${format(parseISO(range.from), 'd MMM')} – ${format(parseISO(range.to), 'd MMM')}`
    : '…';

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

      {/* Period navigation */}
      <div className="mb-4 flex items-center justify-center gap-3">
        <button
          onClick={stepBack}
          aria-label="Previous period"
          className="rounded-md border border-gray-300 p-1.5 text-gray-600 hover:bg-gray-50"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-[9rem] text-center text-sm font-medium tabular-nums text-gray-700">
          {rangeLabel}
        </span>
        <button
          onClick={stepForward}
          aria-label="Next period"
          className="rounded-md border border-gray-300 p-1.5 text-gray-600 hover:bg-gray-50"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        {!isToday && (
          <button
            onClick={() => setAnchor(TODAY())}
            className="rounded-md px-2.5 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-50"
          >
            Today
          </button>
        )}
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
      {isLoading && <p className="mt-2 text-center text-xs text-gray-400">Loading…</p>}

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
