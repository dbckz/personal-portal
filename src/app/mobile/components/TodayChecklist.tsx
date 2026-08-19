'use client';

import { useState } from 'react';
import { ArrowLeftRight, Check, Loader2, Plus, RotateCcw, Trash2, X } from 'lucide-react';

import {
  isCardioEntry,
  isHoldEntry,
  useTodaySession,
  type FieldPatch,
  type TodayRow,
} from '@/hooks/useTodaySession';
import { isCardioName } from '@/lib/exercise-parse';
import { describeVolumeLoad } from '@/lib/exercise-targets';
import { groupRowsIntoSections } from '@/lib/exercise-sections';
import { ActionBadge, FailureTag, FixedTag, KindTag } from '@/components/sections/exercise/action-badge';
import { RirChips } from '@/components/sections/exercise/rir-chips';

// The in-the-gym checklist on mobile: today's workout, one tickable row per
// exercise, each carrying its guidance (what to aim for and why, from last
// time). No "start" tap — the session is created lazily on the first write
// (see useTodaySession). Every action saves on its own, optimistically, because
// this is used one-handed on a connection that drops.
export function TodayChecklist({ onSessionChanged }: { onSessionChanged?: () => void }) {
  const {
    plan,
    rows,
    doneCount,
    totalCount,
    isLoading,
    generating,
    error,
    busyKey,
    knownNames,
    toggleDone,
    commitField,
    commitNote,
    commitRir,
    commitSwap,
    restoreSwap,
    addExercise,
    removeRow,
  } = useTodaySession(undefined, onSessionChanged);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (isLoading) {
    return <p className="py-6 text-center text-sm text-gray-500">Loading today’s workout…</p>;
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          {plan?.label || plan?.components.join(' + ') || 'Today'}
        </h2>
        {totalCount > 0 && (
          <span className="text-sm tabular-nums text-gray-500">
            {doneCount}/{totalCount} done
          </span>
        )}
      </div>

      {generating && (
        <p className="flex items-center gap-1.5 text-xs text-gray-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          Refining today’s plan…
        </p>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {rows.length === 0 && !adding && (
        <p className="text-sm text-gray-500">No planned exercises for today. Add what you do below.</p>
      )}

      <div className="space-y-4">
        {groupRowsIntoSections(rows).map(section => (
          <div key={section.title} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              {section.title}
            </h3>
            {section.rows.map(row => (
              <RowCard
                key={row.key}
                row={row}
                busy={busyKey === row.key}
                open={openKey === row.key}
                knownNames={knownNames}
                onToggleOpen={() => setOpenKey(openKey === row.key ? null : row.key)}
                onToggleDone={() => toggleDone(row)}
                onCommitField={patch => commitField(row, patch)}
                onCommitNote={note => commitNote(row, note)}
                onCommitRir={rir => commitRir(row, rir)}
                onCommitSwap={replacement => commitSwap(row, replacement)}
                onRestoreSwap={() => restoreSwap(row)}
                onRemove={() => removeRow(row)}
              />
            ))}
          </div>
        ))}
      </div>

      {adding ? (
        <AddExerciseForm
          onAdd={async input => {
            await addExercise(input);
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex h-12 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-300 text-sm font-medium text-gray-600 active:bg-gray-50"
        >
          <Plus className="h-4 w-4" />
          Add an exercise
        </button>
      )}
    </section>
  );
}

function RowCard({
  row,
  busy,
  open,
  knownNames,
  onToggleOpen,
  onToggleDone,
  onCommitField,
  onCommitNote,
  onCommitRir,
  onCommitSwap,
  onRestoreSwap,
  onRemove,
}: {
  row: TodayRow;
  busy: boolean;
  open: boolean;
  knownNames: string[];
  onToggleOpen: () => void;
  onToggleDone: () => void;
  onCommitField: (patch: FieldPatch) => void;
  onCommitNote: (note: string) => void;
  onCommitRir: (rir: number | null) => void;
  onCommitSwap: (replacement: { name: string; distanceKm?: number; durationMinutes?: number }) => void;
  onRestoreSwap: () => void;
  onRemove: () => void;
}) {
  const [note, setNote] = useState(row.notes ?? '');
  const [swapping, setSwapping] = useState(false);
  const current = describeVolumeLoad(row);
  const cardio = isCardioEntry(row);
  const hold = isHoldEntry(row);

  return (
    <div
      className={`rounded-lg border bg-white shadow-sm transition-colors ${
        row.done ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200'
      }`}
    >
      <div className="flex items-stretch">
        {/* The common case is one tap: it went as prescribed. */}
        <button
          type="button"
          onClick={onToggleDone}
          disabled={busy}
          aria-pressed={row.done}
          aria-label={row.done ? `Mark ${row.name} not done` : `Mark ${row.name} done`}
          className="flex w-14 flex-shrink-0 items-center justify-center"
        >
          <span
            className={`flex h-8 w-8 items-center justify-center rounded-full border-2 transition-colors ${
              row.done
                ? 'border-emerald-600 bg-emerald-600 text-white'
                : 'border-gray-300 text-transparent'
            }`}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
            ) : (
              <Check className="h-4 w-4" />
            )}
          </span>
        </button>

        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          className="min-w-0 flex-1 py-3 pr-3 text-left"
        >
          <div className="flex flex-wrap items-center gap-2">
            <p
              className={`text-sm font-medium ${
                row.done ? 'text-gray-500 line-through' : 'text-gray-900'
              }`}
            >
              {row.name}
            </p>
            {row.fixed ? (
              <FixedTag fixed={row.fixed} />
            ) : (
              row.kind && <KindTag kind={row.kind} isAnchor={row.isAnchor} />
            )}
            {row.toFailure && <FailureTag />}
            {row.action && <ActionBadge action={row.action} />}
          </div>
          {row.substitutedFor && (
            <p className="mt-0.5 text-[11px] text-amber-600">was: {row.substitutedFor}</p>
          )}
          <p className="mt-0.5 text-xs tabular-nums text-gray-600">
            {current || row.targetText || '—'}
            {row.targetText && row.targetText !== current && (
              <span className="text-gray-400"> · target {row.targetText}</span>
            )}
          </p>
          {row.rationale && <p className="mt-0.5 text-xs text-gray-500">{row.rationale}</p>}
          {row.lastSummary && (
            <p className="mt-0.5 text-[11px] text-gray-400">Last: {row.lastSummary}</p>
          )}
          {row.notes && !open && <p className="mt-0.5 text-xs text-gray-500">{row.notes}</p>}
        </button>
      </div>

      {open && (
        <div className="border-t border-gray-100 p-3">
          <div className="flex flex-wrap gap-2">
            {cardio ? (
              <>
                <NumberField
                  label="Distance (km)"
                  value={row.distanceKm}
                  step={0.1}
                  onCommit={v => onCommitField({ distanceKm: v })}
                />
                <NumberField
                  label="Time (min)"
                  value={row.durationMinutes}
                  onCommit={v => onCommitField({ durationMinutes: v })}
                />
              </>
            ) : (
              <>
                <NumberField label="Sets" value={row.sets} onCommit={v => onCommitField({ sets: v })} />
                {hold ? (
                  <NumberField
                    label="Secs"
                    value={row.holdSeconds}
                    onCommit={v => onCommitField({ holdSeconds: v })}
                  />
                ) : (
                  <NumberField label="Reps" value={row.reps} onCommit={v => onCommitField({ reps: v })} />
                )}
                <NumberField
                  label="kg"
                  value={row.weightKg}
                  step={0.5}
                  onCommit={v => onCommitField({ weightKg: v })}
                />
              </>
            )}
          </div>

          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-semibold text-gray-600">
              {cardio ? 'Pace / how it went' : 'How did it feel?'}
            </span>
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              onBlur={() => note !== (row.notes ?? '') && onCommitNote(note)}
              placeholder={
                cardio
                  ? '9.2 on treadmill, comfortable'
                  : hold
                    ? 'Could have held 15s longer…'
                    : 'Could have done 2 more…'
              }
              className="h-11 w-full rounded-md border border-gray-300 px-3 text-sm"
            />
          </label>
          {!cardio && (
            <>
              <RirChips
                value={row.rir}
                onChange={onCommitRir}
                label={hold ? 'Seconds in reserve' : 'Reps in reserve'}
              />
              <p className="mt-1 text-[11px] text-gray-400">
                The rating (or a note like &ldquo;could have {hold ? 'held 15s longer' : 'done 2 more'}
                &rdquo;) sets next session&apos;s target. A rating wins if you set one.
              </p>
            </>
          )}

          {swapping ? (
            <SwapForm
              knownNames={knownNames}
              onSwap={replacement => {
                onCommitSwap(replacement);
                setSwapping(false);
              }}
              onClose={() => setSwapping(false)}
            />
          ) : (
            <div className="mt-3 flex items-center gap-4">
              <button
                type="button"
                onClick={() => setSwapping(true)}
                className="flex items-center gap-1.5 text-xs font-medium text-gray-500 active:text-gray-900"
              >
                <ArrowLeftRight className="h-3.5 w-3.5" />
                Swap exercise
              </button>
              {row.substitutedFor && (
                <button
                  type="button"
                  onClick={onRestoreSwap}
                  className="flex items-center gap-1.5 text-xs font-medium text-gray-500 active:text-gray-900"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restore {row.substitutedFor}
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={onRemove}
            className="mt-3 flex items-center gap-1.5 text-xs font-medium text-gray-400 active:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove from this session
          </button>
        </div>
      )}
    </div>
  );
}

// Swap a planned exercise for another: a replacement name (autocompleting known
// names, but free text is fine) and an optional distance for a cardio swap
// (Parkrun → a shorter treadmill run). One save, optimistic like every other row
// action.
function SwapForm({
  knownNames,
  onSwap,
  onClose,
}: {
  knownNames: string[];
  onSwap: (replacement: { name: string; distanceKm?: number; durationMinutes?: number }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [distance, setDistance] = useState('');
  const [duration, setDuration] = useState('');
  // Only a cardio replacement earns a time field — "20 mins at 9.2" logs in one
  // go, but a strength swap keeps the lean name-plus-distance form.
  const cardio = isCardioName(name);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const km = Number(distance);
    const min = Number(duration);
    onSwap({
      name: trimmed,
      ...(distance.trim() !== '' && Number.isFinite(km) ? { distanceKm: km } : {}),
      ...(cardio && duration.trim() !== '' && Number.isFinite(min)
        ? { durationMinutes: min }
        : {}),
    });
  };

  return (
    <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-600">Swap for</span>
        <button type="button" onClick={onClose} aria-label="Cancel swap" className="p-1 text-gray-400">
          <X className="h-4 w-4" />
        </button>
      </div>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        list="today-exercise-names"
        placeholder="Replacement exercise"
        className="h-11 w-full rounded-md border border-gray-300 px-3 text-sm"
        autoFocus
      />
      <datalist id="today-exercise-names">
        {knownNames.map(n => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={distance}
          onChange={e => setDistance(e.target.value)}
          type="number"
          inputMode="decimal"
          step={0.1}
          placeholder={cardio ? 'Distance km' : 'Distance km (optional)'}
          className="h-11 flex-1 rounded-md border border-gray-300 px-3 text-sm"
        />
        {cardio && (
          <input
            value={duration}
            onChange={e => setDuration(e.target.value)}
            type="number"
            inputMode="decimal"
            step={1}
            placeholder="Time min"
            className="h-11 flex-1 rounded-md border border-gray-300 px-3 text-sm"
          />
        )}
        <button
          type="button"
          onClick={save}
          disabled={!name.trim()}
          className="h-11 rounded-md bg-gray-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          Swap
        </button>
      </div>
    </div>
  );
}

// Commits on blur rather than on every keystroke, so a half-typed "3" in a
// weight field never gets saved as the weight.
function NumberField({
  label,
  value,
  step = 1,
  onCommit,
}: {
  label: string;
  value?: number;
  step?: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));

  return (
    <label className="flex-1 min-w-20">
      <span className="mb-1 block text-xs font-semibold text-gray-600">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => {
          const parsed = Number(text);
          if (text.trim() !== '' && Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
        }}
        className="h-11 w-full rounded-md border border-gray-300 px-2 text-center text-sm tabular-nums"
      />
    </label>
  );
}

function AddExerciseForm({
  onAdd,
  onClose,
}: {
  onAdd: (input: { name: string; volume?: string; load?: string }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [volume, setVolume] = useState('');
  const [load, setLoad] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd({ name: name.trim(), volume: volume.trim(), load: load.trim() });
    } catch {
      setError('Could not add that exercise.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-600">New exercise</span>
        <button type="button" onClick={onClose} aria-label="Cancel" className="p-1 text-gray-400">
          <X className="h-4 w-4" />
        </button>
      </div>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Exercise"
        className="h-11 w-full rounded-md border border-gray-300 px-3 text-sm"
        autoFocus
      />
      <div className="mt-2 flex gap-2">
        <input
          value={volume}
          onChange={e => setVolume(e.target.value)}
          placeholder="3*8 · 3*30 secs · 2 km"
          className="h-11 flex-1 rounded-md border border-gray-300 px-3 text-sm"
        />
        <input
          value={load}
          onChange={e => setLoad(e.target.value)}
          placeholder="27kg / bodyweight"
          className="h-11 flex-1 rounded-md border border-gray-300 px-3 text-sm"
        />
      </div>
      <button
        type="button"
        onClick={save}
        disabled={saving || !name.trim()}
        className="mt-2 h-11 w-full rounded-md bg-gray-900 text-sm font-semibold text-white disabled:opacity-50"
      >
        {saving ? 'Adding…' : 'Add'}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
