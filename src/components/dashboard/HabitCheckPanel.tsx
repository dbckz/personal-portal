'use client';

import { useEffect, useState } from 'react';
import { addDays, format } from 'date-fns';
import { HeartPulse } from 'lucide-react';

import { api } from '@/lib/api';
import { HABITS, habitCatchupDates, habitDayHeader } from '@/lib/wellbeing-habits';
import type { HabitLog } from '@/types/wellbeing';

// The state of one habit's question. 'unanswered' is deliberately distinct from
// "no": a day left blank is a day nothing is known about, and the analysis
// treats it that way rather than counting it as a miss.
export type HabitAnswer = { done?: boolean; reason: string };
export type HabitAnswers = Record<string, HabitAnswer>;

// One catch-up day's draft, keyed by yyyy-MM-dd in the state below.
export type HabitDayDraft = { answers: HabitAnswers; notes: string };
// The whole panel's state, owned by the caller: a draft per day being reviewed.
export type HabitDayState = Record<string, HabitDayDraft>;

export function emptyHabitAnswers(): HabitAnswers {
  return Object.fromEntries(HABITS.map(h => [h.id, { reason: '' }]));
}

function emptyDayDraft(): HabitDayDraft {
  return { answers: emptyHabitAnswers(), notes: '' };
}

// A "no" is only saveable with a reason. Returns the habit ids that are
// incomplete, so the modal can block the save and point at what's missing.
export function incompleteHabits(answers: HabitAnswers): string[] {
  return HABITS.filter(h => answers[h.id]?.done === false && !answers[h.id]?.reason.trim()).map(
    h => h.id
  );
}

// The dates (across every day in the state) that carry a "no" without a reason.
// A single such day anywhere blocks the whole save — the reason is the only part
// of a skip worth keeping, so an empty one is worse than no answer at all.
export function incompleteHabitDays(state: HabitDayState): string[] {
  return Object.entries(state)
    .filter(([, day]) => incompleteHabits(day.answers).length > 0)
    .map(([date]) => date);
}

// The answers as storage wants them: only the habits actually answered.
export function habitLogsFrom(answers: HabitAnswers): HabitLog[] {
  return HABITS.flatMap(h => {
    const answer = answers[h.id];
    if (answer?.done === undefined) return [];
    return [
      answer.done
        ? { habitId: h.id, done: true }
        : { habitId: h.id, done: false, reason: answer.reason.trim() },
    ];
  });
}

// The days worth writing: any whose draft has at least one answered habit or
// non-empty notes. Days left entirely untouched are dropped, so a catch-up day
// nobody filled in never creates a record.
export function saveableHabitDays(
  state: HabitDayState
): Array<{ date: string; habits: HabitLog[]; notes: string }> {
  return Object.entries(state)
    .map(([date, day]) => ({ date, habits: habitLogsFrom(day.answers), notes: day.notes }))
    .filter(d => d.habits.length > 0 || d.notes.trim() !== '');
}

function dayHasInput(day: HabitDayDraft): boolean {
  return day.notes.trim() !== '' || HABITS.some(h => day.answers[h.id]?.done !== undefined);
}

interface HabitCheckPanelProps {
  today: string; // yyyy-MM-dd — the logical day being reviewed
  state: HabitDayState;
  onChange: (state: HabitDayState) => void;
  // Set once the user has tried to save, so the missing-reason warning appears
  // on the attempt rather than while they're still typing.
  showErrors?: boolean;
}

