'use client';

import { useState } from 'react';
import { AlertTriangle, Check, MessageSquarePlus, Pencil, Plus, Target, Trash2 } from 'lucide-react';

import { api } from '@/lib/api';
import { GoalPacingBar } from '@/components/goals/GoalPacingBar';
import { periodKeyFor, periodLabel } from '@/lib/goal-periods';
import { goalSections, sectionLabel } from '@/lib/life-sections';
import type { GoalNudge } from '@/lib/goal-progress';
import type { Goal, GoalCheckInStatus, GoalPeriodKind, GoalWithProgress } from '@/types/life';
import { MobileGoalEditorSheet } from '../components/MobileGoalEditorSheet';

const CHECK_IN_OPTIONS: Array<{ status: GoalCheckInStatus; label: string; className: string }> = [
  { status: 'on-track', label: 'On track', className: 'bg-emerald-100 text-emerald-800 active:bg-emerald-200' },
  { status: 'slipping', label: 'Slipping', className: 'bg-amber-100 text-amber-800 active:bg-amber-200' },
  { status: 'stalled', label: 'Stalled', className: 'bg-red-100 text-red-800 active:bg-red-200' },
];

// The phone Goals tab is fully read/write, matching the desktop Goals section:
// each goal can be checked in, edited and deleted here, and new goals are set
// with the same natural-language fast path (see MobileGoalEditorSheet).
export function GoalsTab({
  monthItems,
  quarterItems,
  nudges,
  isLoading,
  error,
  onChanged,
}: {
  monthItems: GoalWithProgress[];
  quarterItems: GoalWithProgress[];
  nudges: GoalNudge[];
  isLoading: boolean;
  error: string | null;
  // Refetches the overview after a write so pacing (computed server-side) is
  // recomputed from the new evidence.
  onChanged: () => void;
}) {
  const now = new Date();

  // undefined = closed, null = a new goal, a Goal = editing it.
  const [editing, setEditing] = useState<Goal | null | undefined>(undefined);
  const [newPeriodKind, setNewPeriodKind] = useState<GoalPeriodKind>('month');
  const [writeError, setWriteError] = useState<string | null>(null);
  // Immediate feedback for a just-recorded check-in, until the refresh lands.
  const [savedStatus, setSavedStatus] = useState<Record<string, GoalCheckInStatus>>({});
  // Optimistically hidden while a delete is in flight.
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  // The current quarter's goals are the only eligible parents for a new/edited
  // monthly goal, and the overview already has them.
  const parentCandidates = quarterItems.map(item => item.goal);

  const handleCheckIn = async (
    goalId: string,
    status: GoalCheckInStatus,
    note?: string,
    value?: number
  ) => {
    setWriteError(null);
    setSavedStatus(prev => ({ ...prev, [goalId]: status }));
    try {
      await api.checkInGoal(goalId, { status, note, value, source: 'goals-tab' });
      onChanged();
    } catch (err) {
      console.error('Failed to record goal check-in:', err);
      setSavedStatus(prev => {
        const next = { ...prev };
        delete next[goalId];
        return next;
      });
      setWriteError('Could not save that check-in.');
    }
  };

  const handleDelete = async (goalId: string) => {
    setWriteError(null);
    setDeletingIds(prev => new Set(prev).add(goalId));
    try {
      await api.deleteGoal(goalId);
      onChanged();
    } catch (err) {
      console.error('Failed to delete goal:', err);
      setDeletingIds(prev => {
        const next = new Set(prev);
        next.delete(goalId);
        return next;
      });
      setWriteError('Could not delete that goal.');
    }
  };

  const openNew = () => {
    setNewPeriodKind('month');
    setEditing(null);
  };

  if (isLoading) {
    return <p className="py-10 text-center text-sm text-gray-500">Loading goals…</p>;
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </div>
    );
  }

  const visibleMonth = monthItems.filter(item => !deletingIds.has(item.goal.id));
  const visibleQuarter = quarterItems.filter(item => !deletingIds.has(item.goal.id));
  const isEmpty = visibleMonth.length === 0 && visibleQuarter.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Goals</h2>
        <button
          type="button"
          onClick={openNew}
          className="flex h-9 items-center gap-1.5 rounded-md bg-gray-900 px-3 text-sm font-semibold text-white active:bg-gray-800"
        >
          <Plus className="h-4 w-4" />
          New goal
        </button>
      </div>

      {writeError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {writeError}
        </div>
      )}

      {nudges.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <AlertTriangle className="h-4 w-4" />
            {nudges.length} need{nudges.length === 1 ? 's' : ''} attention
          </h2>
          <ul className="mt-1.5 space-y-1">
            {nudges.slice(0, 4).map(nudge => (
              <li key={nudge.goal.id} className="text-xs text-amber-800">
                <span className="font-medium">{nudge.goal.title}</span> —{' '}
                {nudge.reason === 'stalled'
                  ? 'marked stalled'
                  : nudge.reason === 'no-evidence'
                    ? 'nothing recorded yet'
                    : 'behind pace'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isEmpty ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-10 text-center">
          <Target className="mx-auto h-8 w-8 text-gray-400" />
          <p className="mt-3 text-sm font-medium text-gray-700">No goals set</p>
          <p className="mt-1 text-xs text-gray-500">
            Tap New goal to set one — describe it in a line and the rest is drafted for you.
          </p>
        </div>
      ) : (
        <>
          <GoalGroup
            heading={periodLabel('month', periodKeyFor('month', now))}
            items={visibleMonth}
            savedStatus={savedStatus}
            onCheckIn={handleCheckIn}
            onEdit={setEditing}
            onDelete={handleDelete}
          />
          <GoalGroup
            heading={periodLabel('quarter', periodKeyFor('quarter', now))}
            items={visibleQuarter}
            savedStatus={savedStatus}
            onCheckIn={handleCheckIn}
            onEdit={setEditing}
            onDelete={handleDelete}
          />
        </>
      )}

      {editing !== undefined && (
        <MobileGoalEditorSheet
          goal={editing}
          defaultSectionId={goalSections()[0].id}
          defaultPeriodKind={editing ? editing.periodKind : newPeriodKind}
          parentCandidates={parentCandidates}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function GoalGroup({
  heading,
  items,
  savedStatus,
  onCheckIn,
  onEdit,
  onDelete,
}: {
  heading: string;
  items: GoalWithProgress[];
  savedStatus: Record<string, GoalCheckInStatus>;
  onCheckIn: (goalId: string, status: GoalCheckInStatus, note?: string, value?: number) => void;
  onEdit: (goal: Goal) => void;
  onDelete: (goalId: string) => void;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">{heading}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400">Nothing set.</p>
      ) : (
        <div className="space-y-2">
          {items.map(item => (
            <MobileGoalCard
              key={item.goal.id}
              item={item}
              savedStatus={savedStatus[item.goal.id]}
              onCheckIn={onCheckIn}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MobileGoalCard({
  item,
  savedStatus,
  onCheckIn,
  onEdit,
  onDelete,
}: {
  item: GoalWithProgress;
  savedStatus?: GoalCheckInStatus;
  onCheckIn: (goalId: string, status: GoalCheckInStatus, note?: string, value?: number) => void;
  onEdit: (goal: Goal) => void;
  onDelete: (goalId: string) => void;
}) {
  const { goal, progress } = item;
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [note, setNote] = useState('');
  const [value, setValue] = useState('');

  const submitCheckIn = (status: GoalCheckInStatus) => {
    const parsed = value.trim() === '' ? undefined : Number(value);
    onCheckIn(goal.id, status, note.trim() || undefined, Number.isFinite(parsed) ? parsed : undefined);
    setCheckInOpen(false);
    setNote('');
    setValue('');
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">{goal.title}</p>
          {goal.detail && <p className="mt-0.5 text-xs text-gray-600">{goal.detail}</p>}
        </div>
        <span className="flex-shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
          {sectionLabel(goal.sectionId)}
        </span>
      </div>

      <div className="mt-2">
        <GoalPacingBar progress={progress} target={goal.target} />
      </div>

      {savedStatus && (
        <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-emerald-700">
          <Check className="h-3.5 w-3.5" />
          Checked in — {savedStatus}
        </p>
      )}

      <div className="mt-3 flex items-center gap-1 border-t border-gray-100 pt-2">
        <button
          type="button"
          onClick={() => {
            setConfirmingDelete(false);
            setCheckInOpen(open => !open);
          }}
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-semibold text-gray-600 active:bg-gray-100"
        >
          <MessageSquarePlus className="h-4 w-4" />
          Check in
        </button>
        <button
          type="button"
          onClick={() => onEdit(goal)}
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-semibold text-gray-600 active:bg-gray-100"
        >
          <Pencil className="h-4 w-4" />
          Edit
        </button>
        <button
          type="button"
          onClick={() => {
            setCheckInOpen(false);
            setConfirmingDelete(confirm => !confirm);
          }}
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-semibold text-gray-500 active:bg-red-50 active:text-red-600"
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </button>
      </div>

      {confirmingDelete && (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-xs text-red-800">Delete this goal? Its history goes with it.</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="h-9 flex-1 rounded-md border border-gray-300 bg-white text-xs font-semibold text-gray-700 active:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete(goal.id);
              }}
              className="h-9 flex-1 rounded-md bg-red-600 text-xs font-semibold text-white active:bg-red-700"
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {checkInOpen && (
        <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3">
          <label className="mb-1 block text-xs font-medium text-gray-600" htmlFor={`note-${goal.id}`}>
            Note (optional)
          </label>
          <input
            id={`note-${goal.id}`}
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="What's the state of this?"
            className="h-10 w-full rounded-md border border-gray-300 px-2 text-base"
          />
          {goal.evidence.kind === 'manual' && (
            <div className="mt-2">
              <label className="mb-1 block text-xs font-medium text-gray-600" htmlFor={`value-${goal.id}`}>
                Figure so far{goal.target?.unit ? ` (${goal.target.unit})` : ''}
              </label>
              <input
                id={`value-${goal.id}`}
                type="number"
                inputMode="numeric"
                value={value}
                onChange={e => setValue(e.target.value)}
                className="h-10 w-32 rounded-md border border-gray-300 px-2 text-base"
              />
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {CHECK_IN_OPTIONS.map(option => (
              <button
                key={option.status}
                type="button"
                onClick={() => submitCheckIn(option.status)}
                className={`flex h-9 items-center gap-1 rounded-md px-3 text-xs font-semibold ${option.className}`}
              >
                <Check className="h-3.5 w-3.5" />
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
