// Two-way sync between planned exercise sessions and the personal Google
// calendar.
//
// The plan already lives on the calendar as all-day events — "🏋️ Push
// (shoulders) + Run (2 km)", "🏃 Parkrun + core" — and that is where Dave sees
// it day to day. So the calendar stays the visible surface: planning in the
// portal WRITES those events, and pulling READS them back, keeping the two in
// step whichever end a change is made at.
//
// Pull is keyed on the Google event id (`gcal:<id>`), so a title edited in
// Google updates the portal's session instead of creating a second one.
//
// Server-only: reaches into storage and the Google API.

import { addDays, format, parseISO } from 'date-fns';

import {
  createCalendarEvent,
  deleteCalendarEvent,
  ensureValidCredentials,
  listEventsInRange,
  updateCalendarEvent,
} from './google-calendar';
import { parsePlannedTitle, parseTimedExerciseTitle } from './exercise-parse';
import { getEnabledGoogleIntegrations } from './integration-storage';
import {
  attachCalendarEvent,
  getSessionsByImportPrefix,
  deleteSession,
  updateSession,
  upsertSessionByImportKey,
  type CreateSessionInput,
} from './storage/exercise';
import type { ExerciseSession, ParsedPlannedSession } from '@/types/life';

const IMPORT_PREFIX = 'gcal:';

// The emoji the plan is written with, so events the portal creates look exactly
// like the ones already there.
const STRENGTH_PREFIX = '🏋️';
const RUN_PREFIX = '🏃';

export interface ExerciseCalendarTarget {
  integrationId: string;
  clientId: string;
  clientSecret: string;
  credentials: Awaited<ReturnType<typeof ensureValidCredentials>>;
  calendarId: string;
}

// Which calendar the plan lives on. Defaults to the primary calendar of the
// first enabled Google integration — that is where the existing all-day
// planning events are. `EXERCISE_CALENDAR_ID` overrides it without a code
// change if the plan ever moves to the dedicated Exercise sub-calendar.
export async function resolveCalendarTarget(): Promise<ExerciseCalendarTarget | null> {
  const integrations = await getEnabledGoogleIntegrations();
  const integration = integrations.find(i => !!i.credentials);
  if (!integration) return null;

  return {
    integrationId: integration.id,
    clientId: integration.clientId,
    clientSecret: integration.clientSecret,
    credentials: await ensureValidCredentials(integration),
    calendarId: process.env.EXERCISE_CALENDAR_ID || 'primary',
  };
}

// Build the event title from a session, mirroring the existing convention.
export function plannedEventTitle(session: {
  type: string;
  components?: string[];
  title?: string;
}): string {
  const prefix = /run|parkrun|track|cardio/i.test(session.type) ? RUN_PREFIX : STRENGTH_PREFIX;
  const body = session.components?.length
    ? session.components.join(' + ')
    : (session.title ?? session.type);
  return `${prefix} ${body}`;
}

// ---------------------------------------------------------------------------
// Pull: calendar → portal
// ---------------------------------------------------------------------------

export interface PullResult {
  scanned: number;
  created: number;
  updated: number;
  removed: number;
  // Planned sessions given a durationMinutes from a same-day timed event.
  enriched: number;
}

// A timed event as the enricher needs it — a title to classify and a start/end
// to measure. Kept minimal so planTimedEnrichments stays testable without Google.
export interface TimedExerciseEvent {
  summary: string;
  startDateTime: string;
  endDateTime: string;
}

// A planned session as the enricher reasons about it: enough to match by day and
// type, and to decide whether its duration may be overwritten.
type EnrichableSession = Pick<
  ExerciseSession,
  'id' | 'date' | 'type' | 'durationMinutes' | 'durationSource'
>;

export interface TimedEnrichment {
  sessionId: string;
  durationMinutes: number;
}

const isCardioType = (type: string) => /\b(run|cardio|cycle|swim|track)\b/i.test(type);

// Minutes between two ISO timestamps, or null when the pair is unusable (bad
// parse, non-positive, or longer than a day — an all-day slot masquerading as a
// timed one, which is not a session length).
function timedDurationMinutes(startISO: string, endISO: string): number | null {
  const start = parseISO(startISO).getTime();
  const end = parseISO(endISO).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const minutes = Math.round((end - start) / 60000);
  if (minutes <= 0 || minutes > 24 * 60) return null;
  return minutes;
}

