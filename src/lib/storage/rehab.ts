// Dave's daily back-rehab block: a small tickable home routine, shown every day
// (rest days included) and tracked DELIBERATELY SEPARATELY from the exercise
// session/programme system. It rehabs a back issue (tight hip flexors / anterior
// pelvic tilt from running), so it must persist whether or not a gym session
// exists that day. Some movements here also appear as gym staples — the two are
// not synced; a tick here is only ever a tick here.
//
// Its own `rehabRoutine` domain in the user-data store (see ./db), read and
// written directly rather than through getUserData(): a dedicated module owns
// the seed-on-empty, the tick bookkeeping and the tick-date pruning.
//
// SEED_EXERCISES is a captured default, not a placeholder: on the first read of
// an empty store it is written in so the block has real content, then becomes
// ordinary editable data. Ids are stable slugs so a tick survives an edit.

import { readAllDomains, writeAllDomains } from './db';
import type { RehabExercise, RehabRoutine } from '@/types/life';

const SEED_EXERCISES: RehabExercise[] = [
  {
    id: 'couch-stretch',
    name: 'Couch stretch',
    prescription: '90 s per side',
    note: 'Back knee against sofa/wall, glute squeezed, torso tall — feel it in the front of the hip, not the lower back',
  },
  {
    id: 'glute-bridge',
    name: 'Glute bridge',
    prescription: '2×15',
    note: "2 s squeeze at the top, ribs down, don't arch the lower back",
  },
  {
    id: 'dead-bug',
    name: 'Dead bug',
    prescription: '10 per side, slow',
    note: 'Lower back pressed into the floor',
  },
  {
    id: 'side-plank',
    name: 'Side plank',
    prescription: '30 s per side',
    note: 'On knees if the full version aggravates anything',
  },
  {
    id: 'bird-dog',
    name: 'Bird dog',
    prescription: '8 per side, slow',
    note: 'Hips level',
  },
  {
    id: 'standing-pelvic-tilt',
    name: 'Standing pelvic tilt',
    prescription: '10 reps',
    note: "Tuck into POSTERIOR tilt and hold a beat — the tuck is the rep. Practise 'run tall, tuck the pelvis'",
  },
];

// Tick dates older than this are pruned on write — a year of history is ample
// and keeps the domain from growing without bound.
const TICK_RETENTION_DAYS = 366;

// Slugify a name to a stable id, disambiguating against ids already in use so an
// added exercise never collides with an existing one.
function slugify(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'exercise';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

// Clean one incoming exercise: coerce the shape, trim, drop the blank-named.
// Reuses a provided id when valid, else mints a fresh slug. Kept tolerant so a
// malformed field can't corrupt the store.
function normaliseExercise(raw: unknown, taken: Set<string>): RehabExercise | null {
  if (!raw || typeof raw !== 'object') return null;
  const ex = raw as Partial<RehabExercise>;
  const name = typeof ex.name === 'string' ? ex.name.trim() : '';
  if (!name) return null;
  const prescription = typeof ex.prescription === 'string' ? ex.prescription.trim() : '';
  const note = typeof ex.note === 'string' ? ex.note.trim() : '';

  const provided = typeof ex.id === 'string' ? ex.id.trim() : '';
  const id = provided && !taken.has(provided) ? provided : slugify(name, taken);
  taken.add(id);

  return {
    id,
    name,
    prescription,
    ...(note ? { note } : {}),
  };
}

// A well-formed { date: string[] } map, keeping only yyyy-MM-dd keys whose value
// is an array of exercise-id strings. Ids no longer in the list are dropped, and
// dates older than the retention window are pruned.
function normaliseTicks(raw: unknown, validIds: Set<string>): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') return {};
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TICK_RETENTION_DAYS);
  const cutoffKey = cutoff.toISOString().slice(0, 10);

  const out: Record<string, string[]> = {};
  for (const [date, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < cutoffKey) continue;
    if (!Array.isArray(ids)) continue;
    const kept = ids.filter((id): id is string => typeof id === 'string' && validIds.has(id));
    if (kept.length) out[date] = Array.from(new Set(kept));
  }
  return out;
}

function readRoutine(): RehabRoutine | null {
  const raw = readAllDomains().rehabRoutine;
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<RehabRoutine>;
  if (!Array.isArray(source.exercises)) return null;

  const taken = new Set<string>();
  const exercises = source.exercises
    .map(ex => normaliseExercise(ex, taken))
    .filter((ex): ex is RehabExercise => ex !== null);
  if (!exercises.length) return null;

  const validIds = new Set(exercises.map(ex => ex.id));
  return { exercises, ticks: normaliseTicks(source.ticks, validIds) };
}

// The whole rehab routine. Seeds the captured default on first read of an empty
// store, persisting it so subsequent reads and edits build on it.
export async function getRehabRoutine(): Promise<RehabRoutine> {
  const existing = readRoutine();
  if (existing) return existing;

  const seeded: RehabRoutine = { exercises: SEED_EXERCISES.map(ex => ({ ...ex })), ticks: {} };
  writeAllDomains({ rehabRoutine: seeded });
  return seeded;
}

// Replace the exercise list (validated and normalised, ids minted for new ones),
// preserving the tick history for ids that survive the edit.
export async function updateRehabExercises(exercises: unknown): Promise<RehabRoutine> {
  if (!Array.isArray(exercises)) {
    throw new Error('rehab exercises must be an array');
  }
  const current = await getRehabRoutine();

  const taken = new Set<string>();
  const normalised = exercises
    .map(ex => normaliseExercise(ex, taken))
    .filter((ex): ex is RehabExercise => ex !== null);

  const validIds = new Set(normalised.map(ex => ex.id));
  const ticks = normaliseTicks(current.ticks, validIds);

  const routine: RehabRoutine = { exercises: normalised, ticks };
  writeAllDomains({ rehabRoutine: routine });
  return routine;
}

// Tick or untick one exercise on one day. Idempotent: adding an id already
// present (or removing one already absent) is a no-op that still returns the
// current routine. Throws on a bad date or an unknown exercise id.
export async function setRehabTick(
  date: string,
  exerciseId: string,
  done: boolean
): Promise<RehabRoutine> {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('date must be yyyy-MM-dd');
  }
  const routine = await getRehabRoutine();
  if (!routine.exercises.some(ex => ex.id === exerciseId)) {
    throw new Error(`Unknown rehab exercise: ${exerciseId}`);
  }

  const current = routine.ticks[date] ?? [];
  const has = current.includes(exerciseId);
  let next: string[];
  if (done) {
    if (has) return routine; // already ticked — nothing to write
    next = [...current, exerciseId];
  } else {
    if (!has) return routine; // already clear — nothing to write
    next = current.filter(id => id !== exerciseId);
  }

  const ticks = { ...routine.ticks };
  if (next.length) ticks[date] = next;
  else delete ticks[date];

  const updated: RehabRoutine = { exercises: routine.exercises, ticks };
  writeAllDomains({ rehabRoutine: updated });
  return updated;
}
