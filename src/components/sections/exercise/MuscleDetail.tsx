'use client';

import { format, parseISO } from 'date-fns';

import { muscleById, type MuscleLoad } from '@/lib/exercise-muscles';

// The full breakdown for one muscle: description, the assessment sentence, and
// the per-exercise done-vs-planned table. Presentational and layout-neutral so
// the desktop side panel and the mobile bottom sheet share it.
export function MuscleDetail({ load }: { load: MuscleLoad }) {
  const muscle = muscleById(load.muscleId);
  if (!muscle) return null;

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-semibold text-gray-900">{muscle.label}</h3>
          <span className="text-xs tabular-nums text-gray-500">
            {load.doneSetsPerWeek} / wk
            {load.plannedSetsPerWeek > 0 ? ` · ${load.plannedSetsPerWeek} planned` : ''}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-gray-500">{muscle.description}</p>
      </div>

      <p className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700">{load.assessment}</p>

      {load.plannedEstimated && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Planned figure is an estimate from your usual sessions — this day is a calendar plan with
          no exercises filled in yet.
        </p>
      )}

      {load.exercises.length > 0 ? (
        <div>
          <div className="mb-1 grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            <span>Exercise</span>
            <span className="text-right">Done</span>
            <span className="text-right">Plan</span>
            <span className="text-right">Last</span>
          </div>
          <ul className="space-y-1">
            {load.exercises.map(ex => (
              <li
                key={ex.name}
                className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-3 text-sm"
              >
                <span className="min-w-0 truncate text-gray-700" title={ex.estimated ? ex.note : undefined}>
                  {ex.name}
                  {ex.role === 'secondary' && (
                    <span className="ml-1 text-[10px] uppercase tracking-wide text-gray-400">2nd</span>
                  )}
                  {ex.estimated && (
                    <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-medium uppercase tracking-wide text-amber-700">
                      est
                    </span>
                  )}
                </span>
                <span className="text-right tabular-nums text-gray-600">{ex.doneSets || '—'}</span>
                <span className="text-right tabular-nums text-gray-400">{ex.plannedSets || '—'}</span>
                <span className="text-right tabular-nums text-gray-400">
                  {ex.lastDoneDate ? format(parseISO(ex.lastDoneDate), 'd MMM') : '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-gray-400">Nothing logged or planned for this muscle in the window.</p>
      )}

      {muscle.examples.length > 0 && (
        <p className="text-xs text-gray-500">
          Try: <span className="text-gray-700">{muscle.examples.join(', ')}</span>
        </p>
      )}
    </div>
  );
}
