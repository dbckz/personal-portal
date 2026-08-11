'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Check, Loader2, Plus, Trash2, X } from 'lucide-react';

import { api } from '@/lib/api';
import { parseLoad, parseVolume } from '@/lib/exercise-parse';
import { describeEntry } from '@/components/sections/exercise/ExerciseEntryList';
import type { ExerciseIntensity, ExerciseSession } from '@/types/life';
import { MobileSheet } from './MobileSheet';

// Create, edit or delete a planned/past session on the phone — the mobile
// counterpart of the desktop ExerciseLog's SessionForm, in a bottom sheet.
//
// Create comes in two modes: 'plan' (a session intended for later,
// completed=false) and 'log' (something already done, completed=true, with an
// optional per-exercise list). Passing a `session` puts the sheet in edit mode:
// the session-level fields plus a completed toggle, and a delete affordance with
// a confirm step. Editing a session's individual exercises stays on the Today
// checklist (which owns per-entry writes); here the exercises are shown for
// context.

const TODAY = () => format(new Date(), 'yyyy-MM-dd');
const INTENSITIES: ExerciseIntensity[] = ['easy', 'moderate', 'hard'];

// One in-progress exercise row in the create form.
interface DraftEntry {
  key: string;
  name: string;
  volume: string;
  load: string;
  notes: string;
}

