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
import { deriveCompletedLabel } from '../exercise-label';
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

function sameComponents(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Keep a plan-linked completed session's TITLE honest: after its exercises
// change, re-derive label/components from what was actually done, so a swapped
// treadmill run shows in history as "Treadmill run + core", not the planned
// "Parkrun + core". This is the server-side chokepoint every client writes
// through (tick, swap, add, remove), so desktop, mobile and freeform all get it.
//
// Derivation always reads the PLAN's own parts — the linked planned session, or
// the session itself when a plan is being completed in place — never the parts
// this function last wrote. That keeps repeated edits stable and reversible:
// undoing a swap restores the planned wording. A session with no plan parts
// (freeform, ad-hoc) is left exactly as it was.
function withDerivedLabel(session: ExerciseSession, all: ExerciseSession[]): ExerciseSession {
  if (!session.completed) return session;
  const plan = session.plannedSessionId
    ? all.find(s => s.id === session.plannedSessionId)
    : undefined;
  const source = plan ?? session;
  if (!source.components?.length) return session;

  const { components, label } = deriveCompletedLabel(
    source.components,
    source.label,
    session.exercises ?? []
  );
  if (label === session.label && sameComponents(components, session.components)) return session;
  return { ...session, components, label };
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
  // 'home' marks a session swapped to a home workout; absent means the gym. Set
  // on the planned session (via the venue route) and copied onto the logged
  // session when it is started. See setSessionVenue for clearing it.
  venue?: 'home';
  label?: string;
  // Per-exercise detail; ids are assigned here so callers (importers, the UI)
  // don't have to invent them.
  exercises?: Array<Omit<ExerciseEntry, 'id'>>;
  googleEventId?: string;
  googleCalendarId?: string;
  components?: string[];
  targetDistanceKm?: number;
  // A planned session's calendar-event description and the prescription parsed
  // from it. `planDescription` being a string (even '') marks the caller as one
  // that manages the prescription, so a re-sync can clear it when the event's
  // description is removed; left undefined, the prescription fields are untouched.
  planDescription?: string;
  prescription?: ExerciseSession['prescription'];
  prescriptionNote?: string;
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
    ...(input.venue ? { venue: input.venue } : {}),
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    ...(input.exercises?.length
      ? { exercises: input.exercises.map(e => ({ ...canonicalise(e), id: randomUUID() })) }
      : {}),
    ...(input.googleEventId ? { googleEventId: input.googleEventId } : {}),
    ...(input.googleCalendarId ? { googleCalendarId: input.googleCalendarId } : {}),
    ...(input.components?.length ? { components: input.components } : {}),
    ...(input.targetDistanceKm ? { targetDistanceKm: input.targetDistanceKm } : {}),
    ...(input.planDescription ? { planDescription: input.planDescription } : {}),
    ...(input.prescription?.length ? { prescription: input.prescription } : {}),
    ...(input.prescriptionNote ? { prescriptionNote: input.prescriptionNote } : {}),
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

  const existing = await getAllSessions();
  const derived = withDerivedLabel(session, existing);
  await writeSessions([...existing, derived]);
  return derived;
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

  const patched: ExerciseSession = {
    ...existing,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    updatedAt: now,
  } as ExerciseSession;

  // When this patch is what completes a planned session in place, retitle it from
  // whatever actuals it carries before writing.
  const next = withDerivedLabel(patched, sessions);
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

  // Prescription reconciles as a set for callers that manage it (the calendar
  // sync always passes planDescription, even ''): a description writes the parsed
  // prescription, one removed at the Google end clears it. Callers that don't
  // touch prescriptions (the sheet importer) leave planDescription undefined and
  // the existing fields stand.
  if (input.planDescription !== undefined) {
    reconcilePrescription(next, input);
  }

  await writeSessions(sessions.map(s => (s.id === existing.id ? next : s)));
  return { session: next, created: false };
}

function reconcilePrescription(session: ExerciseSession, input: CreateSessionInput): void {
  if (input.planDescription) session.planDescription = input.planDescription;
  else delete session.planDescription;

  if (input.prescription?.length) session.prescription = input.prescription;
  else delete session.prescription;

  if (input.prescriptionNote) session.prescriptionNote = input.prescriptionNote;
  else delete session.prescriptionNote;
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

  const patched: ExerciseSession = {
    ...existing,
    exercises: existing.exercises.map(e => (e.id === entryId ? applyEntryPatch(e, canonicalPatch) : e)),
    updatedAt: now,
  };
  const next = withDerivedLabel(patched, sessions);
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
  const patched: ExerciseSession = {
    ...existing,
    exercises: [...(existing.exercises ?? []), withId],
    updatedAt: now,
  };
  const next = withDerivedLabel(patched, sessions);
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

  const patched: ExerciseSession = {
    ...existing,
    exercises: existing.exercises.filter(e => e.id !== entryId),
    updatedAt: now,
  };
  const next = withDerivedLabel(patched, sessions);
  await writeSessions(sessions.map(s => (s.id === sessionId ? next : s)));
  return next;
}

// Whether an entry is an UNTOUCHED seeded row — one pre-filled from a programme
// the user has not yet acted on. The robust, simple signal: not ticked done, no
// note, no reps-in-reserve rating, and not a swap. Such rows carry no user input,
// so when the programme changes underneath them (a venue swap regenerates it)
// they can be dropped and re-seeded from the new targets. A ticked, noted, rated
// or swapped row is the user's own work and is always kept.
export function isUntouchedSeededEntry(e: ExerciseEntry): boolean {
  return e.done !== true && !e.notes?.trim() && e.rir === undefined && !e.substitutedFor;
}

// Drop untouched seeded entries from the date's in-progress logged session, so a
// venue swap (which regenerates the programme) doesn't leave stale rows seeded
// from the OLD programme on the board — e.g. a treadmill run on a home day. The
// merge path then re-seeds the live rows from the new targets. Entries the user
// has ticked, noted, rated or swapped are kept. A no-op when there is no
// in-progress session for the date, or nothing is prunable.
export async function pruneUntouchedSeededEntries(
  date: string,
  now = new Date().toISOString()
): Promise<{ removed: number }> {
  const sessions = await getAllSessions();
  const session = sessions.find(s => s.date === date && s.completed && s.source === 'manual');
  if (!session?.exercises?.length) return { removed: 0 };

  const kept = session.exercises.filter(e => !isUntouchedSeededEntry(e));
  const removed = session.exercises.length - kept.length;
  if (removed === 0) return { removed: 0 };

  const patched: ExerciseSession = { ...session, exercises: kept, updatedAt: now };
  const next = withDerivedLabel(patched, sessions);
  await writeSessions(sessions.map(s => (s.id === session.id ? next : s)));
  return { removed };
}

// Set or clear a session's venue. Kept separate from updateSession because it is
// the one field that needs to be REMOVED (switching back to the gym), which a
// merge-only patch can't do — a field left off a spread stays, so clearing has
// to delete it explicitly. `venue` undefined clears it (gym); 'home' sets it.
export async function setSessionVenue(
  id: string,
  venue: 'home' | undefined,
  now = new Date().toISOString()
): Promise<ExerciseSession | null> {
  const sessions = await getAllSessions();
  const existing = sessions.find(s => s.id === id);
  if (!existing) return null;

  const next: ExerciseSession = { ...existing, updatedAt: now };
  if (venue) next.venue = venue;
  else delete next.venue;

  await writeSessions(sessions.map(s => (s.id === id ? next : s)));
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
