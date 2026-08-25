// Pure "reconcile stored schedule with the live calendar" decision.
//
// Plan-my-week and Replan act on stored records (scheduled Asana tasks, ad-hoc
// tasks, prep blocks). When the user deletes a planned block straight off the
// calendar, the stored record is left behind — it keeps suppressing candidates
// and consuming quota even though the block no longer exists. This module
// decides, from the week's fetched events, which stored records point at an
// event that is GONE and should therefore be purged.
//
// It is I/O-free and deterministic so it can be unit-tested in isolation; the
// gather step feeds it the fetched events and applies the purge.

export type ReconcileRecordKind = 'asana' | 'adhoc' | 'prep' | 'ritual';

// A stored record that owns a Google event. `id` identifies the record within
// its store (schedule-entry id / ad-hoc id / prep-block id). `date` is the
// record's in-week anchor (scheduledDate / dueDate / prep date).
export interface ReconcileRecord {
  kind: ReconcileRecordKind;
  id: string;
  googleEventId: string;
  googleIntegrationId?: string;
  date?: string; // yyyy-MM-dd
}

export interface ReconcileInput {
  records: ReconcileRecord[];
  // Event ids present in the week's fetch (the live calendar).
  presentEventIds: Set<string>;
  // Integrations whose week fetch fully succeeded. A record on an integration
  // NOT in this set is skipped — a failed/partial fetch must never be read as
  // "the event was deleted".
  fetchedIntegrationIds: Set<string>;
  weekStartStr: string;
  weekEndStr: string;
}

// Return the records whose backing event was deleted by the user and should be
// purged. A record is stale only when ALL of these hold:
//   * it has a googleEventId and a googleIntegrationId,
//   * its date falls within the fetched week,
//   * its integration's fetch fully succeeded, AND
//   * its event id is absent from the live calendar.
// Any record that fails a precondition is left untouched (conservative).
export function selectStaleRecords(input: ReconcileInput): ReconcileRecord[] {
  const { records, presentEventIds, fetchedIntegrationIds, weekStartStr, weekEndStr } = input;
  const inWeek = (d?: string): boolean => !!d && d >= weekStartStr && d <= weekEndStr;

  return records.filter(r => {
    if (!r.googleEventId || !r.googleIntegrationId) return false;
    if (!inWeek(r.date)) return false;
    // Can't verify deletion unless this integration's fetch actually succeeded.
    if (!fetchedIntegrationIds.has(r.googleIntegrationId)) return false;
    return !presentEventIds.has(r.googleEventId);
  });
}

// --- Move reconcile ---------------------------------------------------------
//
// The deletion reconciler above heals records whose event is GONE. This one
// heals records whose event still exists but was MOVED straight on the calendar
// (dragged to another day/time or resized): the stored snapshot's date/time/
// duration then disagrees with the live event and must be written back so the
// planner reasons about where the block actually is.

// A stored record plus the placement snapshot to compare against the live event.
// Same identity fields as ReconcileRecord; `date`/`time`/`durationMinutes` are
// the record's currently-stored placement (scheduledDate/scheduledTime/duration,
// dueDate/dueTime/duration, or a block's date/start/durationMinutes).
export interface ReconcileMoveRecord {
  kind: ReconcileRecordKind;
  id: string;
  googleEventId: string;
  googleIntegrationId?: string;
  date?: string;           // yyyy-MM-dd
  time?: string;           // HH:mm
  durationMinutes?: number;
}

// The live event's local placement, derived by the caller the SAME way the
// confirm flow writes these fields (local yyyy-MM-dd / HH:mm, whole minutes).
export interface LivePlacement {
  date: string;
  time: string;
  durationMinutes: number;
  allDay: boolean;
}

// A record that moved, with the live values to write back.
export interface MovedRecord {
  record: ReconcileMoveRecord;
  date: string;
  time: string;
  durationMinutes: number;
}

export interface MoveReconcileInput {
  records: ReconcileMoveRecord[];
  // eventId -> the live event's derived local placement (timed events only need
  // apply; all-day placements are kept so this function can skip them itself).
  livePlacements: Map<string, LivePlacement>;
  fetchedIntegrationIds: Set<string>;
  weekStartStr: string;
  weekEndStr: string;
}

// Return the records whose backing event was moved/resized and the live values
// to write back. A record is a move candidate only when ALL of these hold:
//   * it has a googleEventId and a googleIntegrationId,
//   * its stored date falls within the fetched week,
//   * its integration's fetch fully succeeded,
//   * the event is still present (absent → deletion reconciler's job, skip), AND
//   * the live event is timed (all-day → skip; app blocks are never all-day).
// It is then a move only when the live date, time (HH:mm) or duration differs
// from the stored snapshot. Any record failing a precondition is left untouched.
export function selectMovedRecords(input: MoveReconcileInput): MovedRecord[] {
  const { records, livePlacements, fetchedIntegrationIds, weekStartStr, weekEndStr } = input;
  const inWeek = (d?: string): boolean => !!d && d >= weekStartStr && d <= weekEndStr;

  const moved: MovedRecord[] = [];
  for (const r of records) {
    if (!r.googleEventId || !r.googleIntegrationId) continue;
    if (!inWeek(r.date)) continue;
    if (!fetchedIntegrationIds.has(r.googleIntegrationId)) continue;
    const live = livePlacements.get(r.googleEventId);
    if (!live) continue; // event gone — deletion reconciler handles it
    if (live.allDay) continue; // turned into an all-day event — leave it alone
    if (live.date === r.date && live.time === r.time && live.durationMinutes === r.durationMinutes) {
      continue;
    }
    moved.push({ record: r, date: live.date, time: live.time, durationMinutes: live.durationMinutes });
  }
  return moved;
}
