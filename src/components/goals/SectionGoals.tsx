'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';

import { api } from '@/lib/api';
import { periodKeyFor, periodLabel } from '@/lib/goal-periods';
import type { Goal, GoalCheckInStatus, GoalPeriodKind, GoalStatus, GoalWithProgress } from '@/types/life';
import { GoalCard } from './GoalCard';
import { GoalEditorModal } from './GoalEditorModal';

interface SectionGoalsProps {
  sectionId: string;
  // Shown when the section has no goals yet, to explain what the tab is for.
  emptyHint?: string;
}

// One life area's goals for the current month and quarter. The Goals section is
// the cross-cutting view; this is the same data narrowed to the area you are
// already looking at, so Exercise and Music each get a Goals tab without
// duplicating the machinery.
export function SectionGoals({ sectionId, emptyHint }: SectionGoalsProps) {
  const [items, setItems] = useState<Record<GoalPeriodKind, GoalWithProgress[]>>({
    quarter: [],
    month: [],
  });
  const [parentCandidates, setParentCandidates] = useState<Goal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ goal: Goal | null; periodKind: GoalPeriodKind } | null>(null);

  const monthKey = periodKeyFor('month', new Date());
  const quarterKey = periodKeyFor('quarter', new Date());

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [months, quarters] = await Promise.all([
        api.getGoals({ sectionId, periodKind: 'month', periodKey: monthKey, withProgress: true }),
        api.getGoals({ sectionId, periodKind: 'quarter', periodKey: quarterKey, withProgress: true }),
      ]);
      setItems({ month: months.items ?? [], quarter: quarters.items ?? [] });
      setParentCandidates(quarters.goals);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load goals.');
    } finally {
      setIsLoading(false);
    }
  }, [sectionId, monthKey, quarterKey]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCheckIn = useCallback(
    async (goalId: string, status: GoalCheckInStatus, note?: string, value?: number) => {
      try {
        await api.checkInGoal(goalId, { status, note, value, source: 'goals-tab' });
        load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to record the check-in.');
      }
    },
    [load]
  );

  const handleDelete = useCallback(
    async (goalId: string) => {
      if (!window.confirm('Delete this goal? Its history goes with it.')) return;
      try {
        await api.deleteGoal(goalId);
        load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete the goal.');
      }
    },
    [load]
  );

  const handleSetStatus = useCallback(
    async (goalId: string, status: GoalStatus, reflection?: string) => {
      try {
        await api.updateGoal(goalId, { status, ...(reflection ? { reflection } : {}) });
        load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update the goal.');
      }
    },
    [load]
  );

  const allItems = [...items.quarter, ...items.month];
  const findGoal = (goalId: string) => allItems.find(i => i.goal.id === goalId)?.goal ?? null;

  return (
    <div className="max-w-3xl mx-auto p-6">
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {isLoading && <p className="text-sm text-gray-500">Loading goals…</p>}

      {!isLoading && allItems.length === 0 && emptyHint && (
        <div className="mb-5 rounded-lg border border-dashed border-gray-300 p-6 text-center">
          <p className="text-sm text-gray-600">{emptyHint}</p>
        </div>
      )}

      {(['quarter', 'month'] as const).map(kind => (
        <section key={kind} className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              {periodLabel(kind, kind === 'month' ? monthKey : quarterKey)}
            </h2>
            <button
              onClick={() => setEditing({ goal: null, periodKind: kind })}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              <Plus className="w-3.5 h-3.5" />
              Add {kind === 'month' ? 'monthly' : 'quarterly'} goal
            </button>
          </div>

          {items[kind].length === 0 ? (
            <p className="text-sm text-gray-400">Nothing set.</p>
          ) : (
            <div className="space-y-3">
              {items[kind].map(item => (
                <GoalCard
                  key={item.goal.id}
                  item={item}
                  showSection={false}
                  onCheckIn={handleCheckIn}
                  onEdit={goalId => setEditing({ goal: findGoal(goalId), periodKind: kind })}
                  onDelete={handleDelete}
                  onSetStatus={handleSetStatus}
                />
              ))}
            </div>
          )}
        </section>
      ))}

      {editing && (
        <GoalEditorModal
          goal={editing.goal}
          defaultSectionId={sectionId}
          defaultPeriodKind={editing.periodKind}
          defaultPeriodKey={editing.periodKind === 'month' ? monthKey : quarterKey}
          parentCandidates={parentCandidates}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}
