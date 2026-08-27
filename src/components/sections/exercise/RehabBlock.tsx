'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Check, Loader2 } from 'lucide-react';

import { api } from '@/lib/api';
import type { RehabExercise, RehabRoutine } from '@/types/life';

// The daily back-rehab block: a compact, tickable ~12-minute home routine, shown
// every day (rest days included) and tracked DELIBERATELY SEPARATELY from the gym
// session/programme. Ticks are for TODAY only and save optimistically; the block
// renders whether or not a session exists. Shared verbatim by the desktop
// exercise section and the mobile exercise tab.
export function RehabBlock() {
  const today = format(new Date(), 'yyyy-MM-dd');
  const [routine, setRoutine] = useState<RehabRoutine | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ids currently mid-write, so a double-tap can't fire a second PATCH.
  const [busyIds, setBusyIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .getRehabRoutine()
      .then(res => !cancelled && setRoutine(res.routine))
      .catch(() => !cancelled && setError('Could not load the rehab block.'));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error && !routine) {
    return (
      <section className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </section>
    );
  }
  if (!routine) {
    return <p className="py-4 text-sm text-gray-400">Loading rehab block…</p>;
  }

  const doneToday = new Set(routine.ticks[today] ?? []);
  const doneCount = routine.exercises.filter(ex => doneToday.has(ex.id)).length;

  const toggle = async (ex: RehabExercise) => {
    if (busyIds.includes(ex.id)) return;
    const done = !doneToday.has(ex.id);

    // Optimistic: flip the tick locally, roll back if the write fails.
    setBusyIds(ids => [...ids, ex.id]);
    setError(null);
    setRoutine(prev => (prev ? applyTick(prev, today, ex.id, done) : prev));
    try {
      const res = await api.setRehabTick(today, ex.id, done);
      setRoutine(res.routine);
    } catch {
      setError('Could not save that. Try again.');
      setRoutine(prev => (prev ? applyTick(prev, today, ex.id, !done) : prev));
    } finally {
      setBusyIds(ids => ids.filter(id => id !== ex.id));
    }
  };

  return (
    <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex items-baseline justify-between gap-3 border-b border-gray-100 px-3 py-2.5">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Back rehab — daily</h2>
          <p className="text-xs text-gray-500">Every day, rest days included.</p>
        </div>
        <span className="text-sm tabular-nums text-gray-500">
          {doneCount}/{routine.exercises.length}
        </span>
      </div>

      {error && <p className="px-3 pt-2 text-xs text-red-600">{error}</p>}

      <ul className="divide-y divide-gray-100">
        {routine.exercises.map(ex => {
          const done = doneToday.has(ex.id);
          const busy = busyIds.includes(ex.id);
          return (
            <li key={ex.id} className="flex items-stretch">
              <button
                type="button"
                onClick={() => toggle(ex)}
                disabled={busy}
                aria-pressed={done}
                aria-label={done ? `Mark ${ex.name} not done` : `Mark ${ex.name} done`}
                className="flex w-12 flex-shrink-0 items-center justify-center"
              >
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full border-2 transition-colors ${
                    done
                      ? 'border-emerald-600 bg-emerald-600 text-white'
                      : 'border-gray-300 text-transparent'
                  }`}
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                </span>
              </button>

              <div className="min-w-0 flex-1 py-2.5 pr-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={`text-sm font-medium ${
                      done ? 'text-gray-500 line-through' : 'text-gray-900'
                    }`}
                  >
                    {ex.name}
                  </span>
                  {ex.prescription && (
                    <span className="flex-shrink-0 text-xs tabular-nums text-gray-500">
                      {ex.prescription}
                    </span>
                  )}
                </div>
                {ex.note && <p className="mt-0.5 text-xs text-gray-500">{ex.note}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Return a copy of the routine with one exercise's tick set for a day. Pure, so
// it drives both the optimistic flip and its rollback.
function applyTick(
  routine: RehabRoutine,
  date: string,
  exerciseId: string,
  done: boolean
): RehabRoutine {
  const current = routine.ticks[date] ?? [];
  const next = done
    ? Array.from(new Set([...current, exerciseId]))
    : current.filter(id => id !== exerciseId);
  const ticks = { ...routine.ticks };
  if (next.length) ticks[date] = next;
  else delete ticks[date];
  return { exercises: routine.exercises, ticks };
}
