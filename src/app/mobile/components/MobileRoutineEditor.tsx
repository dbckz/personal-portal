'use client';

import { useState } from 'react';
import { Bed, Loader2, Plus, Trash2, X } from 'lucide-react';

import { api } from '@/lib/api';
import type { WeeklyRoutineDay } from '@/types/life';
import { MobileSheet } from './MobileSheet';

// The phone's read/write surface for the standing weekly routine: the same seven
// day cards the desktop Routine tab edits, in a bottom sheet. Edits are batched
// and saved as a whole (one routine PUT), matching the desktop idiom — the
// routine is stored data, not a live per-row log, so a single Save is the right
// grain here. On failure the edits are kept so they can be retried.

const DAY_LABELS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  0: 'Sun',
};

const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function sortDays(days: WeeklyRoutineDay[]): WeeklyRoutineDay[] {
  return [...days].sort(
    (a, b) => DISPLAY_ORDER.indexOf(a.dayOfWeek) - DISPLAY_ORDER.indexOf(b.dayOfWeek)
  );
}

export function MobileRoutineEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: WeeklyRoutineDay[];
  onClose: () => void;
  onSaved: (saved: WeeklyRoutineDay[]) => void;
}) {
  const [routine, setRoutine] = useState<WeeklyRoutineDay[]>(sortDays(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchDay = (dayOfWeek: number, patch: Partial<WeeklyRoutineDay>) =>
    setRoutine(prev => prev.map(d => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { routine: saved } = await api.saveWeeklyRoutine(routine);
      onSaved(sortDays(saved));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the routine.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <MobileSheet onClose={onClose}>
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 pb-3">
        <h2 className="text-lg font-semibold leading-6 text-gray-950">Weekly routine</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-gray-500 active:bg-gray-100"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
        {routine.map(day => (
          <DayEditor
            key={day.dayOfWeek}
            day={day}
            onChange={patch => patchDay(day.dayOfWeek, patch)}
          />
        ))}
      </div>

      <div className="flex-shrink-0 space-y-2 border-t border-gray-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="flex h-12 w-full items-center justify-center gap-1.5 rounded-lg bg-gray-900 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {saving ? 'Saving…' : 'Save routine'}
        </button>
      </div>
    </MobileSheet>
  );
}

function DayEditor({
  day,
  onChange,
}: {
  day: WeeklyRoutineDay;
  onChange: (patch: Partial<WeeklyRoutineDay>) => void;
}) {
  // A rest day carries no exercises; turning rest off leaves the lists empty for
  // the user to fill in.
  const toggleRest = () =>
    onChange(day.rest ? { rest: false } : { rest: true, anchors: [], staples: [] });

  return (
    <div
      className={`rounded-lg border p-3 ${
        day.rest ? 'border-gray-100 bg-gray-50/60' : 'border-gray-200 bg-white'
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="w-9 shrink-0 text-xs font-semibold uppercase tracking-wide text-gray-400">
          {DAY_LABELS[day.dayOfWeek]}
        </span>
        <input
          value={day.title}
          onChange={e => onChange({ title: e.target.value })}
          placeholder={day.rest ? 'Rest' : 'Session title'}
          className={`h-10 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-sm font-medium ${
            day.rest ? 'bg-transparent text-gray-500' : 'text-gray-900'
          }`}
        />
        <button
          type="button"
          onClick={toggleRest}
          aria-pressed={day.rest}
          title={day.rest ? 'Make this a training day' : 'Mark as a rest day'}
          className={`flex h-10 items-center gap-1 rounded-md px-2.5 text-xs font-semibold ${
            day.rest ? 'bg-gray-200 text-gray-600' : 'border border-gray-300 text-gray-500'
          }`}
        >
          <Bed className="h-3.5 w-3.5" />
          Rest
        </button>
      </div>

      {!day.rest && (
        <div className="space-y-3">
          <input
            value={day.note ?? ''}
            onChange={e => onChange({ note: e.target.value })}
            placeholder="Note (optional)"
            className="h-10 w-full rounded-md border border-gray-300 px-2 text-sm text-gray-600"
          />
          <NameList
            label="Anchors"
            names={day.anchors}
            onChange={anchors => onChange({ anchors })}
            addLabel="Add anchor"
          />
          <NameList
            label="Staples"
            names={day.staples ?? []}
            onChange={staples => onChange({ staples })}
            addLabel="Add staple"
          />
        </div>
      )}
    </div>
  );
}

// An editable list of exercise names — anchors lead a day and are driven up week
// to week; staples are the fixed recurring work.
function NameList({
  label,
  names,
  onChange,
  addLabel,
}: {
  label: string;
  names: string[];
  onChange: (names: string[]) => void;
  addLabel: string;
}) {
  const [adding, setAdding] = useState('');

  const add = () => {
    const name = adding.trim();
    if (!name) return;
    onChange([...names, name]);
    setAdding('');
  };

  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      {names.length === 0 && <p className="mb-1 text-xs text-gray-400">None yet.</p>}
      <ul className="space-y-1">
        {names.map((name, index) => (
          <li key={`${name}-${index}`} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-gray-800">{name}</span>
            <button
              type="button"
              onClick={() => onChange(names.filter((_, i) => i !== index))}
              aria-label={`Remove ${name}`}
              className="p-1.5 text-gray-400 active:text-red-600"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          value={adding}
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={addLabel}
          className="h-10 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-sm"
        />
        <button
          type="button"
          onClick={add}
          disabled={!adding.trim()}
          className="flex h-10 items-center gap-1 rounded-md border border-gray-300 px-2.5 text-xs font-semibold text-gray-700 disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>
    </div>
  );
}
