'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bed, Plus, Save, Trash2, X } from 'lucide-react';

import { api } from '@/lib/api';
import type { WeeklyRoutineDay } from '@/types/life';
import { KindTag } from './action-badge';

// The desktop Routine tab: Dave's standing weekly training routine, seven day
// cards Mon→Sun. This is the source the portal will build future sessions from
// once the authored calendar plan ends, so it's stored, editable data rather
// than a live view of the plan. Desktop is the read/write surface (per CLAUDE.md);
// mobile shows the same routine read-only.

// Monday-first labels, keyed by JS getDay() value (0 = Sunday).
const DAY_LABELS: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  0: 'Sunday',
};

const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function RoutineTab() {
  const [routine, setRoutine] = useState<WeeklyRoutineDay[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { routine } = await api.getWeeklyRoutine();
      setRoutine(sortDays(routine));
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the routine.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patchDay = (dayOfWeek: number, patch: Partial<WeeklyRoutineDay>) => {
    setRoutine(prev =>
      prev ? prev.map(d => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d)) : prev
    );
    setDirty(true);
  };

  const save = async () => {
    if (!routine) return;
    setSaving(true);
    setError(null);
    try {
      const { routine: saved } = await api.saveWeeklyRoutine(routine);
      setRoutine(sortDays(saved));
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the routine.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h2 className="font-semibold text-gray-900">Weekly routine</h2>
          <p className="text-sm text-gray-500">
            The standing shape of your training week. Future sessions are built from this once the
            planned calendar runs out.
          </p>
        </div>
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="flex shrink-0 items-center gap-1.5 px-3 py-2 text-sm font-semibold text-white bg-gray-900 rounded-md hover:bg-gray-800 disabled:opacity-40"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}

      {routine && (
        <div className="space-y-3">
          {routine.map(day => (
            <DayCard key={day.dayOfWeek} day={day} onChange={patch => patchDay(day.dayOfWeek, patch)} />
          ))}
        </div>
      )}
    </div>
  );
}

function DayCard({
  day,
  onChange,
}: {
  day: WeeklyRoutineDay;
  onChange: (patch: Partial<WeeklyRoutineDay>) => void;
}) {
  const toggleRest = () => {
    // A rest day carries no exercises; turning rest off leaves the lists empty
    // for the user to fill in.
    onChange(day.rest ? { rest: false } : { rest: true, anchors: [], staples: [] });
  };

  return (
    <div
      className={`rounded-lg border p-4 ${
        day.rest ? 'border-gray-100 bg-gray-50/60' : 'border-gray-200 bg-white'
      }`}
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-400 w-24 shrink-0">
          {DAY_LABELS[day.dayOfWeek]}
        </span>
        <input
          value={day.title}
          onChange={e => onChange({ title: e.target.value })}
          placeholder={day.rest ? 'Rest' : 'Session title'}
          className={`flex-1 min-w-0 px-2 py-1.5 text-sm font-medium border border-gray-200 rounded-md ${
            day.rest ? 'text-gray-500 bg-transparent' : 'text-gray-900'
          }`}
        />
        <button
          onClick={toggleRest}
          title={day.rest ? 'Make this a training day' : 'Mark as a rest day'}
          className={`flex items-center gap-1 px-2 py-1.5 text-xs font-semibold rounded-md ${
            day.rest
              ? 'text-gray-600 bg-gray-200'
              : 'text-gray-500 border border-gray-200 hover:bg-gray-50'
          }`}
        >
          <Bed className="w-3.5 h-3.5" />
          Rest
        </button>
      </div>

      {day.rest ? (
        <p className="pl-24 text-sm text-gray-400">Rest day.</p>
      ) : (
        <div className="pl-24 space-y-3">
          <input
            value={day.note ?? ''}
            onChange={e => onChange({ note: e.target.value })}
            placeholder="Note (optional)"
            className="w-full px-2 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-md"
          />

          <NameList
            label="Anchors"
            kind="core"
            isAnchor
            names={day.anchors}
            onChange={anchors => onChange({ anchors })}
            addLabel="Add anchor"
          />
          <NameList
            label="Staples"
            kind="core"
            names={day.staples ?? []}
            onChange={staples => onChange({ staples })}
            addLabel="Add staple"
          />
        </div>
      )}
    </div>
  );
}

// An editable list of exercise names, each badged with its role. Anchors lead a
// day and are driven up week to week; staples are the fixed recurring work.
function NameList({
  label,
  kind,
  isAnchor,
  names,
  onChange,
  addLabel,
}: {
  label: string;
  kind: 'core';
  isAnchor?: boolean;
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
            <KindTag kind={kind} isAnchor={isAnchor} />
            <span className="flex-1 min-w-0 text-sm text-gray-800 truncate">{name}</span>
            <button
              onClick={() => onChange(names.filter((_, i) => i !== index))}
              className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
              aria-label={`Remove ${name}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
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
          className="flex-1 min-w-0 px-2 py-1 text-sm border border-gray-200 rounded-md"
        />
        {adding.trim() ? (
          <button
            onClick={add}
            className="flex items-center gap-1 px-2 py-1 text-xs font-semibold text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        ) : (
          adding && (
            <button
              onClick={() => setAdding('')}
              className="p-1 rounded text-gray-400 hover:bg-gray-100"
              aria-label="Clear"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )
        )}
      </div>
    </div>
  );
}

function sortDays(days: WeeklyRoutineDay[]): WeeklyRoutineDay[] {
  return [...days].sort(
    (a, b) => DISPLAY_ORDER.indexOf(a.dayOfWeek) - DISPLAY_ORDER.indexOf(b.dayOfWeek)
  );
}
