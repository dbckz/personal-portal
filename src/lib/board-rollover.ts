// Pure engine for the daily board rollover.
//
// Once per logical day, every unfinished ONE-OFF dated task (a scheduled Asana
// entry or an ad-hoc task) whose date has slipped into the past is moved forward
// to the next working day, so the board never leaves stale work stranded on a
// day that has already passed. The task's ORIGINAL planned date is remembered
// (once) and a roll counter incremented, so the card can be badged ("from Tue").
//
// This module is I/O-free and deterministic: it decides WHAT to roll and to
// WHEN; the storage layer (lib/storage/board-rollover) reads the inputs, applies
// the plan and stamps the last-run day. Rituals and prep blocks are never rolled
// — a lapsed routine simply has tomorrow's own instance. Undated tasks are left
// untouched. The Google Calendar event is never moved: this is a date-only move
// on the local record, mirroring the board's own view of a card's date.

import { boardKeyForAdhoc, boardKeyForBlock, boardKeyForSched } from '@/lib/board';
import { isWorkingDay } from '@/lib/scheduling/end-of-week';
import { formatLocalDate } from '@/lib/date-utils';
import type { AdHocTask, BoardTaskState, ScheduledAsanaTask } from '@/types';

// --- Date helpers (yyyy-MM-dd, built from local parts so a bare date never
// drifts across a timezone boundary). ---------------------------------------

function dateFromStr(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// The next configured working day on or after `dateStr` (so a working day maps
// to itself; a Saturday maps to the following Monday). Bounded so a pathological
// empty working-day set can't loop forever.
export function nextWorkingDayOnOrAfter(dateStr: string, workingDays?: string[]): string {
  const d = dateFromStr(dateStr);
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(d, workingDays)) return formatLocalDate(d);
    d.setDate(d.getDate() + 1);
  }
  return dateStr;
}

// --- Done detection ---------------------------------------------------------

// Whether the board considers this task DONE, mirroring deriveBoardCardStatus in
// lib/board so the rollover and the board agree. The engine has only the local
// stores (no live Asana fetch), so an Asana task's completion is read from the
// portal-done flag, the block-done override, the board state, or a durable
// weekly "done" outcome — the same facts the board GET route exposes.
export interface DoneFacts {
  states: Record<string, BoardTaskState>;
  portalDoneGids: Set<string>;
  blockDoneEventIds: Set<string>;
  doneTaskIds: Set<string>; // gid / adhoc id with a weekly-stats 'done' outcome
}

function scheduledDone(s: ScheduledAsanaTask, facts: DoneFacts): boolean {
  const key = s.googleEventId ? boardKeyForBlock(s.googleEventId) : boardKeyForSched(s.id);
  if (facts.states[key]?.status === 'done') return true;
  if (s.googleEventId && facts.blockDoneEventIds.has(s.googleEventId)) return true;
  if (facts.portalDoneGids.has(s.asanaTaskId)) return true;
  if (facts.doneTaskIds.has(s.asanaTaskId)) return true;
  return false;
}

function adhocDone(t: AdHocTask, facts: DoneFacts): boolean {
  if (t.completed) return true;
  const key = t.googleEventId ? boardKeyForBlock(t.googleEventId) : boardKeyForAdhoc(t.id);
  if (facts.states[key]?.status === 'done') return true;
  if (t.googleEventId && facts.blockDoneEventIds.has(t.googleEventId)) return true;
  if (facts.doneTaskIds.has(t.id)) return true;
  return false;
}

// --- Plan -------------------------------------------------------------------

export interface RolloverInput extends DoneFacts {
  logicalToday: string; // yyyy-MM-dd
  workingDays?: string[];
  scheduledAsanaTasks: ScheduledAsanaTask[];
  adHocTasks: AdHocTask[];
  // taskId → yyyy-MM-dd resume date; a task deferred to a FUTURE date is parked
  // and must not be rolled back onto the board.
  deferrals: Record<string, string>;
}

// One task to move: its record id, the new date, the (preserved) original date
// and the incremented roll count.
export interface RolledEntry {
  id: string;
  date: string; // new date (yyyy-MM-dd)
  originallyPlannedFor: string;
  rolls: number;
}

export interface RolloverPlan {
  scheduled: RolledEntry[];
  adhoc: RolledEntry[];
}

// A task is deferred out of the way when it has a resume date strictly after the
// logical day — an expired deferral no longer parks it.
function isDeferredForward(taskId: string, logicalToday: string, deferrals: Record<string, string>): boolean {
  const until = deferrals[taskId];
  return typeof until === 'string' && until > logicalToday;
}

// Compute the rollover plan. An eligible task has a date strictly BEFORE the
// logical day, is not done, and is not deferred to a future date; its new date
// is the next working day on/after the logical day (today itself when today is a
// working day). originallyPlannedFor is set from the CURRENT date only when not
// already present; rolls increments from its current value (absent ⇒ 0).
export function planBoardRollover(input: RolloverInput): RolloverPlan {
  const { logicalToday, workingDays, scheduledAsanaTasks, adHocTasks, deferrals } = input;
  const target = nextWorkingDayOnOrAfter(logicalToday, workingDays);

  const scheduled: RolledEntry[] = [];
  for (const s of scheduledAsanaTasks) {
    if (!s.scheduledDate || s.scheduledDate >= logicalToday) continue;
    if (scheduledDone(s, input)) continue;
    if (isDeferredForward(s.asanaTaskId, logicalToday, deferrals)) continue;
    scheduled.push({
      id: s.id,
      date: target,
      originallyPlannedFor: s.originallyPlannedFor ?? s.scheduledDate,
      rolls: (s.rolls ?? 0) + 1,
    });
  }

  const adhoc: RolledEntry[] = [];
  for (const t of adHocTasks) {
    if (!t.dueDate || t.dueDate >= logicalToday) continue;
    if (adhocDone(t, input)) continue;
    if (isDeferredForward(t.id, logicalToday, deferrals)) continue;
    adhoc.push({
      id: t.id,
      date: target,
      originallyPlannedFor: t.originallyPlannedFor ?? t.dueDate,
      rolls: (t.rolls ?? 0) + 1,
    });
  }

  return { scheduled, adhoc };
}
