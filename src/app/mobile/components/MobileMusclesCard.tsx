'use client';

import { useState } from 'react';

import { coolestMuscles, muscleById } from '@/lib/exercise-muscles';
import { useMuscleLoad } from '@/hooks/useMuscleLoad';
import { BodyMap } from '@/components/sections/exercise/BodyMap';
import { MuscleDetail } from '@/components/sections/exercise/MuscleDetail';
import { MobileSheet } from './MobileSheet';

// The mobile muscle heatmap: the same BodyMap as desktop (SVG, so tap works),
// with the per-muscle detail opening as a bottom sheet instead of a side panel.
// No hover affordances — tap a muscle (or a "most missed" chip) to open it.

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: '2w', days: 14 },
  { label: '4w', days: 28 },
  { label: '8w', days: 56 },
];

export function MobileMusclesCard() {
  const [windowDays, setWindowDays] = useState(28);
  const [selected, setSelected] = useState<string | null>(null);
  const { muscles, isLoading, error } = useMuscleLoad(windowDays);

  const selectedLoad = selected ? muscles.find(m => m.muscleId === selected) ?? null : null;
  const missed = coolestMuscles(muscles, 3);

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
        <BodyMap loads={muscles} selectedMuscle={selected} onSelect={setSelected} />
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
