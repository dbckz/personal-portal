import { NextRequest, NextResponse } from 'next/server';

import {
  getChallenge75State,
  restartChallenge75,
  setChallenge75Note,
  setChallenge75StartDate,
  setChallenge75Tick,
} from '@/lib/storage/challenge75';

// GET /api/challenge75 — the whole challenge state (all attempts, the last one
// active). Seeds the first attempt (startDate 2026-09-14) on an empty store.
// The client evaluates pass/fail with the shared lib, so no summary is derived
// here.
export async function GET() {
  try {
    const state = await getChallenge75State();
    return NextResponse.json({ state });
  } catch (error) {
    console.error('Error reading 75 Hard state:', error);
    return NextResponse.json({ error: 'Failed to read challenge state' }, { status: 500 });
  }
}

// PATCH — one per-action write against the active attempt:
//   { date, rule, value }  tick/untick one rule on one date
//   { date, note }         set/clear the day's free-text note
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { date, rule, value, note } = body ?? {};

    if (typeof date !== 'string') {
      return NextResponse.json({ error: 'Expected a date.' }, { status: 400 });
    }

    if (typeof note === 'string' && rule === undefined) {
      const state = await setChallenge75Note(date, note);
      return NextResponse.json({ state });
    }

    if (typeof rule === 'string' && typeof value === 'boolean') {
      const state = await setChallenge75Tick(date, rule as never, value);
      return NextResponse.json({ state });
    }

    return NextResponse.json(
      { error: 'Invalid body. Expected { date, rule, value } or { date, note }.' },
      { status: 400 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update challenge';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// PUT { startDate } — edit the active attempt's start date.
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body || typeof body.startDate !== 'string') {
      return NextResponse.json(
        { error: 'Invalid body. Expected { startDate }.' },
        { status: 400 }
      );
    }
    const state = await setChallenge75StartDate(body.startDate);
    return NextResponse.json({ state });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to set start date';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// POST { startDate? } — restart from day 1: archive the active attempt and begin
// a fresh one from the chosen date (default: today).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const startDate = typeof body?.startDate === 'string' ? body.startDate : undefined;
    const state = await restartChallenge75(startDate);
    return NextResponse.json({ state });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to restart challenge';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
