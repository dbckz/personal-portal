import { NextRequest, NextResponse } from 'next/server';
import { addDays, format, startOfWeek } from 'date-fns';

import { getWorkflowConfig } from '@/lib/workflow-config-storage';
import { fetchWeekEvents } from '@/lib/scheduling/gather';
import { localDateStr, timeStr } from '@/lib/scheduling/engine';
import { DEFAULT_ROLLOVER_HOUR, logicalTodayDate } from '@/lib/date-utils';

// One meeting this week that the user has not responded to yet.
interface PendingInvite {
  eventId: string;
  title: string;
  date: string; // yyyy-MM-dd
  start: string; // HH:mm
  // The user's own RSVP: 'needsAction' (no response yet) or 'tentative' (maybe).
  responseStatus: string;
  // The calendar the event lives on, for context.
  calendar?: string;
}

// GET/POST /api/scheduling/pending-invites?weekStart=yyyy-MM-dd
//
// The wizard's first step ("Review your calendar") lists this week's timed
// meetings — from today to the end of the week — whose OWN RSVP is still
// 'needsAction' or 'tentative', so the user can accept/decline them before
// planning (an accurate calendar makes for an accurate plan). Read-only; a failure
// degrades to a static instruction client-side, so it must never block planning.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const weekStartParam = typeof body?.weekStart === 'string' ? body.weekStart : undefined;
    return await respond(weekStartParam);
  } catch (error) {
    console.error('Error resolving pending invites:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to resolve pending invites' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const weekStartParam = request.nextUrl.searchParams.get('weekStart') ?? undefined;
    return await respond(weekStartParam);
  } catch (error) {
    console.error('Error resolving pending invites:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to resolve pending invites' },
      { status: 500 }
    );
  }
}

async function respond(weekStartParam?: string) {
  const now = new Date();
  // Match gatherWeekContext's week derivation so the step agrees with the rest of
  // the wizard on which week it is planning (honouring the day-rollover hour).
  const config = await getWorkflowConfig();
  const rolloverHour = config.scheduling?.dayRolloverHour ?? DEFAULT_ROLLOVER_HOUR;
  const weekStart = weekStartParam
    ? startOfWeek(new Date(`${weekStartParam}T00:00:00`), { weekStartsOn: 1 })
    : startOfWeek(logicalTodayDate(now, rolloverHour), { weekStartsOn: 1 });
  const weekEndStr = format(addDays(weekStart, 6), 'yyyy-MM-dd');
  const todayStr = localDateStr(logicalTodayDate(now, rolloverHour));

  const { events } = await fetchWeekEvents(weekStart);

  // A pending invite: a timed meeting from today to the end of the week whose own
  // RSVP still needs a response. Declined/accepted events are already dealt with.
  const invites: PendingInvite[] = [];
  for (const e of events) {
    if (e.allDay) continue;
    const status = e.selfResponseStatus;
    if (status !== 'needsAction' && status !== 'tentative') continue;
    const date = localDateStr(e.startTime);
    if (date < todayStr || date > weekEndStr) continue;
    invites.push({
      eventId: e.id,
      title: e.title,
      date,
      start: timeStr(e.startTime.getTime()),
      responseStatus: status,
      ...(e.calendarId ? { calendar: e.calendarId } : {}),
    });
  }
  // Chronological, so the list reads top-to-bottom through the week.
  invites.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.start < b.start ? -1 : 1));

  return NextResponse.json({ invites });
}
