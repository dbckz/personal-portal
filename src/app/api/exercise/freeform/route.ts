import { NextRequest, NextResponse } from 'next/server';
import { format } from 'date-fns';

import { parseFreeform, type FreeformDraft } from '@/lib/exercise-freeform';
import { createSession } from '@/lib/storage/exercise';
import { prewarmProgramme } from '@/lib/exercise-prewarm';

// POST /api/exercise/freeform — log a session from a blob of text describing
// what was actually done, for the days that go off-plan.
//
// Two calls, one route:
//   { text, date? }          → parse only, returns the draft to confirm/correct
//   { text, date?, draft }   → save the (possibly corrected) draft
//
// The desktop uses both — read it, check it, save it. Mobile posts once without
// a draft and lets the parse stand, because confirming a table of exercises on
// a phone is exactly the friction this feature exists to remove; the original
// text is stored either way, so nothing is lost by not checking it there.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return NextResponse.json({ error: 'Describe what you did.' }, { status: 400 });
    }
    const date = typeof body.date === 'string' && body.date ? body.date : format(new Date(), 'yyyy-MM-dd');

    if (body.draft) {
      const session = await saveDraft(body.draft as FreeformDraft, text, date);
      return NextResponse.json({ session, parsed: true });
    }

    const { draft, parsed } = await parseFreeform(text, date);
    if (!body.save) return NextResponse.json({ draft, parsed });

    const session = await saveDraft(draft, text, date);
    return NextResponse.json({ session, parsed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to log the session';
    console.error('Error logging a freehand exercise session:', error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// A freehand log is always something already done, so it is created completed
// and unplanned — it is history, never an intention.
async function saveDraft(draft: FreeformDraft, text: string, date: string) {
  const session = await createSession({
    date: draft.date || date,
    type: draft.type,
    ...(draft.label ? { label: draft.label } : {}),
    ...(draft.durationMinutes ? { durationMinutes: draft.durationMinutes } : {}),
    ...(draft.distanceKm ? { distanceKm: draft.distanceKm } : {}),
    ...(draft.intensity ? { intensity: draft.intensity } : {}),
    ...(draft.notes ? { notes: draft.notes } : {}),
    ...(draft.exercises?.length ? { exercises: draft.exercises } : {}),
    source: 'freeform',
    freeformText: text,
    planned: false,
    completed: true,
  });
  // A freehand log (often backdated) changes history — pre-generate the
  // programme so the next Today open doesn't wait on Claude.
  void prewarmProgramme().catch(error =>
    console.error('Failed to pre-warm exercise programme:', error)
  );
  return session;
}
