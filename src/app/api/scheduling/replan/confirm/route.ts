import { NextRequest, NextResponse } from 'next/server';
import { addDays, format, startOfWeek } from 'date-fns';

import { createCalendarEvent, deleteCalendarEvent, ensureValidCredentials, updateCalendarEvent } from '@/lib/google-calendar';
import { completeTask, deleteTask, refreshAsanaToken } from '@/lib/asana';
import { blockEventDescription, colorIdForBlock, eventTitleForBlock } from '@/lib/scheduling/event-titles';
import {
  getEnabledAsanaIntegrations,
  getEnabledGoogleIntegrations,
  getGoogleIntegrationById,
  getIntegrationById,
  updateIntegration,
} from '@/lib/integration-storage';
import { getWorkflowConfig } from '@/lib/workflow-config-storage';
import { createRitualEvent } from '@/lib/scheduling/ritual-events';
import { ritualIntegrationIdForBlock, isRitualLikeTitle } from '@/lib/scheduling/rituals';
import { buildAsanaEventRouting, createTaskBlockEvent, routeTaskBlock } from '@/lib/scheduling/confirm-task-block';
import type { ProposedBlock } from '@/lib/scheduling/types';
import {
  getAdHocTasks,
  getPrepBlocks,
  getRitualBlocks,
  getScheduledAsanaTasks,
  addAdHocTask,
  updateAdHocTask,
  deleteAdHocTask,
  addPrepBlock,
  updatePrepBlock,
  deletePrepBlock,
  deleteRitualBlock,
  unscheduleAsanaTask,
  scheduleAsanaTask,
  setBlockDoneOverride,
  removeGoogleEventAttribution,
  removeBlockDoneOverride,
  setTaskDeferrals,
  setCarryOvers,
  removeCarryOvers,
  setWeeklyTaskOutcomes,
  setGoogleEventAttribution,
  addEventAttributionRule,
  upsertDelegationEntry,
  updateScheduledAsanaTasksByGoogleEvent,
  recordWeeklyTasks,
  markCarryOversScheduled,
} from '@/lib/user-data-storage';
import type { ReviewAdoptInput } from '@/lib/scheduling/daily-review';
import type {
  AsanaIntegration,
  GoogleCalendarCredentials,
  GoogleIntegration,
  WeeklyTaskOutcomeKind,
} from '@/types';

// One accepted move: patch the existing Google event to a new time and update
// the stored schedule for its linked work.
interface MoveInput {
  googleEventId: string;
  googleIntegrationId?: string;
  date: string; // yyyy-MM-dd
  start: string; // HH:mm
  durationMinutes: number;
}

interface MoveResult {
  googleEventId: string;
  success: boolean;
  error?: string;
}

interface DoneResult {
  googleEventId: string;
  success: boolean;
  error?: string;
}

// One adopted bare calendar event (daily review): a not-done Google event with no
// local record turned into a scheduled Asana block (gid set) or an ad-hoc task,
// so the replan step re-slots it like any other missed work.
interface AdoptResult {
  googleEventId: string;
  success: boolean;
  error?: string;
}

interface AsanaCompleteInput {
  gid: string;
  integrationId: string;
}

interface AsanaCompleteResult {
  gid: string;
  success: boolean;
  error?: string;
}

// One deferred unplaceable block: its backing task ids are parked until next
// Monday, and any planning override on its event is cleared.
interface DeferInput {
  taskIds: string[];
  googleEventId?: string;
}

interface DeferResult {
  taskIds: string[];
  googleEventId?: string;
  success: boolean;
  error?: string;
}

// One "didn't do" answer: the planned block's event is removed and, when the user
// said what they did instead, a replacement is created in the same slot.
//  * 'work'     — a replacement on the chosen workspace's calendar (with a manual
//                 attribution as a belt-and-braces guarantee it counts there),
//  * 'personal' — a replacement that counts toward NOTHING (a pinned 'none'
//                 attribution rule for that event id),
//  * 'none'     — deletion only.
interface ReplacementInput {
  googleEventId: string;
  googleIntegrationId?: string;
  date: string;
  start: string;
  durationMinutes: number;
  mode: 'work' | 'personal' | 'none';
  title?: string;
  workspaceId?: string;
}

interface ReplacementResult {
  googleEventId: string;
  deleted: boolean;
  replacementEventId?: string;
  success: boolean;
  error?: string;
}

// One end-of-week carry-over decision for a block's tasks. The loud form (the
// default) marks each task as carried out of the CURRENT week — so next week's
// plan-week wizard badges it — and defers it to next Monday so a weekend replan
// leaves it alone. The `quiet` form is "back to backlog": no marker, no deferral,
// just the same cleanup the 'leave unscheduled' path does.
// Carry decisions are applied PER TASK ID — the block ids are only used to
// reject rituals/prep and to clear planning overrides — so a merged card (a
// grouped category's sibling blocks folded into one) can send whichever of its
// block ids it likes without the task ids having to belong to any one of them.
interface CarryInput {
  blockId?: string; // the card's primary Google event id (echoed back in the result)
  blockIds: string[]; // every block behind the card, primary included
  taskIds: string[];
  quiet: boolean;
  // Escalation for a task that keeps sliding: carry it AND flag it "must do next
  // week", so the wizard pre-ticks it and no selection cap can drop it.
  mustDo?: boolean;
}

// One "delegate instead of carrying" decision: the task goes to the agent queue
// rather than into next week's plan, so NO carry-over marker is written — next-week
// Dave isn't doing it, the agent is.
interface DelegateInput {
  blockId?: string;
  gid: string;
  integrationId: string;
  title?: string;
  brief?: string;
}

interface DelegateResult {
  gid: string;
  success: boolean;
  error?: string;
}

interface CarryResult {
  blockId?: string;
  taskIds: string[];
  success: boolean;
  error?: string;
}

// One "prioritise tomorrow" victim: its calendar event is removed and its stored
// schedule cleared, freeing the slot for the prioritised block (which arrives as
// a normal move). Its tasks are then deferred to next week ('defer') or left in
// the pool to be re-planned ('leave') — the same disposition unplaceable blocks
// get.
interface DisplaceInput {
  googleEventId: string;
  googleIntegrationId?: string;
  taskIds: string[];
  mode: 'defer' | 'leave';
  // The victim's own slot length and the prioritised block that will fill it. A
  // victim shorter than the prioritised block is rejected, so the freed slot
  // always fits without overlapping whatever follows it.
  durationMinutes?: number;
  priorityDurationMinutes?: number;
}

interface DisplaceResult {
  googleEventId: string;
  success: boolean;
  error?: string;
}

// One "delete task" decision from the couldn't-fit section ("I'm not doing this
// at all"): the calendar block is removed, its local records cleared, and every
// backing Asana task deleted outright. Ad-hoc tasks (no gid) are simply removed
// locally. The abandoned task ids are recorded as 'dropped' for the week.
interface DropInput {
  googleEventId: string;
  googleIntegrationId?: string;
  taskIds: string[];
}

interface DropResult {
  googleEventId: string;
  success: boolean;
  error?: string;
}

