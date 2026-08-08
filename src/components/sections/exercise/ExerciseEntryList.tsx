'use client';

import { formatEntryDuration } from '@/lib/exercise-targets';
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

export function ExerciseEntryList({ entries }: { entries: ExerciseEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <ul className="divide-y divide-gray-100">
      {entries.map(entry => (
        <li key={entry.id} className="py-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 text-sm font-medium text-gray-900">{entry.name}</span>
            <span className="flex-shrink-0 text-xs tabular-nums text-gray-600">
              {describeEntry(entry)}
            </span>
          </div>
          {entry.notes && <p className="mt-0.5 text-xs text-gray-500">{entry.notes}</p>}
        </li>
      ))}
    </ul>
  );
}
