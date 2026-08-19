import { NextRequest, NextResponse } from 'next/server';
import { addDays, subDays } from 'date-fns';

import { materialiseRoutineSessions, pullPlannedSessions } from '@/lib/exercise-calendar';
import { getExerciseLastSyncedAt, setExerciseLastSyncedAt } from '@/lib/user-data-storage';
import { prewarmProgramme } from '@/lib/exercise-prewarm';

// How far either side of today to sync by default. Back far enough to pick up a
// plan written last week, forward far enough to cover the fortnight ahead that
// actually gets planned.
const DEFAULT_BACK_DAYS = 28;
const DEFAULT_FORWARD_DAYS = 28;

// How stale an automatic sync tolerates before doing the work again. The desktop
// section and mobile tab both fire an `auto: true` sync on load; this stops
// opening the section repeatedly from hammering Google.
const AUTO_SYNC_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// POST /api/exercise/sync-calendar { backDays?, forwardDays?, auto? }
//
// Two-way sync in one pass. First PULLS planned sessions from the personal Google
// calendar's all-day events into the portal, then MATERIALISES the days ahead
// from the standing weekly routine and pushes those back to the calendar (and
// reconciles them when the routine is edited). Materialising after the pull lets
// a hand-made calendar event win its date. Idempotent: re-running reconciles
// rather than duplicates. Top-level created/updated/removed sum both halves so
// the client's sync note reflects all of it; `materialise` breaks out the push.
//
// With `auto: true` the sync is throttled: if a sync (auto or manual) ran within
// the last 6 hours it returns { skipped: true, lastSyncedAt } and does no work. A
// manual (non-auto) sync always runs. Either way, a run stamps the timestamp.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const backDays = Number(body.backDays) || DEFAULT_BACK_DAYS;
    const forwardDays = Number(body.forwardDays) || DEFAULT_FORWARD_DAYS;

    if (body.auto === true) {
      const lastSyncedAt = await getExerciseLastSyncedAt();
      if (lastSyncedAt && Date.now() - new Date(lastSyncedAt).getTime() < AUTO_SYNC_MAX_AGE_MS) {
        return NextResponse.json({ skipped: true, lastSyncedAt });
      }
    }

    const now = new Date();
    const pull = await pullPlannedSessions(subDays(now, backDays), addDays(now, forwardDays));
    const materialise = await materialiseRoutineSessions();
    await setExerciseLastSyncedAt(now.toISOString());
    // Plan sessions may have been re-asserted for today, moving its programme
    // hash — pre-generate the new programme so the next Today open doesn't wait.
    void prewarmProgramme().catch(error =>
      console.error('Failed to pre-warm exercise programme:', error)
    );
    return NextResponse.json({
      ...pull,
      created: pull.created + materialise.created,
      updated: pull.updated + materialise.updated,
      removed: pull.removed + materialise.removed,
      materialise,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to sync from the calendar';
    console.error('Error syncing exercise plan from calendar:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