// One legacy deep-work block to convert in place to a generic container: retitle
// + re-describe its event, and record the week's deep-work tasks as its shared
// membership. The slot is untouched.
interface ConversionInput {
  googleEventId: string;
  googleIntegrationId?: string;
  category: string;
  date: string;
  start: string;
  durationMinutes: number;
  tasks: Array<{ gid?: string; adhocId?: string; title: string; integrationId?: string }>;
}

// One created ritual addition, reported back by its proposal id.
interface AdditionResult {
  id: string;
  success: boolean;
  googleEventId?: string;
  error?: string;
}

// One created task-backfill block, reported back by its proposal id. Created +
// stored exactly like a weekly-plan task block (see confirm-task-block).
interface BackfillResult {
  id: string;
  success: boolean;
  googleEventId?: string;
  error?: string;
}

function toStartEnd(date: string, start: string, durationMinutes: number): { start: Date; end: Date } {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = start.split(':').map(Number);
  const startDate = new Date(y, mo - 1, d, h, m, 0, 0);
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
  return { start: startDate, end: endDate };
}

// A calendar delete that 404s/410s means the event is already gone — the caller
// treats that as success rather than an error.
function isEventGoneError(err: unknown): boolean {
  const status =
    (err as { code?: number; status?: number; response?: { status?: number } })?.code ??
    (err as { status?: number })?.status ??
    (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || status === 410;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const moves: MoveInput[] = Array.isArray(body?.moves) ? body.moves : [];
    // Event ids the user chose to mark "done" instead of rescheduling. Ownership
    // is resolved server-side: prep block → done:true, ad-hoc → completed:true,
    // Asana-backed → a planning override (the Asana task itself stays open).
    const doneEventIds: string[] = Array.isArray(body?.done)
      ? body.done.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    // Event ids the user marked "not done" in the daily review: reverse whatever
    // made the block read as done — prep block → done:false, ad-hoc → completed:false,
    // else clear the planning override — so the next analyze classifies it as missed.
    const notDoneEventIds: string[] = Array.isArray(body?.notDone)
      ? body.notDone.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    // Asana tasks to complete in Asana (daily review "Complete in Asana"). Once
    // completed they drop out of the next analyze's incomplete-task fetch.
    const asanaCompletions: AsanaCompleteInput[] = Array.isArray(body?.completeAsana)
      ? body.completeAsana.filter(
          (a: unknown): a is AsanaCompleteInput =>
            !!a &&
            typeof a === 'object' &&
            typeof (a as { gid?: unknown }).gid === 'string' &&
            typeof (a as { integrationId?: unknown }).integrationId === 'string'
        )
      : [];
    // Unplaceable blocks the user deferred to next week: park their tasks and
    // clear any planning override (the past block record itself stays as history).
    const deferInputs: DeferInput[] = Array.isArray(body?.defer)
      ? body.defer
          .filter(
            (d: unknown): d is { taskIds?: unknown; googleEventId?: unknown } =>
              !!d && typeof d === 'object'
          )
          .map((d: { taskIds?: unknown; googleEventId?: unknown }) => ({
            taskIds: Array.isArray(d.taskIds)
              ? d.taskIds.filter((t: unknown): t is string => typeof t === 'string')
              : [],
            googleEventId: typeof d.googleEventId === 'string' ? d.googleEventId : undefined,
          }))
          .filter((d: DeferInput) => d.taskIds.length > 0 || d.googleEventId)
      : [];
    // Unplaceable blocks the user chose to leave unscheduled: no deferral, just
    // clear any stale planning override so the row stops reading as done.
    const leaveEventIds: string[] = Array.isArray(body?.leaveUnscheduled)
      ? body.leaveUnscheduled.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    // End-of-week carry-overs: mark each block's chosen tasks as carried into
    // next week (or, when quiet, quietly returned to the backlog).
    const carryInputs: CarryInput[] = Array.isArray(body?.carry)
      ? body.carry
          .filter((c: unknown): c is Record<string, unknown> => !!c && typeof c === 'object')
          .map((c: Record<string, unknown>) => {
            const blockId = typeof c.blockId === 'string' ? c.blockId : undefined;
            const extra = Array.isArray(c.blockIds)
              ? c.blockIds.filter((b: unknown): b is string => typeof b === 'string')
              : [];
            return {
              blockId,
              blockIds: [...new Set([...(blockId ? [blockId] : []), ...extra])],
              taskIds: Array.isArray(c.taskIds)
                ? c.taskIds.filter((t: unknown): t is string => typeof t === 'string')
                : [],
              quiet: c.quiet === true,
              mustDo: c.mustDo === true,
            };
          })
          .filter((c: CarryInput) => c.taskIds.length > 0 || c.blockIds.length > 0)
      : [];
    // Tasks the user chose to hand to an agent instead of carrying.
    const delegateInputs: DelegateInput[] = Array.isArray(body?.delegate)
      ? body.delegate.filter(
          (d: unknown): d is DelegateInput =>
            !!d &&
            typeof d === 'object' &&
            typeof (d as DelegateInput).gid === 'string' &&
            typeof (d as DelegateInput).integrationId === 'string'
        )
      : [];
    // "Prioritise tomorrow" victims: displace each so its tomorrow slot frees up
    // for the prioritised block (which comes through as a normal move).
    const displaceInputs: DisplaceInput[] = Array.isArray(body?.displace)
      ? body.displace
          .filter(
            (d: unknown): d is { googleEventId: string } =>
              !!d && typeof d === 'object' && typeof (d as { googleEventId?: unknown }).googleEventId === 'string'
          )
          .map(
            (d: {
              googleEventId: string;
              googleIntegrationId?: unknown;
              taskIds?: unknown;
              mode?: unknown;
              durationMinutes?: unknown;
              priorityDurationMinutes?: unknown;
            }) => ({
              googleEventId: d.googleEventId,
              googleIntegrationId: typeof d.googleIntegrationId === 'string' ? d.googleIntegrationId : undefined,
              taskIds: Array.isArray(d.taskIds)
                ? d.taskIds.filter((t: unknown): t is string => typeof t === 'string')
                : [],
              mode: d.mode === 'leave' ? 'leave' : ('defer' as 'defer' | 'leave'),
              durationMinutes: typeof d.durationMinutes === 'number' ? d.durationMinutes : undefined,
              priorityDurationMinutes:
                typeof d.priorityDurationMinutes === 'number' ? d.priorityDurationMinutes : undefined,
            })
          )
      : [];
    // Unplaceable blocks the user chose to delete outright: remove the calendar
    // block, clear its local records, and delete each backing Asana task.
    const dropInputs: DropInput[] = Array.isArray(body?.drop)
      ? body.drop
          .filter(
            (d: unknown): d is { googleEventId: string } =>
              !!d && typeof d === 'object' && typeof (d as { googleEventId?: unknown }).googleEventId === 'string'
          )
          .map((d: { googleEventId: string; googleIntegrationId?: unknown; taskIds?: unknown }) => ({
            googleEventId: d.googleEventId,
            googleIntegrationId: typeof d.googleIntegrationId === 'string' ? d.googleIntegrationId : undefined,
            taskIds: Array.isArray(d.taskIds)
              ? d.taskIds.filter((t: unknown): t is string => typeof t === 'string')
              : [],
          }))
      : [];
    // Stale prep blocks the user dismissed: the prep record is deleted (its past
    // meeting is over, so there is nothing left to prepare for).
    const dismissEventIds: string[] = Array.isArray(body?.dismiss)
      ? body.dismiss.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    // Missing-ritual additions the user accepted: each creates a fresh ritual
    // event (routed to the ritual calendar, opaque) + record.
    const additions: ProposedBlock[] = Array.isArray(body?.additions)
      ? body.additions.filter((a: unknown): a is ProposedBlock => !!a && typeof a === 'object')
      : [];
    // Task-backfill blocks the user accepted: each creates a task/reserved/grouped
    // calendar event + scheduling records, exactly like the weekly-plan confirm.
    const backfill: ProposedBlock[] = Array.isArray(body?.backfill)
      ? body.backfill.filter((b: unknown): b is ProposedBlock => !!b && typeof b === 'object')
      : [];
    // Legacy single-task deep-work blocks to CONVERT in place to generic "Deep
    // work" containers: retitle + re-describe the event and turn the stored record
    // into container membership. The slot never changes.
    const conversionInputs: ConversionInput[] = Array.isArray(body?.conversions)
      ? body.conversions
          .filter(
            (c: unknown): c is Record<string, unknown> =>
              !!c && typeof c === 'object' && typeof (c as { googleEventId?: unknown }).googleEventId === 'string'
          )
          .map((c: Record<string, unknown>) => ({
            googleEventId: c.googleEventId as string,
            googleIntegrationId: typeof c.googleIntegrationId === 'string' ? c.googleIntegrationId : undefined,
            category: typeof c.category === 'string' ? c.category : 'Writing/Deep Work',
            date: typeof c.date === 'string' ? c.date : '',
            start: typeof c.start === 'string' ? c.start : '',
            durationMinutes: typeof c.durationMinutes === 'number' ? c.durationMinutes : 0,
            tasks: Array.isArray(c.tasks)
              ? (c.tasks as unknown[])
                  .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
                  .map(t => ({
                    gid: typeof t.gid === 'string' ? t.gid : undefined,
                    adhocId: typeof t.adhocId === 'string' ? t.adhocId : undefined,
                    title: typeof t.title === 'string' ? t.title : 'Deep work task',
                    integrationId: typeof t.integrationId === 'string' ? t.integrationId : undefined,
                  }))
              : [],
          }))
          .filter((c: ConversionInput) => c.date && c.start && c.durationMinutes > 0)
      : [];
    // Conflicted break blocks the user accepted deleting: the calendar event AND
    // its ritual record are removed (a break has no fixed home to move to).
    const deletions: Array<{ googleEventId: string; googleIntegrationId?: string }> = Array.isArray(
      body?.deletions
    )
      ? body.deletions.filter(
          (d: unknown): d is { googleEventId: string; googleIntegrationId?: string } =>
            !!d && typeof d === 'object' && typeof (d as { googleEventId?: unknown }).googleEventId === 'string'
        )
      : [];
    // Blocks the user marked STARTED (worked on, not finished): recorded as a
    // 'started' outcome for the week. They stay not-done everywhere else, and
    // their calendar event is never touched — that time really was spent.
    // Each entry is either a bare event id (whole block started) or
    // { googleEventId, taskIds } naming the members actually worked on — so a
    // grouped block never records 'started' for tasks left untouched.
    const startedEntries: Array<{ googleEventId: string; taskIds?: string[] }> = Array.isArray(
      body?.started
    )
      ? body.started
          .map((entry: unknown) => {
            if (typeof entry === 'string') return { googleEventId: entry };
            if (!entry || typeof entry !== 'object') return null;
            const e = entry as { googleEventId?: unknown; taskIds?: unknown };
            if (typeof e.googleEventId !== 'string') return null;
            const taskIds = Array.isArray(e.taskIds)
              ? e.taskIds.filter((id: unknown): id is string => typeof id === 'string')
              : undefined;
            return {
              googleEventId: e.googleEventId,
              ...(taskIds && taskIds.length > 0 ? { taskIds } : {}),
            };
          })
          .filter((e: { googleEventId: string } | null): e is { googleEventId: string; taskIds?: string[] } => !!e)
      : [];
    // "Didn't do" answers: delete the block's own event and, optionally, put what
    // actually happened in the slot instead.
    const replacementInputs: ReplacementInput[] = Array.isArray(body?.replacements)
      ? body.replacements
          .filter(
            (r: unknown): r is Record<string, unknown> =>
              !!r &&
              typeof r === 'object' &&
              typeof (r as { googleEventId?: unknown }).googleEventId === 'string'
          )
          .map((r: Record<string, unknown>) => ({
            googleEventId: r.googleEventId as string,
            googleIntegrationId:
              typeof r.googleIntegrationId === 'string' ? r.googleIntegrationId : undefined,
            date: typeof r.date === 'string' ? r.date : '',
            start: typeof r.start === 'string' ? r.start : '',
            durationMinutes: typeof r.durationMinutes === 'number' ? r.durationMinutes : 0,
            mode: r.mode === 'work' || r.mode === 'personal' ? r.mode : ('none' as const),
            title: typeof r.title === 'string' ? r.title : undefined,
            workspaceId: typeof r.workspaceId === 'string' ? r.workspaceId : undefined,
          }))
      : [];

    // Bare calendar events (source 'calendar') the user left not-done: adopt each
    // into a local record so the replan step can re-slot it. Trust only the shape;
    // the record type is chosen server-side from whether a gid is present.
    const adoptInputs: ReviewAdoptInput[] = Array.isArray(body?.adopt)
      ? body.adopt.filter(
          (a: unknown): a is ReviewAdoptInput =>
            !!a &&
            typeof a === 'object' &&
            typeof (a as { googleEventId?: unknown }).googleEventId === 'string' &&
            typeof (a as { title?: unknown }).title === 'string' &&
            typeof (a as { date?: unknown }).date === 'string' &&
            typeof (a as { start?: unknown }).start === 'string' &&
            typeof (a as { durationMinutes?: unknown }).durationMinutes === 'number'
        )
      : [];
    if (
      moves.length === 0 &&
      doneEventIds.length === 0 &&
      startedEntries.length === 0 &&
      replacementInputs.length === 0 &&
      notDoneEventIds.length === 0 &&
      asanaCompletions.length === 0 &&
      adoptInputs.length === 0 &&
      deferInputs.length === 0 &&
      leaveEventIds.length === 0 &&
      carryInputs.length === 0 &&
      delegateInputs.length === 0 &&
      displaceInputs.length === 0 &&
      dropInputs.length === 0 &&
      dismissEventIds.length === 0 &&
      additions.length === 0 &&
      backfill.length === 0 &&
      deletions.length === 0 &&
      conversionInputs.length === 0
    ) {
      return NextResponse.json(
        { error: 'No moves, done markings, dismissals, additions or deletions provided' },
        { status: 400 }
      );
    }

    const enabledGoogle = await getEnabledGoogleIntegrations();
    const defaultGoogle = enabledGoogle[0] ?? null;

    // Resolve + validate each Google integration at most once per request.
    const googleCache = new Map<
      string,
      { integration: GoogleIntegration; credentials: GoogleCalendarCredentials }
    >();
    const resolveGoogle = async (id?: string) => {
      const target = id ? await getGoogleIntegrationById(id) : defaultGoogle;
      const integration = target && target.credentials ? target : defaultGoogle;
      if (!integration || !integration.credentials) return null;
      const cached = googleCache.get(integration.id);
      if (cached) return cached;
      const credentials = await ensureValidCredentials(integration);
      const resolved = { integration, credentials };
      googleCache.set(integration.id, resolved);
      return resolved;
    };

    // Resolve + refresh an Asana integration's access token at most once per
    // request. Shared by the Asana-completion and delete-task paths.
    const asanaCredCache = new Map<string, string>(); // integrationId -> accessToken
    const resolveAsanaToken = async (integrationId: string): Promise<string> => {
      const cached = asanaCredCache.get(integrationId);
      if (cached) return cached;
      const integration = (await getIntegrationById(integrationId)) as AsanaIntegration | null;
      if (!integration || integration.type !== 'asana' || !integration.credentials) {
        throw new Error('Asana integration not found or not authenticated');
      }
      let credentials = integration.credentials;
      if (credentials.expiresAt && Date.now() >= credentials.expiresAt - 60000) {
        credentials = await refreshAsanaToken(
          credentials.refreshToken!,
          integration.clientId,
          integration.clientSecret
        );
        await updateIntegration(integration.id, { credentials });
      }
      asanaCredCache.set(integrationId, credentials.accessToken);
      return credentials.accessToken;
    };

    const [adHocTasks, prepBlocks, ritualBlocks, scheduledAsana] = await Promise.all([
      getAdHocTasks(),
      getPrepBlocks(),
      getRitualBlocks(),
      getScheduledAsanaTasks(),
    ]);
    const results: MoveResult[] = [];

    // --- Durable weekly record -------------------------------------------
    // Outcomes collected as we go and written once at the end, EACH keyed to the
    // week its block belongs to. Most actions resolve current-week work, so they
    // default to `weekStartStr`; but a block reviewed now can belong to a PRIOR
    // week (a Friday block picked up on the following Monday), and its outcome
    // must land in THAT week's record — where the task already has a
    // high-water-mark entry from when it was scheduled — not this week's.
    const weekStartStr = format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd');
    const weeklyOutcomes: Array<{
      taskId: string;
      outcome: WeeklyTaskOutcomeKind;
      weekStart: string;
    }> = [];
    const recordOutcome = (
      taskId: string,
      outcome: WeeklyTaskOutcomeKind,
      weekStart: string = weekStartStr
    ) => weeklyOutcomes.push({ taskId, outcome, weekStart });
    // The Monday of the week a block's scheduled date falls in (same date the
    // analyze route used to place it). Current-week dates resolve to weekStartStr,
    // so the common case stays byte-identical.
    const weekStartForDate = (date?: string): string =>
      date
        ? format(startOfWeek(new Date(`${date}T00:00:00`), { weekStartsOn: 1 }), 'yyyy-MM-dd')
        : weekStartStr;
    // The task ids behind a block's Google event, from whichever store owns it.
    const taskIdsForEvent = (googleEventId: string): string[] => {
      const asana = scheduledAsana
        .filter(s => s.googleEventId === googleEventId)
        .map(s => s.asanaTaskId);
      if (asana.length > 0) return asana;
      const adhoc = adHocTasks.find(t => t.googleEventId === googleEventId);
      return adhoc ? [adhoc.id] : [];
    };
    // The week a block's Google event belongs to, resolved from whichever store
    // owns it — so a prior-week block's outcome is attributed to its own week.
    const weekStartForEvent = (googleEventId: string): string => {
      const asana = scheduledAsana.find(s => s.googleEventId === googleEventId);
      if (asana) return weekStartForDate(asana.scheduledDate);
      const adhoc = adHocTasks.find(t => t.googleEventId === googleEventId);
      if (adhoc) return weekStartForDate(adhoc.dueDate);
      const prep = prepBlocks.find(p => p.googleEventId === googleEventId);
      if (prep) return weekStartForDate(prep.date);
      return weekStartStr;
    };
    // The week an Asana task's scheduled block belongs to (for Complete-in-Asana,
    // which is keyed by gid rather than event id).
    const weekStartForTask = (taskId: string): string => {
      const asana = scheduledAsana.find(s => s.asanaTaskId === taskId);
      if (asana) return weekStartForDate(asana.scheduledDate);
      return weekStartStr;
    };

    // --- Done markings (no calendar mutation; the event stays as history) ---
    const doneResults: DoneResult[] = [];
    for (const googleEventId of doneEventIds) {
      try {
        const prep = prepBlocks.find(p => p.googleEventId === googleEventId);
        if (prep) {
          await updatePrepBlock(prep.id, { done: true });
        } else {
          const adhoc = adHocTasks.find(t => t.googleEventId === googleEventId);
          if (adhoc) {
            await updateAdHocTask(adhoc.id, { completed: true });
            // A completed task is no longer carried over.
            await removeCarryOvers([adhoc.id]);
          } else {
            // Asana-backed (or unknown): a planning-only override.
            await setBlockDoneOverride(googleEventId);
          }
        }
        const wk = weekStartForEvent(googleEventId);
        for (const taskId of taskIdsForEvent(googleEventId)) {
          recordOutcome(taskId, 'done', wk);
        }
        doneResults.push({ googleEventId, success: true });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to mark done ${googleEventId}:`, err);
        doneResults.push({
          googleEventId,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to mark done',
        });
      }
    }

    // --- Not-done markings: reverse of done[] so the block re-reads as missed ---
    const notDoneResults: DoneResult[] = [];
    for (const googleEventId of notDoneEventIds) {
      try {
        const prep = prepBlocks.find(p => p.googleEventId === googleEventId);
        if (prep) {
          await updatePrepBlock(prep.id, { done: false });
        } else {
          const adhoc = adHocTasks.find(t => t.googleEventId === googleEventId);
          if (adhoc) {
            await updateAdHocTask(adhoc.id, { completed: false });
          }
        }
        // Always clear any planning override (Asana-backed or otherwise).
        await removeBlockDoneOverride(googleEventId);
        // Reversing a done marking puts the task back in the week's outstanding
        // set — it stays in the denominator either way.
        const wk = weekStartForEvent(googleEventId);
        for (const taskId of taskIdsForEvent(googleEventId)) {
          recordOutcome(taskId, 'scheduled', wk);
        }
        notDoneResults.push({ googleEventId, success: true });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to mark not done ${googleEventId}:`, err);
        notDoneResults.push({
          googleEventId,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to mark not done',
        });
      }
    }

    // --- Adoptions: turn a not-done bare calendar event into a local record ---
    // Asana-matched → a scheduled Asana block (the replan re-slots it and later
    // completion flows through Asana); otherwise → an ad-hoc task. Both link the
    // existing Google event, so nothing new lands on the calendar.
    const adoptResults: AdoptResult[] = [];
    for (const a of adoptInputs) {
      try {
        if (a.gid && a.integrationId) {
          await scheduleAsanaTask(
            a.gid,
            a.integrationId,
            a.date,
            a.start,
            a.durationMinutes,
            a.googleEventId,
            a.googleIntegrationId,
            a.title
          );
        } else {
          await addAdHocTask({
            title: a.title,
            completed: false,
            priority: 'medium',
            taskType: 'focus',
            dueDate: a.date,
            dueTime: a.start,
            duration: a.durationMinutes,
            googleEventId: a.googleEventId,
            googleIntegrationId: a.googleIntegrationId,
          });
        }
        adoptResults.push({ googleEventId: a.googleEventId, success: true });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to adopt calendar event ${a.googleEventId}:`, err);
        adoptResults.push({
          googleEventId: a.googleEventId,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to adopt calendar event',
        });
      }
    }

    // --- Asana completions: mark selected tasks complete in Asana directly ---
    const asanaResults: AsanaCompleteResult[] = [];
    for (const { gid, integrationId } of asanaCompletions) {
      try {
        const accessToken = await resolveAsanaToken(integrationId);
        await completeTask(accessToken, gid, true);
        // A completed task is no longer carried over.
        await removeCarryOvers([gid]);
        recordOutcome(gid, 'done', weekStartForTask(gid));
        asanaResults.push({ gid, success: true });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to complete Asana task ${gid}:`, err);
        asanaResults.push({
          gid,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to complete Asana task',
        });
      }
    }

    // --- Deferrals: park each block's tasks until next Monday (server-computed,
    // never trusting a client date) and clear its planning override ---
    const deferResults: DeferResult[] = [];
    if (deferInputs.length > 0) {
      const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
      const until = format(addDays(weekStart, 7), 'yyyy-MM-dd'); // next Monday
      for (const d of deferInputs) {
        try {
          if (d.taskIds.length > 0) {
            await setTaskDeferrals(d.taskIds.map(taskId => ({ taskId, until })));
          }
          if (d.googleEventId) await removeBlockDoneOverride(d.googleEventId);
          for (const taskId of d.taskIds) recordOutcome(taskId, 'carried');
          deferResults.push({ taskIds: d.taskIds, googleEventId: d.googleEventId, success: true });
        } catch (err) {
          console.error(`[Replan Confirm] Failed to defer ${d.googleEventId ?? d.taskIds.join(',')}:`, err);
          deferResults.push({
            taskIds: d.taskIds,
            googleEventId: d.googleEventId,
            success: false,
            error: err instanceof Error ? err.message : 'Failed to defer',
          });
        }
      }
    }

    // --- Leave unscheduled: clear the override AND record the outcome --------
    // The block leaves the calendar but its tasks stay open, so they must show
    // up in the dashboard's "Left unscheduled" list rather than silently
    // vanishing. Recorded as 'unscheduled' (counted alongside 'carried' in the
    // week's denominator — see summariseWeek).
    for (const googleEventId of leaveEventIds) {
      try {
        await removeBlockDoneOverride(googleEventId);
        for (const taskId of taskIdsForEvent(googleEventId)) {
          recordOutcome(taskId, 'unscheduled');
        }
        deferResults.push({ taskIds: [], googleEventId, success: true });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to leave-unscheduled ${googleEventId}:`, err);
        deferResults.push({
          taskIds: [],
          googleEventId,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to leave unscheduled',
        });
      }
    }

    // --- Started: worked on but not finished --------------------------------
    // Recorded for the week's stats only. No calendar change, no done marking:
    // the task still needs finishing, so replan and carry-over still offer it.
    for (const entry of startedEntries) {
      // Named tasks only when the review named them; otherwise every task on the
      // block (a single-task block, or an older caller that sent a bare id).
      const taskIds = entry.taskIds ?? taskIdsForEvent(entry.googleEventId);
      const wk = weekStartForEvent(entry.googleEventId);
      for (const taskId of taskIds) {
        recordOutcome(taskId, 'started', wk);
      }
    }

    // --- "Didn't do": rewrite the calendar to match reality -----------------
    // The planned block didn't happen, so its event goes (leaving it would inflate
    // the time analysis with work that never took place). Deletion is scoped to
    // the reviewed block's OWN event id — never a sweep. A failure is reported and
    // the rest of the apply continues.
    const replacementResults: ReplacementResult[] = [];
    for (const r of replacementInputs) {
      let deleted = false;
      try {
        const record = scheduledAsana.find(s => s.googleEventId === r.googleEventId);
        const adhoc = adHocTasks.find(t => t.googleEventId === r.googleEventId);
        const prep = prepBlocks.find(p => p.googleEventId === r.googleEventId);
        const ritual = ritualBlocks.find(x => x.googleEventId === r.googleEventId);
        const resolved = await resolveGoogle(
          r.googleIntegrationId ??
            record?.googleIntegrationId ??
            adhoc?.googleIntegrationId ??
            prep?.googleIntegrationId ??
            ritual?.googleIntegrationId
        );
        if (resolved) {
          try {
            await deleteCalendarEvent(
              resolved.credentials,
              resolved.integration.clientId,
              resolved.integration.clientSecret,
              r.googleEventId
            );
            deleted = true;
          } catch (err) {
            if (isEventGoneError(err)) deleted = true;
            else throw err;
          }
        }

        // Clear the local records that pointed at the deleted event, so the task
        // returns to the pool rather than looking scheduled at a time that no
        // longer exists.
        for (const s of scheduledAsana.filter(x => x.googleEventId === r.googleEventId)) {
          await unscheduleAsanaTask(s.id);
        }
        if (adhoc) {
          await updateAdHocTask(adhoc.id, {
            googleEventId: undefined,
            dueDate: undefined,
            dueTime: undefined,
          });
        }
        if (prep) await deletePrepBlock(prep.id);
        if (ritual) await deleteRitualBlock(ritual.id);
        await removeGoogleEventAttribution(r.googleEventId);
        await removeBlockDoneOverride(r.googleEventId);

        // Nothing to put in the slot: deletion was the whole answer.
        if (r.mode === 'none' || !r.date || !r.start || r.durationMinutes <= 0) {
          replacementResults.push({ googleEventId: r.googleEventId, deleted, success: true });
          continue;
        }

        // Create what actually happened, in the same slot. Work goes to the
        // workspace's own calendar where one is configured (so the normal
        // calendar-as-source-of-truth attribution picks it up); personal time goes
        // to the default calendar and is pinned to "counts toward nothing".
        const workspaceGoogleId =
          r.mode === 'work' && r.workspaceId
            ? (await getIntegrationById(r.workspaceId).catch(() => null) as AsanaIntegration | null)
                ?.eventGoogleIntegrationId
            : undefined;
        const target = await resolveGoogle(workspaceGoogleId);
        if (!target) {
          replacementResults.push({
            googleEventId: r.googleEventId,
            deleted,
            success: false,
            error: 'No authenticated Google integration to create the replacement on',
          });
          continue;
        }
        const title =
          r.title?.trim() || (r.mode === 'personal' ? 'Personal time' : 'Worked on something else');
        const { start, end } = toStartEnd(r.date, r.start, r.durationMinutes);
        const created = await createCalendarEvent(
          target.credentials,
          target.integration.clientId,
          target.integration.clientSecret,
          title,
          start,
          end,
          r.mode === 'personal' ? 'Personal time (not counted as work)' : 'Worked on this instead',
          'default',
          'primary',
          { transparency: 'opaque' }
        );

        if (r.mode === 'work' && r.workspaceId) {
          // Belt and braces: even if the replacement landed on a calendar that
          // maps to no workspace, this pins it to the chosen one.
          await setGoogleEventAttribution(created.id, target.integration.id, r.workspaceId);
        } else if (r.mode === 'personal') {
          // Pin it to "counts toward nothing", whatever calendar it landed on.
          await addEventAttributionRule({
            id: `personal-${created.id}`,
            recurringEventId: created.id,
            asanaIntegrationId: 'none',
            note: 'Personal time recorded from a daily review',
            createdAt: new Date().toISOString(),
          });
        }

        replacementResults.push({
          googleEventId: r.googleEventId,
          deleted,
          replacementEventId: created.id,
          success: true,
        });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to rewrite slot for ${r.googleEventId}:`, err);
        replacementResults.push({
          googleEventId: r.googleEventId,
          deleted,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to rewrite the slot',
        });
      }
    }

    // --- Carry-overs: park each chosen task for next week's plan -------------
    // A carried task gets BOTH a carry-over marker (so the plan-week wizard
    // badges and floats it next week) and the normal deferral to next Monday (so
    // a weekend replan leaves it alone). "Back to backlog" (quiet) writes no
    // marker and drops any stale one, leaving the task in the ordinary pool.
    const carryResults: CarryResult[] = [];
    if (carryInputs.length > 0) {
      const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
      const fromWeek = format(weekStart, 'yyyy-MM-dd'); // this week's Monday
      const until = format(addDays(weekStart, 7), 'yyyy-MM-dd'); // next Monday
      for (const c of carryInputs) {
        try {
          // Rituals and meeting prep are never carried: next week's plan creates
          // rituals fresh, and a prep block belongs to its own meeting.
          const isRitual = c.blockIds.some(id => ritualBlocks.some(r => r.googleEventId === id));
          const isPrep = c.blockIds.some(id => prepBlocks.some(p => p.googleEventId === id));
          if (isRitual || isPrep) {
            carryResults.push({
              blockId: c.blockId,
              taskIds: c.taskIds,
              success: false,
              error: `${isRitual ? 'Ritual' : 'Meeting prep'} blocks cannot be carried over`,
            });
            continue;
          }
          // A ritual the user created by hand with no emoji can have been adopted
          // as an ad-hoc task by an earlier review; never carry one over, whatever
          // the client sends.
          const taskIds = c.taskIds.filter(id => {
            const adhoc = adHocTasks.find(t => t.id === id);
            return !(adhoc && isRitualLikeTitle(adhoc.title));
          });
          if (taskIds.length > 0) {
            if (c.quiet) {
              await removeCarryOvers(taskIds);
            } else {
              // setCarryOvers increments the streak, so a task carried three
              // weeks running reports carries: 3 rather than starting over.
              await setCarryOvers(
                taskIds.map(taskId => ({ taskId, fromWeek, ...(c.mustDo ? { mustDo: true } : {}) }))
              );
              await setTaskDeferrals(taskIds.map(taskId => ({ taskId, until })));
            }
          }
          // Carried (or dropped back to the backlog) — either way it did NOT get
          // done this week, and it stays in the week's denominator.
          for (const taskId of taskIds) recordOutcome(taskId, 'carried');
          // Clear the planning override on every block behind the card.
          for (const id of c.blockIds) await removeBlockDoneOverride(id);
          carryResults.push({ blockId: c.blockId, taskIds, success: true });
        } catch (err) {
          console.error(`[Replan Confirm] Failed to carry over ${c.blockIds.join(',') || c.taskIds.join(',')}:`, err);
          carryResults.push({
            blockId: c.blockId,
            taskIds: c.taskIds,
            success: false,
            error: err instanceof Error ? err.message : 'Failed to carry over',
          });
        }
      }
    }

    // --- Delegations: hand a carried task to an agent instead ---------------
    // Uses the same queue the dashboard's Delegate action writes to. No
    // carry-over marker is written and no deferral is set: the task is not
    // waiting for next-week Dave, so it should not badge or park.
    const delegateResults: DelegateResult[] = [];
    for (const d of delegateInputs) {
      try {
        await upsertDelegationEntry(d.gid, d.integrationId, {
          title: d.title ?? 'Delegated task',
          brief: d.brief?.trim() || d.title || 'Complete this task.',
          mode: 'background',
          state: 'queued',
        });
        // A delegated task is no longer carrying.
        await removeCarryOvers([d.gid]);
        if (d.blockId) await removeBlockDoneOverride(d.blockId);
        delegateResults.push({ gid: d.gid, success: true });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to delegate ${d.gid}:`, err);
        delegateResults.push({
          gid: d.gid,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to delegate',
        });
      }
    }

    // --- Dismissals: delete the (stale) prep record and clean up after it ---
    for (const googleEventId of dismissEventIds) {
      try {
        const prep = prepBlocks.find(p => p.googleEventId === googleEventId);
        if (prep) await deletePrepBlock(prep.id);
        await removeGoogleEventAttribution(googleEventId);
        await removeBlockDoneOverride(googleEventId);
        doneResults.push({ googleEventId, success: true });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to dismiss ${googleEventId}:`, err);
        doneResults.push({
          googleEventId,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to dismiss',
        });
      }
    }

    // --- Deletions: remove conflicted break events + their tracking records ---
    for (const del of deletions) {
      try {
        const record = ritualBlocks.find(r => r.googleEventId === del.googleEventId);
        const resolved = await resolveGoogle(del.googleIntegrationId ?? record?.googleIntegrationId);
        if (resolved) {
          try {
            await deleteCalendarEvent(
              resolved.credentials,
              resolved.integration.clientId,
              resolved.integration.clientSecret,
              del.googleEventId
            );
          } catch (err) {
            // Already-gone events still count as a successful deletion.
            if (!isEventGoneError(err)) throw err;
          }
        }
        if (record) await deleteRitualBlock(record.id);
        await removeGoogleEventAttribution(del.googleEventId);
        await removeBlockDoneOverride(del.googleEventId);
        doneResults.push({ googleEventId: del.googleEventId, success: true });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to delete break ${del.googleEventId}:`, err);
        doneResults.push({
          googleEventId: del.googleEventId,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to delete break',
        });
      }
    }

    // --- Conversions: retitle a legacy single-task deep-work block into a
    // generic "Deep work" container and record its shared membership -----------
    // The slot never changes. The event's title becomes "✍️ Deep work" and its
    // description lists the week's deep-work tasks; each week deep-work task that
    // isn't already scheduled against this event gets a scheduled record here, so
    // the block reads as a container in the next analyze (and stops being offered
    // for conversion). Ad-hoc members keep their own home; only Asana-backed
    // members join the container's records.
    const conversionResults: MoveResult[] = [];
    for (const conv of conversionInputs) {
      try {
        const resolved = await resolveGoogle(conv.googleIntegrationId);
        const block: ProposedBlock = {
          id: conv.googleEventId,
          category: conv.category,
          tasks: conv.tasks,
          date: conv.date,
          start: conv.start,
          durationMinutes: conv.durationMinutes,
          reason: "Deep work leads the morning — the week's deep-work tasks.",
        };
        if (resolved) {
          const { start, end } = toStartEnd(conv.date, conv.start, conv.durationMinutes);
          await updateCalendarEvent(
            resolved.credentials,
            resolved.integration.clientId,
            resolved.integration.clientSecret,
            conv.googleEventId,
            start,
            end,
            eventTitleForBlock(block),
            blockEventDescription(block),
            'primary',
            colorIdForBlock(block)
          );
        }
        const already = new Set(
          scheduledAsana.filter(s => s.googleEventId === conv.googleEventId).map(s => s.asanaTaskId)
        );
        for (const t of conv.tasks) {
          if (t.gid && !already.has(t.gid)) {
            await scheduleAsanaTask(
              t.gid,
              t.integrationId,
              conv.date,
              conv.start,
              conv.durationMinutes,
              conv.googleEventId,
              resolved?.integration.id ?? conv.googleIntegrationId,
              t.title
            );
          }
        }
        conversionResults.push({ googleEventId: conv.googleEventId, success: true });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to convert deep-work block ${conv.googleEventId}:`, err);
        conversionResults.push({
          googleEventId: conv.googleEventId,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to convert deep-work block',
        });
      }
    }

    // --- Displacements: free tomorrow's slot for a "prioritise tomorrow" block ---
    // Delete the victim's calendar event, clear its stored schedule (so the slot
    // is genuinely free and the task returns to the pool), then either defer its
    // tasks to next week or leave them to be re-planned. The prioritised block
    // itself arrives as a normal move into the freed slot (handled below).
    const displaceResults: DisplaceResult[] = [];
    if (displaceInputs.length > 0) {
      const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
      const until = format(addDays(weekStart, 7), 'yyyy-MM-dd'); // next Monday
      for (const d of displaceInputs) {
        try {
          // Reject a victim too short to hold the prioritised block, so the freed
          // slot can never overlap what follows it. The paired move is skipped
          // client-side; this is the server-side backstop.
          if (
            d.durationMinutes !== undefined &&
            d.priorityDurationMinutes !== undefined &&
            d.durationMinutes < d.priorityDurationMinutes
          ) {
            displaceResults.push({
              googleEventId: d.googleEventId,
              success: false,
              error: `Block is too short (${d.durationMinutes}m) to hold the prioritised ${d.priorityDurationMinutes}m block`,
            });
            continue;
          }
          const resolved = await resolveGoogle(d.googleIntegrationId);
          if (resolved) {
            try {
              await deleteCalendarEvent(
                resolved.credentials,
                resolved.integration.clientId,
                resolved.integration.clientSecret,
                d.googleEventId
              );
            } catch (err) {
              // Already-gone events still count as a successful displacement.
              if (!isEventGoneError(err)) throw err;
            }
          }
          // Clear the stored schedule for whichever store owns the victim event.
          for (const s of scheduledAsana.filter(s => s.googleEventId === d.googleEventId)) {
            await unscheduleAsanaTask(s.id);
          }
          const adhoc = adHocTasks.find(t => t.googleEventId === d.googleEventId);
          if (adhoc) {
            await updateAdHocTask(adhoc.id, { googleEventId: undefined, dueDate: undefined, dueTime: undefined });
          }
          // Defer the freed work to next week, or leave it in the pool ('leave').
          // Either way it did not get a slot this week: 'defer' records it as
          // carried, 'leave' as unscheduled (both count as planned-but-not-done).
          if (d.mode === 'defer' && d.taskIds.length > 0) {
            await setTaskDeferrals(d.taskIds.map(taskId => ({ taskId, until })));
            for (const taskId of d.taskIds) recordOutcome(taskId, 'carried');
          } else if (d.mode === 'leave') {
            for (const taskId of d.taskIds) recordOutcome(taskId, 'unscheduled');
          }
          await removeBlockDoneOverride(d.googleEventId);
          await removeGoogleEventAttribution(d.googleEventId);
          displaceResults.push({ googleEventId: d.googleEventId, success: true });
        } catch (err) {
          console.error(`[Replan Confirm] Failed to displace ${d.googleEventId}:`, err);
          displaceResults.push({
            googleEventId: d.googleEventId,
            success: false,
            error: err instanceof Error ? err.message : 'Failed to displace block',
          });
        }
      }
    }

    // --- Drops: delete the block AND its backing task(s) outright -------------
    // "I'm not doing this at all." Mirrors the replacements cleanup — delete the
    // calendar event, clear every local record pointing at it — then goes one
    // further and deletes the underlying Asana task (ad-hoc tasks, which have no
    // gid, are simply removed locally). Every failure is caught per row so the
    // rest of the apply continues. The abandoned tasks stay in the week's
    // denominator as 'dropped'.
    const dropResults: DropResult[] = [];
    for (const d of dropInputs) {
      try {
        const record = scheduledAsana.find(s => s.googleEventId === d.googleEventId);
        const adhoc = adHocTasks.find(t => t.googleEventId === d.googleEventId);
        const prep = prepBlocks.find(p => p.googleEventId === d.googleEventId);
        const ritual = ritualBlocks.find(x => x.googleEventId === d.googleEventId);
        const resolved = await resolveGoogle(
          d.googleIntegrationId ??
            record?.googleIntegrationId ??
            adhoc?.googleIntegrationId ??
            prep?.googleIntegrationId ??
            ritual?.googleIntegrationId
        );
        if (resolved) {
          try {
            await deleteCalendarEvent(
              resolved.credentials,
              resolved.integration.clientId,
              resolved.integration.clientSecret,
              d.googleEventId
            );
          } catch (err) {
            // Already-gone events still count as a successful drop.
            if (!isEventGoneError(err)) throw err;
          }
        }

        // Delete each backing Asana task before clearing its local schedule (the
        // scheduled record carries the gid + integration id needed to reach it).
        for (const s of scheduledAsana.filter(x => x.googleEventId === d.googleEventId && x.integrationId)) {
          const accessToken = await resolveAsanaToken(s.integrationId!);
          await deleteTask(accessToken, s.asanaTaskId);
        }

        // Clear every local record that pointed at the deleted block. An ad-hoc
        // task has no gid, so removing its record here is the whole story.
        for (const s of scheduledAsana.filter(x => x.googleEventId === d.googleEventId)) {
          await unscheduleAsanaTask(s.id);
        }
        if (adhoc) await deleteAdHocTask(adhoc.id);
        if (prep) await deletePrepBlock(prep.id);
        if (ritual) await deleteRitualBlock(ritual.id);
        await removeGoogleEventAttribution(d.googleEventId);
        await removeBlockDoneOverride(d.googleEventId);
        await removeCarryOvers(d.taskIds);

        for (const taskId of d.taskIds) recordOutcome(taskId, 'dropped');
        dropResults.push({ googleEventId: d.googleEventId, success: true });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to drop ${d.googleEventId}:`, err);
        dropResults.push({
          googleEventId: d.googleEventId,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to drop task',
        });
      }
    }

    for (const move of moves) {
      try {
        const resolved = await resolveGoogle(move.googleIntegrationId);
        if (!resolved) {
          results.push({
            googleEventId: move.googleEventId,
            success: false,
            error: 'No authenticated Google integration available',
          });
          continue;
        }

        const { start, end } = toStartEnd(move.date, move.start, move.durationMinutes);
        // Patch only the time — passing no title/description/color keeps the
        // event's existing content and transparency intact.
        await updateCalendarEvent(
          resolved.credentials,
          resolved.integration.clientId,
          resolved.integration.clientSecret,
          move.googleEventId,
          start,
          end
        );

        // Update the stored schedule for whichever store owns this event.
        const updated = await updateScheduledAsanaTasksByGoogleEvent(move.googleEventId, {
          scheduledDate: move.date,
          scheduledTime: move.start,
        });
        if (updated === 0) {
          const adhoc = adHocTasks.find(t => t.googleEventId === move.googleEventId);
          if (adhoc) {
            await updateAdHocTask(adhoc.id, { dueDate: move.date, dueTime: move.start });
          } else {
            const prep = prepBlocks.find(p => p.googleEventId === move.googleEventId);
            if (prep) {
              await updatePrepBlock(prep.id, {
                date: move.date,
                start: move.start,
                durationMinutes: move.durationMinutes,
              });
            }
          }
        }

        results.push({ googleEventId: move.googleEventId, success: true });
      } catch (err) {
        console.error(`[Replan Confirm] Failed to move event ${move.googleEventId}:`, err);
        results.push({
          googleEventId: move.googleEventId,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to move event',
        });
      }
    }

    // --- Additions: create each missing ritual / early-next-week prep block ---
    // Ritual events route to the configured ritual Google integration (else the
    // default), opaque, via the shared creator reused by the weekly-plan confirm.
    // Prep additions (kind 'prep') create a "📖 Prep:" event on the default
    // calendar and record a PrepBlock linked to the (next-week) meeting, exactly
    // like the weekly-plan confirm — so the morning-briefing still finds it.
    const additionResults: AdditionResult[] = [];
    if (additions.length > 0) {
      const config = await getWorkflowConfig();
      for (const block of additions) {
        try {
          if (block.kind === 'prep') {
            const resolved = await resolveGoogle();
            if (!resolved) {
              additionResults.push({
                id: block.id,
                success: false,
                error: 'No authenticated Google integration available',
              });
              continue;
            }
            const { start, end } = toStartEnd(block.date, block.start, block.durationMinutes);
            const event = await createCalendarEvent(
              resolved.credentials,
              resolved.integration.clientId,
              resolved.integration.clientSecret,
              eventTitleForBlock(block),
              start,
              end,
              blockEventDescription(block),
              'default',
              'primary',
              { transparency: 'opaque', colorId: colorIdForBlock(block) }
            );
            if (block.meeting) {
              await addPrepBlock({
                googleEventId: event.id,
                googleIntegrationId: resolved.integration.id,
                meetingEventId: block.meeting.eventId,
                meetingTitle: block.meeting.title,
                meetingStart: block.meeting.meetingStart,
                date: block.date,
                start: block.start,
                durationMinutes: block.durationMinutes,
              });
            }
            additionResults.push({ id: block.id, success: true, googleEventId: event.id });
            continue;
          }
          const ritualId = ritualIntegrationIdForBlock(config.scheduling, block.title ?? '');
          const resolved = await resolveGoogle(ritualId);
          if (!resolved) {
            additionResults.push({
              id: block.id,
              success: false,
              error: 'No authenticated Google integration available',
            });
            continue;
          }
          const googleEventId = await createRitualEvent(resolved, block);
          additionResults.push({ id: block.id, success: true, googleEventId });
        } catch (err) {
          console.error(`[Replan Confirm] Failed to add block ${block.id}:`, err);
          additionResults.push({
            id: block.id,
            success: false,
            error: err instanceof Error ? err.message : 'Failed to add block',
          });
        }
      }
    }

    // --- Task backfill: create each accepted task block into the freed/free time ---
    // Same creation + record-storage the weekly-plan confirm uses (shared helper),
    // so a backfilled task block is indistinguishable from one the full plan placed:
    // a Google event, its scheduled-Asana / ad-hoc records, event attribution and
    // the durable weekly-task record.
    const backfillResults: BackfillResult[] = [];
    if (backfill.length > 0) {
      const asanaRouting = buildAsanaEventRouting(await getEnabledAsanaIntegrations());
      const backfillScheduledTaskIds: string[] = [];
      const backfillWeeklyTasks: Parameters<typeof recordWeeklyTasks>[1] = [];
      for (const block of backfill) {
        try {
          const route = routeTaskBlock(block, asanaRouting, defaultGoogle?.id ?? '');
          const resolved = await resolveGoogle(route.googleIntegrationId);
          if (!resolved) {
            backfillResults.push({
              id: block.id,
              success: false,
              error: 'No authenticated Google integration available',
            });
            continue;
          }
          const applied = await createTaskBlockEvent({
            proposal: block,
            credentials: resolved.credentials,
            googleIntegration: resolved.integration,
            transparency: route.transparency,
          });
          backfillScheduledTaskIds.push(...applied.scheduledTaskIds);
          backfillWeeklyTasks.push(...applied.weeklyTasks);
          backfillResults.push({ id: block.id, success: true, googleEventId: applied.eventId });
        } catch (err) {
          console.error(`[Replan Confirm] Failed to backfill block ${block.id}:`, err);
          backfillResults.push({
            id: block.id,
            success: false,
            error: err instanceof Error ? err.message : 'Failed to create backfill block',
          });
        }
      }
      // Durable weekly record for the tasks this backfill scheduled into the week,
      // and stamp their carry-over markers, exactly as the weekly-plan confirm does.
      if (backfillWeeklyTasks.length > 0) {
        try {
          await recordWeeklyTasks(weekStartStr, backfillWeeklyTasks);
        } catch (err) {
          console.error('[Replan Confirm] Failed to record backfill weekly stats:', err);
        }
      }
      if (backfillScheduledTaskIds.length > 0) {
        try {
          await markCarryOversScheduled(backfillScheduledTaskIds, weekStartStr);
        } catch (err) {
          console.error('[Replan Confirm] Failed to stamp backfill carry-over markers:', err);
        }
      }
    }

    // One write PER WEEK for the outcomes this confirm settled. Almost always a
    // single group (the current week) — a byte-identical single write to
    // weekStartStr — but a review that crossed the week boundary also writes the
    // prior week's group to its own record, where the task's high-water-mark
    // entry already lives. Unknown task ids are ignored by the store, so nothing
    // that was never planned can appear.
    if (weeklyOutcomes.length > 0) {
      const byWeek = new Map<string, Array<{ taskId: string; outcome: WeeklyTaskOutcomeKind }>>();
      for (const { taskId, outcome, weekStart } of weeklyOutcomes) {
        const list = byWeek.get(weekStart) ?? [];
        list.push({ taskId, outcome });
        byWeek.set(weekStart, list);
      }
      for (const [wk, outs] of byWeek) {
        try {
          await setWeeklyTaskOutcomes(wk, outs);
        } catch (err) {
          console.error(`[Replan Confirm] Failed to record weekly outcomes for ${wk}:`, err);
        }
      }
    }

    return NextResponse.json({ results, doneResults, notDoneResults, asanaResults, adoptResults, deferResults, carryResults, displaceResults, dropResults, additionResults, backfillResults, replacementResults, delegateResults, conversionResults });
  } catch (error) {
    console.error('Error confirming mid-week replan:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to confirm replan' },
      { status: 500 }
    );
  }
}
