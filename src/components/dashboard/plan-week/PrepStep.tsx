'use client';

import { Dispatch, SetStateAction } from 'react';
import { ChevronRight } from 'lucide-react';
import { format, parseISO } from 'date-fns';

import type { PrepCandidatesResponse } from '@/lib/api';
import { RowSelect, PREP_LENGTH_OPTIONS, timeRange } from './helpers';

interface PrepStepProps {
  prepData: PrepCandidatesResponse | null;
  isLoading: boolean;
  showOtherMeetings: boolean;
  setShowOtherMeetings: Dispatch<SetStateAction<boolean>>;
  prepDurations: Record<string, number>;
  prepDays: Record<string, string>;
  setPrepDecision: (title: string, needsPrep: boolean) => void;
  changePrepDuration: (eventId: string, durationMinutes: number) => void;
  changePrepDay: (eventId: string, date: string) => void;
}

export function PrepStep({
  prepData,
  isLoading,
  showOtherMeetings,
  setShowOtherMeetings,
  prepDurations,
  prepDays,
  setPrepDecision,
  changePrepDuration,
  changePrepDay,
}: PrepStepProps) {
  if (!prepData) {
    return (
      <p className="text-sm text-gray-400 italic py-8 text-center">No meeting data available.</p>
    );
  }
  // Suggested = every needs-prep meeting EXCEPT ones the server couldn't place
  // (those show in the amber box below, keyed by `key`). A meeting just toggled ON
  // has no proposed `block` yet and isn't unplaced, so it lands here as a pending
  // slot until Next re-proposes; a placed meeting carries its block. Matching the
  // server's needs-prep-minus-unplaced set keeps the optimistic toggle from either
  // dropping a row (block gap) or double-listing a genuinely unplaceable one.
  const unplacedKeys = new Set(prepData.unplaced.map(u => u.key));
  const suggested = prepData.meetings.filter(m => m.needsPrep && !unplacedKeys.has(m.key));
  const others = prepData.meetings.filter(m => !m.needsPrep);
  const workingDays = prepData.workingDays ?? [];

  // Per-meeting prep-day options: every working day THIS week up to and including
  // the meeting's day. A next-week meeting's prep is always placed this week, so
  // its options are this week's remaining days (none is "Day of"/"Day before").
  // Labels: the meeting day is "Day of", the day immediately before is "Day
  // before", the rest are "EEE d".
  const dayOptionsFor = (m: (typeof prepData.meetings)[number]): Array<{ value: string; label: string }> => {
    const meetingDate = m.date;
    const md = parseISO(meetingDate);
    const dayBefore = format(new Date(md.getFullYear(), md.getMonth(), md.getDate() - 1), 'yyyy-MM-dd');
    const pool = workingDays.filter(d => d <= meetingDate);
    return [...new Set(pool)]
      .sort()
      .map(d => ({
        value: d,
        label:
          d === meetingDate ? 'Day of' : d === dayBefore ? 'Day before' : format(parseISO(d), 'EEE d'),
      }));
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
          Suggested prep
        </h3>
        {suggested.length === 0 ? (
          <p className="text-sm text-gray-400 italic">
            No meetings this week look like they need prep.
          </p>
        ) : (
          <ul className="space-y-2">
            {suggested.map(m => {
              const b = m.block;
              return (
                <li
                  key={m.eventId}
                  className="flex items-start gap-3 rounded-lg border border-gray-200 p-3"
                >
                  <input
                    type="checkbox"
                    checked
                    onChange={() => setPrepDecision(m.title, false)}
                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 flex items-center gap-1.5">
                      <span className="truncate">{m.title}</span>
                    </p>
                    {b ? (
                      <p className="text-xs text-gray-500 mt-0.5">
                        <span className="font-medium text-slate-600">
                          {format(parseISO(b.date), 'EEE')} {timeRange(b.start, b.durationMinutes)}
                        </span>{' '}
                        · {m.reason}
                      </p>
                    ) : (
                      // Just toggled ON — the server proposes its slot on Next.
                      <p className="text-xs text-gray-400 italic mt-0.5">Slot proposed at next step</p>
                    )}
                  </div>
                  <RowSelect
                    value={prepDurations[m.eventId] ?? 15}
                    options={PREP_LENGTH_OPTIONS}
                    onChange={v => changePrepDuration(m.eventId, Number(v))}
                    disabled={isLoading}
                    ariaLabel={`Prep length for ${m.title}`}
                    className="mt-0.5"
                  />
                  <RowSelect
                    value={prepDays[m.eventId] ?? b?.date ?? m.date}
                    options={dayOptionsFor(m)}
                    onChange={v => changePrepDay(m.eventId, v)}
                    disabled={isLoading}
                    ariaLabel={`Prep day for ${m.title}`}
                    className="mt-0.5"
                  />
                </li>
              );
            })}
          </ul>
        )}
        {suggested.length > 0 && (
          <p className="mt-2 text-[11px] text-gray-400">
            Slots finalize when you press Next.
          </p>
        )}
      </div>

      {prepData.unplaced.length > 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
          <p className="text-xs font-medium text-amber-800 mb-1">Couldn&apos;t fit prep for:</p>
          <ul className="text-xs text-amber-700 space-y-0.5">
            {prepData.unplaced.map(u => (
              <li key={u.key}>
                <span className="font-medium">{u.title}</span> · {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {others.length > 0 && (
        <div>
          <button
            onClick={() => setShowOtherMeetings(v => !v)}
            className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-600"
          >
            <ChevronRight
              className={`w-3.5 h-3.5 transition-transform ${showOtherMeetings ? 'rotate-90' : ''}`}
            />
            Other meetings ({others.length})
          </button>
          {showOtherMeetings && (
            <ul className="mt-2 space-y-2">
              {others.map(m => (
                <li
                  key={m.eventId}
                  className="flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3"
                >
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => setPrepDecision(m.title, true)}
                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-700">{m.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {format(parseISO(m.date), 'EEE')} {m.start} · add a prep block
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
