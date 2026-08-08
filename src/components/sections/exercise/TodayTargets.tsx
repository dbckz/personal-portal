'use client';

import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';

import { api } from '@/lib/api';
import { describeVolumeLoad, type ExerciseTarget } from '@/lib/exercise-targets';
import { ActionBadge, FailureTag, KindTag } from './action-badge';

// What to aim for today, from the last time each exercise was trained.
//
// Every row shows its reasoning and what was actually done last time, because
// the recommendation is a heuristic over the log — it should be easy to
// disagree with, not something to follow blindly.
export function TodayTargets({ date }: { date?: string }) {
  const [targets, setTargets] = useState<ExerciseTarget[]>([]);
  const [plan, setPlan] = useState<{ label?: string; components: string[] } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getExerciseTargets(date)
      .then(res => {
        if (cancelled) return;
        setTargets(res.targets);
        setPlan(res.plan ?? null);
      })
      .catch(err => console.error('Failed to load exercise targets:', err))
      .finally(() => !cancelled && setIsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [date]);

  if (isLoading || targets.length === 0) return null;

  return (
    <section className="mb-5 rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-gray-900">
          Aim for {date ? format(parseISO(date), 'EEE d MMM') : 'today'}
        </h3>
        {plan && (
          <span className="text-xs text-gray-500">
            Plan: {plan.label || plan.components.join(' + ')}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-gray-500">
        Progress each exercise from last time: more weight, more reps, longer holds or more distance,
        depending on how the last one felt. Based on your last session and the note you wrote about it.
      </p>

      <ul className="divide-y divide-gray-100">
        {targets.map(target => (
          <li key={target.key} className="py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-medium text-gray-900">{target.name}</p>
                  {target.kind && <KindTag kind={target.kind} />}
                  {target.toFailure && <FailureTag />}
                </div>
                <p className="mt-0.5 text-xs text-gray-500">{target.rationale}</p>
                {target.lastSummary && (
                  <p className="mt-0.5 text-[11px] text-gray-400">Last: {target.lastSummary}</p>
                )}
              </div>

              <div className="flex flex-shrink-0 flex-col items-end gap-1">
                {target.action && <ActionBadge action={target.action} />}
                <span className="text-sm font-semibold tabular-nums text-gray-900">
                  {describeTarget(target)}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function describeTarget(target: ExerciseTarget): string {
  return describeVolumeLoad(target) || '—';
}
