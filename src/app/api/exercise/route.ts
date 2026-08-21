import { NextRequest, NextResponse } from 'next/server';

import { pushPlannedSession } from '@/lib/exercise-calendar';
import { createSession, getSessionsInRange } from '@/lib/storage/exercise';
import { prewarmProgramme } from '@/lib/exercise-prewarm';

// GET /api/exercise?from=yyyy-MM-dd&to=yyyy-MM-dd — planned and completed
// sessions in an inclusive window. Both bounds optional; omitting them returns
// the whole log.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessions = await getSessionsInRange(
      searchParams.get('from') ?? undefined,
      searchParams.get('to') ?? undefined
    );
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error('Error listing exercise sessions:', error);
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const session = await createSession({
      date: body.date,
      type: body.type ?? '',
      durationMinutes: body.durationMinutes === undefined ? undefined : Number(body.durationMinutes),
      distanceKm: body.distanceKm === undefined ? undefined : Number(body.distanceKm),
      intensity: body.intensity,
      notes: body.notes,
      planned: body.planned,
      completed: body.completed,
      label: body.label,
      venue: body.venue,
      exercises: body.exercises,
      components: body.components,
    });

    // A new (possibly backdated) session changes today's history — pre-generate
    // the programme so the next Today open doesn't wait on Claude. A no-op when
    // today's inputs are unchanged (hash dedup + cache hit).
    void prewarmProgramme().catch(error =>
      console.error('Failed to pre-warm exercise programme:', error)
    );

    // Planning in the portal writes the all-day event, so the plan stays
    // visible in the calendar Dave actually looks at. A calendar failure must
    // not lose the session, so the write is best-effort and reported.
    if (session.planned && body.syncToCalendar !== false) {
      try {
        const synced = await pushPlannedSession(session);
        return NextResponse.json({ session: synced });
      } catch (error) {
        console.error('Failed to write planned session to the calendar:', error);
        return NextResponse.json({
          session,
          warning: 'Saved, but could not write it to your Google calendar.',
        });
      }
    }

    return NextResponse.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create session';
    console.error('Error creating exercise session:', error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
