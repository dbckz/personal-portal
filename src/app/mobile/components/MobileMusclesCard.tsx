'use client';

import { useEffect, useState } from 'react';
import { addWeeks, format, parseISO, subDays } from 'date-fns';

import { coolestMuscles, muscleById } from '@/lib/exercise-muscles';
import { useMuscleLoad } from '@/hooks/useMuscleLoad';
import { BodyMap } from '@/components/sections/exercise/BodyMap';
import { MuscleDetail } from '@/components/sections/exercise/MuscleDetail';
import { MobileSheet } from './MobileSheet';

// The mobile muscle heatmap: one figure with a Planned/Actual toggle (side by
// side won't fit a phone), a draggable time scrubber, and tap-to-detail as a
// bottom sheet. Same BodyMap as desktop — it's just SVG, so tap works.

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: '2w', days: 14 },
  { label: '4w', days: 28 },
  { label: '8w', days: 56 },
];

const MIN_WEEK = -52;
const MAX_WEEK = 26;
const FETCH_DEBOUNCE_MS = 250;

export function MobileMusclesCard() {
  const [windowDays, setWindowDays] = useState(28);
  const [mode, setMode] = useState<'planned' | 'done'>('done');
  const [selected, setSelected] = useState<string | null>(null);
  const [today] = useState(() => format(new Date(), 'yyyy-MM-dd'));
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

  const liveTo = parseISO(liveAnchor);
  const rangeLabel = `${format(subDays(liveTo, windowDays), 'd MMM')} – ${format(liveTo, 'd MMM')}`;

  const resetToday = () => {
    setWeekOffset(0);
    setAnchor(today);
  };

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
        {/* Time scrubber */}
        <div className="mb-2">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span
              className={`text-sm font-medium tabular-nums text-gray-700 ${isLoading ? 'animate-pulse text-gray-400' : ''}`}
            >
              {rangeLabel}
            </span>
            {!isToday && (
              <button
                type="button"
                onClick={resetToday}
                className="rounded-md px-2 py-1 text-xs font-semibold text-blue-600 active:bg-blue-50"
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
            className="h-11 w-full cursor-pointer accent-gray-900"
            style={{ touchAction: 'none' }}
          />
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
