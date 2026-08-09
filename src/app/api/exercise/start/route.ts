import { NextRequest, NextResponse } from 'next/server';
import { format } from 'date-fns';

import { describeVolumeLoad, type ExerciseTarget } from '@/lib/exercise-targets';
import { createSession, getAllSessions } from '@/lib/storage/exercise';
import { resolveSessionTargets } from '@/lib/exercise-session-targets';

// POST /api/exercise/start { date? }
//
// The one button you press on arriving at the gym: opens today's session,
// pre-filled with what to aim for on each exercise.
//
// The seeded entries come from resolveSessionTargets — the SAME resolver the
// checklist's /api/exercise/targets route uses — so the pre-filled "done" numbers
// always match what the screen recommends. It uses the cached AI programme when
// one exists, else the deterministic targets, and never triggers a fresh
// generation: starting a session at the gym must stay fast and offline-tolerant.
//
// Idempotent — pressing it again returns the session already in progress rather
// than starting a second one, because the phone will get closed and reopened
// mid-workout.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const date = typeof body.date === 'string' ? body.date : format(new Date(), 'yyyy-MM-dd');

    const sessions = await getAllSessions();
    const inProgress = sessions.find(s => s.date === date && s.completed && s.source === 'manual');
    if (inProgress) return NextResponse.json({ session: inProgress, resumed: true });

    const { plan, targets } = await resolveSessionTargets(date, sessions);

    const session = await createSession({
      date,
      type: plan?.type ?? 'session',
      ...(plan?.label ? { label: plan.label } : {}),
      ...(plan?.components ? { components: plan.components } : {}),
      exercises: targets.map(toEntry),
      // The explicit link back to the plan this session is being done against.
      ...(plan ? { plannedSessionId: plan.id } : {}),
      planned: false,
      // Logged from the start: the session is being done now, and every tick
      // during it should land in the record immediately.
      completed: true,
      source: 'manual',
    });

    return NextResponse.json({ session, resumed: false, plan: plan?.label ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start the session';
    console.error('Error starting exercise session:', error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// Seed an entry from its target: the numbers to aim for are pre-filled as the
// numbers done, so a session that goes to plan needs only a tick per exercise.
// Cardio measures (duration/distance) and the per-side flag are carried too, so
// a seeded run or a side plank starts with the right shape rather than reverting
// to sets/reps/kg on the checklist.
function toEntry(target: ExerciseTarget) {
  return {
    name: target.name,
    ...(target.sets !== undefined ? { sets: target.sets } : {}),
    ...(target.reps !== undefined ? { reps: target.reps } : {}),
    ...(target.holdSeconds !== undefined ? { holdSeconds: target.holdSeconds } : {}),
    ...(target.perSide ? { perSide: true } : {}),
    ...(target.weightKg !== undefined ? { weightKg: target.weightKg } : {}),
    ...(target.durationMinutes !== undefined ? { durationMinutes: target.durationMinutes } : {}),
    ...(target.distanceKm !== undefined ? { distanceKm: target.distanceKm } : {}),
    targetText: describeVolumeLoad(target),
    done: false,
  };
}
