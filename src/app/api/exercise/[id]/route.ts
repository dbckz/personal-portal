import { NextRequest, NextResponse } from 'next/server';

import { removePlannedEvent } from '@/lib/exercise-calendar';
import { getAllSessions, deleteSession, updateSession } from '@/lib/storage/exercise';
import { prewarmProgramme } from '@/lib/exercise-prewarm';

// PATCH is how a planned session becomes a done one: send { completed: true }
// plus whatever the actuals turned out to be.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const session = await updateSession(id, {
      date: body.date,
      type: body.type,
      durationMinutes: body.durationMinutes === undefined ? undefined : Number(body.durationMinutes),
      distanceKm: body.distanceKm === undefined ? undefined : Number(body.distanceKm),
      intensity: body.intensity,
      notes: body.notes,
      planned: body.planned,
      completed: body.completed,
    });
    if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    // A session edit (completing a plan, correcting a date) changes today's
    // history — pre-generate so the next Today open doesn't wait on Claude.
    void prewarmProgramme().catch(error =>
      console.error('Failed to pre-warm exercise programme:', error)
    );
    return NextResponse.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update session';
    console.error('Error updating exercise session:', error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    // Read it before deleting so the calendar event it created can go too —
    // otherwise a deleted plan lingers on the calendar forever.
    const session = (await getAllSessions()).find(s => s.id === id);
    const deleted = await deleteSession(id);
    if (!deleted) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    if (session?.planned && session.googleEventId) await removePlannedEvent(session);
    // Deleting a session changes today's history — pre-generate so the next
    // Today open doesn't wait on Claude.
    void prewarmProgramme().catch(error =>
      console.error('Failed to pre-warm exercise programme:', error)
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting exercise session:', error);
    return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 });
  }
}
