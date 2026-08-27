import { NextRequest, NextResponse } from 'next/server';

import { getRehabRoutine, setRehabTick, updateRehabExercises } from '@/lib/storage/rehab';

// GET /api/exercise/rehab — the daily back-rehab block (exercise list + per-day
// ticks). Seeds the captured default on first read of an empty store.
//
// Deliberately independent of the exercise session/programme system: no
// prewarmProgramme, no calendar. A tick here is only ever a tick here.
export async function GET() {
  try {
    const routine = await getRehabRoutine();
    return NextResponse.json({ routine });
  } catch (error) {
    console.error('Error reading rehab routine:', error);
    return NextResponse.json({ error: 'Failed to read rehab routine' }, { status: 500 });
  }
}

// PUT { exercises: RehabExercise[] } — replace the exercise list (validated and
// normalised server-side, ids minted for new ones) and return the saved routine.
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body || !Array.isArray(body.exercises)) {
      return NextResponse.json(
        { error: 'Invalid body. Expected { exercises: RehabExercise[] }.' },
        { status: 400 }
      );
    }
    const routine = await updateRehabExercises(body.exercises);
    return NextResponse.json({ routine });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save rehab exercises';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// PATCH { date, exerciseId, done } — tick/untick one exercise on one day.
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { date, exerciseId, done } = body ?? {};
    if (typeof date !== 'string' || typeof exerciseId !== 'string' || typeof done !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid body. Expected { date, exerciseId, done }.' },
        { status: 400 }
      );
    }
    const routine = await setRehabTick(date, exerciseId, done);
    return NextResponse.json({ routine });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update rehab tick';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
