// The exercise log: planned and completed sessions, stored as one
// `exerciseSessions` domain in the user-data store.
//
// One record type covers both plans and history. A session created ahead of
// time is planned=true / completed=false; completing it flips the flag and
// fills in the actuals. Something done without a plan is created completed.
// Keeping them in one list means adherence ("did I do what I planned?") is a
// filter, not a join.

import { randomUUID } from 'crypto';
import { readAllDomains, writeAllDomains } from './db';
import { normalizeExerciseName } from '../exercise-names';
import type { ExerciseEntry, ExerciseSession, ExerciseSource } from '@/types/life';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

// The single chokepoint for canonical naming: every path that persists an entry
// (createSession, the importer's upsert, the mid-session add, and renames via
// updateSessionEntry) runs its name through here, so the store never gains a new
// spelling variant regardless of which route wrote it.
function canonicalise(entry: Omit<ExerciseEntry, 'id'>): Omit<ExerciseEntry, 'id'> {
  return { ...entry, name: normalizeExerciseName(entry.name) };
}

// Its own `exerciseSessions` domain, for the same reason as goals: getUserData()
// only returns the domains it knows about.
export async function getAllSessions(): Promise<ExerciseSession[]> {
  const raw = readAllDomains().exerciseSessions;
  if (!Array.isArray(raw)) return [];
  const sessions = raw.filter(
    (s): s is ExerciseSession =>
      !!s &&
      typeof s === 'object' &&
      typeof (s as ExerciseSession).id === 'string' &&
      typeof (s as ExerciseSession).date === 'string'
  );
  return sessions.sort((a, b) => a.date.localeCompare(b.date));
}

async function writeSessions(sessions: ExerciseSession[]): Promise<void> {
  writeAllDomains({ exerciseSessions: sessions });
}

// Inclusive date-string range; both bounds optional.
export async function getSessionsInRange(from?: string, to?: string): Promise<ExerciseSession[]> {
  const all = await getAllSessions();
  return all.filter(s => (!from || s.date >= from) && (!to || s.date <= to));
}

export interface CreateSessionInput {
  date: string;
  type: string;
  durationMinutes?: number;
  durationSource?: ExerciseSession['durationSource'];
  distanceKm?: number;
  intensity?: ExerciseSession['intensity'];
  notes?: string;
  planned?: boolean;
  completed?: boolean;
  label?: string;
  // Per-exercise detail; ids are assigned here so callers (importers, the UI)
  // don't have to invent them.
  exercises?: Array<Omit<ExerciseEntry, 'id'>>;
  googleEventId?: string;
  googleCalendarId?: string;
  components?: string[];
  targetDistanceKm?: number;
  source?: ExerciseSource;
  freeformText?: string;
  importKey?: string;
  plannedSessionId?: string;
}

export async function createSession(
  input: CreateSessionInput,
  now = new Date().toISOString()
): Promise<ExerciseSession> {
  if (!DATE_KEY.test(input.date)) throw new Error(`Invalid date: ${input.date}`);
  const type = input.type.trim();
  if (!type) throw new Error('Session type is required');
  // Duration is optional: a session imported from the training log has
  // per-exercise detail but no overall duration. When given, it must be real.
  if (input.durationMinutes !== undefined && !(input.durationMinutes > 0)) {
    throw new Error('Duration must be greater than zero');
  }

  const planned = input.planned ?? false;
  const session: ExerciseSession = {
    id: randomUUID(),
    date: input.date,
    type,
    ...(input.durationMinutes !== undefined
      ? { durationMinutes: Math.round(input.durationMinutes) }
      : {}),
    ...(input.durationSource ? { durationSource: input.durationSource } : {}),
    ...(typeof input.distanceKm === 'number' && input.distanceKm > 0
      ? { distanceKm: input.distanceKm }
      : {}),
    ...(input.intensity ? { intensity: input.intensity } : {}),
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    ...(input.exercises?.length
      ? { exercises: input.exercises.map(e => ({ ...canonicalise(e), id: randomUUID() })) }
      : {}),
    ...(input.googleEventId ? { googleEventId: input.googleEventId } : {}),
    ...(input.googleCalendarId ? { googleCalendarId: input.googleCalendarId } : {}),
    ...(input.components?.length ? { components: input.components } : {}),
    ...(input.targetDistanceKm ? { targetDistanceKm: input.targetDistanceKm } : {}),
    source: input.source ?? 'manual',
    ...(input.freeformText?.trim() ? { freeformText: input.freeformText.trim() } : {}),
    ...(input.importKey ? { importKey: input.importKey } : {}),
    ...(input.plannedSessionId ? { plannedSessionId: input.plannedSessionId } : {}),
    planned,
    // An unplanned session is by definition something already done.
    completed: input.completed ?? !planned,
    createdAt: now,
    updatedAt: now,
  };

  await writeSessions([...(await getAllSessions()), session]);
  return session;
}

