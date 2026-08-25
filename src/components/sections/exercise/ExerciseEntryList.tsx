'use client';

import { Check } from 'lucide-react';

import { formatEntryDuration } from '@/lib/exercise-targets';
import { entryWasPerformed } from '@/lib/exercise-entry';
import type { ExerciseEntry } from '@/types/life';

// Render one exercise the way it was logged: "3 × 8 · 27kg", "3 × 30s each
// side", "10 min". Falls back to the raw text the parser couldn't read, so
// nothing in the training log is ever invisible.
export function describeEntry(entry: ExerciseEntry): string {
  const parts: string[] = [];

  if (entry.sets && entry.reps) parts.push(`${entry.sets} × ${entry.reps}`);
  else if (entry.sets && entry.holdSeconds) parts.push(`${entry.sets} × ${entry.holdSeconds}s`);
  else if (entry.reps) parts.push(`${entry.reps} reps`);
  // A single hold with no set count — "a 90 second plank", as freehand logs
  // tend to describe it.
  else if (entry.holdSeconds) parts.push(`${entry.holdSeconds}s`);

  if (entry.perSide && parts.length > 0) parts[parts.length - 1] += ' each side';

  if (entry.distanceKm) parts.push(`${entry.distanceKm} km`);
  if (entry.durationMinutes) parts.push(formatEntryDuration(entry.durationMinutes));

  if (entry.weightKg !== undefined) parts.push(`${entry.weightKg}kg`);
  else if (entry.bodyweight) parts.push('bodyweight');

  // Nothing parsed — show what was actually written rather than an empty row.
  if (parts.length === 0) {
    return [entry.volumeText, entry.loadText].filter(Boolean).join(' · ');
  }
  return parts.join(' · ');
}

// `completed` marks a session that has been logged (history), where a
// not-done entry is a genuinely skipped exercise and should read that way. A
// planned session leaves it false: every entry there is legitimately pending,
// so no done/skipped markers are shown.
export function ExerciseEntryList({
  entries,
  completed = false,
}: {
  entries: ExerciseEntry[];
  completed?: boolean;
}) {
  if (entries.length === 0) return null;

  return (
    <ul className="divide-y divide-gray-100">
      {entries.map(entry => {
        // Only in a completed session is a not-done entry a skip. The seeded
        // target numbers are kept but read as not-performed (dimmed + label).
        const skipped = completed && !entryWasPerformed(entry);
        const done = completed && entryWasPerformed(entry);
        return (
          <li key={entry.id} className="py-2">
            <div className="flex items-baseline justify-between gap-3">
              <span
                className={`flex min-w-0 items-baseline gap-1.5 text-sm font-medium ${
                  skipped ? 'text-gray-400' : 'text-gray-900'
                }`}
              >
                {done && (
                  <Check className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-emerald-600" />
                )}
                <span className="min-w-0">{entry.name}</span>
                {skipped && (
                  <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                    skipped
                  </span>
                )}
              </span>
              <span
                className={`flex-shrink-0 text-xs tabular-nums ${
                  skipped ? 'text-gray-400 line-through' : 'text-gray-600'
                }`}
              >
                {describeEntry(entry)}
              </span>
            </div>
            {entry.notes && (
              <p className={`mt-0.5 text-xs ${skipped ? 'text-gray-400' : 'text-gray-500'}`}>
                {entry.notes}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
