'use client';

import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { AlertTriangle, Check, Loader2, PartyPopper, RotateCcw } from 'lucide-react';

import { useChallenge75 } from '@/hooks/useChallenge75';
import {
  CHALLENGE_RULES,
  isWalkRequired,
  type Challenge75Day,
  type Challenge75Summary,
} from '@/lib/challenge75';
import type { Challenge75Rule } from '@/types/life';

// The 75 Hard tracker, shared verbatim by the desktop Exercise sub-tab and the
// mobile Exercise card. Responsive: the header stats wrap, and the 75-cell grid
// reflows from ten columns down to seven on a phone.
//
// It shows the attempt's state and stats, the day being edited (today by
// default, any past day when a grid cell is tapped) as a five-rule checklist,
// the full 75-day grid coloured by pass/miss/pending, the rules in plain text,
// and — when the attempt has failed or completed — a banner with the restart.
export function Challenge75Panel({ compact = false }: { compact?: boolean }) {
  const {
    summary,
    today,
    isLoading,
    error,
    isBusy,
    toggleRule,
    setNote,
    setStartDate,
    restart,
  } = useChallenge75();

  // The day whose checklist is open, once the reader has picked one. Until then
  // it's derived (today if in the attempt, else day 1) rather than synced via an
  // effect, so there's no cascading render.
  const [pickedDate, setPickedDate] = useState<string | null>(null);

  if (isLoading && !summary) {
    return <p className="py-6 text-sm text-gray-400">Loading 75 Hard…</p>;
  }
  if (!summary) {
    return (
      <section className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error ?? 'Could not load the 75 Hard tracker.'}
      </section>
    );
  }

  const defaultDate = summary.days.some(d => d.date === today) ? today : summary.days[0]?.date;
  const selected =
    summary.days.find(d => d.date === (pickedDate ?? defaultDate)) ?? summary.days[0];

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-gray-900">75 Hard</h2>
          <p className="text-xs text-gray-500">
            Started {format(parseISO(summary.startDate), 'EEE d MMM yyyy')}
          </p>
        </div>
        <StateBadge state={summary.state} />
      </header>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {summary.state === 'failed' && (
        <FailedBanner summary={summary} today={today} onRestart={restart} />
      )}
      {summary.state === 'complete' && <CompleteBanner />}

      <StatsRow summary={summary} />

      {selected && (
        <DayChecklist
          day={selected}
          today={today}
          isBusy={isBusy}
          onToggle={toggleRule}
          onNote={setNote}
          disabled={summary.state !== 'active'}
        />
      )}

      <Grid days={summary.days} selectedDate={selected?.date} onSelect={setPickedDate} />

      <Rules />

      <Footer
        summary={summary}
        today={today}
        onSetStartDate={setStartDate}
        onRestart={restart}
        compact={compact}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

