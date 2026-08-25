import { NextRequest, NextResponse } from 'next/server';

import { getAllSessions, removeSessionEntry, updateSessionEntry } from '@/lib/storage/exercise';
import { deriveSwapTargetPatch } from '@/lib/exercise-swap-target';
import { prewarmProgramme } from '@/lib/exercise-prewarm';

// A reps-in-reserve rating: a number 0-10, null to clear an existing rating, or
// undefined when the value is unusable (out of range / non-numeric) and should be
// left alone. updateSessionEntry treats null as an explicit clear and undefined as
// "not asserted", so a bad value never disturbs a rating already stored.
function parseRir(value: unknown): number | null | undefined {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : undefined;
}

// Does this body perform a swap — a rename to a substitute exercise that records
// what it stood in for? A non-empty new name plus a non-empty substitutedFor. A
// restore (substitutedFor null/blank) and a plain rename (no substitutedFor) are
// not swaps.
function isSwap(body: Record<string, unknown>): boolean {
  return (
    typeof body.name === 'string' &&
    body.name.trim() !== '' &&
    typeof body.substitutedFor === 'string' &&
    body.substitutedFor.trim() !== ''
  );
}

// Whether the client already supplied a target for the swap. When it did, its
// numbers win and no derivation runs; cardio measures (distance/time) are NOT
// targets in this sense — they refine a derived target rather than replace it.
function hasExplicitTarget(body: Record<string, unknown>): boolean {
  return (
    body.sets !== undefined ||
    body.reps !== undefined ||
    body.weightKg !== undefined ||
    body.holdSeconds !== undefined ||
    body.targetText !== undefined
  );
}

// PATCH /api/exercise/:id/entries/:entryId
//
// One exercise at a time: tick it done, correct the weight actually used, add a
// note. Deliberately fine-grained — this is written from a phone mid-session,
// so each action lands on its own and a dropped connection costs one tap.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  try {
    const { id, entryId } = await params;
    const body = await request.json();

    const patch: Record<string, unknown> = {
      // Renaming matters: an exercise filed under the wrong name is a separate
      // history, so correcting it merges the two.
      ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
      ...(body.done !== undefined ? { done: !!body.done } : {}),
      ...(body.sets !== undefined ? { sets: Number(body.sets) } : {}),
      ...(body.reps !== undefined ? { reps: Number(body.reps) } : {}),
      ...(body.holdSeconds !== undefined ? { holdSeconds: Number(body.holdSeconds) } : {}),
      ...(body.weightKg !== undefined
        ? { weightKg: body.weightKg === null ? undefined : Number(body.weightKg) }
        : {}),
      ...(body.notes !== undefined ? { notes: String(body.notes) } : {}),
      // Cardio actuals: patchable so a Parkrun entry can be swapped for a shorter
      // treadmill run and carry its own distance/time. null clears the figure.
      ...(body.distanceKm !== undefined
        ? { distanceKm: body.distanceKm === null ? null : Number(body.distanceKm) }
        : {}),
      ...(body.durationMinutes !== undefined
        ? { durationMinutes: body.durationMinutes === null ? null : Number(body.durationMinutes) }
        : {}),
      // Explicit reps-in-reserve, 0-10 (the UI only offers 0-4). null clears it;
      // an out-of-range or non-numeric value is ignored rather than stored.
      ...(body.rir !== undefined ? { rir: parseRir(body.rir) } : {}),
      // Per-exercise swap provenance: the original planned name this entry stands
      // in for. An empty string or null clears it (the original was restored).
      ...(body.substitutedFor !== undefined
        ? {
            substitutedFor:
              body.substitutedFor === null ? null : String(body.substitutedFor).trim() || null,
          }
        : {}),
      // The pre-filled "aim for" text. null clears, a string overwrites. On a swap
      // the client leaves this off so the target is DERIVED from the substitute's
      // own history below, rather than left showing the old exercise's aim.
      ...(body.targetText !== undefined
        ? { targetText: body.targetText === null ? null : String(body.targetText) }
        : {}),
    };

    // Swap target derivation: when a swap arrives without an explicit target, give
    // the substitute a target built from ITS OWN history (last time, progressed) —
    // sets/reps/weight or hold/cardio measures plus the "aim for" text — so the
    // entry stops carrying the replaced exercise's numbers. A cardio measure the
    // client typed during the swap still wins over the derived one; a substitute
    // with no history leaves the target blank (a free entry), as before.
    if (isSwap(body) && !hasExplicitTarget(body)) {
      const sessions = await getAllSessions();
      const current = sessions.find(s => s.id === id);
      const derived = current
        ? deriveSwapTargetPatch(sessions, current, body.name.trim())
        : null;
      if (derived) {
        patch.sets = derived.sets;
        patch.reps = derived.reps;
        patch.holdSeconds = derived.holdSeconds;
        patch.perSide = derived.perSide;
        patch.weightKg = derived.weightKg;
        patch.targetText = derived.targetText;
        if (body.distanceKm === undefined) patch.distanceKm = derived.distanceKm;
        if (body.durationMinutes === undefined) patch.durationMinutes = derived.durationMinutes;
      }
    }

    const session = await updateSessionEntry(id, entryId, patch);
    if (!session) return NextResponse.json({ error: 'Entry not found' }, { status: 404 });

    // Correcting an entry (weight, reps, a rename that merges histories) changes
    // history — pre-generate so the next Today open doesn't wait on Claude.
    void prewarmProgramme().catch(error =>
      console.error('Failed to pre-warm exercise programme:', error)
    );

    return NextResponse.json({ session });
  } catch (error) {
    console.error('Error updating exercise entry:', error);
    return NextResponse.json({ error: 'Failed to update the exercise' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  try {
    const { id, entryId } = await params;
    const session = await removeSessionEntry(id, entryId);
    if (!session) return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    // Removing an entry changes history — pre-generate so the next Today open
    // doesn't wait on Claude.
    void prewarmProgramme().catch(error =>
      console.error('Failed to pre-warm exercise programme:', error)
    );
    return NextResponse.json({ session });
  } catch (error) {
    console.error('Error removing exercise entry:', error);
    return NextResponse.json({ error: 'Failed to remove the exercise' }, { status: 500 });
  }
}
