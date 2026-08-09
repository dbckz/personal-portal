import { NextRequest, NextResponse } from 'next/server';

import { getWeeklyRoutine, saveWeeklyRoutine } from '@/lib/storage/weekly-routine';

// GET /api/exercise/routine — the seven-day standing training routine, Mon→Sun.
// Seeds the captured default on first read of an empty store.
export async function GET() {
  try {
    const routine = await getWeeklyRoutine();
    return NextResponse.json({ routine });
  } catch (error) {
    console.error('Error reading weekly routine:', error);
    return NextResponse.json({ error: 'Failed to read routine' }, { status: 500 });
  }
}

// PUT { routine: WeeklyRoutineDay[] } — replace the whole routine (validated and
// normalised server-side) and return the saved days.
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body || !Array.isArray(body.routine)) {
      return NextResponse.json(
        { error: 'Invalid body. Expected { routine: WeeklyRoutineDay[] }.' },
        { status: 400 }
      );
    }
    const routine = await saveWeeklyRoutine(body.routine);
    return NextResponse.json({ routine });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save routine';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
