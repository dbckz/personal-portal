import { NextRequest, NextResponse } from 'next/server';

import {
  getWeeklyRoutine,
  listRoutines,
  setActiveRoutine,
} from '@/lib/storage/weekly-routine';
import { materialiseRoutineSessions } from '@/lib/exercise-calendar';
import { prewarmProgramme } from '@/lib/exercise-prewarm';

// POST /api/exercise/routine/activate { name } — switch the active routine.
//
// Activation is a bigger change than a single edit, so it reconciles the 14-day
// horizon of routine-sourced planned sessions to the new routine
// (materialiseRoutineSessions — the same reconcile the calendar sync runs) and
// pre-warms today's programme, then returns the GET shape. The horizon reconcile
// is best-effort: it touches Google Calendar, and a calendar failure must not
// leave the routine un-switched, so it is logged, not thrown.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    await setActiveRoutine(name);

    // Bring the fortnight ahead of routine-sourced plans in line with the new
    // routine (create/update/remove dated sessions), then pre-warm today.
    try {
      await materialiseRoutineSessions();
    } catch (error) {
      console.error('Failed to reconcile the plan after activating a routine:', error);
    }
    void prewarmProgramme().catch(error =>
      console.error('Failed to pre-warm exercise programme:', error)
    );

    const routine = await getWeeklyRoutine();
    const { names, active } = await listRoutines();
    return NextResponse.json({ routine, active, names });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to activate routine';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