// The daily habits, asked at the end of the daily review. Fetches the trailing
// week once on mount and asks separately for today plus any recent day whose
// habits were never answered — so skipping the review for a day or two doesn't
// lose those days. Any answer already recorded for a listed day is loaded in, so
// re-running the review shows what was said rather than a blank form.
export function HabitCheckPanel({ today, state, onChange, showErrors = false }: HabitCheckPanelProps) {
  const [loaded, setLoaded] = useState(false);
  // Today renders immediately; the catch-up days are appended once the fetch
  // tells us which recent days are still unanswered.
  const [dates, setDates] = useState<string[]>([today]);

  useEffect(() => {
    let cancelled = false;
    const start = format(addDays(new Date(`${today}T12:00:00`), -6), 'yyyy-MM-dd');
    api
      .getWellbeingDays(start, today)
      .then(res => {
        if (cancelled) return;
        const days = res.days ?? [];
        const list = habitCatchupDates(today, days);
        const byDate = new Map(days.map(d => [d.date, d]));
        // Seed each listed day from any stored record, but never clobber a day
        // the user has already started typing into (they may have answered today
        // before the fetch returned).
        const seeded: HabitDayState = {};
        for (const date of list) {
          const existing = state[date];
          if (existing && dayHasInput(existing)) {
            seeded[date] = existing;
            continue;
          }
          const draft = emptyDayDraft();
          const stored = byDate.get(date);
          if (stored) {
            for (const log of stored.habits) {
              if (draft.answers[log.habitId]) {
                draft.answers[log.habitId] = { done: log.done, reason: log.reason ?? '' };
              }
            }
            if (stored.notes) draft.notes = stored.notes;
          }
          seeded[date] = draft;
        }
        setDates(list);
        onChange(seeded);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
    // Seeding runs once per day being reviewed; state/onChange are the caller's
    // and re-running on their identity would clobber typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  const multiDay = dates.length > 1;

  const setDay = (date: string, draft: HabitDayDraft) => onChange({ ...state, [date]: draft });

  return (
    <section className="mt-4 rounded-lg border border-violet-200 bg-violet-50/50 p-3.5">
      <div className="flex items-center gap-2">
        <HeartPulse className="h-4 w-4 text-violet-500" />
        <h3 className="text-sm font-medium text-gray-800">Daily habits</h3>
        {!loaded && <span className="text-[11px] text-gray-400">loading…</span>}
      </div>

      {multiDay && (
        <p className="mt-1 text-[11px] text-gray-500">
          Catching up a few days — answer each one, or leave a day blank and it
          simply won’t be recorded.
        </p>
      )}

      <div className={multiDay ? 'mt-2 space-y-4' : ''}>
        {dates.map(date => (
          <HabitDaySection
            key={date}
            date={date}
            header={multiDay ? habitDayHeader(date, today) : undefined}
            draft={state[date] ?? emptyDayDraft()}
            onChange={draft => setDay(date, draft)}
            showErrors={showErrors}
          />
        ))}
      </div>
    </section>
  );
}

// One day's habit questions and notes. Rendered without a header for a plain
// single-day review (so it looks as it always has); with a compact header once
// there is more than one day to catch up.
function HabitDaySection({
  date,
  header,
  draft,
  onChange,
  showErrors,
}: {
  date: string;
  // yyyy-MM-dd of "today", used only to keep today's field labels stable (and
  // therefore addressable) regardless of how many days are shown.
  header?: string;
  draft: HabitDayDraft;
  onChange: (draft: HabitDayDraft) => void;
  showErrors: boolean;
}) {
  const { answers, notes } = draft;
  const missing = showErrors ? incompleteHabits(answers) : [];
  // Today's labels stay bare so existing addressing keeps working; a catch-up
  // day disambiguates with its header.
  const labelSuffix = header && header !== 'Today' ? ` (${header})` : '';
  const notesId = `wellbeing-notes-${date}`;

  const setAnswer = (habitId: string, patch: Partial<HabitAnswer>) =>
    onChange({ answers: { ...answers, [habitId]: { ...answers[habitId], ...patch } }, notes });

  return (
    <div>
      {header && (
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-600">
          {header}
        </h4>
      )}

      <ul className={`${header ? 'mt-1.5' : 'mt-2.5'} space-y-2.5`}>
        {HABITS.map(habit => {
          const answer = answers[habit.id] ?? { reason: '' };
          const needsReason = missing.includes(habit.id);
          return (
            <li key={habit.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-gray-700">{habit.question}</span>
                <div
                  role="group"
                  aria-label={`${habit.question}${labelSuffix}`}
                  className="inline-flex flex-shrink-0 overflow-hidden rounded-md border border-gray-200 text-[11px] font-medium"
                >
                  <button
                    type="button"
                    onClick={() => setAnswer(habit.id, { done: answer.done === true ? undefined : true })}
                    aria-pressed={answer.done === true}
                    className={`px-2.5 py-1 transition-colors ${
                      answer.done === true
                        ? 'bg-emerald-500 text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnswer(habit.id, { done: answer.done === false ? undefined : false })}
                    aria-pressed={answer.done === false}
                    className={`px-2.5 py-1 transition-colors ${
                      answer.done === false
                        ? 'bg-gray-500 text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    No
                  </button>
                </div>
              </div>

              {answer.done === false && (
                <div className="mt-1.5">
                  <input
                    type="text"
                    value={answer.reason}
                    onChange={e => setAnswer(habit.id, { reason: e.target.value })}
                    placeholder="Why not? (required)"
                    aria-label={`Why ${habit.label.toLowerCase()} didn’t happen${labelSuffix}`}
                    aria-invalid={needsReason}
                    className={`w-full rounded-md border px-2 py-1 text-xs focus:outline-none focus:ring-1 ${
                      needsReason
                        ? 'border-red-300 focus:ring-red-400'
                        : 'border-gray-200 focus:ring-orange-400'
                    }`}
                  />
                  {needsReason && (
                    <p className="mt-1 text-[11px] text-red-600">
                      Say what got in the way — that’s the part worth having later.
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-3">
        <label className="block text-[11px] font-medium text-gray-600" htmlFor={notesId}>
          Anything else worth noting?{labelSuffix}
        </label>
        <textarea
          id={notesId}
          value={notes}
          onChange={e => onChange({ answers, notes: e.target.value })}
          rows={2}
          placeholder="Optional — mood, sleep, what the day was like. Useful context later."
          className="mt-1 w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-orange-400"
        />
      </div>
    </div>
  );
}
