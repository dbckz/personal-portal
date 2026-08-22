'use client';

import { useMemo, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import {
  AdHocTask,
  BUILT_IN_TASK_TYPE_EMOJIS,
  BUILT_IN_TASK_TYPE_LABELS,
  BuiltInTaskType,
  CalendarEvent,
  CustomTaskType,
  TaskType,
} from '@/types';
import { asanaTypeLabel, boardKeyForAdhoc, boardKeyForAsana } from '@/lib/board';
import type { PinToWeekArgs } from '@/hooks/useBoard';
import { MobileSheet } from './MobileSheet';
import { dayFilterChips } from '@/lib/board-format';

const BUILT_IN_TASK_TYPES: BuiltInTaskType[] = [
  'writing', 'reading', 'focus', 'email', 'batch', 'walk',
];

const DURATION_CHOICES = [15, 30, 45, 60, 90];

interface TypeChoice {
  value: TaskType;
  emoji: string;
  label: string;
}

// Add a task to the board: a new quick ad-hoc task pinned to the visible week,
// or an existing live Asana task pinned to the week. Both go on the board with
// status "todo".
export function MobileBoardAddSheet({
  weekStart,
  initialDay,
  customTypes,
  asanaTasks,
  onCreateAdhoc,
  pinToWeek,
  onClose,
}: {
  weekStart: string;
  // A day within the visible week to pre-select (from the active day filter).
  initialDay?: string;
  customTypes: CustomTaskType[];
  asanaTasks: CalendarEvent[];
  onCreateAdhoc: (task: Omit<AdHocTask, 'id' | 'createdAt' | 'updatedAt'>) => Promise<AdHocTask | null>;
  pinToWeek: (args: PinToWeekArgs) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'new' | 'asana'>('new');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New-task form.
  const [title, setTitle] = useState('');
  const [taskType, setTaskType] = useState<TaskType | null>(null);
  const [dueDate, setDueDate] = useState<string | undefined>(initialDay);
  const [duration, setDuration] = useState(30);

  // From-Asana search.
  const [query, setQuery] = useState('');

  const typeChoices = useMemo<TypeChoice[]>(() => {
    const builtIns: TypeChoice[] = BUILT_IN_TASK_TYPES.map(t => ({
      value: t,
      emoji: BUILT_IN_TASK_TYPE_EMOJIS[t],
      label: BUILT_IN_TASK_TYPE_LABELS[t],
    }));
    const customs: TypeChoice[] = customTypes.map(ct => ({
      value: `custom:${ct.id}` as TaskType,
      emoji: ct.emoji,
      label: ct.label,
    }));
    return [...builtIns, ...customs];
  }, [customTypes]);

  const selectedChoice = useMemo(
    () => typeChoices.find(c => c.value === taskType) ?? null,
    [typeChoices, taskType]
  );

  const days = useMemo(() => dayFilterChips(weekStart), [weekStart]);

  const handleCreateNew = async () => {
    if (!taskType || !selectedChoice) return;
    const trimmed = title.trim();
    const composed = trimmed
      ? `${selectedChoice.emoji} ${selectedChoice.label}: ${trimmed}`
      : `${selectedChoice.emoji} ${selectedChoice.label}`;

    setIsSubmitting(true);
    setError(null);
    try {
      const created = await onCreateAdhoc({
        title: composed,
        dueDate: dueDate || undefined,
        duration,
        priority: 'medium',
        taskType,
        completed: false,
      });
      if (!created) throw new Error('create failed');
      await pinToWeek({
        key: boardKeyForAdhoc(created.id),
        weekStart,
        title: composed,
        typeLabel: selectedChoice.label,
        status: 'todo',
      });
      onClose();
    } catch {
      setError('Could not add that task — check your connection and try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return asanaTasks.slice(0, 20);
    return asanaTasks
      .filter(t => {
        const inTitle = t.title.toLowerCase().includes(q);
        const inProject = t.projects?.some(p => p.name.toLowerCase().includes(q));
        return inTitle || inProject;
      })
      .slice(0, 20);
  }, [asanaTasks, query]);

  const handlePinAsana = async (task: CalendarEvent) => {
    setIsSubmitting(true);
    setError(null);
    try {
      await pinToWeek({
        key: boardKeyForAsana(task.id),
        weekStart,
        title: task.title,
        typeLabel: asanaTypeLabel(task),
        integrationId: task.integrationId,
        status: 'todo',
      });
      onClose();
    } catch {
      setError('Could not add that task — check your connection and try again.');
      setIsSubmitting(false);
    }
  };

  const inputClass =
    'h-12 w-full rounded-lg border border-gray-300 px-3 text-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500';

  return (
    <MobileSheet onClose={onClose}>
      <div className="flex items-center justify-between border-b border-gray-200 px-4 pb-3">
        <h2 className="text-lg font-semibold text-gray-950">Add task</h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-md text-gray-500 transition-colors active:bg-gray-100"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMode('new')}
            className={`h-11 rounded-lg text-sm font-medium transition-colors ${
              mode === 'new' ? 'bg-orange-600 text-white' : 'border border-gray-300 text-gray-700 active:bg-gray-50'
            }`}
          >
            New task
          </button>
          <button
            type="button"
            onClick={() => setMode('asana')}
            className={`h-11 rounded-lg text-sm font-medium transition-colors ${
              mode === 'asana' ? 'bg-orange-600 text-white' : 'border border-gray-300 text-gray-700 active:bg-gray-50'
            }`}
          >
            From Asana
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
        )}

        {mode === 'new' ? (
          <>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Type <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                {typeChoices.map(choice => (
                  <button
                    key={choice.value}
                    type="button"
                    onClick={() => setTaskType(choice.value)}
                    className={`flex h-14 flex-col items-center justify-center gap-0.5 rounded-lg text-xs transition-colors ${
                      taskType === choice.value
                        ? 'bg-orange-100 text-orange-700 ring-1 ring-orange-300'
                        : 'border border-gray-200 bg-white text-gray-600 active:bg-gray-100'
                    }`}
                  >
                    <span className="text-lg">{choice.emoji}</span>
                    <span>{choice.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Title {!taskType && <span className="text-red-500">*</span>}
              </label>
              <input
                type="text"
                defaultValue={title}
                onBlur={e => setTitle(e.target.value)}
                placeholder={selectedChoice ? `Optional — defaults to "${selectedChoice.label}"` : 'Enter task title'}
                className={inputClass}
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Planned day</label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setDueDate(undefined)}
                  className={`rounded-full px-3 py-2 text-xs font-medium transition-colors ${
                    !dueDate
                      ? 'bg-orange-100 text-orange-700 ring-1 ring-orange-300'
                      : 'border border-gray-200 bg-white text-gray-600 active:bg-gray-100'
                  }`}
                >
                  None
                </button>
                {days.map(day => (
                  <button
                    key={day.date}
                    type="button"
                    onClick={() => setDueDate(prev => (prev === day.date ? undefined : day.date))}
                    className={`flex flex-col items-center rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      dueDate === day.date
                        ? 'bg-orange-100 text-orange-700 ring-1 ring-orange-300'
                        : 'border border-gray-200 bg-white text-gray-600 active:bg-gray-100'
                    }`}
                  >
                    <span>{day.label}</span>
                    <span className="text-[10px] opacity-70">{day.dayOfMonth}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Duration</label>
              <div className="flex flex-wrap gap-1.5">
                {DURATION_CHOICES.map(mins => (
                  <button
                    key={mins}
                    type="button"
                    onClick={() => setDuration(mins)}
                    className={`rounded-full px-3 py-2 text-xs font-medium transition-colors ${
                      duration === mins
                        ? 'bg-orange-100 text-orange-700 ring-1 ring-orange-300'
                        : 'border border-gray-200 bg-white text-gray-600 active:bg-gray-100'
                    }`}
                  >
                    {mins}m
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={handleCreateNew}
              disabled={!taskType || isSubmitting}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-orange-600 font-medium text-white transition-colors active:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Add to board
            </button>
          </>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search Asana tasks"
                className={`${inputClass} pl-9`}
              />
            </div>

            <div className="space-y-2">
              {searchResults.length === 0 ? (
                <p className="py-6 text-center text-sm text-gray-400">No matching tasks.</p>
              ) : (
                searchResults.map(task => (
                  <button
                    key={task.id}
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => handlePinAsana(task)}
                    className="w-full rounded-lg border border-gray-200 bg-white p-3 text-left shadow-sm transition-colors active:bg-gray-50 disabled:opacity-60"
                  >
                    <div className="text-sm font-medium leading-snug text-gray-950">{task.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
                      {asanaTypeLabel(task) && (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5">{asanaTypeLabel(task)}</span>
                      )}
                      {task.projects?.[0]?.name && <span>{task.projects[0].name}</span>}
                    </div>
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </MobileSheet>
  );
}
