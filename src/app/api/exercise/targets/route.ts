import { NextRequest, NextResponse } from 'next/server';
import { format } from 'date-fns';

import { getAllSessions } from '@/lib/storage/exercise';
import { resolveSessionTargets } from '@/lib/exercise-session-targets';
import { kickOffGeneration } from '@/lib/exercise-prewarm';

// GET /api/exercise/targets?date=yyyy-MM-dd
//
// What to aim for in a session, for each exercise. Two sources, one shape:
//
//   'ai'       — a Claude-programmed session (ordered, core/rotation/cardio
//                tagged, one exercise to failure), cached per day-plan.
//   'fallback' — the instant rule-based targets, served while the AI programme
//                is being generated (or when Claude is unavailable).
//
// The resolution itself (cache-or-deterministic) lives in resolveSessionTargets,
// shared with /api/exercise/start so the seeded session and this checklist can
// never disagree. This route adds the one thing start must NOT do: when no
// programme is cached yet, kick off generation in the background and return the
// fallback with generating:true; the client refetches to pick up the programme
// once it lands.

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || format(new Date(), 'yyyy-MM-dd');

    const sessions = await getAllSessions();
    const resolved = await resolveSessionTargets(date, sessions);
    const { plan, components, targets, input, hash } = resolved;

    const planPayload = plan ? { plan: { label: plan.label, components } } : {};

    if (resolved.source === 'ai') {
      return NextResponse.json({
        date,
        ...planPayload,
        targets,
        source: 'ai',
        generating: false,
      });
    }

    // No programme cached: serve the instant rule-based targets and, when there
    // is history to program from, generate the AI version in the background.
    const generating = input.exercises.length > 0;
    if (generating) void kickOffGeneration(date, hash, input);

    return NextResponse.json({
      date,
      ...planPayload,
      targets,
      source: 'fallback',
      generating,
    });
  } catch (error) {
    console.error('Error building exercise targets:', error);
    return NextResponse.json({ error: 'Failed to build targets' }, { status: 500 });
  }
}
