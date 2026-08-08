// Google Calendar integration service

import { google } from 'googleapis';
import { CalendarEvent, GoogleCalendarCredentials, GoogleIntegration } from '@/types';
import { updateIntegration } from './integration-storage';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks',
  // Send-only Gmail access, used by the morning meeting-briefings job to email
  // the daily digest. The app itself does not send mail; this scope rides along
  // so a reconnected integration's token can be reused by that local job.
  'https://www.googleapis.com/auth/gmail.send',
  // Per-file Drive access, used by the morning meeting-briefings job's gdoc
  // helper to create and update briefing Google Docs in place. The app itself
  // does not touch Drive; this scope rides along so a reconnected integration's
  // token can be reused by that local job.
  'https://www.googleapis.com/auth/drive.file',
];

export function createOAuth2Client(clientId: string, clientSecret: string, redirectUri?: string) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function createAuthenticatedClient(
  credentials: GoogleCalendarCredentials,
  clientId: string,
  clientSecret: string
) {
  const oauth2Client = createOAuth2Client(clientId, clientSecret);
  oauth2Client.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  });
  return oauth2Client;
}

export function getAuthUrl(clientId: string, clientSecret: string, redirectUri: string): string {
  const oauth2Client = createOAuth2Client(clientId, clientSecret, redirectUri);

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

export async function getTokensFromCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<GoogleCalendarCredentials> {
  const oauth2Client = createOAuth2Client(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth2Client.getToken(code);

  return {
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token!,
    expiresAt: tokens.expiry_date || Date.now() + 3600000,
  };
}

/**
 * Ensures credentials are valid, refreshing if needed.
 * Updates stored credentials when a refresh occurs.
 */
export async function ensureValidCredentials(integration: GoogleIntegration): Promise<GoogleCalendarCredentials> {
  let credentials = integration.credentials!;
  if (credentials.expiresAt && Date.now() >= credentials.expiresAt - 60000) {
    credentials = await refreshAccessToken(credentials, integration.clientId, integration.clientSecret);
    await updateIntegration(integration.id, { credentials });
  }
  return credentials;
}

export async function refreshAccessToken(
  credentials: GoogleCalendarCredentials,
  clientId: string,
  clientSecret: string
): Promise<GoogleCalendarCredentials> {
  const oauth2Client = createOAuth2Client(clientId, clientSecret);
  oauth2Client.setCredentials({
    refresh_token: credentials.refreshToken,
  });

  const { credentials: newCreds } = await oauth2Client.refreshAccessToken();

  return {
    accessToken: newCreds.access_token!,
    refreshToken: credentials.refreshToken,
    expiresAt: newCreds.expiry_date || Date.now() + 3600000,
  };
}

export async function listCalendars(
  credentials: GoogleCalendarCredentials,
  clientId: string,
  clientSecret: string
): Promise<Array<{ id: string; summary: string; backgroundColor: string }>> {
  const oauth2Client = createAuthenticatedClient(credentials, clientId, clientSecret);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const response = await calendar.calendarList.list();
  const items = response.data.items || [];

  return items.map(item => ({
    id: item.id!,
    summary: item.summary || item.id!,
    backgroundColor: item.backgroundColor || '#4285f4',
  }));
}

function parseGoogleDateOnly(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

const DEFAULT_TIME_ZONE = 'Europe/London';

function formatDateOnly(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  return formatter.format(date);
}

function toCalendarEvent(
  event: { id?: string | null; summary?: string | null; description?: string | null; start?: { date?: string | null; dateTime?: string | null } | null; end?: { date?: string | null; dateTime?: string | null } | null; colorId?: string | null; location?: string | null; recurringEventId?: string | null; attendees?: Array<{ self?: boolean | null; responseStatus?: string | null }> | null; eventType?: string | null; transparency?: string | null },
  fallbackColor: string,
  calendarId?: string
): CalendarEvent {
  const isAllDay = !!event.start?.date;
  const startTime = isAllDay
    ? parseGoogleDateOnly(event.start?.date || '')
    : new Date(event.start?.dateTime || '');
  const endTime = isAllDay
    ? parseGoogleDateOnly(event.end?.date || '')
    : new Date(event.end?.dateTime || '');

  // The user's own RSVP, from the attendee flagged self:true. Absent when the
  // user isn't listed (e.g. an event they own solo) → left undefined (attending).
  const selfAttendee = event.attendees?.find(a => a?.self === true);

  return {
    id: event.id!,
    title: event.summary || 'Untitled Event',
    description: event.description || undefined,
    startTime,
    endTime,
    source: 'google',
    color: event.colorId ? getGoogleColor(event.colorId) : fallbackColor,
    location: event.location || undefined,
    allDay: isAllDay,
    calendarId,
    recurringEventId: event.recurringEventId || undefined,
    attendeeCount: event.attendees?.length,
    selfResponseStatus: selfAttendee?.responseStatus || undefined,
    eventType: event.eventType || undefined,
    // Google only sends `transparency` when it's 'transparent' (opaque is the
    // default and omitted). Normalise to the two-value union; absent → busy.
    transparency: event.transparency === 'transparent' ? 'transparent' : 'opaque',
  };
}

// Build Google Calendar start/end payload based on all-day or timed event.
function buildEventDate(date: Date, isAllDay: boolean): { date: string } | { dateTime: string; timeZone: string } {
  return isAllDay
    ? { date: formatDateOnly(date) }
    : { dateTime: date.toISOString(), timeZone: DEFAULT_TIME_ZONE };
}

export async function getCalendarEvents(
  credentials: GoogleCalendarCredentials,
  clientId: string,
  clientSecret: string,
  date: Date,
  calendarId: string = 'primary',
  defaultColor?: string
): Promise<CalendarEvent[]> {
  const oauth2Client = createAuthenticatedClient(credentials, clientId, clientSecret);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const response = await calendar.events.list({
    calendarId,
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = response.data.items || [];
  const fallbackColor = defaultColor || '#4285f4';

  return events.map(event => toCalendarEvent(event, fallbackColor, calendarId));
}

export async function updateCalendarEvent(
  credentials: GoogleCalendarCredentials,
  clientId: string,
  clientSecret: string,
  eventId: string,
  startTime: Date,
  endTime: Date,
  title?: string,
  description?: string,
  calendarId: string = 'primary',
  colorId?: string
): Promise<CalendarEvent> {
  const oauth2Client = createAuthenticatedClient(credentials, clientId, clientSecret);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const existingEvent = await calendar.events.get({
    calendarId,
    eventId,
  });

  const event = existingEvent.data;
  const isAllDay = !!event.start?.date;
  const updatedEvent = await calendar.events.update({
    calendarId,
    eventId,
    requestBody: {
      ...event,
      summary: title !== undefined ? title : event.summary,
      description: description !== undefined ? description : event.description,
      colorId: colorId !== undefined ? colorId : event.colorId,
      start: buildEventDate(startTime, isAllDay),
      end: buildEventDate(endTime, isAllDay),
    },
  });

  return {
    id: updatedEvent.data.id!,
    title: updatedEvent.data.summary || 'Untitled Event',
    description: updatedEvent.data.description || undefined,
    startTime: new Date(updatedEvent.data.start?.dateTime || updatedEvent.data.start?.date || ''),
    endTime: new Date(updatedEvent.data.end?.dateTime || updatedEvent.data.end?.date || ''),
    source: 'google',
    color: updatedEvent.data.colorId ? getGoogleColor(updatedEvent.data.colorId) : '#4285f4',
    location: updatedEvent.data.location || undefined,
    allDay: isAllDay,
  };
}

export async function createCalendarEvent(
  credentials: GoogleCalendarCredentials,
  clientId: string,
  clientSecret: string,
  title: string,
  startTime: Date,
  endTime: Date,
  description?: string,
  eventType?: 'default' | 'focusTime',
  calendarId: string = 'primary',
  options?: {
    allDay?: boolean;
    recurrence?: string[];
    // Google Calendar availability: 'opaque' shows as busy (default),
    // 'transparent' marks the event as free.
    transparency?: 'opaque' | 'transparent';
    // Google Calendar colorId (e.g. '5' Banana/yellow, '10' Basil/green). When
    // set, the created event is given this colour.
    colorId?: string;
  }
): Promise<CalendarEvent> {
  const oauth2Client = createAuthenticatedClient(credentials, clientId, clientSecret);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const isAllDay = !!options?.allDay;

  const baseRequestBody = {
    summary: title,
    description,
    start: buildEventDate(startTime, isAllDay),
    end: buildEventDate(endTime, isAllDay),
    ...(options?.recurrence?.length ? { recurrence: options.recurrence } : {}),
    ...(options?.transparency ? { transparency: options.transparency } : {}),
    ...(options?.colorId ? { colorId: options.colorId } : {}),
  };

  // Try with requested eventType first, fall back to default if focusTime isn't supported
  let event;
  try {
    event = await calendar.events.insert({
      calendarId,
      requestBody: { ...baseRequestBody, eventType: eventType ?? 'default' },
    });
  } catch (err) {
    if (eventType !== 'focusTime') throw err;
    // focusTime may not be supported on this calendar, retry as default event
    console.log('focusTime not supported, creating as default event');
    event = await calendar.events.insert({
      calendarId,
      requestBody: { ...baseRequestBody, eventType: 'default' },
    });
  }

  return toCalendarEvent(event.data, '#4285f4', calendarId);
}

export async function deleteCalendarEvent(
  credentials: GoogleCalendarCredentials,
  clientId: string,
  clientSecret: string,
  eventId: string,
  calendarId: string = 'primary'
): Promise<void> {
  const oauth2Client = createAuthenticatedClient(credentials, clientId, clientSecret);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  await calendar.events.delete({
    calendarId,
    eventId,
  });
}

function getGoogleColor(colorId: string): string {
  const colors: Record<string, string> = {
    '1': '#7986cb',
    '2': '#33b679',
    '3': '#8e24aa',
    '4': '#e67c73',
    '5': '#f6c026',
    '6': '#f5511d',
    '7': '#039be5',
    '8': '#616161',
    '9': '#3f51b5',
    '10': '#0b8043',
    '11': '#d60000',
  };
  return colors[colorId] || '#4285f4';
}

// Events across a date RANGE, returned close to Google's own shape.
//
// getCalendarEvents above is per-day and maps into the app's CalendarEvent,
// which drops the all-day/timed distinction that the exercise-plan sync depends
// on (a planned session is precisely an all-day event). This keeps `start.date`
// vs `start.dateTime` intact and pages through the whole range.
export interface RawCalendarEvent {
  id: string;
  summary: string;
  description?: string;
  // Exactly one of these is set: `date` (yyyy-MM-dd) for an all-day event,
  // `dateTime` (ISO) for a timed one.
  startDate?: string;
  startDateTime?: string;
  endDate?: string;
  endDateTime?: string;
}

export async function listEventsInRange(
  credentials: GoogleCalendarCredentials,
  clientId: string,
  clientSecret: string,
  timeMin: Date,
  timeMax: Date,
  calendarId: string = 'primary'
): Promise<RawCalendarEvent[]> {
  const oauth2Client = createAuthenticatedClient(credentials, clientId, clientSecret);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const out: RawCalendarEvent[] = [];
  let pageToken: string | undefined;

  // Bounded page walk: a year of a busy personal calendar fits well inside
  // this, and an unbounded loop on a paging bug would hammer the API.
  for (let page = 0; page < 20; page++) {
    const response = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      pageToken,
    });

    for (const event of response.data.items ?? []) {
      if (!event.id) continue;
      out.push({
        id: event.id,
        summary: event.summary ?? '',
        ...(event.description ? { description: event.description } : {}),
        ...(event.start?.date ? { startDate: event.start.date } : {}),
        ...(event.start?.dateTime ? { startDateTime: event.start.dateTime } : {}),
        ...(event.end?.date ? { endDate: event.end.date } : {}),
        ...(event.end?.dateTime ? { endDateTime: event.end.dateTime } : {}),
      });
    }

    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  return out;
}