// Of the day's enrichable plans, the one a timed slot belongs to: an exact type
// match first, then one on the same cardio/strength side, else the first. Callers
// pass only plans that are still on the table (not already taken this run).
function pickSessionToEnrich(candidates: EnrichableSession[], parsedType: string): EnrichableSession | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const exact = candidates.find(s => s.type === parsedType);
  if (exact) return exact;
  const wantCardio = isCardioType(parsedType);
  return candidates.find(s => isCardioType(s.type) === wantCardio) ?? candidates[0];
}

// Pure core of the timed-event enrichment: given the plans just synced and the
// timed exercise events for the same window, decide which plans get a duration
// and how long. No I/O, so the matching rules are unit-testable on their own.
//
// A plan is a candidate only when its duration is unset or was itself set by a
// previous calendar sync — a duration Dave logged by hand is never overwritten.
// Each timed event claims at most one plan, and each plan at most one event, so
// two gym slots on one day don't both land on the same session.
export function planTimedEnrichments(
  plannedSessions: EnrichableSession[],
  timedEvents: TimedExerciseEvent[]
): TimedEnrichment[] {
  const out: TimedEnrichment[] = [];
  const claimed = new Set<string>();

  for (const event of timedEvents) {
    const parsed = parseTimedExerciseTitle(event.summary);
    if (!parsed) continue;

    const durationMinutes = timedDurationMinutes(event.startDateTime, event.endDateTime);
    if (durationMinutes === null) continue;

    const day = event.startDateTime.slice(0, 10);
    const candidates = plannedSessions.filter(
      s =>
        s.date === day &&
        !claimed.has(s.id) &&
        (s.durationMinutes === undefined || s.durationSource === 'calendar')
    );

    const match = pickSessionToEnrich(candidates, parsed.type);
    if (!match) continue;

    claimed.add(match.id);
    out.push({ sessionId: match.id, durationMinutes });
  }

  return out;
}

// A planned all-day event, reduced to what the upsert needs.
export interface PlannedAllDayEvent {
  id: string;
  startDate: string;
  summary: string;
}

// Build the upsert for one planned all-day event. The calendar is TIMING-ONLY
// now: the event's DESCRIPTION is ignored — session content comes from the
// weekly routine plus history, not hand-written descriptions. For a future or
// today session we pass an empty `planDescription`, which makes the upsert clear
// any `prescription`/`prescriptionNote` left over from the old description-
// parsing sync. A PAST session omits `planDescription`, so the upsert leaves its
// stored prescription untouched — harmless history.
export function buildPlannedUpsert(
  event: PlannedAllDayEvent,
  parsed: ParsedPlannedSession,
  calendarId: string,
  today: string
): { importKey: string; input: CreateSessionInput } {
  const isFutureOrToday = event.startDate >= today;
  const input: CreateSessionInput = {
    date: event.startDate,
    type: parsed.type,
    label: parsed.title,
    components: parsed.components,
    ...(parsed.targetDistanceKm ? { targetDistanceKm: parsed.targetDistanceKm } : {}),
    ...(isFutureOrToday ? { planDescription: '' } : {}),
    planned: true,
    completed: false,
    googleEventId: event.id,
    googleCalendarId: calendarId,
    source: 'calendar',
  };
  return { importKey: `${IMPORT_PREFIX}${event.id}`, input };
}

