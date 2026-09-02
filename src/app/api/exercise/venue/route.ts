import { NextRequest, NextResponse } from 'next/server';
import { format } from 'date-fns';

import {
  createSession,
  getAllSessions,
  pruneUntouchedSeededEntries,
  setSessionVenue,
} from '@/lib/storage/exercise';
import { getWeeklyRoutine } from '@/lib/storage/weekly-routine';
import { getRoutineOverrides } from '@/lib/storage/routine-overrides';
import { routineDayForDate } from '@/lib/exercise-routine-day';
import { parsePlannedTitle } from '@/lib/exercise-parse';
import { resolveSessionTargets } from '@/lib/exercise-session-targets';
import { kickOffGeneration } from '@/lib/exercise-prewarm';
import type { ExerciseSession } from '@/types/life';

// POST /api/exercise/venue { date?, venue: 'home' | 'gym' }
//
// Swap a day's planned session to a home workout (bands, a pull-up bar and
// bodyweight) or back to the gym. Sets (or clears) `venue` on the PLANNED session
// for the date, creating a plan from the day's routine title if none exists yet.
// Then kicks off programme generation immediately so the Today tab gets the home
// programme within seconds — setting the venue moves the programme hash, so
// whatever was cached under the gym hash is regenerated for the new vocabulary.
//
// Deliberately does NOT write to Google Calendar: the venue is a portal-side
// annotation on the plan, not a change to the event.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const date = typeof body.date === 'string' ? body.date : format(new Date(), 'yyyy-MM-dd');
    if (body.venue !== 'home' && body.venue !== 'gym') {
      return NextResponse.json({ error: "venue must be 'home' or 'gym'" }, { status: 400 });
    }
    const venue: 'home' | undefined = body.venue === 'home' ? 'home' : undefined;

    const sessions = await getAllSessions();
    const existing = sessions.find(s => s.date === date && s.planned);

    let session: ExerciseSession | null;
    if (existing) {
      session = await setSessionVenue(existing.id, venue);
    } else {
      // No plan for the day yet — create one from the routine day's title so the
      // home programme has components and a label to work from.
      const shape = await routineShapeForDate(date);
      session = await createSession({
        date,
        type: shape?.type ?? 'session',
        ...(shape?.label ? { label: shape.label } : {}),
        ...(shape?.components?.length ? { components: shape.components } : {}),
        ...(venue ? { venue } : {}),
        planned: true,
        source: 'manual',
      });
    }

    if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

    // Generate the programme for the new venue right away (the hash just moved),
    // so the Today tab upgrades from the deterministic fallback quickly.
    try {
      const resolved = await resolveSessionTargets(date, await getAllSessions());
      if (resolved.source !== 'ai' && resolved.input.exercises.length > 0) {
        void kickOffGeneration(date, resolved.hash, resolved.input);
      }
    } catch (error) {
      console.error('Failed to kick off home programme generation:', error);
    }

    // Drop untouched rows seeded from the OLD programme so the board doesn't show
    // stale entries after the swap (e.g. a treadmill run on a home day). The merge
    // path re-seeds the live rows from the new targets; ticked/noted/swapped rows
    // are kept. Best-effort — never fail the swap over a prune.
    try {
      await pruneUntouchedSeededEntries(date);
    } catch (error) {
      console.error('Failed to prune stale seeded entries after venue swap:', error);
    }

    return NextResponse.json({ session, venue: venue ?? 'gym' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to set the venue';
    console.error('Error setting exercise venue:', error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// The routine day's parsed shape (type, label, components) for a date, read off
// the standing weekly routine — honouring any per-date override (a shifted plan
// or a rest day). Null when there is no routine, the day is a rest day, or its
// title carries no training word. Best-effort: a routine read failure just yields
// a bare plan.
async function routineShapeForDate(
  date: string
): Promise<{ type: string; label: string; components: string[] } | null> {
  try {
    const routine = await getWeeklyRoutine();
    const overrides = await getRoutineOverrides();
    const day = routineDayForDate(routine, overrides, date);
    if (!day || day.rest) return null;
    const parsed = parsePlannedTitle(`🏋️ ${day.title}`);
    if (!parsed) return null;
    return { type: parsed.type, label: parsed.title, components: parsed.components };
  } catch (error) {
    console.error('Failed to read the routine for the venue plan:', error);
    return null;
  }
}
