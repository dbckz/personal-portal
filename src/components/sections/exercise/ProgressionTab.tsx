'use client';

import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

import { api } from '@/lib/api';
import type { ExerciseProgression, ProgressionPoint } from '@/lib/exercise-progression';
import { isCardioName, isHoldName } from '@/lib/exercise-parse';
import { formatEntryDuration } from '@/lib/exercise-targets';

// How a lift's history should be read: a run in distance/time, a plank in seconds
// held, everything else in sets/reps and load. Decided from the name and from
// what the points actually carry, so an un-tagged run or plank still lands right.
type Shape = 'cardio' | 'hold' | 'strength';

function progressionShape(p: ExerciseProgression): Shape {
  const pts = p.points;
  if (
    isCardioName(p.name) ||
    pts.some(pt => pt.distanceKm !== undefined || pt.durationMinutes !== undefined)
  ) {
    return 'cardio';
  }
  if (isHoldName(p.name) || pts.some(pt => pt.holdSeconds !== undefined)) return 'hold';
  return 'strength';
}

// The column headers for a shape — the two middle columns change with it.
function columnHeaders(shape: Shape): [string, string] {
  if (shape === 'cardio') return ['Distance', 'Time'];
  if (shape === 'hold') return ['Hold', 'Weight'];
  return ['Sets', 'Weight'];
}

// The two middle cells for one point, in the shape's own units.
function pointCells(point: ProgressionPoint, shape: Shape): [string, string] {
  if (shape === 'cardio') {
    return [
      point.distanceKm !== undefined ? `${point.distanceKm} km` : '—',
      point.durationMinutes !== undefined ? formatEntryDuration(point.durationMinutes) : '—',
    ];
  }
  if (shape === 'hold') {
    const side = point.perSide ? ' each side' : '';
    const hold =
      point.sets && point.holdSeconds
        ? `${point.sets} × ${point.holdSeconds}s${side}`
        : point.holdSeconds
          ? `${point.holdSeconds}s`
          : '—';
    return [hold, point.weightKg !== undefined ? `${point.weightKg}kg` : '—'];
  }
  const side = point.perSide ? ' each side' : '';
  return [
    point.sets && point.reps ? `${point.sets} × ${point.reps}${side}` : '—',
    point.weightKg !== undefined ? `${point.weightKg}kg` : '—',
  ];
}

// The change worth reporting for a lift: the delta on the measure that lift is
// actually driven by — load for a barbell lift, reps for bodyweight work,
// seconds for a hold, distance (or time) for a run. Null when there is nothing
// to compare (fewer than two points carrying that measure).
interface ProgressionChange {
  delta: number;
  // Includes its own spacing/suffix so the badge reads "+4 km", "+60s", "+2.5kg".
  unit: string;
}

function fieldDelta(points: ProgressionPoint[], field: keyof ProgressionPoint): number | null {
  const withField = points.filter(p => p[field] !== undefined);
  if (withField.length < 2) return null;
  const first = withField[0][field] as number;
  const last = withField[withField.length - 1][field] as number;
  return Math.round((last - first) * 10) / 10;
}

function progressionChange(p: ExerciseProgression, shape: Shape): ProgressionChange | null {
  if (shape === 'cardio') {
    const km = fieldDelta(p.points, 'distanceKm');
    if (km !== null) return { delta: km, unit: ' km' };
    const min = fieldDelta(p.points, 'durationMinutes');
    return min !== null ? { delta: min, unit: ' min' } : null;
  }
  if (shape === 'hold') {
    const secs = fieldDelta(p.points, 'holdSeconds');
    return secs !== null ? { delta: secs, unit: 's' } : null;
  }
  if (p.weightChangeKg !== undefined) return { delta: p.weightChangeKg, unit: 'kg' };
  const reps = fieldDelta(p.points, 'reps');
  return reps !== null ? { delta: reps, unit: reps === 1 || reps === -1 ? ' rep' : ' reps' } : null;
}

// Per-lift history. The point of logging sets and weights rather than just
// "went to the gym": whether a given exercise is actually going up.
export function ProgressionTab() {
  const [progressions, setProgressions] = useState<ExerciseProgression[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getExerciseProgressions()
      .then(res => !cancelled && setProgressions(res.progressions))
      .catch(err => console.error('Failed to load exercise progressions:', err))
      .finally(() => !cancelled && setIsLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading) {
    return <p className="max-w-3xl mx-auto p-6 text-sm text-gray-500">Loading…</p>;
  }

  if (progressions.length === 0) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <p className="text-sm text-gray-500">
          No exercises logged yet. Progression appears once sessions have exercises recorded
          against them.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <p className="mb-4 text-sm text-gray-500">
        Every exercise you&apos;ve logged, most-trained first. Tap one to see its history.
      </p>

      <div className="space-y-2">
        {progressions.map(progression => {
          const isOpen = expanded === progression.key;
          const shape = progressionShape(progression);
          const [midHeader, endHeader] = columnHeaders(shape);
          return (
            <div key={progression.key} className="rounded-lg border border-gray-200 bg-white">
              <button
                onClick={() => setExpanded(isOpen ? null : progression.key)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-3 p-3 text-left"
              >
                <div className="min-w-0">
                  <p className="font-medium text-gray-900">{progression.name}</p>
                  <p className="text-xs text-gray-500">
                    {progression.sessions} session{progression.sessions === 1 ? '' : 's'}
                    {progression.latest?.weightKg !== undefined &&
                      ` · latest ${progression.latest.weightKg}kg`}
                  </p>
                </div>
                <ChangeBadge change={progressionChange(progression, shape)} />
              </button>

              {isOpen && (
                <div className="border-t border-gray-100 px-3 pb-3">
                  <table className="w-full text-sm">
                    <thead className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                      <tr>
                        <th className="py-2 font-semibold">Date</th>
                        <th className="py-2 font-semibold">{midHeader}</th>
                        <th className="py-2 font-semibold">{endHeader}</th>
                        <th className="py-2 font-semibold">Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {progression.points.map((point, i) => {
                        const [mid, end] = pointCells(point, shape);
                        return (
                          <tr key={`${point.date}-${i}`}>
                            <td className="py-2 text-gray-600 tabular-nums">
                              {format(parseISO(point.date), 'd MMM')}
                            </td>
                            <td className="py-2 text-gray-600 tabular-nums">{mid}</td>
                            <td className="py-2 text-gray-600 tabular-nums">{end}</td>
                            <td className="py-2 text-xs text-gray-500">{point.notes ?? ''}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The change on whichever measure the lift is driven by (load, reps, seconds or
// distance), since its first comparable session. Silent when there is nothing to
// compare — a single session, or a measure never recorded.
function ChangeBadge({ change }: { change: ProgressionChange | null }) {
  if (change === null) return <span className="text-xs text-gray-400">—</span>;

  if (change.delta === 0) {
    return (
      <span className="flex flex-shrink-0 items-center gap-1 text-xs font-semibold text-gray-500">
        <Minus className="h-3.5 w-3.5" />
        level
      </span>
    );
  }

  const up = change.delta > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`flex flex-shrink-0 items-center gap-1 text-xs font-semibold ${
        up ? 'text-emerald-700' : 'text-amber-700'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {up ? '+' : ''}
      {change.delta}
      {change.unit}
    </span>
  );
}
