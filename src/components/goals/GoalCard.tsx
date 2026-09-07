'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Check, CheckCircle2, MessageSquarePlus, Pencil, RotateCcw, Trash2 } from 'lucide-react';

import { sectionLabel } from '@/lib/life-sections';
import type { GoalCheckInStatus, GoalStatus, GoalWithProgress } from '@/types/life';
import { GoalPacingBar } from './GoalPacingBar';

const CHECK_IN_OPTIONS: Array<{ status: GoalCheckInStatus; label: string; className: string }> = [
  { status: 'on-track', label: 'On track', className: 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200' },
  { status: 'slipping', label: 'Slipping', className: 'bg-amber-100 text-amber-800 hover:bg-amber-200' },
  { status: 'stalled', label: 'Stalled', className: 'bg-red-100 text-red-800 hover:bg-red-200' },
];

// The terminal verdicts, in the order the reflection session uses them.
const CLOSE_OPTIONS: Array<{ status: Exclude<GoalStatus, 'active'>; label: string; className: string }> = [
  { status: 'hit', label: 'Hit', className: 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200' },
  { status: 'partial', label: 'Partial', className: 'bg-amber-100 text-amber-800 hover:bg-amber-200' },
  { status: 'missed', label: 'Missed', className: 'bg-red-100 text-red-800 hover:bg-red-200' },
  { status: 'dropped', label: 'Dropped', className: 'bg-gray-100 text-gray-700 hover:bg-gray-200' },
];

interface GoalCardProps {
  item: GoalWithProgress;
  // Monthly goals rendered underneath their quarterly parent.
  subGoals?: GoalWithProgress[];
  showSection?: boolean;
  onCheckIn: (goalId: string, status: GoalCheckInStatus, note?: string, value?: number) => void;
  onEdit: (goalId: string) => void;
  onDelete: (goalId: string) => void;
  // Close a goal early with a terminal verdict, or reopen a closed one
  // (status 'active').
  onSetStatus: (goalId: string, status: GoalStatus, reflection?: string) => void;
}

export function GoalCard({
  item,
  subGoals = [],
  showSection = true,
  onCheckIn,
  onEdit,
  onDelete,
  onSetStatus,
}: GoalCardProps) {
  const { goal, progress } = item;
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [note, setNote] = useState('');
  const [value, setValue] = useState('');
  const [closeNote, setCloseNote] = useState(goal.reflection ?? '');

  const isActive = goal.status === 'active';

  const submitCheckIn = (status: GoalCheckInStatus) => {
    const parsed = value.trim() === '' ? undefined : Number(value);
    onCheckIn(goal.id, status, note.trim() || undefined, Number.isFinite(parsed) ? parsed : undefined);
    setCheckInOpen(false);
    setNote('');
    setValue('');
  };

  const submitClose = (status: Exclude<GoalStatus, 'active'>) => {
    onSetStatus(goal.id, status, closeNote.trim() || undefined);
    setCloseOpen(false);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-gray-900 break-words">{goal.title}</h3>
          {goal.detail && <p className="mt-0.5 text-sm text-gray-600">{goal.detail}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
            {showSection && (
              <span className="px-1.5 py-0.5 rounded bg-gray-100 font-medium">
                {sectionLabel(goal.sectionId)}
              </span>
            )}
            {goal.status !== 'active' && (
              <span className="px-1.5 py-0.5 rounded bg-gray-800 text-white font-medium uppercase tracking-wide">
                {goal.status}
              </span>
            )}
            {progress.lastCheckIn && (
              <span>
                Last check-in {format(new Date(progress.lastCheckIn.at), 'd MMM')} ·{' '}
                {progress.lastCheckIn.status}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setCheckInOpen(open => !open)}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-800"
            aria-label="Add a check-in"
            title="Add a check-in"
          >
            <MessageSquarePlus className="w-4 h-4" />
          </button>
          {isActive ? (
            <button
              onClick={() => {
                setCheckInOpen(false);
                setCloseOpen(open => !open);
              }}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-800"
              aria-label="Close goal"
              title="Close goal"
            >
              <CheckCircle2 className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => onSetStatus(goal.id, 'active')}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-800"
              aria-label="Reopen goal"
              title="Reopen goal"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => onEdit(goal.id)}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-800"
            aria-label="Edit goal"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(goal.id)}
            className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
            aria-label="Delete goal"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="mt-3">
        <GoalPacingBar progress={progress} target={goal.target} />
      </div>

      {checkInOpen && (
        <div className="mt-3 p-3 rounded-md bg-gray-50 border border-gray-200">
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor={`note-${goal.id}`}>
            Note (optional)
          </label>
          <input
            id={`note-${goal.id}`}
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="What's the state of this?"
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
          />
          {goal.evidence.kind === 'manual' && (
            <div className="mt-2">
              <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor={`value-${goal.id}`}>
                Figure so far{goal.target?.unit ? ` (${goal.target.unit})` : ''}
              </label>
              <input
                id={`value-${goal.id}`}
                type="number"
                value={value}
                onChange={e => setValue(e.target.value)}
                className="w-32 px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              />
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {CHECK_IN_OPTIONS.map(option => (
              <button
                key={option.status}
                onClick={() => submitCheckIn(option.status)}
                className={`flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md ${option.className}`}
              >
                <Check className="w-3 h-3" />
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {closeOpen && (
        <div className="mt-3 p-3 rounded-md bg-gray-50 border border-gray-200">
          <p className="text-xs font-medium text-gray-600 mb-1">How did this goal land?</p>
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor={`close-note-${goal.id}`}>
            Note (optional)
          </label>
          <textarea
            id={`close-note-${goal.id}`}
            value={closeNote}
            onChange={e => setCloseNote(e.target.value)}
            placeholder="What happened, and what would you do differently?"
            rows={3}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {CLOSE_OPTIONS.map(option => (
              <button
                key={option.status}
                onClick={() => submitClose(option.status)}
                className={`flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md ${option.className}`}
              >
                <Check className="w-3 h-3" />
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {subGoals.length > 0 && (
        <div className="mt-3 pl-3 border-l-2 border-gray-200 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Monthly goals under this
          </p>
          {subGoals.map(child => (
            <div key={child.goal.id} className="rounded-md bg-gray-50 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium text-gray-800">{child.goal.title}</span>
                <span className="text-[11px] text-gray-500 shrink-0">{child.goal.periodKey}</span>
              </div>
              <div className="mt-2">
                <GoalPacingBar progress={child.progress} target={child.goal.target} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
