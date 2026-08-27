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
  // Duplicate overdue records to delete (a task re-planned across weeks has one
  // scheduled entry per week; only one survives — see decideTaskRollover).
  removeScheduledIds: string[];
  removeAdhocIds: string[];
}

// A task is deferred out of the way when it has a resume date strictly after the
// logical day — an expired deferral no longer parks it.
function isDeferredForward(taskId: string, logicalToday: string, deferrals: Record<string, string>): boolean {
  const until = deferrals[taskId];
  return typeof until === 'string' && until > logicalToday;
}

// --- Per-task dedupe ---------------------------------------------------------
//
// A single task legitimately has SEVERAL dated records: it can be GENUINELY
// planned on more than one day in the same week (a block on Thursday AND another
// on Friday — intentional multi-day planning, not duplication), and the rollover
// itself leaves a moved record behind. A naive per-record rollover multiplies the
// task across the board, so given ALL of one task's dated records we decide which
// single overdue record to roll forward and which overdue records to delete —
// WITHOUT ever destroying a genuine record as a "duplicate" of another.
//
// A record is ROLLED/stale when the rollover created or moved it (rolls >= 1 or
// an originallyPlannedFor is set); otherwise it is GENUINE. A `blocked` record
// (done, or deferred to a future date) is never rolled and never removed.
//
//  - Any record on or after `logicalToday` (genuine OR rolled) means the task is
//    already on the board today/ahead: roll nothing, and drop only the stale
//    ROLLED overdue records — genuine overdue records are left as history.
//  - Otherwise (nothing scheduled today or later) roll exactly ONE overdue record
//    forward — the latest scheduledDate, tie-broken by the latest
//    originallyPlannedFor — and remove the other overdue records.
//
// Pure and self-contained: a one-off data cleanup reuses it.

export interface TaskRolloverRecord {
  id: string;
  date: string; // yyyy-MM-dd (scheduledDate / dueDate)
  blocked?: boolean;
  // Rollover bookkeeping, used to tell a rolled/stale record from a genuine one
  // and to tie-break the survivor. Absent on a genuinely-planned record.
  rolls?: number;
  originallyPlannedFor?: string;
}

export interface TaskRolloverDecision {
  keep: string | null; // record id to roll forward, or null when nothing rolls
  remove: string[]; // record ids to delete
  rollTarget?: string; // new date for the kept record (present iff keep !== null)
}

function isRolled(r: TaskRolloverRecord): boolean {
  return (r.rolls ?? 0) >= 1 || r.originallyPlannedFor != null;
}

export function decideTaskRollover(
  records: TaskRolloverRecord[],
  logicalToday: string,
  workingDays?: string[]
): TaskRolloverDecision {
  const overdue = records.filter(r => !r.blocked && r.date && r.date < logicalToday);
  if (overdue.length === 0) return { keep: null, remove: [] };

  // Already scheduled today or later (a genuine or rolled anchor): roll nothing
  // and drop only the stale rolled overdue records, keeping genuine history.
  if (records.some(r => r.date && r.date >= logicalToday)) {
    return { keep: null, remove: overdue.filter(isRolled).map(r => r.id) };
  }

  // Nothing on/after today: roll the most-recent overdue record forward (latest
  // scheduledDate, tie-broken by latest originallyPlannedFor); remove the rest.
  const survivor = overdue.reduce((a, b) => {
    if (b.date !== a.date) return b.date > a.date ? b : a;
    return (b.originallyPlannedFor ?? '') > (a.originallyPlannedFor ?? '') ? b : a;
  });
  return {
    keep: survivor.id,
    remove: overdue.filter(r => r.id !== survivor.id).map(r => r.id),
    rollTarget: nextWorkingDayOnOrAfter(logicalToday, workingDays),
  };
}

// A dated record tagged with the task it belongs to: asanaTaskId for a scheduled
// entry, the task's own id for an ad-hoc task (which is always one record).
interface IdentifiedRecord extends TaskRolloverRecord {
  taskId: string;
}

// Group records by task identity and run decideTaskRollover on each group,
// collecting the entries to roll and the ids to delete. Shared by the scheduled
// and ad-hoc passes, which differ only in where their fields come from.
function planRecordGroups(
  records: IdentifiedRecord[],
  logicalToday: string,
  target: string,
  workingDays?: string[]
): { rolled: RolledEntry[]; removeIds: string[] } {
  const byTask = new Map<string, IdentifiedRecord[]>();
  for (const r of records) {
    const group = byTask.get(r.taskId);
    if (group) group.push(r);
    else byTask.set(r.taskId, [r]);
  }

  const rolled: RolledEntry[] = [];
  const removeIds: string[] = [];
  for (const group of byTask.values()) {
    const decision = decideTaskRollover(group, logicalToday, workingDays);
    removeIds.push(...decision.remove);
    const survivor = group.find(r => r.id === decision.keep);
    if (survivor) {
      rolled.push({
        id: survivor.id,
        date: target,
        originallyPlannedFor: survivor.originallyPlannedFor ?? survivor.date,
        rolls: (survivor.rolls ?? 0) + 1,
      });
    }
  }
  return { rolled, removeIds };
}

// Compute the rollover plan. Records are grouped by task identity and deduped
// via decideTaskRollover, which protects genuine multi-day planning: at most ONE
// overdue record per task rolls to the next working day on/after the logical
// day, stale rolled duplicates are removed, and genuine records (especially any
// on/after today) are preserved. originallyPlannedFor is set from the CURRENT
// date only when not already present; rolls increments from its value (absent ⇒ 0).
export function planBoardRollover(input: RolloverInput): RolloverPlan {
  const { logicalToday, workingDays, scheduledAsanaTasks, adHocTasks, deferrals } = input;
  const target = nextWorkingDayOnOrAfter(logicalToday, workingDays);

  const scheduledRecords: IdentifiedRecord[] = [];
  for (const s of scheduledAsanaTasks) {
    if (!s.scheduledDate) continue;
    scheduledRecords.push({
      taskId: s.asanaTaskId,
      id: s.id,
      date: s.scheduledDate,
      blocked: scheduledDone(s, input) || isDeferredForward(s.asanaTaskId, logicalToday, deferrals),
      rolls: s.rolls,
      originallyPlannedFor: s.originallyPlannedFor,
    });
  }

  const adhocRecords: IdentifiedRecord[] = [];
  for (const t of adHocTasks) {
    if (!t.dueDate) continue;
    adhocRecords.push({
      taskId: t.id,
      id: t.id,
      date: t.dueDate,
      blocked: adhocDone(t, input) || isDeferredForward(t.id, logicalToday, deferrals),
      rolls: t.rolls,
      originallyPlannedFor: t.originallyPlannedFor,
    });
  }

  const scheduledPlan = planRecordGroups(scheduledRecords, logicalToday, target, workingDays);
  const adhocPlan = planRecordGroups(adhocRecords, logicalToday, target, workingDays);

  return {
    scheduled: scheduledPlan.rolled,
    adhoc: adhocPlan.rolled,
    removeScheduledIds: scheduledPlan.removeIds,
    removeAdhocIds: adhocPlan.removeIds,
  };
}
