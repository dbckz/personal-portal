import { NextRequest, NextResponse } from 'next/server';

import { getSessionsInRange } from '@/lib/storage/exercise';
import { getProgrammesInRange } from '@/lib/storage/exercise-programmes';
import {
  aggregateMuscleLoad,
  rangeFromAnchor,
  type MuscleProgrammeDay,
} from '@/lib/exercise-muscles';

// GET /api/exercise/muscles?anchor=yyyy-MM-dd&windowDays=28 — per-muscle planned
// vs done load over the inclusive range [anchor - windowDays, anchor]. Reads
// sessions and the programme cache server-side and returns the aggregated result
// plus the resolved range so the UI can label the period. The diagram's static
// muscle metadata lives in the exercise-muscles lib on the client.
const DEFAULT_WINDOW_DAYS = 28;
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 120;
const MAX_ANCHOR_OFFSET_DAYS = 366;
// How far before the display range to read sessions, for synthesising a row-less
// planned session's plan from the most recent matching real session.
const HISTORY_LOOKBACK_DAYS = 120;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function clampAnchor(raw: string | null): string {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  if (!raw || !ISO_DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    return todayIso;
  }
  // Keep the anchor within a year either side of today.
  const min = new Date(today);
  min.setUTCDate(min.getUTCDate() - MAX_ANCHOR_OFFSET_DAYS);
  const max = new Date(today);
  max.setUTCDate(max.getUTCDate() + MAX_ANCHOR_OFFSET_DAYS);
  const minIso = min.toISOString().slice(0, 10);
  const maxIso = max.toISOString().slice(0, 10);
  if (raw < minIso) return minIso;
  if (raw > maxIso) return maxIso;
  return raw;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawWindow = Number(searchParams.get('windowDays'));
    const windowDays = Number.isFinite(rawWindow)
      ? Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.round(rawWindow)))
      : DEFAULT_WINDOW_DAYS;
    const anchor = clampAnchor(searchParams.get('anchor'));
    const range = rangeFromAnchor(anchor, windowDays);

    // Fetch a longer history slice than the display range so a row-less planned
    // session (a calendar import with only components) can be synthesised from
    // the most recent matching real session. Out-of-range sessions never count
    // toward the totals — aggregateMuscleLoad only accumulates within `range`.
    const historyFrom = new Date(`${range.from}T00:00:00Z`);
    historyFrom.setUTCDate(historyFrom.getUTCDate() - HISTORY_LOOKBACK_DAYS);
    const historyFromIso = historyFrom.toISOString().slice(0, 10);

    const [sessions, programmeRows] = await Promise.all([
      getSessionsInRange(historyFromIso, range.to),
      Promise.resolve(getProgrammesInRange(range.from, range.to)),
    ]);

    const programmes: MuscleProgrammeDay[] = programmeRows.map(day => ({
      date: day.date,
      rows: day.rows.map(row => ({ name: row.name, sets: row.target?.sets })),
    }));

    const muscles = aggregateMuscleLoad(sessions, programmes, range);
    return NextResponse.json({ muscles, range, anchor, windowDays });
  } catch (error) {
    console.error('Error building muscle load:', error);
    return NextResponse.json({ error: 'Failed to build muscle load' }, { status: 500 });
  }
}
