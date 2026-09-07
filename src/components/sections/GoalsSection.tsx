'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ClipboardCheck, Plus, Target } from 'lucide-react';

import { api } from '@/lib/api';
import {
  isReflectionDue,
} from '@/lib/goal-progress';
import {
  nextPeriodKey,
  periodKeyFor,
  periodLabel,
  previousPeriodKey,
} from '@/lib/goal-periods';
import { goalSections, sectionLabel } from '@/lib/life-sections';
import type {
  Goal,
  GoalCheckInStatus,
  GoalPeriodKind,
  GoalStatus,
  GoalWithProgress,
  Scorecard,
} from '@/types/life';
import { GoalCard } from '@/components/goals/GoalCard';
import { GoalEditorModal } from '@/components/goals/GoalEditorModal';
import { PlanningModal } from '@/components/goals/PlanningModal';
import { ReflectionModal } from '@/components/goals/ReflectionModal';

interface GoalsSectionProps {
  // 'current' or 'history' — the section's sub-tabs.
  subTab: string;
  onGoalsChanged?: () => void;
}

// The cross-cutting Goals view: monthly and quarterly goals across every life
// area, the reflection and planning sessions, and the scorecard history.
export function GoalsSection({ subTab, onGoalsChanged }: GoalsSectionProps) {
  const [periodKind, setPeriodKind] = useState<GoalPeriodKind>('month');
  const [periodKey, setPeriodKey] = useState(() => periodKeyFor('month', new Date()));
  const [sectionFilter, setSectionFilter] = useState('all');
  const [items, setItems] = useState<GoalWithProgress[]>([]);
  const [childItems, setChildItems] = useState<GoalWithProgress[]>([]);
  const [parentCandidates, setParentCandidates] = useState<Goal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Goal | null | undefined>(undefined); // undefined = closed
  const [reflectionOpen, setReflectionOpen] = useState(false);
  const [planningOpen, setPlanningOpen] = useState(false);

  // Switching between month and quarter resets the key to the equivalent
  // current period rather than leaving a stale key of the wrong shape.
  const changePeriodKind = useCallback((kind: GoalPeriodKind) => {
    setPeriodKind(kind);
    setPeriodKey(periodKeyFor(kind, new Date()));
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.getGoals({
        periodKind,
        periodKey,
        sectionId: sectionFilter === 'all' ? undefined : sectionFilter,
        withProgress: true,
      });
      setItems(res.items ?? []);

      // Viewing a quarter also loads that quarter's monthly goals so each
      // quarterly card can show what ladders up to it.
      if (periodKind === 'quarter') {
        const months = await api.getGoals({ periodKind: 'month', withProgress: true });
        setChildItems(months.items ?? []);
      } else {
        setChildItems([]);
        // Editing a monthly goal needs the quarter's goals as parent options.
        const quarters = await api.getGoals({ periodKind: 'quarter' });
        setParentCandidates(quarters.goals);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load goals.');
    } finally {
      setIsLoading(false);
    }
  }, [periodKind, periodKey, sectionFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = useCallback(() => {
    load();
    onGoalsChanged?.();
  }, [load, onGoalsChanged]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string, GoalWithProgress[]>();
    for (const item of childItems) {
      if (!item.goal.parentGoalId) continue;
      map.set(item.goal.parentGoalId, [...(map.get(item.goal.parentGoalId) ?? []), item]);
    }
    return map;
  }, [childItems]);

  const handleCheckIn = useCallback(
    async (goalId: string, status: GoalCheckInStatus, note?: string, value?: number) => {
      try {
        await api.checkInGoal(goalId, { status, note, value, source: 'goals-tab' });
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to record the check-in.');
      }
    },
    [refresh]
  );

  const handleDelete = useCallback(
    async (goalId: string) => {
      if (!window.confirm('Delete this goal? Its history goes with it.')) return;
      try {
        await api.deleteGoal(goalId);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete the goal.');
      }
    },
    [refresh]
  );

  const handleSetStatus = useCallback(
    async (goalId: string, status: GoalStatus, reflection?: string) => {
      try {
        await api.updateGoal(goalId, { status, ...(reflection ? { reflection } : {}) });
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update the goal.');
      }
    },
    [refresh]
  );

  if (subTab === 'history') {
    return <GoalHistory />;
  }

  const reflectionDue = isReflectionDue(periodKind, periodKey);
  const kindWord = periodKind === 'month' ? 'Monthly' : 'Quarterly';

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
          {(['month', 'quarter'] as const).map(kind => (
            <button
              key={kind}
              onClick={() => changePeriodKind(kind)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                periodKind === kind ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {kind === 'month' ? 'Monthly' : 'Quarterly'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setPeriodKey(k => previousPeriodKey(periodKind, k))}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
            aria-label="Previous period"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="min-w-36 text-center text-sm font-semibold text-gray-900">
            {periodLabel(periodKind, periodKey)}
          </span>
          <button
            onClick={() => setPeriodKey(k => nextPeriodKey(periodKind, k))}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
            aria-label="Next period"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <select
          value={sectionFilter}
          onChange={e => setSectionFilter(e.target.value)}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-md"
          aria-label="Filter by life area"
        >
          <option value="all">All areas</option>
          {goalSections().map(s => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-2 mb-5">
        <button
          onClick={() => setReflectionOpen(true)}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-md ${
            reflectionDue
              ? 'bg-amber-500 text-white hover:bg-amber-600'
              : 'bg-white text-gray-800 border border-gray-300 hover:bg-gray-50'
          }`}
        >
          <ClipboardCheck className="w-4 h-4" />
          {kindWord} reflection
          {reflectionDue && <span className="text-[11px] font-normal opacity-90">due</span>}
        </button>
        <button
          onClick={() => setPlanningOpen(true)}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-md bg-white text-gray-800 border border-gray-300 hover:bg-gray-50"
        >
          <Target className="w-4 h-4" />
          {kindWord} planning
        </button>
        <button
          onClick={() => setEditing(null)}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-md bg-gray-900 text-white hover:bg-gray-800"
        >
          <Plus className="w-4 h-4" />
          New goal
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {isLoading && <p className="text-sm text-gray-500">Loading goals…</p>}

      {!isLoading && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center">
          <p className="text-gray-600">
            No {periodKind === 'month' ? 'monthly' : 'quarterly'} goals for{' '}
            {periodLabel(periodKind, periodKey)}.
          </p>
          <p className="mt-1 text-sm text-gray-500">
            Run a planning session to set some, or add one directly.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {items.map(item => (
          <GoalCard
            key={item.goal.id}
            item={item}
            subGoals={childrenByParent.get(item.goal.id) ?? []}
            showSection={sectionFilter === 'all'}
            onCheckIn={handleCheckIn}
            onEdit={goalId => setEditing(items.find(i => i.goal.id === goalId)?.goal ?? null)}
            onDelete={handleDelete}
            onSetStatus={handleSetStatus}
          />
        ))}
      </div>

      {editing !== undefined && (
        <GoalEditorModal
          goal={editing}
          defaultSectionId={sectionFilter === 'all' ? goalSections()[0].id : sectionFilter}
          defaultPeriodKind={periodKind}
          defaultPeriodKey={periodKey}
          parentCandidates={parentCandidates}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            refresh();
          }}
        />
      )}

      {reflectionOpen && (
        <ReflectionModal
          periodKind={periodKind}
          periodKey={periodKey}
          onClose={() => setReflectionOpen(false)}
          onFinished={() => {
            setReflectionOpen(false);
            refresh();
          }}
        />
      )}

      {planningOpen && (
        <PlanningModal
          periodKind={periodKind}
          // Planning is forward-looking: default to the period after the one on
          // screen, which from the current period means "next month/quarter".
          periodKey={nextPeriodKey(periodKind, periodKey)}
          onClose={() => setPlanningOpen(false)}
          onFinished={() => {
            setPlanningOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// Past periods as scorecards — the durable record of what was set and how it
// went, independent of the reflection sessions that produced the verdicts.
function GoalHistory() {
  const [periodKind, setPeriodKind] = useState<GoalPeriodKind>('month');
  const [periodKey, setPeriodKey] = useState(() =>
    previousPeriodKey('month', periodKeyFor('month', new Date()))
  );
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.getScorecard(periodKind, periodKey);
      setScorecard(res.scorecard);
    } catch (err) {
      console.error('Failed to load scorecard:', err);
    } finally {
      setIsLoading(false);
    }
  }, [periodKind, periodKey]);

  useEffect(() => {
    load();
  }, [load]);

  const changeKind = (kind: GoalPeriodKind) => {
    setPeriodKind(kind);
    setPeriodKey(previousPeriodKey(kind, periodKeyFor(kind, new Date())));
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
          {(['month', 'quarter'] as const).map(kind => (
            <button
              key={kind}
              onClick={() => changeKind(kind)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                periodKind === kind ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {kind === 'month' ? 'Monthly' : 'Quarterly'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPeriodKey(k => previousPeriodKey(periodKind, k))}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
            aria-label="Previous period"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="min-w-36 text-center text-sm font-semibold text-gray-900">
            {periodLabel(periodKind, periodKey)}
          </span>
          <button
            onClick={() => setPeriodKey(k => nextPeriodKey(periodKind, k))}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
            aria-label="Next period"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}

      {!isLoading && scorecard && scorecard.rows.length === 0 && (
        <p className="text-sm text-gray-600">No goals recorded for this period.</p>
      )}

      {!isLoading && scorecard && scorecard.rows.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="grid grid-cols-4 divide-x divide-gray-200 border-b border-gray-200">
            <Stat label="Hit" value={scorecard.hit} className="text-emerald-700" />
            <Stat label="Partial" value={scorecard.partial} className="text-amber-700" />
            <Stat label="Missed" value={scorecard.missed} className="text-red-700" />
            <Stat label="Dropped" value={scorecard.dropped} className="text-gray-500" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 font-semibold">Goal</th>
                  <th className="px-4 py-2 font-semibold">Area</th>
                  <th className="px-4 py-2 font-semibold">Result</th>
                  <th className="px-4 py-2 font-semibold">Verdict</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {scorecard.rows.map(row => (
                  <tr key={row.goal.id}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-gray-900">{row.goal.title}</div>
                      {row.goal.reflection && (
                        <div className="mt-0.5 text-xs text-gray-500">{row.goal.reflection}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{sectionLabel(row.goal.sectionId)}</td>
                    <td className="px-4 py-2.5 text-gray-600 tabular-nums">
                      {row.goal.target
                        ? `${row.progress.actual ?? 0} / ${row.goal.target.value}${
                            row.goal.target.unit ? ` ${row.goal.target.unit}` : ''
                          }`
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5 font-semibold uppercase text-xs tracking-wide text-gray-700">
                      {row.suggestedVerdict}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className="p-3 text-center">
      <div className={`text-2xl font-bold ${className}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}
