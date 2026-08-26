'use client';

import { useState } from 'react';

import { coolestMuscles, muscleById } from '@/lib/exercise-muscles';
import { useMuscleLoad } from '@/hooks/useMuscleLoad';
import { BodyMap } from './BodyMap';
import { MuscleDetail } from './MuscleDetail';

// The desktop Muscles tab: a window selector, the front/back heatmap, a detail
// panel for the selected muscle, and a "most missed" strip of the three coolest
// muscles. The heavy lifting (mapping, aggregation) is server-side via
// useMuscleLoad; this is layout and selection only.

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: '2 weeks', days: 14 },
  { label: '4 weeks', days: 28 },
  { label: '8 weeks', days: 56 },
];

export function MusclesTab() {
  const [windowDays, setWindowDays] = useState(28);
  const [selected, setSelected] = useState<string | null>(null);
  const { muscles, isLoading, error } = useMuscleLoad(windowDays);

  const selectedLoad = selected ? muscles.find(m => m.muscleId === selected) ?? null : null;
  const missed = coolestMuscles(muscles, 3);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-gray-900">Muscles</h2>
          <p className="text-sm text-gray-500">
            Which muscles your training is actually hitting — and which it's missing.
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

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <BodyMap loads={muscles} selectedMuscle={selected} onSelect={setSelected} />
          {isLoading && <p className="mt-2 text-center text-xs text-gray-400">Loading…</p>}
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4">
          {selectedLoad ? (
            <MuscleDetail load={selectedLoad} />
          ) : (
            <p className="text-sm text-gray-500">
              Hover a muscle for a quick read, or click one for the full breakdown.
            </p>
          )}
        </div>
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
