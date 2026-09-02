import { NextRequest, NextResponse } from 'next/server';

import { getRoutineOverrides, setRoutineOverride } from '@/lib/storage/routine-overrides';
import { prewarmProgramme } from '@/lib/exercise-prewarm';
import type { RoutineOverride } from '@/types/life';

// GET /api/exercise/routine/overrides — the per-date routine overrides, keyed by
// yyyy-MM-dd. Each is either { dayOfWeek } (follow that weekday's routine on this
// date) or { rest: true } (treat this date as rest).
export async function GET() {
  try {
    const overrides = await getRoutineOverrides();
    return NextResponse.json({ overrides });
  } catch (error) {
    console.error('Error reading routine overrides:', error);
    return NextResponse.json({ error: 'Failed to read overrides' }, { status: 500 });
  }
}

// PUT { date, dayOfWeek?: number, rest?: boolean, clear?: boolean } — set or clear
// the override for one date, returning the resulting map. `clear` (or no dayOfWeek
// and no rest) removes the override; `rest` sets a rest override; `dayOfWeek` sets
// a follow-that-weekday override.
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const date = typeof body.date === 'string' ? body.date : '';
    if (!date) {
      return NextResponse.json({ error: 'date is required (yyyy-MM-dd)' }, { status: 400 });
    }

    let override: RoutineOverride | null;
    if (body.clear === true || (body.dayOfWeek === undefined && body.rest !== true)) {
      override = null;
    } else if (body.rest === true) {
      override = { rest: true };
    } else {
      override = { dayOfWeek: Number(body.dayOfWeek) };
    }

    const overrides = await setRoutineOverride(date, override);
    // The override reshapes which routine day applies to a date, moving its
    // programme hash — pre-generate in the background so the next Today open
    // doesn't wait on Claude.
    void prewarmProgramme().catch(error =>
      console.error('Failed to pre-warm exercise programme:', error)
    );
    return NextResponse.json({ overrides });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to set override';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