// Read planned sessions out of the calendar for a date window.
//
// The all-day events ARE the plan: "🏋️ Push (shoulders) + Run (2 km)" becomes a
// planned session. Timed events are NOT plans — treating both as plans would
// double-count every day — but a timed "🏋️ Gym" or "🏃 Track" is where that
// day's plan was actually done, so its start/end is read to fill in the planned
// session's durationMinutes (see planTimedEnrichments). A timed event never
// creates a session; it only enriches one that already exists for the day.
//
// Events that have since disappeared from the calendar have their portal
// sessions removed — but ONLY if still unlogged. A session Dave has completed is
// history and is kept whatever the calendar now says.
export async function pullPlannedSessions(from: Date, to: Date): Promise<PullResult> {
  const target = await resolveCalendarTarget();
  if (!target) return { scanned: 0, created: 0, updated: 0, removed: 0, enriched: 0 };

  const events = await listEventsInRange(
    target.credentials,
    target.clientId,
    target.clientSecret,
    from,
    to,
    target.calendarId
  );

  const allDay = events.filter(e => !!e.startDate);
  const today = format(new Date(), 'yyyy-MM-dd');
  let created = 0;
  let updated = 0;
  const seen = new Set<string>();
  const plannedSessions: ExerciseSession[] = [];

  for (const event of allDay) {
    const parsed = parsePlannedTitle(event.summary);
    if (!parsed) continue;

    const { importKey, input } = buildPlannedUpsert(
      { id: event.id, startDate: event.startDate!, summary: event.summary },
      parsed,
      target.calendarId,
      today
    );
    seen.add(importKey);

    const result = await upsertSessionByImportKey(importKey, input);
    plannedSessions.push(result.session);
    if (result.created) created++;
    else updated++;
  }

  // Fill each plan's duration from a same-day timed exercise event, where one is
  // there to read it from. Only the plans just synced are eligible, so a timed
  // slot can never conjure a session — it only measures one already planned.
  const timedEvents: TimedExerciseEvent[] = events
    .filter(e => !!e.startDateTime && !!e.endDateTime)
    .map(e => ({ summary: e.summary, startDateTime: e.startDateTime!, endDateTime: e.endDateTime! }));
  let enriched = 0;
  for (const { sessionId, durationMinutes } of planTimedEnrichments(plannedSessions, timedEvents)) {
    await updateSession(sessionId, { durationMinutes, durationSource: 'calendar' });
    enriched++;
  }

  // Retire sessions whose event is gone from the window we just read.
  let removed = 0;
  const fromKey = format(from, 'yyyy-MM-dd');
  const toKey = format(to, 'yyyy-MM-dd');
  for (const session of await getSessionsByImportPrefix(IMPORT_PREFIX)) {
    if (session.date < fromKey || session.date > toKey) continue;
    if (seen.has(session.importKey!)) continue;
    if (session.completed) continue; // logged work is history, not a plan
    if (await deleteSession(session.id)) removed++;
  }

  return { scanned: allDay.length, created, updated, removed, enriched };
}

// ---------------------------------------------------------------------------
// Push: portal → calendar
// ---------------------------------------------------------------------------

// Create (or move/retitle) the all-day event for a planned session, and record
// the event id on the session so later edits update rather than duplicate.
//
// Returns the session unchanged when there is no calendar to write to, so
// planning still works with Google disconnected.
export async function pushPlannedSession(session: ExerciseSession): Promise<ExerciseSession> {
  const target = await resolveCalendarTarget();
  if (!target) return session;

  const title = plannedEventTitle(session);
  const start = parseISO(session.date);
  // Google's all-day events use an exclusive end date, so a single day ends on
  // the next one.
  const end = addDays(start, 1);

  if (session.googleEventId) {
    await updateCalendarEvent(
      target.credentials,
      target.clientId,
      target.clientSecret,
      session.googleEventId,
      start,
      end,
      title,
      undefined,
      target.calendarId
    );
    return session;
  }

  const created = await createCalendarEvent(
    target.credentials,
    target.clientId,
    target.clientSecret,
    title,
    start,
    end,
    undefined,
    'default',
    target.calendarId,
    // A plan shouldn't make the day look busy to anyone checking availability.
    { allDay: true, transparency: 'transparent' }
  );

  // Stamp the new event onto the EXISTING session — the session is already in
  // the portal, so creating a second one here would duplicate it. The import
  // key matches what a later pull will compute, so the two sides converge.
  const attached = await attachCalendarEvent(
    session.id,
    created.id,
    target.calendarId,
    `${IMPORT_PREFIX}${created.id}`
  );
  return attached ?? session;
}

// Remove the calendar event backing a planned session. Failure is logged, not
// thrown: the portal-side delete has already been asked for, and a stale event
// is a smaller problem than a delete that appears not to work.
export async function removePlannedEvent(session: ExerciseSession): Promise<void> {
  if (!session.googleEventId) return;
  const target = await resolveCalendarTarget();
  if (!target) return;

  try {
    await deleteCalendarEvent(
      target.credentials,
      target.clientId,
      target.clientSecret,
      session.googleEventId,
      session.googleCalendarId ?? target.calendarId
    );
  } catch (error) {
    console.error(`Failed to delete calendar event ${session.googleEventId}:`, error);
  }
}
