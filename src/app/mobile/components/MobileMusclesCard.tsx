'use client';

import { useState } from 'react';
import { addDays, format, parseISO, subDays } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { coolestMuscles, muscleById } from '@/lib/exercise-muscles';
import { useMuscleLoad } from '@/hooks/useMuscleLoad';
import { BodyMap } from '@/components/sections/exercise/BodyMap';
import { MuscleDetail } from '@/components/sections/exercise/MuscleDetail';
import { MobileSheet } from './MobileSheet';

// The mobile muscle heatmap: one figure with a Planned/Actual toggle (side by
// side won't fit a phone), the same period stepper as desktop, and tap-to-detail
// as a bottom sheet. Same BodyMap as desktop — it's just SVG, so tap works.

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: '2w', days: 14 },
  { label: '4w', days: 28 },
  { label: '8w', days: 56 },
];

const TODAY = () => format(new Date(), 'yyyy-MM-dd');

export function MobileMusclesCard() {
  const [windowDays, setWindowDays] = useState(28);
  const [anchor, setAnchor] = useState(TODAY);
  const [mode, setMode] = useState<'planned' | 'done'>('done');
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
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Muscles</h2>
        <div className="flex items-center gap-1 rounded-md border border-gray-200 p-0.5">
          {WINDOWS.map(w => (
            <button
              key={w.days}
              type="button"
              onClick={() => setWindowDays(w.days)}
              className={`rounded px-2 py-1 text-xs font-semibold ${
                windowDays === w.days ? 'bg-gray-900 text-white' : 'text-gray-600 active:bg-gray-100'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        {/* Period navigation */}
        <div className="mb-2 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={stepBack}
            aria-label="Previous period"
            className="rounded-md border border-gray-300 p-1.5 text-gray-600 active:bg-gray-50"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[8rem] text-center text-sm font-medium tabular-nums text-gray-700">
            {rangeLabel}
          </span>
          <button
            type="button"
            onClick={stepForward}
            aria-label="Next period"
            className="rounded-md border border-gray-300 p-1.5 text-gray-600 active:bg-gray-50"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          {!isToday && (
            <button
              type="button"
              onClick={() => setAnchor(TODAY())}
              className="rounded-md px-2 py-1 text-xs font-semibold text-blue-600 active:bg-blue-50"
            >
              Today
            </button>
          )}
        </div>

        {/* Planned / Actual toggle */}
        <div className="mx-auto mb-2 flex w-full max-w-[240px] rounded-md border border-gray-200 p-0.5">
          {(['planned', 'done'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 rounded px-3 py-1 text-xs font-semibold ${
                mode === m ? 'bg-gray-900 text-white' : 'text-gray-600 active:bg-gray-100'
              }`}
            >
              {m === 'planned' ? 'Planned' : 'Actual'}
            </button>
          ))}
        </div>

        <BodyMap loads={muscles} heatKind={mode} selectedMuscle={selected} onSelect={setSelected} />
        {isLoading && <p className="mt-1 text-center text-xs text-gray-400">Loading…</p>}

        {missed.length > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Most missed
            </p>
            <div className="flex flex-wrap gap-1.5">
              {missed.map(load => (
                <button
                  key={load.muscleId}
                  type="button"
                  onClick={() => setSelected(load.muscleId)}
                  className="rounded-full border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 active:bg-gray-50"
                >
                  {muscleById(load.muscleId)?.label} · {load.doneSetsPerWeek}/wk
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {selectedLoad && (
        <MobileSheet onClose={() => setSelected(null)}>
          <div className="overflow-y-auto px-4 pb-6 pt-1">
            <MuscleDetail load={selectedLoad} />
          </div>
        </MobileSheet>
      )}
    </section>
  );
}