function StateBadge({ state }: { state: Challenge75Summary['state'] }) {
  const styles: Record<Challenge75Summary['state'], string> = {
    active: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-rose-100 text-rose-700',
    complete: 'bg-blue-100 text-blue-700',
  };
  const label = state === 'active' ? 'Active' : state === 'failed' ? 'Failed' : 'Complete';
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${styles[state]}`}>
      {label}
    </span>
  );
}

function StatsRow({ summary }: { summary: Challenge75Summary }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <Stat label="Day" value={`${summary.currentDay} / ${summary.totalDays}`} />
      <Stat label="Passes" value={String(summary.passes)} />
      <Stat
        label="Misses left"
        value={String(summary.missesRemaining)}
        tone={summary.missesRemaining <= 1 ? 'warn' : 'plain'}
      />
      <Stat
        label="Last 7"
        value={summary.rolling.label}
        tone={summary.rolling.ok ? 'plain' : 'warn'}
      />
      <Stat label="Days left" value={String(summary.daysRemaining)} />
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'plain',
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'warn';
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-2.5 text-center shadow-sm">
      <div
        className={`text-lg font-bold tabular-nums ${
          tone === 'warn' ? 'text-rose-600' : 'text-gray-900'
        }`}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

function FailedBanner({
  summary,
  today,
  onRestart,
}: {
  summary: Challenge75Summary;
  today: string;
  onRestart: (startDate: string) => void;
}) {
  const reason =
    summary.failReason === 'cap'
      ? 'You used all 5 misses.'
      : summary.failReason === 'rolling'
        ? 'Two misses fell inside a 7-day window.'
        : 'The attempt has failed.';
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-rose-800">Attempt failed</p>
          <p className="mt-0.5 text-xs text-rose-700">{reason} Your ticks are kept in history.</p>
          <div className="mt-2">
            <RestartControl today={today} onRestart={onRestart} tone="rose" />
          </div>
        </div>
      </div>
    </div>
  );
}

function CompleteBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
      <PartyPopper className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
      <div>
        <p className="text-sm font-semibold text-blue-800">75 days done</p>
        <p className="mt-0.5 text-xs text-blue-700">
          You reached day 75 without breaking the rules. That&apos;s the whole challenge.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day checklist
// ---------------------------------------------------------------------------

function DayChecklist({
  day,
  today,
  isBusy,
  onToggle,
  onNote,
  disabled,
}: {
  day: Challenge75Day;
  today: string;
  isBusy: (key: string) => boolean;
  onToggle: (date: string, rule: Challenge75Rule, value: boolean) => void;
  onNote: (date: string, note: string) => void;
  disabled: boolean;
}) {
  const isFuture = day.date > today;
  const heading =
    day.date === today ? 'Today' : format(parseISO(day.date), 'EEEE d MMMM');

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex items-baseline justify-between gap-2 border-b border-gray-100 px-3 py-2.5">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">
            {heading} <span className="text-gray-400">· day {day.dayNumber}</span>
          </h3>
          <p className="text-xs text-gray-500">
            {isFuture ? 'Not started yet' : 'Tick each rule you met'}
          </p>
        </div>
        <StatusPill status={day.status} />
      </div>

      <ul className="divide-y divide-gray-100">
        {CHALLENGE_RULES.map(rule => {
          const walkExempt = rule.id === 'walk' && !isWalkRequired(day.date);
          const done = day.ticks[rule.id] === true;
          const key = `${day.date}:${rule.id}`;
          const busy = isBusy(key);
          return (
            <li key={rule.id} className="flex items-stretch">
              <button
                type="button"
                onClick={() => onToggle(day.date, rule.id, !done)}
                disabled={walkExempt || isFuture || disabled || busy}
                aria-pressed={done}
                aria-label={done ? `Mark ${rule.label} not done` : `Mark ${rule.label} done`}
                className="flex w-12 flex-shrink-0 items-center justify-center disabled:cursor-not-allowed"
              >
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full border-2 transition-colors ${
                    walkExempt
                      ? 'border-gray-200 bg-gray-100 text-gray-400'
                      : done
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

              <div className="min-w-0 flex-1 py-2.5 pr-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={`text-sm font-medium ${
                      done && !walkExempt ? 'text-gray-500 line-through' : 'text-gray-900'
                    }`}
                  >
                    {rule.label}
                  </span>
                  {walkExempt && (
                    <span className="flex-shrink-0 rounded bg-gray-100 px-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                      N/A Sunday
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-gray-500">
                  {walkExempt ? "Sunday's long walk is the exercise" : rule.description}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      {!isFuture && (
        <div className="border-t border-gray-100 px-3 py-2">
          <NoteField
            key={day.date}
            initial={day.ticks.note ?? ''}
            disabled={disabled}
            onCommit={note => onNote(day.date, note)}
          />
        </div>
      )}
    </div>
  );
}

// A note that commits on blur, not per keystroke (unreliable phone connections).
function NoteField({
  initial,
  disabled,
  onCommit,
}: {
  initial: string;
  disabled: boolean;
  onCommit: (note: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      type="text"
      value={value}
      disabled={disabled}
      placeholder="Note (optional)"
      onChange={e => setValue(e.target.value)}
      onBlur={() => {
        if (value.trim() !== initial.trim()) onCommit(value);
      }}
      className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-sm text-gray-700 placeholder:text-gray-400 disabled:bg-gray-50"
    />
  );
}

function StatusPill({ status }: { status: Challenge75Day['status'] }) {
  const styles: Record<Challenge75Day['status'], string> = {
    pass: 'bg-emerald-100 text-emerald-700',
    miss: 'bg-rose-100 text-rose-700',
    pending: 'bg-gray-100 text-gray-500',
  };
  const label = status === 'pass' ? 'Pass' : status === 'miss' ? 'Miss' : 'Pending';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles[status]}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The 75-cell grid
// ---------------------------------------------------------------------------

function Grid({
  days,
  selectedDate,
  onSelect,
}: {
  days: Challenge75Day[];
  selectedDate: string | undefined;
  onSelect: (date: string) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-10">
        {days.map(day => (
          <GridCell
            key={day.date}
            day={day}
            selected={day.date === selectedDate}
            onSelect={onSelect}
          />
        ))}
      </div>
      <Legend />
    </div>
  );
}

function GridCell({
  day,
  selected,
  onSelect,
}: {
  day: Challenge75Day;
  selected: boolean;
  onSelect: (date: string) => void;
}) {
  const base =
    'relative flex aspect-square items-center justify-center rounded-md text-xs font-semibold tabular-nums transition-colors';
  let tone: string;
  if (day.status === 'pass') tone = 'bg-emerald-500 text-white hover:bg-emerald-600';
  else if (day.status === 'miss') tone = 'bg-rose-500 text-white hover:bg-rose-600';
  else if (day.isToday) tone = 'bg-white text-amber-700 ring-2 ring-amber-400';
  else tone = 'bg-gray-100 text-gray-400 hover:bg-gray-200';

  const ring = selected ? 'outline outline-2 outline-offset-1 outline-gray-900' : '';
  const label = `Day ${day.dayNumber} · ${format(parseISO(day.date), 'EEE d MMM')} · ${day.status}`;

  return (
    <button
      type="button"
      onClick={() => onSelect(day.date)}
      title={label}
      aria-label={label}
      aria-pressed={selected}
      className={`${base} ${tone} ${ring}`}
    >
      {day.dayNumber}
    </button>
  );
}

function Legend() {
  const items = [
    { tone: 'bg-emerald-500', label: 'Pass' },
    { tone: 'bg-rose-500', label: 'Miss' },
    { tone: 'bg-white ring-2 ring-amber-400', label: 'Today' },
    { tone: 'bg-gray-100', label: 'Pending' },
  ];
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
      {items.map(item => (
        <span key={item.label} className="flex items-center gap-1 text-[11px] text-gray-500">
          <span className={`inline-block h-2.5 w-2.5 rounded-sm ${item.tone}`} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rules + footer
// ---------------------------------------------------------------------------

function Rules() {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
        The rules
      </h3>
      <ol className="list-inside list-decimal space-y-0.5 text-xs text-gray-600">
        <li>Do the planned exercise (Sunday: long walk + yoga).</li>
        <li>A 45-minute walk (Monday–Saturday; Sunday&apos;s long walk covers it).</li>
        <li>Drink 3 litres of water.</li>
        <li>Read a good chunk of a book.</li>
        <li>Take a progress photo.</li>
      </ol>
      <p className="mt-2 text-[11px] text-gray-500">
        Miss any required box and the day is a miss. At most 1 miss in any 7 days, and 5 misses
        total across the 75 days. Break either and the attempt fails.
      </p>
    </div>
  );
}

function Footer({
  summary,
  today,
  onSetStartDate,
  onRestart,
  compact,
}: {
  summary: Challenge75Summary;
  today: string;
  onSetStartDate: (startDate: string) => void;
  onRestart: (startDate: string) => void;
  compact: boolean;
}) {
  const [editingStart, setEditingStart] = useState(false);
  const [startValue, setStartValue] = useState(summary.startDate);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3">
      {editingStart ? (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={startValue}
            onChange={e => setStartValue(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={() => {
              if (startValue) onSetStartDate(startValue);
              setEditingStart(false);
            }}
            className="rounded-md bg-gray-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-gray-800"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setStartValue(summary.startDate);
              setEditingStart(false);
            }}
            className="text-xs font-medium text-gray-500 hover:text-gray-700"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditingStart(true)}
          className="text-xs font-medium text-gray-500 hover:text-gray-700"
        >
          Edit start date
        </button>
      )}

      {/* A restart is always reachable, not only after a failure — but it's kept
          quiet here (the loud path is the failed banner). */}
      {summary.state !== 'failed' && !compact && (
        <RestartControl today={today} onRestart={onRestart} tone="gray" />
      )}
    </div>
  );
}

// The restart affordance: a button that reveals a start-date picker and a
// confirm, so archiving the attempt is never a single mis-tap.
function RestartControl({
  today,
  onRestart,
  tone,
}: {
  today: string;
  onRestart: (startDate: string) => void;
  tone: 'rose' | 'gray';
}) {
  const [open, setOpen] = useState(false);
  const [startValue, setStartValue] = useState(today);

  const trigger =
    tone === 'rose'
      ? 'bg-rose-600 text-white hover:bg-rose-700'
      : 'border border-gray-300 text-gray-700 hover:bg-gray-50';

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold ${trigger}`}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Restart from day 1
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-gray-600">New start:</span>
      <input
        type="date"
        value={startValue}
        onChange={e => setStartValue(e.target.value)}
        className="rounded-md border border-gray-300 px-2 py-1 text-sm"
      />
      <button
        type="button"
        onClick={() => {
          onRestart(startValue || today);
          setOpen(false);
        }}
        className="rounded-md bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-700"
      >
        Confirm restart
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-xs font-medium text-gray-500 hover:text-gray-700"
      >
        Cancel
      </button>
    </div>
  );
}
