'use client';

import { format, parseISO } from 'date-fns';

import { describeEntry } from '@/components/sections/exercise/ExerciseEntryList';
import { formatEntryDuration } from '@/lib/exercise-targets';
import type { ExerciseAnalysis, ExerciseSession } from '@/types/life';
import { FreeformLogCard } from '../components/FreeformLogCard';
import { TodayChecklist } from '../components/TodayChecklist';

// The mobile Exercise view — the primary gym surface. Today's workout leads as
// an interactive checklist (logging is read/write here, per project CLAUDE.md);
// below it, a read-only summary of the numbers, what's planned and what's been
// done recently.
export function ExerciseTab({
  planned,
  recent,
  analysis,
  isLoading,
  error,
  onSessionChanged,
}: {
  planned: ExerciseSession[];
  recent: ExerciseSession[];
  analysis: ExerciseAnalysis | null;
  isLoading: boolean;
  error: string | null;
  onSessionChanged?: () => void;
}) {
  return (
    <div className="space-y-5">
      <TodayChecklist onSessionChanged={onSessionChanged} />

      {/* The escape hatch from the checklist: the day the plan didn't happen. */}
      <FreeformLogCard onLogged={onSessionChanged} />

      {isLoading && <p className="text-center text-sm text-gray-500">Loading sessions…</p>}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {analysis && analysis.totalSessions > 0 && (
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Sessions" value={String(analysis.totalSessions)} />
          <Stat label="Per week" value={String(analysis.sessionsPerWeek)} />
          <Stat label="Streak" value={`${analysis.currentStreakWeeks}w`} />
        </div>
      )}

      <SessionGroup
        heading="Planned"
        sessions={planned}
        empty="Nothing planned."
        dateFormat="EEE d MMM"
      />
      <SessionGroup
        heading="Recent"
        sessions={recent}
        empty="Nothing logged recently."
        dateFormat="EEE d MMM"
      />

      {analysis && analysis.suggestions.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Suggestions
          </h2>
          <ul className="space-y-2">
            {analysis.suggestions.map(suggestion => (
              <li
                key={suggestion}
                className="rounded-lg border border-gray-200 bg-white p-3 text-sm leading-6 text-gray-700 shadow-sm"
              >
                {suggestion}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SessionGroup({
  heading,
  sessions,
  empty,
  dateFormat,
}: {
  heading: string;
  sessions: ExerciseSession[];
  empty: string;
  dateFormat: string;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">{heading}</h2>
      {sessions.length === 0 ? (
        <p className="text-sm text-gray-400">{empty}</p>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
          <ul className="divide-y divide-gray-100">
            {sessions.map(session => {
              const entries = session.exercises ?? [];
              return (
                <li key={session.id} className="px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">
                        {session.label || session.type}
                      </p>
                      <p className="text-xs text-gray-500">
                        {format(parseISO(session.date), dateFormat)}
                        {session.intensity ? ` · ${session.intensity}` : ''}
                      </p>
                    </div>
                    <span className="flex-shrink-0 text-xs tabular-nums text-gray-600">
                      {session.durationMinutes ? formatEntryDuration(session.durationMinutes) : ''}
                      {session.distanceKm ? ` · ${session.distanceKm} km` : ''}
                    </span>
                  </div>

                  {/* The exercises are the interesting part on a phone: this is
                      what you check standing in the gym. Read-only, like the
                      rest of this summary. */}
                  {entries.length > 0 && (
                    <ul className="mt-1.5 space-y-1 border-l-2 border-gray-100 pl-2.5">
                      {entries.map(entry => (
                        <li key={entry.id} className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 text-xs text-gray-700">{entry.name}</span>
                          <span className="flex-shrink-0 text-[11px] tabular-nums text-gray-500">
                            {describeEntry(entry)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 text-center shadow-sm">
      <div className="text-xl font-bold tabular-nums text-gray-900">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}
