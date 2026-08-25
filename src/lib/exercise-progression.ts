// Per-exercise progression: how a given lift has moved over time.
//
// This is the reason the log is kept at exercise level rather than session
// level. "Am I training enough?" is a session-count question; "is my chest press
// going up?" can only be answered from the individual sets.

import { normalizeExerciseName } from './exercise-names';
import { entryWasPerformed } from './exercise-entry';
import type { ExerciseSession } from '@/types/life';

export interface ProgressionPoint {
  date: string; // yyyy-MM-dd
  weightKg?: number;
  sets?: number;
  reps?: number;
  holdSeconds?: number;
  // "each side" — the sets/reps (or seconds) are per side, not a total. Carried
  // so a unilateral lift's "last time" and next target both read "each side".
  perSide?: boolean;
  // Cardio work is measured in time and distance, not sets and load. Carried so
  // a treadmill "last time" reads "15 min · 3.5 km" and not "the same".
  durationMinutes?: number;
  distanceKm?: number;
  // sets × reps × weight for the session — the usual rough proxy for work done.
  volume?: number;
  notes?: string;
  // Explicit reps-in-reserve logged for the exercise, if any. Carried so the
  // recommender can prefer it over the effort it parses out of `notes`.
  rir?: number;
}

export interface ExerciseProgression {
  // The display name, taken from the most recent spelling.
  name: string;
  key: string;
  sessions: number;
  points: ProgressionPoint[];
  first?: ProgressionPoint;
  latest?: ProgressionPoint;
  // Change in top weight from first to latest, in kg. Undefined when the
  // exercise has never been loaded (bodyweight work), where it would be noise.
  weightChangeKg?: number;
}

// Exercise names are typed by hand and drift ("Db lateral raise" vs "DB lateral
// raise"). Grouping on a key derived from the canonical name (see
// exercise-names) keeps one lift's history together — even where old,
// un-migrated data on the other machine still carries a pre-canonical spelling —
// without forcing a fixed exercise list.
export function exerciseKey(name: string): string {
  return normalizeExerciseName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// `before`, when given, restricts progression to sessions dated strictly before
// it. The Today view and the start route pass the day being planned so that
// "last time" means the PREVIOUS workout, not the session being logged right
// now — otherwise today's just-created session becomes its own `latest`. Left
// unset elsewhere (the Progress tab, analysis), so their semantics are
// unchanged.
export function buildProgressions(
  sessions: ExerciseSession[],
  options: { before?: string } = {}
): ExerciseProgression[] {
  const byKey = new Map<string, ExerciseProgression>();

  // Oldest first, so `first` and `latest` mean what they say.
  const ordered = [...sessions]
    .filter(
      s => s.completed && s.exercises?.length && (!options.before || s.date < options.before)
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const session of ordered) {
    for (const entry of session.exercises ?? []) {
      // A seeded-but-unticked (or explicitly un-ticked) entry was never
      // performed: its pre-filled target numbers must not enter the history as
      // if they were done, or they become the "last time" the next target
      // builds on.
      if (!entryWasPerformed(entry)) continue;
      const key = exerciseKey(entry.name);
      if (!key) continue;

      const point: ProgressionPoint = {
        date: session.date,
        ...(entry.weightKg !== undefined ? { weightKg: entry.weightKg } : {}),
        ...(entry.sets !== undefined ? { sets: entry.sets } : {}),
        ...(entry.reps !== undefined ? { reps: entry.reps } : {}),
        ...(entry.holdSeconds !== undefined ? { holdSeconds: entry.holdSeconds } : {}),
        ...(entry.perSide ? { perSide: true } : {}),
        ...(entry.durationMinutes !== undefined ? { durationMinutes: entry.durationMinutes } : {}),
        ...(entry.distanceKm !== undefined ? { distanceKm: entry.distanceKm } : {}),
        ...(entry.notes ? { notes: entry.notes } : {}),
        ...(entry.rir !== undefined ? { rir: entry.rir } : {}),
      };
      if (entry.weightKg !== undefined && entry.sets && entry.reps) {
        point.volume = entry.weightKg * entry.sets * entry.reps;
      }

      const existing = byKey.get(key);
      if (existing) {
        existing.points.push(point);
        existing.sessions += 1;
        // The latest spelling wins, so a tidied-up name shows through.
        existing.name = entry.name;
      } else {
        byKey.set(key, { name: entry.name, key, sessions: 1, points: [point] });
      }
    }
  }

  return [...byKey.values()]
    .map(p => {
      const loaded = p.points.filter(pt => pt.weightKg !== undefined);
      const first = p.points[0];
      const latest = p.points[p.points.length - 1];
      return {
        ...p,
        ...(first ? { first } : {}),
        ...(latest ? { latest } : {}),
        // Only meaningful across two or more loaded sessions.
        ...(loaded.length >= 2
          ? {
              weightChangeKg:
                round1((loaded[loaded.length - 1].weightKg ?? 0) - (loaded[0].weightKg ?? 0)),
            }
          : {}),
      };
    })
    // Most-trained first: the lifts with the most history are the ones worth
    // looking at.
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
