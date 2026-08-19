// Resolve a scheduled calendar block (a Google event) to the member tasks
// scheduled into it, for the desktop batch drill-down dialog.
//
// A grouped block — the planner's "Batch" quota category and the other grouped
// containers (Engagement / Outreach, Writing / Deep Work) — is a single Google
// event whose id is shared by several member records: scheduled Asana tasks
// and/or ad-hoc tasks all carrying the same `googleEventId`. This mirrors the
// server-side grouping the replan analyze route does (asanaGroups keyed by
// googleEventId) and the block→task union in gather.ts, but resolves the member
// list on the client from data already in hand, so no fetch is needed to open
// the dialog.
//
// Kept pure and I/O-free so it is unit-testable and the page + dialog stay thin.

import type { AdHocTask, CalendarEvent, ScheduledAsanaTask } from '@/types';

// One task scheduled into a block. `taskId` is the id the weekly-stats record is
// keyed by (Asana gid or ad-hoc id) — the same id the review flow records an
// outcome against.
export interface BlockMember {
  // Stable React key: the scheduled-record id (Asana) or the ad-hoc task id.
  key: string;
  source: 'asana' | 'adhoc';
  title: string;
  done: boolean;
  // Portal-done ("waiting on others"): the user's work is finished but the Asana
  // task waits on someone else, so it is neither open nor complete. Rendered as a
  // distinct "waiting" state. Only Asana members can be portal-done (ad-hoc tasks
  // have no Asana side).
  portalDone?: boolean;
  // The weekly-stats task id (Asana gid or ad-hoc id).
  taskId: string;
  // Asana members carry the gid + integration needed to complete the task and to
  // open its full detail dialog; the scheduleId is its ScheduledAsanaTask.id, the
  // record removed to take it out of the block.
  gid?: string;
  integrationId?: string;
  scheduleId?: string;
  // Ad-hoc members carry the ad-hoc task id (also `taskId`), whose scheduling is
  // cleared to take it out of the block.
  adhocId?: string;
}

// Look up an Asana task's live title / completion by gid. Callers pass a lookup
// over the page's CalendarEvent-shaped Asana list (id === gid). That list holds
// only incomplete tasks, so a scheduled member absent from it has been completed
// and dropped: it is treated as done, and falls back to the scheduled record's
// captured name. (Use the UNFILTERED raw list for the lookup, so a task hidden by
// a client-side filter isn't mistaken for a completed one.)
export type AsanaTaskLookup = (gid: string) => { title: string; completed: boolean; integrationId?: string } | undefined;

// The member tasks scheduled into a block, in a stable display order (Asana
// members first in schedule order, then ad-hoc). Asana members are matched by
// `googleEventId`; an ad-hoc task is a member when it carries the same event id.
export function resolveBlockMembers(
  googleEventId: string,
  scheduledAsanaTasks: ScheduledAsanaTask[],
  adhocTasks: AdHocTask[],
  lookupAsanaTask: AsanaTaskLookup,
  // Asana gids the user marked portal-done (waiting on others). A portal-done
  // member is still present + incomplete in Asana, so it needs a third state
  // distinct from open and done.
  portalDoneGids?: ReadonlySet<string>
): BlockMember[] {
  const members: BlockMember[] = [];

  for (const s of scheduledAsanaTasks) {
    if (s.googleEventId !== googleEventId) continue;
    const live = lookupAsanaTask(s.asanaTaskId);
    members.push({
      key: s.id,
      source: 'asana',
      title: live?.title ?? s.taskName ?? 'Scheduled task',
      // The live list is incomplete-only; a member missing from it is done.
      done: live ? live.completed : true,
      ...(portalDoneGids?.has(s.asanaTaskId) ? { portalDone: true } : {}),
      taskId: s.asanaTaskId,
      gid: s.asanaTaskId,
      integrationId: s.integrationId ?? live?.integrationId,
      scheduleId: s.id,
    });
  }

  for (const t of adhocTasks) {
    if (t.googleEventId !== googleEventId) continue;
    members.push({
      key: t.id,
      source: 'adhoc',
      title: t.title,
      done: t.completed,
      taskId: t.id,
      adhocId: t.id,
    });
  }

  return members;
}

// Whether a calendar event is a grouped block worth drilling into: an app-created
// Google event backed by two or more member tasks sharing its id. Single-task
// blocks and non-Google events keep their existing double-click behaviour (open
// the linked task / the Google event modal).
export function isGroupedBlock(
  event: CalendarEvent,
  scheduledAsanaTasks: ScheduledAsanaTask[],
  adhocTasks: AdHocTask[]
): boolean {
  if (event.source !== 'google') return false;
  const memberCount =
    scheduledAsanaTasks.filter(s => s.googleEventId === event.id).length +
    adhocTasks.filter(t => t.googleEventId === event.id).length;
  return memberCount >= 2;
}