export function MobileSessionSheet({
  mode,
  session,
  onClose,
  onSaved,
  onDelete,
}: {
  // Ignored when `session` is set (edit mode).
  mode: 'plan' | 'log';
  session?: ExerciseSession;
  onClose: () => void;
  onSaved: () => void;
  // Optimistic delete lives in the parent (it owns the list); the sheet just
  // asks for it once the confirm is through.
  onDelete?: () => void;
}) {
  const editing = !!session;

  const [date, setDate] = useState(session?.date ?? TODAY());
  const [type, setType] = useState(session?.type ?? '');
  const [duration, setDuration] = useState(
    session?.durationMinutes !== undefined ? String(session.durationMinutes) : ''
  );
  const [distance, setDistance] = useState(
    session?.distanceKm !== undefined ? String(session.distanceKm) : ''
  );
  const [intensity, setIntensity] = useState<ExerciseIntensity | ''>(session?.intensity ?? '');
  const [notes, setNotes] = useState(session?.notes ?? '');
  const [completed, setCompleted] = useState(session?.completed ?? false);
  const [entries, setEntries] = useState<DraftEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // The create form only offers the per-exercise list when logging something
  // already done, matching the desktop split between planning and history.
  const showExercises = !editing && mode === 'log';

  const addEntry = () =>
    setEntries(prev => [
      ...prev,
      { key: `${prev.length}-${Date.now()}`, name: '', volume: '', load: '', notes: '' },
    ]);
  const updateEntry = (key: string, patch: Partial<DraftEntry>) =>
    setEntries(prev => prev.map(e => (e.key === key ? { ...e, ...patch } : e)));
  const removeEntry = (key: string) => setEntries(prev => prev.filter(e => e.key !== key));

  const save = async () => {
    if (!type.trim()) {
      setError('Give the session a type (run, gym, climbing…).');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await api.updateExerciseSession(session.id, {
          date,
          type: type.trim(),
          durationMinutes: duration.trim() ? Number(duration) : undefined,
          distanceKm: distance.trim() ? Number(distance) : undefined,
          intensity: intensity || undefined,
          notes: notes.trim() || undefined,
          completed,
          planned: !completed,
        });
      } else {
        const named = entries.filter(e => e.name.trim());
        await api.createExerciseSession({
          date,
          type: type.trim(),
          ...(duration.trim() ? { durationMinutes: Number(duration) } : {}),
          ...(distance.trim() ? { distanceKm: Number(distance) } : {}),
          ...(intensity ? { intensity } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(named.length
            ? {
                exercises: named.map(e => ({
                  name: e.name.trim(),
                  ...parseVolume(e.volume),
                  ...parseLoad(e.load),
                  ...(e.volume.trim() ? { volumeText: e.volume.trim() } : {}),
                  ...(e.load.trim() ? { loadText: e.load.trim() } : {}),
                  ...(e.notes.trim() ? { notes: e.notes.trim() } : {}),
                })),
              }
            : {}),
          planned: mode === 'plan',
          completed: mode === 'log',
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the session.');
      setSaving(false);
    }
  };

  const title = editing
    ? 'Edit session'
    : mode === 'plan'
      ? 'Plan a session'
      : 'Log a session';

  const existingEntries = session?.exercises ?? [];

  return (
    <MobileSheet onClose={onClose}>
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 pb-3">
        <h2 className="text-lg font-semibold leading-6 text-gray-950">{title}</h2>
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
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="h-11 w-full rounded-md border border-gray-300 px-2 text-sm"
            />
          </Field>
          <Field label="Type">
            <input
              value={type}
              onChange={e => setType(e.target.value)}
              placeholder="run, gym, climbing"
              autoFocus={!editing}
              className="h-11 w-full rounded-md border border-gray-300 px-2 text-sm"
            />
          </Field>
          <Field label="Minutes (optional)">
            <input
              type="number"
              inputMode="numeric"
              min="1"
              value={duration}
              onChange={e => setDuration(e.target.value)}
              className="h-11 w-full rounded-md border border-gray-300 px-2 text-sm"
            />
          </Field>
          <Field label="Distance km (optional)">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.1"
              value={distance}
              onChange={e => setDistance(e.target.value)}
              className="h-11 w-full rounded-md border border-gray-300 px-2 text-sm"
            />
          </Field>
          <Field label="Intensity">
            <select
              value={intensity}
              onChange={e => setIntensity(e.target.value as ExerciseIntensity | '')}
              className="h-11 w-full rounded-md border border-gray-300 px-2 text-sm"
            >
              <option value="">Not recorded</option>
              {INTENSITIES.map(i => (
                <option key={i} value={i} className="capitalize">
                  {i}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notes">
            <input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="h-11 w-full rounded-md border border-gray-300 px-2 text-sm"
            />
          </Field>
        </div>

        {editing && (
          <button
            type="button"
            onClick={() => setCompleted(c => !c)}
            aria-pressed={completed}
            className={`flex h-11 w-full items-center justify-center gap-1.5 rounded-md text-sm font-semibold ${
              completed
                ? 'bg-emerald-600 text-white'
                : 'border border-gray-300 text-gray-700'
            }`}
          >
            <Check className="h-4 w-4" />
            {completed ? 'Marked done' : 'Mark as done'}
          </button>
        )}

        {showExercises && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-600">Exercises</span>
              <span className="text-[11px] text-gray-400">3*8 · 27kg · 2 km</span>
            </div>
            <div className="space-y-2">
              {entries.map(entry => (
                <div key={entry.key} className="rounded-md border border-gray-200 p-2">
                  <div className="flex items-center gap-2">
                    <input
                      value={entry.name}
                      onChange={e => updateEntry(entry.key, { name: e.target.value })}
                      placeholder="Exercise"
                      className="h-10 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => removeEntry(entry.key)}
                      aria-label="Remove exercise"
                      className="p-1.5 text-gray-400 active:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={entry.volume}
                      onChange={e => updateEntry(entry.key, { volume: e.target.value })}
                      placeholder="3*8 · 2 km"
                      className="h-10 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-sm"
                    />
                    <input
                      value={entry.load}
                      onChange={e => updateEntry(entry.key, { load: e.target.value })}
                      placeholder="27kg"
                      className="h-10 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-sm"
                    />
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addEntry}
              className="mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-gray-300 text-sm font-medium text-gray-600 active:bg-gray-50"
            >
              <Plus className="h-4 w-4" />
              Add exercise
            </button>
          </div>
        )}

        {editing && existingEntries.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Exercises
            </p>
            <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
              {existingEntries.map(entry => (
                <li key={entry.id} className="flex items-baseline justify-between gap-2 px-2.5 py-1.5">
                  <span className="min-w-0 text-sm text-gray-700">{entry.name}</span>
                  <span className="flex-shrink-0 text-[11px] tabular-nums text-gray-500">
                    {describeEntry(entry)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-gray-400">
              Edit individual exercises from the Today checklist.
            </p>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 space-y-2 border-t border-gray-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {error && <p className="text-sm text-red-600">{error}</p>}

        {editing && onDelete && (
          confirmingDelete ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="h-11 flex-1 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onDelete();
                  onClose();
                }}
                className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-red-600 text-sm font-semibold text-white"
              >
                <Trash2 className="h-4 w-4" />
                Delete session
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="flex h-11 w-full items-center justify-center gap-1.5 rounded-lg text-sm font-semibold text-red-600 active:bg-red-50"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
          )
        )}

        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="flex h-12 w-full items-center justify-center gap-1.5 rounded-lg bg-gray-900 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </MobileSheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-gray-600">{label}</span>
      {children}
    </label>
  );
}
