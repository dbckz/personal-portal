import { NextRequest, NextResponse } from 'next/server';

import { getSessionsInRange } from '@/lib/storage/exercise';
import { getProgrammesInRange } from '@/lib/storage/exercise-programmes';
import { aggregateMuscleLoad, type MuscleProgrammeDay } from '@/lib/exercise-muscles';

// GET /api/exercise/muscles?windowDays=28 — per-muscle done vs planned load over
// the window, for the Muscles heatmap. Reads completed + planned sessions and the
// programme cache server-side and returns the aggregated result; the diagram's
// static muscle metadata lives in the exercise-muscles lib on the client.
const DEFAULT_WINDOW_DAYS = 28;
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 120;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const raw = Number(searchParams.get('windowDays'));
    const windowDays = Number.isFinite(raw)
      ? Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.round(raw)))
      : DEFAULT_WINDOW_DAYS;

    // Done work looks back, planned work looks forward, so fetch the union
    // [now-window, now+window] and let aggregateMuscleLoad split the two.
    const now = new Date();
    const back = new Date(now);
    back.setDate(back.getDate() - windowDays);
    const forward = new Date(now);
    forward.setDate(forward.getDate() + windowDays);
    const fromIso = back.toISOString().slice(0, 10);
    const toIso = forward.toISOString().slice(0, 10);

    const [sessions, programmeRows] = await Promise.all([
      getSessionsInRange(fromIso, toIso),
      Promise.resolve(getProgrammesInRange(fromIso, toIso)),
    ]);

    const programmes: MuscleProgrammeDay[] = programmeRows.map(day => ({
      date: day.date,
      rows: day.rows.map(row => ({ name: row.name, sets: row.target?.sets })),
    }));

    const muscles = aggregateMuscleLoad(sessions, programmes, windowDays, now);
    return NextResponse.json({ muscles, windowDays });
  } catch (error) {
    console.error('Error building muscle load:', error);
    return NextResponse.json({ error: 'Failed to build muscle load' }, { status: 500 });
  }
}
