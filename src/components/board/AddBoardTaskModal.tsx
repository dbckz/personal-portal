'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';

import {
  BUILT_IN_TASK_TYPE_EMOJIS,
  BUILT_IN_TASK_TYPE_LABELS,
  getCustomTaskTypeId,
  isCustomTaskType,
  type BuiltInTaskType,
  type CalendarEvent,
  type CustomTaskType,
  type TaskType,
  type TaskTypeSelection,
} from '@/types';
import { asanaTypeLabel } from '@/lib/board';
import { dayFilterChips } from '@/lib/board-format';

const BUILT_IN_TASK_TYPES: BuiltInTaskType[] = [
  'flight', 'train', 'car', 'walk', 'writing', 'reading', 'focus', 'email', 'batch',
];

// What the "New task" tab hands back to the board (which creates the ad-hoc task
// and pins it). Title stays plain; the type drives the card's type chip.
export interface NewBoardTask {
  title: string;
  taskType: TaskType;
  typeLabel: string;
  dueDate?: string; // yyyy-MM-dd, no time
  duration?: number;
  priority: 'low' | 'medium' | 'high';
}

interface AddBoardTaskModalProps {
  weekStart: string;
  defaultDay?: string; // the currently filtered day, pre-selected as the planned day
  customTypes: CustomTaskType[];
  asanaTasks: CalendarEvent[]; // live incomplete Asana tasks, for "From Asana"
  onClose: () => void;
  onAddNew: (task: NewBoardTask) => Promise<void>;
  onAddAsana: (task: CalendarEvent) => Promise<void>;
}

type Tab = 'new' | 'asana';

function typeDisplay(
  type: TaskType,
  customTypes: CustomTaskType[]
): { emoji: string; label: string } {
  if (isCustomTaskType(type)) {
    const custom = customTypes.find(c => c.id === getCustomTaskTypeId(type));
    return { emoji: custom?.emoji || '📌', label: custom?.label || 'Custom' };
  }
  return {
    emoji: BUILT_IN_TASK_TYPE_EMOJIS[type as BuiltInTaskType],
    label: BUILT_IN_TASK_TYPE_LABELS[type as BuiltInTaskType],
  };
}

export function AddBoardTaskModal({
  weekStart,
  defaultDay,
  customTypes,
  asanaTasks,
  onClose,
  onAddNew,
  onAddAsana,
}: AddBoardTaskModalProps) {
  const [tab, setTab] = useState<Tab>('new');

  // New-task form state
  const [title, setTitle] = useState('');
  const [taskType, setTaskType] = useState<TaskTypeSelection>(null);
  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const [plannedDay, setPlannedDay] = useState<string | undefined>(defaultDay);
  const [duration, setDuration] = useState(30);
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [busy, setBusy] = useState(false);

  // From-Asana search
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const allTypes = useMemo(
    () => [
      ...BUILT_IN_TASK_TYPES.map(t => ({ type: t as TaskType, ...typeDisplay(t, customTypes) })),
      ...customTypes.map(c => ({ type: `custom:${c.id}` as TaskType, emoji: c.emoji, label: c.label })),
    ],
    [customTypes]
  );

  const days = dayFilterChips(weekStart);

  const filteredAsana = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? asanaTasks.filter(
          t =>
            t.title.toLowerCase().includes(q) ||
            t.projects?.some(p => p.name.toLowerCase().includes(q))
        )
      : asanaTasks;
    return list.slice(0, 40);
  }, [asanaTasks, query]);

  const handleSubmitNew = async () => {
    if (!taskType || !title.trim() || busy) return;
    setBusy(true);
    try {
      await onAddNew({
        title: title.trim(),
        taskType,
        typeLabel: typeDisplay(taskType, customTypes).label,
        dueDate: plannedDay,
        duration,
        priority,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const handleAddAsana = async (task: CalendarEvent) => {
    if (busy) return;
    setBusy(true);
    try {
      await onAddAsana(task);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const selectedType = taskType ? typeDisplay(taskType, customTypes) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="text-lg font-semibold">Add to board</h2>
          <button onClick={onClose} className="rounded-lg p-1 hover:bg-gray-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b px-4 pt-3">
          {(['new', 'asana'] as Tab[]).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-t-lg px-3 py-2 text-sm font-medium ${
                tab === t
                  ? 'border-b-2 border-orange-500 text-orange-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'new' ? 'New task' : 'From Asana'}
            </button>
          ))}
        </div>

        {tab === 'new' ? (
          <div className="space-y-4 p-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Title</label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                autoFocus
                placeholder="What needs doing?"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
              />
            </div>

            {/* Type picker */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Type</label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowTypeMenu(v => !v)}
                  className="flex w-full items-center justify-between rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-orange-500"
                >
                  <span className={selectedType ? 'text-gray-900' : 'text-gray-400'}>
                    {selectedType ? `${selectedType.emoji} ${selectedType.label}` : 'Select type…'}
                  </span>
                  <ChevronDown className="h-4 w-4 text-gray-400" />
                </button>
                {showTypeMenu && (
                  <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
                    {allTypes.map(t => (
                      <button
                        key={t.type}
                        type="button"
                        onClick={() => {
                          setTaskType(t.type);
                          setShowTypeMenu(false);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-orange-50"
                      >
                        <span>{t.emoji}</span>
                        <span>{t.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Planned day */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Planned day <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {days.map(d => (
                  <button
                    key={d.date}
                    type="button"
                    onClick={() => setPlannedDay(prev => (prev === d.date ? undefined : d.date))}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                      plannedDay === d.date
                        ? 'border-orange-500 bg-orange-500 text-white'
                        : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Duration (min)</label>
                <input
                  type="number"
                  min={5}
                  step={5}
                  value={duration}
                  onChange={e => setDuration(Math.max(5, Number(e.target.value) || 0))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-orange-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Priority</label>
                <select
                  value={priority}
                  onChange={e => setPriority(e.target.value as 'low' | 'medium' | 'high')}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-orange-500"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmitNew}
                disabled={!taskType || !title.trim() || busy}
                className="flex-1 rounded-lg bg-orange-500 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add task
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4">
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                autoFocus
                placeholder="Search live Asana tasks…"
                className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-orange-500"
              />
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {filteredAsana.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400">No matching tasks.</p>
              ) : (
                filteredAsana.map(task => {
                  const type = asanaTypeLabel(task);
                  const project = task.projects?.[0]?.name;
                  return (
                    <button
                      key={task.id}
                      type="button"
                      disabled={busy}
                      onClick={() => handleAddAsana(task)}
                      className="flex w-full flex-col items-start rounded-lg border border-gray-100 px-3 py-2 text-left hover:border-orange-200 hover:bg-orange-50 disabled:opacity-50"
                    >
                      <span className="text-sm font-medium text-gray-900">{task.title}</span>
                      <span className="mt-0.5 flex flex-wrap gap-1.5 text-[11px] text-gray-400">
                        {type && <span>{type}</span>}
                        {project && <span>· {project}</span>}
                        {task.integrationName && <span>· {task.integrationName}</span>}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