export type UpdateSessionInput = Partial<CreateSessionInput>;

export async function updateSession(
  id: string,
  patch: UpdateSessionInput,
  now = new Date().toISOString()
): Promise<ExerciseSession | null> {
  const sessions = await getAllSessions();
  const existing = sessions.find(s => s.id === id);
  if (!existing) return null;
  if (patch.date && !DATE_KEY.test(patch.date)) throw new Error(`Invalid date: ${patch.date}`);

  const next: ExerciseSession = {
    ...existing,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    updatedAt: now,
  } as ExerciseSession;

  await writeSessions(sessions.map(s => (s.id === id ? next : s)));
  return next;
}

export async function deleteSession(id: string): Promise<boolean> {
  const sessions = await getAllSessions();
  if (!sessions.some(s => s.id === id)) return false;
  await writeSessions(sessions.filter(s => s.id !== id));
  return true;
}

// Create or update a session identified by its natural key in the source
// system (a spreadsheet date, a Google event id). Re-running an import must
// leave one session per source row, not a fresh copy each time.
//
// Hand-made edits are respected: fields the caller does not assert are left
// alone, so re-importing a session Dave has since annotated keeps the note.
export async function upsertSessionByImportKey(
  importKey: string,
  input: CreateSessionInput,
  now = new Date().toISOString()
): Promise<{ session: ExerciseSession; created: boolean }> {
  const sessions = await getAllSessions();
  const existing = sessions.find(s => s.importKey === importKey);

  if (!existing) {
    const session = await createSession({ ...input, importKey }, now);
    return { session, created: true };
  }

  const next: ExerciseSession = {
    ...existing,
    date: input.date,
    type: input.type.trim() || existing.type,
    ...(input.durationMinutes !== undefined
      ? { durationMinutes: Math.round(input.durationMinutes) }
      : {}),
    ...(input.distanceKm !== undefined ? { distanceKm: input.distanceKm } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    // Exercises are replaced wholesale: the source row IS the record of what
    // was done, and merging two lists of lifts would produce nonsense.
    ...(input.exercises
      ? { exercises: input.exercises.map(e => ({ ...canonicalise(e), id: randomUUID() })) }
      : {}),
    ...(input.components ? { components: input.components } : {}),
    ...(input.targetDistanceKm !== undefined
      ? { targetDistanceKm: input.targetDistanceKm }
      : {}),
    ...(input.googleEventId ? { googleEventId: input.googleEventId } : {}),
    ...(input.googleCalendarId ? { googleCalendarId: input.googleCalendarId } : {}),
    updatedAt: now,
  };

  await writeSessions(sessions.map(s => (s.id === existing.id ? next : s)));
  return { session: next, created: false };
}

// Sessions the portal created on the calendar that are no longer in the plan —
// used by the calendar sync to retire events deleted at the Google end.
export async function getSessionsByImportPrefix(prefix: string): Promise<ExerciseSession[]> {
  return (await getAllSessions()).filter(s => s.importKey?.startsWith(prefix));
}

// Update one exercise inside a session — ticking it done, correcting the weight
// actually used, adding a note.
//
// Scoped to a single entry rather than replacing the whole exercises array:
// this is written from a phone in a gym, one set at a time, and a whole-array
// write would lose a concurrent edit (or everything, on a dropped connection).
// A field left `undefined` in a patch is not asserted (leave it alone); a field
// set to `null` is an explicit clear (drop it from the entry). Everything else
// overwrites. Clearing is why this can't be a plain spread: a spread can set a
// field but never remove one.
type EntryPatch = { [K in keyof Omit<ExerciseEntry, 'id'>]?: ExerciseEntry[K] | null };

function applyEntryPatch(entry: ExerciseEntry, patch: EntryPatch): ExerciseEntry {
  const next: ExerciseEntry = { ...entry };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete (next as unknown as Record<string, unknown>)[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }
  return next;
}

export async function updateSessionEntry(
  sessionId: string,
  entryId: string,
  patch: EntryPatch,
  now = new Date().toISOString()
): Promise<ExerciseSession | null> {
  const sessions = await getAllSessions();
  const existing = sessions.find(s => s.id === sessionId);
  if (!existing?.exercises?.some(e => e.id === entryId)) return null;

  // A rename is corrected to its canonical spelling, so filing an exercise under
  // a variant name still merges it into the one history.
  const canonicalPatch =
    typeof patch.name === 'string' ? { ...patch, name: normalizeExerciseName(patch.name) } : patch;

  const next: ExerciseSession = {
    ...existing,
    exercises: existing.exercises.map(e => (e.id === entryId ? applyEntryPatch(e, canonicalPatch) : e)),
    updatedAt: now,
  };
  await writeSessions(sessions.map(s => (s.id === sessionId ? next : s)));
  return next;
}

// Append an exercise to a session — for the one you decided to do on the spot.
export async function addSessionEntry(
  sessionId: string,
  entry: Omit<ExerciseEntry, 'id'>,
  now = new Date().toISOString()
): Promise<{ session: ExerciseSession; entry: ExerciseEntry } | null> {
  const sessions = await getAllSessions();
  const existing = sessions.find(s => s.id === sessionId);
  if (!existing) return null;

  const withId: ExerciseEntry = { ...canonicalise(entry), id: randomUUID() };
  const next: ExerciseSession = {
    ...existing,
    exercises: [...(existing.exercises ?? []), withId],
    updatedAt: now,
  };
  await writeSessions(sessions.map(s => (s.id === sessionId ? next : s)));
  return { session: next, entry: withId };
}

export async function removeSessionEntry(
  sessionId: string,
  entryId: string,
  now = new Date().toISOString()
): Promise<ExerciseSession | null> {
  const sessions = await getAllSessions();
  const existing = sessions.find(s => s.id === sessionId);
  if (!existing?.exercises) return null;

  const next: ExerciseSession = {
    ...existing,
    exercises: existing.exercises.filter(e => e.id !== entryId),
    updatedAt: now,
  };
  await writeSessions(sessions.map(s => (s.id === sessionId ? next : s)));
  return next;
}

// Record the Google event a planned session was written to, so later edits
// update that event instead of creating another. Kept separate from
// updateSession because it is bookkeeping, not a user edit.
export async function attachCalendarEvent(
  sessionId: string,
  googleEventId: string,
  googleCalendarId: string,
  importKey: string,
  now = new Date().toISOString()
): Promise<ExerciseSession | null> {
  const sessions = await getAllSessions();
  const existing = sessions.find(s => s.id === sessionId);
  if (!existing) return null;

  const next: ExerciseSession = {
    ...existing,
    googleEventId,
    googleCalendarId,
    importKey,
    updatedAt: now,
  };
  await writeSessions(sessions.map(s => (s.id === sessionId ? next : s)));
  return next;
}
