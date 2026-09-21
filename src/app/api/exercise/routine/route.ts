import { NextRequest, NextResponse } from 'next/server';

import {
  getRoutine,
  getWeeklyRoutine,
  listRoutines,
  saveRoutine,
  saveWeeklyRoutine,
} from '@/lib/storage/weekly-routine';
import { prewarmProgramme } from '@/lib/exercise-prewarm';

// GET /api/exercise/routine[?name=…] — a seven-day routine (Mon→Sun) plus the
// library: `active` is the live routine's name and `names` lists every routine
// available to switch to. Without `name` the active routine's days are returned;
// with `name` that routine's days are returned instead (so a non-active routine
// can be viewed and edited without activating it), and an unknown name is 404.
// Seeds/migrates on first read of an empty store.
export async function GET(request: NextRequest) {
  try {
    const name = request.nextUrl.searchParams.get('name')?.trim() ?? '';
    const { names, active } = await listRoutines();
    const routine = name ? await getRoutine(name) : await getWeeklyRoutine();
    if (name && !routine) {
      return NextResponse.json({ error: `Unknown routine: ${name}` }, { status: 404 });
    }
    return NextResponse.json({ routine, active, names });
  } catch (error) {
    console.error('Error reading weekly routine:', error);
    return NextResponse.json({ error: 'Failed to read routine' }, { status: 500 });
  }
}

// PUT { routine: WeeklyRoutineDay[], name?: string } — replace a routine's days
// (validated and normalised server-side). With `name` it edits that named
// routine (which may be a non-active one); without it, the active routine.
// Returns the same shape as GET.
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body || !Array.isArray(body.routine)) {
      return NextResponse.json(
        { error: 'Invalid body. Expected { routine: WeeklyRoutineDay[] }.' },
        { status: 400 }
      );
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
    if (name) await saveRoutine(name, body.routine);
    else await saveWeeklyRoutine(body.routine);

    // A routine edit moves today's programme hash — pre-generate the new
    // programme in the background so the next Today open doesn't wait on Claude.
    void prewarmProgramme().catch(error =>
      console.error('Failed to pre-warm exercise programme:', error)
    );

    const routine = await getWeeklyRoutine();
    const { names, active } = await listRoutines();
    return NextResponse.json({ routine, active, names });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save routine';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
