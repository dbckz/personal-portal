// Shared week-context gathering for the "Plan my week" endpoints.
//
// Every scheduling endpoint (propose, candidates, priorities match, prep
// candidates) needs the same picture of the week: the workflow config, the
// user's incomplete tasks, the calendar's busy time and full events, and what is
// already scheduled. gatherWeekContext assembles it once — a single Google fetch
// serves both prep classification and free/busy — so the routes stay thin.

import { addDays, format, startOfWeek } from 'date-fns';

import { getWorkflowConfig, type WorkflowConfig } from '@/lib/workflow-config-storage';
import {
  getScheduledAsanaTasks,
  getAdHocTasks,
  getCustomTaskTypes,
  getAllTaskMetadata,
  getPrepBlocks,
  getRitualBlocks,
  unscheduleAsanaTask,
  updateAdHocTask,
  deletePrepBlock,
  deleteRitualBlock,
  removeGoogleEventAttribution,
  getTaskDeferrals,
  removeTaskDeferrals,
  getCarryOvers,
  removeCarryOvers,
  type PrepBlock,
  type RitualBlock,
} from '@/lib/user-data-storage';
import { DEFAULT_ROLLOVER_HOUR, logicalTodayDate } from '@/lib/date-utils';
import { partitionDeferrals } from '@/lib/scheduling/deferrals';
import { partitionCarryOvers } from '@/lib/scheduling/carry-overs';
import { selectStaleRecords, type ReconcileRecord } from '@/lib/scheduling/reconcile';
import { getEnabledAsanaIntegrations, getEnabledGoogleIntegrations, updateIntegration } from '@/lib/integration-storage';
import { getMyTasks, refreshAsanaToken } from '@/lib/asana';
import { getLocalTaskTypes, overlayLocalType } from '@/lib/local-task-types';
import { ensureValidCredentials, getCalendarEvents } from '@/lib/google-calendar';
import { classifyBlockCategory, type CapacityQuota } from '@/lib/capacity';
import { eventsToBusyIntervals, outOfOfficeDates } from '@/lib/scheduling/free-busy';
import { resolveWorkingWindow } from '@/lib/scheduling/engine';
import type { BusyInterval, CandidateTask } from '@/lib/scheduling/types';
import {
  AdHocTask,
  AsanaIntegration,
  AsanaTask,
  BUILT_IN_TASK_TYPE_LABELS,
  BuiltInTaskType,
  CalendarEvent,
  CustomTaskType,
  GoogleIntegration,
  ScheduledAsanaTask,
  isCustomTaskType,
  getCustomTaskTypeId,
} from '@/types';

// A raw Asana candidate: the task plus its integration and "Type" value.
export interface AsanaCandidate {
  task: AsanaTask;
  integrationId: string;
  typeValue: string | null;
}

export interface WeekContext {
  config: WorkflowConfig;
  weekStart: Date;
  weekStartStr: string;
  weekEndStr: string;
  now: Date;
  candidateTasks: CandidateTask[]; // unscheduled Asana + ad-hoc tasks
  asanaCandidates: AsanaCandidate[]; // raw Asana tasks (for priorities matching)
  // gid -> live task name, including tasks COMPLETED this week (completed-inclusive
  // like typeByGid), so a scheduled block's completed member still resolves its title.
  asanaNameByGid: Map<string, string>;
  busyIntervals: BusyInterval[];
  weekEvents: CalendarEvent[]; // full events (for the prep step + "Prep:" dedupe)
  // Meetings on the FIRST working day of NEXT week (e.g. next Mon). These fall
  // OUTSIDE this week, so they never enter busyIntervals, quota counting or
  // reconcile — they exist solely so the prep step can offer a prep block THIS
  // week for a meeting that lands early next week (a Monday-morning meeting can
  // only realistically be prepped the week before). Candidacy (before noon on
  // that day) is decided in resolvePrepCandidates against nextWeekFirstWorkingDay.
  nextWeekEarlyEvents: CalendarEvent[];
  // The first working day of NEXT week (yyyy-MM-dd), or null when next week has no
  // working days. resolvePrepCandidates uses it to gate next-week prep candidacy.
  nextWeekFirstWorkingDay: string | null;
  existingScheduledCounts: Record<string, number>;
  existingCategoryCountsByDate: Record<string, Record<string, number>>;
  // Dates (yyyy-MM-dd) the user is out of office this week (a full-day OOO event
  // covering the working window). Threaded into the schedulers so these days are
  // dropped from working days and weekly quotas scale down.
  outOfOfficeDates: Set<string>;
  quotas: CapacityQuota[];
  // How many still-active deferred tasks fall in each quota category (for the
  // wizard's "N deferred to next week" note). Keyed by category.
  deferredCountsByCategory: Record<string, number>;
}

// Resolve the type signals for an ad-hoc task's taskType (id + human label).
// Mirrors the dashboard capacity route so classification stays consistent.
export function adHocTypeSignals(taskType: string, customTypes: CustomTaskType[]): string[] {
  const signals = [taskType];
  if (isCustomTaskType(taskType as `custom:${string}`)) {
    const id = getCustomTaskTypeId(taskType as `custom:${string}`);
    const custom = customTypes.find(c => c.id === id);
    if (custom) signals.push(custom.label);
  } else {
    const label = BUILT_IN_TASK_TYPE_LABELS[taskType as BuiltInTaskType];
    if (label) signals.push(label);
  }
  return signals;
}

// Fetch the user's Asana tasks across enabled integrations. Returns two things:
//   * candidates — the INCOMPLETE tasks (tagged with integration id + "Type"
//     custom-field value, sorted by due date), the pool the wizard schedules
//     from. This must stay incomplete-only: downstream (e.g. replan) treats an
//     absent gid as "completed in Asana".
//   * typeByGid — a gid -> "Type" value map that ALSO covers tasks COMPLETED
//     since `completedSince` (week start). The existing-block count needs a
//     completed member's type: it otherwise drops out of the live fetch, and a
//     grouped block whose classifying member is done would lose its category and
//     go uncounted (mirrors buildAsanaTypeMap in the dashboard capacity route).
//   * nameByGid — a gid -> task name map with the SAME completed-inclusive reach,
//     so a scheduled block's member that was completed this week still resolves
//     its real title (rather than falling back to a generic placeholder) even
//     though it's absent from the incomplete-only candidates.
async function fetchAsanaData(completedSince: string): Promise<{
  candidates: AsanaCandidate[];
  typeByGid: Map<string, string | null>;
  nameByGid: Map<string, string>;
}> {
  const candidates: AsanaCandidate[] = [];
  const typeByGid = new Map<string, string | null>();
  const nameByGid = new Map<string, string>();
  // Locally-stored Types overlay for tasks whose workspace has no writable Asana
  // Type field (e.g. DBC), so those tasks classify into the capacity categories.
  const localTypes = await getLocalTaskTypes();
  try {
    const integrations = await getEnabledAsanaIntegrations();
    await Promise.all(
      integrations.map(async (integration: AsanaIntegration) => {
        if (!integration.credentials || !integration.workspaceId) return;
        let credentials = integration.credentials;
        if (credentials.expiresAt && Date.now() >= credentials.expiresAt - 60000) {
          credentials = await refreshAsanaToken(
            credentials.refreshToken!,
            integration.clientId,
            integration.clientSecret
          );
          await updateIntegration(integration.id, { credentials });
        }
        const tasks = await getMyTasks(
          credentials.accessToken,
          integration.workspaceId,
          completedSince
        );
        for (const task of tasks) {
          const customFields = overlayLocalType(task.gid, task.customFields, localTypes);
          const typeField = customFields?.find(cf => cf.name.toLowerCase() === 'type');
          const typeValue = typeField?.displayValue ?? null;
          typeByGid.set(task.gid, typeValue);
          if (task.name) nameByGid.set(task.gid, task.name);
          if (!task.completed) {
            candidates.push({ task, integrationId: integration.id, typeValue });
          }
        }
      })
    );
  } catch (error) {
    console.error('[Scheduling] Failed to fetch Asana tasks:', error);
  }
  // Match getIncompleteTasks' ordering: by due date ascending, undated last.
  candidates.sort((a, b) => {
    if (!a.task.dueOn && !b.task.dueOn) return 0;
    if (!a.task.dueOn) return 1;
    if (!b.task.dueOn) return -1;
    return a.task.dueOn.localeCompare(b.task.dueOn);
  });
  return { candidates, typeByGid, nameByGid };
}

const DEFAULT_CALENDAR = { id: 'primary', backgroundColor: '#4285f4', summary: 'Primary', selected: true as const };

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// The first `count` working days of the week AFTER `weekStart`, derived from the
// configured working-day names (so "first two working days of next week" honours
// a Mon–Fri or a custom schedule rather than hardcoding Mon/Tue).
export function firstWorkingDaysOfNextWeek(
  scheduling: WorkflowConfig['scheduling'],
  weekStart: Date,
  count: number
): Date[] {
  const names = new Set(
    (scheduling?.workingDays ?? []).map(d => d.charAt(0).toUpperCase() + d.slice(1).toLowerCase())
  );
  const nextWeekStart = addDays(weekStart, 7);
  const days: Date[] = [];
  for (let i = 0; i < 7 && days.length < count; i++) {
    const day = addDays(nextWeekStart, i);
    if (names.has(WEEKDAY_NAMES[day.getDay()])) days.push(day);
  }
  return days;
}

// Fetch all timed/all-day events across enabled Google calendars for the given
// days, tagging each with the integration it came from. Returns the events plus
// the set of integration ids whose fetch FULLY succeeded — every day/calendar
// sub-fetch returned without error. Reconcile only trusts "the event is gone"
// for integrations in that set, so a swallowed partial failure never triggers a
// mass purge.
export async function fetchEventsForDays(
  integrations: GoogleIntegration[],
  days: Date[]
): Promise<{ events: CalendarEvent[]; fetchedIntegrationIds: Set<string> }> {
  const allEvents: CalendarEvent[] = [];
  const fetchedIntegrationIds = new Set<string>();

  await Promise.all(
    integrations.map(async (integration: GoogleIntegration) => {
      if (!integration.credentials) return;
      let fullySucceeded = true;
      try {
        const credentials = await ensureValidCredentials(integration);
        const selected = integration.calendars?.filter(c => c.selected);
        const calendars = selected?.length ? selected : [DEFAULT_CALENDAR];
        for (const day of days) {
          for (const cal of calendars) {
            try {
              const events = await getCalendarEvents(
                credentials,
                integration.clientId,
                integration.clientSecret,
                day,
                cal.id
              );
              // Tag each event with its integration so reconcile can match a
              // stored record's googleIntegrationId to the calendar it lives on.
              for (const e of events) allEvents.push({ ...e, integrationId: integration.id });
            } catch (err) {
              fullySucceeded = false;
              console.error(`[Scheduling] calendar ${cal.id} fetch failed:`, err);
            }
          }
        }
      } catch (err) {
        fullySucceeded = false;
        console.error(`[Scheduling] integration ${integration.name} failed:`, err);
      }
      if (fullySucceeded) fetchedIntegrationIds.add(integration.id);
    })
  );

  return { events: allEvents, fetchedIntegrationIds };
}

// One fetch serves both prep classification (needs titles/recurrence/attendees)
// and free/busy (derived via eventsToBusyIntervals) for the seven days of the week.
export async function fetchWeekEvents(
  weekStart: Date
): Promise<{ events: CalendarEvent[]; fetchedIntegrationIds: Set<string> }> {
  const integrations = await getEnabledGoogleIntegrations();
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  return fetchEventsForDays(integrations, days);
}

// Fetch meetings on the FIRST working day of NEXT week. Used only to offer prep
// blocks this week; these events never enter this week's busy set, quotas or
// reconcile. Which of them actually warrant prep (a before-noon meeting on that
// day) is decided in resolvePrepCandidates.
export async function fetchNextWeekEarlyEvents(
  weekStart: Date,
  scheduling: WorkflowConfig['scheduling']
): Promise<CalendarEvent[]> {
  const [firstDay] = firstWorkingDaysOfNextWeek(scheduling, weekStart, 1);
  if (!firstDay) return [];
  const integrations = await getEnabledGoogleIntegrations();
  const { events } = await fetchEventsForDays(integrations, [firstDay]);
  return events;
}

// Purge stored records whose backing Google event has been deleted off the
// calendar, then return the in-week arrays with those purges applied so the rest
// of gather sees reality: a deleted Asana block's gid drops back into
// candidates, a deleted ad-hoc block becomes unscheduled, a deleted prep block
// is removed and re-proposable. Only records on fully-fetched integrations are
// touched (see selectStaleRecords).
async function reconcileDeletedEvents(
  scheduledAsana: ScheduledAsanaTask[],
  adHocTasks: AdHocTask[],
  prepBlocks: PrepBlock[],
  ritualBlocks: RitualBlock[],
  weekEvents: CalendarEvent[],
  fetchedIntegrationIds: Set<string>,
  weekStartStr: string,
  weekEndStr: string
): Promise<{ scheduledAsana: ScheduledAsanaTask[]; adHocTasks: AdHocTask[] }> {
  const presentEventIds = new Set(weekEvents.map(e => e.id));

  const records: ReconcileRecord[] = [];
  for (const s of scheduledAsana) {
    if (!s.googleEventId) continue;
    records.push({
      kind: 'asana',
      id: s.id,
      googleEventId: s.googleEventId,
      googleIntegrationId: s.googleIntegrationId,
      date: s.scheduledDate,
    });
  }
  for (const t of adHocTasks) {
    if (!t.googleEventId) continue;
    records.push({
      kind: 'adhoc',
      id: t.id,
      googleEventId: t.googleEventId,
      googleIntegrationId: t.googleIntegrationId,
      date: t.dueDate,
    });
  }
  for (const p of prepBlocks) {
    records.push({
      kind: 'prep',
      id: p.id,
      googleEventId: p.googleEventId,
      googleIntegrationId: p.googleIntegrationId,
      date: p.date,
    });
  }
  for (const r of ritualBlocks) {
    records.push({
      kind: 'ritual',
      id: r.id,
      googleEventId: r.googleEventId,
      googleIntegrationId: r.googleIntegrationId,
      date: r.date,
    });
  }

  const stale = selectStaleRecords({
    records,
    presentEventIds,
    fetchedIntegrationIds,
    weekStartStr,
    weekEndStr,
  });
  if (stale.length === 0) return { scheduledAsana, adHocTasks };

  const staleAsanaIds = new Set<string>();
  const staleAdhocIds = new Set<string>();
  const purgedEventIds = new Set<string>();
  for (const r of stale) {
    purgedEventIds.add(r.googleEventId);
    if (r.kind === 'asana') {
      await unscheduleAsanaTask(r.id);
      staleAsanaIds.add(r.id);
    } else if (r.kind === 'adhoc') {
      await updateAdHocTask(r.id, { googleEventId: undefined, dueDate: undefined, dueTime: undefined });
      staleAdhocIds.add(r.id);
    } else if (r.kind === 'ritual') {
      await deleteRitualBlock(r.id);
    } else {
      await deletePrepBlock(r.id);
    }
  }
  // Any time-tracking attribution for a purged event is now meaningless.
  for (const eventId of purgedEventIds) await removeGoogleEventAttribution(eventId);

  console.log(
    `[Scheduling] Reconcile purged ${stale.length} record(s) for deleted calendar events: ` +
      stale.map(r => `${r.kind}:${r.id}→${r.googleEventId}`).join(', ')
  );

  return {
    scheduledAsana: scheduledAsana.filter(s => !staleAsanaIds.has(s.id)),
    adHocTasks: adHocTasks.map(t =>
      staleAdhocIds.has(t.id)
        ? { ...t, googleEventId: undefined, dueDate: undefined, dueTime: undefined }
        : t
    ),
  };
}

export async function gatherWeekContext(weekStartParam?: string): Promise<WeekContext> {
  const now = new Date();
  // Read config first so the default week honours the day-rollover hour: in the
  // small hours before rollover, "this week" is still the logical-today week
  // (e.g. Monday 00:30 with a 04:00 rollover still targets the week containing
  // the preceding Sunday). `now` itself stays the real clock time — it's used
  // downstream to tell which blocks have actually ended.
  const config = await getWorkflowConfig();
  const rolloverHour = config.scheduling?.dayRolloverHour ?? DEFAULT_ROLLOVER_HOUR;
  const weekStart = weekStartParam
    ? startOfWeek(new Date(`${weekStartParam}T00:00:00`), { weekStartsOn: 1 })
    : startOfWeek(logicalTodayDate(now, rolloverHour), { weekStartsOn: 1 });
  const weekStartStr = format(weekStart, 'yyyy-MM-dd');
  const weekEndStr = format(addDays(weekStart, 6), 'yyyy-MM-dd');
  const [nextWeekFirstDay] = firstWorkingDaysOfNextWeek(config.scheduling, weekStart, 1);
  const nextWeekFirstWorkingDay = nextWeekFirstDay ? format(nextWeekFirstDay, 'yyyy-MM-dd') : null;

  const [scheduledAsanaRaw, adHocTasksRaw, customTypes, metadata, asanaData, fetched, nextWeekEarlyEvents, prepBlocksRaw, ritualBlocksRaw, deferralsRaw, carryOversRaw] =
    await Promise.all([
      getScheduledAsanaTasks(),
      getAdHocTasks(),
      getCustomTaskTypes(),
      getAllTaskMetadata(),
      // Use the local week-start instant, not the local date stamped as UTC: in
      // BST `${weekStartStr}T00:00:00.000Z` would exclude tasks completed in the
      // local 00:00–01:00 Monday window.
      fetchAsanaData(weekStart.toISOString()),
      fetchWeekEvents(weekStart),
      fetchNextWeekEarlyEvents(weekStart, config.scheduling),
      getPrepBlocks(),
      getRitualBlocks(),
      getTaskDeferrals(),
      getCarryOvers(),
    ]);
  const asanaCandidates = asanaData.candidates;

  // Task deferrals: tasks parked out of the candidate pool until their resume
  // date. Prune any whose date has arrived (lazy cleanup); the rest suppress
  // their task from this week's candidates.
  const { active: activeDeferrals, expired: expiredDeferrals } = partitionDeferrals(
    deferralsRaw,
    weekEndStr
  );
  if (expiredDeferrals.length > 0) await removeTaskDeferrals(expiredDeferrals);

  // Carry-overs: tasks the user explicitly carried out of an earlier week's
  // end-of-week review. Only markers from a week BEFORE the one being planned
  // count (carrying out of this very week is not "last week's leftover"); stale
  // ones are pruned on read, like deferrals.
  const { carried, stale: staleCarryOvers } = partitionCarryOvers(carryOversRaw, weekStartStr);
  if (staleCarryOvers.length > 0) await removeCarryOvers(staleCarryOvers);

  const weekEvents = fetched.events;

  // --- Reconcile stored records with the live calendar (deleted events) ---
  // A stored record whose backing event has been deleted off the calendar must
  // not keep suppressing candidates / consuming quota. selectStaleRecords is
  // conservative: it only flags records on integrations whose fetch fully
  // succeeded (never on a failed/partial fetch), so we don't mass-purge on a
  // transient Google error.
  const { scheduledAsana, adHocTasks } = await reconcileDeletedEvents(
    scheduledAsanaRaw,
    adHocTasksRaw,
    prepBlocksRaw,
    ritualBlocksRaw,
    weekEvents,
    fetched.fetchedIntegrationIds,
    weekStartStr,
    weekEndStr
  );

  // App-created blocks (prep / ritual / task / ad-hoc) are written transparent on
  // the OM calendar but must still count as busy. Collect their live Google event
  // ids from the stored records so eventsToBusyIntervals keeps them busy even when
  // marked free (title matching is the fallback for anything not in the store).
  const appEventIds = new Set<string>();
  for (const s of scheduledAsana) if (s.googleEventId) appEventIds.add(s.googleEventId);
  for (const t of adHocTasks) if (t.googleEventId) appEventIds.add(t.googleEventId);
  for (const p of prepBlocksRaw) if (p.googleEventId) appEventIds.add(p.googleEventId);
  for (const r of ritualBlocksRaw) if (r.googleEventId) appEventIds.add(r.googleEventId);
  const busyIntervals = eventsToBusyIntervals(weekEvents, appEventIds);

  // Out-of-office days: a full-day OOO event (Google eventType 'outOfOffice', or
  // an all-day OOO-titled event) covering a working day's window removes that day
  // from scheduling entirely. Computed over this week's candidate working days
  // (before OOO exclusion) and threaded into every scheduler via WeekContext.
  // Requires working-hours config to know each day's window; absent → no OOO.
  let oooDates = new Set<string>();
  if (config.scheduling?.workingHours) {
    const { workingDays: candidateWorkingDays } = resolveWorkingWindow(config.scheduling, weekStart, now);
    oooDates = outOfOfficeDates(weekEvents, candidateWorkingDays);
  }

  const quotas: CapacityQuota[] = Object.entries(config.taskQuotas).map(([category, quota]) => ({
    category,
    weeklyCount: quota.weeklyCount,
    targetLength: quota.targetLength,
    types: config.typeMapping?.[category] ?? [],
  }));

  // --- Existing scheduled blocks this week (counts + per-date + exclusions) ---
  // Type lookup covers tasks completed this week too (see fetchAsanaData), so a
  // grouped block whose classifying member is done still resolves its type.
  const asanaTypeByGid = asanaData.typeByGid;
  const inWeek = (d?: string) => !!d && d >= weekStartStr && d <= weekEndStr;

  const existingScheduledCounts: Record<string, number> = {};
  const existingCategoryCountsByDate: Record<string, Record<string, number>> = {};
  const scheduledGids = new Set<string>();

  const bump = (category: string | null, date: string) => {
    if (!category) return;
    existingScheduledCounts[category] = (existingScheduledCounts[category] ?? 0) + 1;
    const byCat = (existingCategoryCountsByDate[date] ??= {});
    byCat[category] = (byCat[category] ?? 0) + 1;
  };

  // Candidate exclusion is per-task: every listed task drops from candidates,
  // even grouped ones, so populate the exclusion sets over ALL in-week records.
  const inWeekAsana = scheduledAsana.filter(s => inWeek(s.scheduledDate));
  for (const s of inWeekAsana) scheduledGids.add(s.asanaTaskId);

  const scheduledAdhocIds = new Set<string>();
  const inWeekAdhoc = adHocTasks.filter(t => inWeek(t.dueDate));
  for (const t of inWeekAdhoc) if (!t.completed) scheduledAdhocIds.add(t.id);

  // Count existing BLOCKS this week. Grouped blocks (e.g. Engagement / Outreach,
  // Batch) all point at the SAME Google event, and record one entry per agenda
  // task — Asana tasks AND ad-hoc tasks alike, and COMPLETED members too (a
  // completed block still consumed its slot this week). The quota counts BLOCKS,
  // so we group both record types by googleEventId across the COMBINED set and
  // UNION their type signals before classifying: records with no event id are
  // each their own block. Unioning (rather than keeping the first record's
  // signals) matters because a completed member can carry an empty signal — if it
  // sorted first, a plain first-wins dedupe left the whole grouped block
  // unclassified and uncounted, letting the wizard over-schedule the category.
  // This mirrors mergeBlocksByEventId in the dashboard capacity route.
  interface CountRecord {
    googleEventId?: string | null;
    typeSignals: string[];
    date: string;
    // Category stored at scheduling time, preferred over re-deriving from
    // typeSignals (legacy records carry none).
    category?: string;
  }
  const countRecords: CountRecord[] = [];
  for (const s of inWeekAsana) {
    const typeValue = asanaTypeByGid.get(s.asanaTaskId) ?? null;
    countRecords.push({
      googleEventId: s.googleEventId,
      typeSignals: typeValue ? [typeValue] : [],
      date: s.scheduledDate,
      ...(s.category ? { category: s.category } : {}),
    });
  }
  for (const t of inWeekAdhoc) {
    countRecords.push({
      googleEventId: t.googleEventId,
      typeSignals: adHocTypeSignals(t.taskType, customTypes),
      date: t.dueDate!,
      ...(t.category ? { category: t.category } : {}),
    });
  }

  // Collapse records sharing a Google event id into one block, unioning signals;
  // no-event records each stay their own block. Then classify and count once.
  const grouped = new Map<string, CountRecord>();
  const standalone: CountRecord[] = [];
  for (const r of countRecords) {
    if (!r.googleEventId) {
      standalone.push(r);
      continue;
    }
    const existing = grouped.get(r.googleEventId);
    // Copy signals on first insert so pushing more doesn't mutate the source record.
    if (existing) {
      existing.typeSignals.push(...r.typeSignals);
      // Any member's stored category wins over re-derivation for the whole block.
      if (!existing.category && r.category) existing.category = r.category;
    } else {
      grouped.set(r.googleEventId, { ...r, typeSignals: [...r.typeSignals] });
    }
  }
  for (const { typeSignals, date, category } of [...grouped.values(), ...standalone]) {
    bump(category ?? classifyBlockCategory(typeSignals, quotas), date);
  }

  // --- Candidate tasks (not yet scheduled this week) ---
  // Deferred tasks are held out of the pool; count them per category so the
  // wizard can note "N deferred to next week".
  const deferredCountsByCategory: Record<string, number> = {};
  const bumpDeferred = (signals: string[]) => {
    const category = classifyBlockCategory(signals, quotas);
    if (category) deferredCountsByCategory[category] = (deferredCountsByCategory[category] ?? 0) + 1;
  };

  // Carry-over flags for a candidate, omitted entirely when the task was not
  // carried (so the candidate shape is unchanged for everything else).
  const carryFlags = (taskId: string) => {
    const info = carried.get(taskId);
    if (!info) return {};
    return {
      carriedOver: true as const,
      carriedFromWeek: info.fromWeek,
      // Consecutive carries, so the wizard can escalate a task that keeps
      // sliding rather than badging every carry the same.
      carryStreak: info.carries,
      ...(info.mustDo ? { mustDo: true as const } : {}),
    };
  };

  const candidateTasks: CandidateTask[] = [];
  for (const { task, integrationId, typeValue } of asanaCandidates) {
    if (scheduledGids.has(task.gid)) continue;
    if (activeDeferrals.has(task.gid)) {
      bumpDeferred(typeValue ? [typeValue] : []);
      continue;
    }
    const meta = metadata[task.gid];
    candidateTasks.push({
      gid: task.gid,
      title: task.name,
      integrationId,
      dueDate: task.dueOn,
      typeSignals: typeValue ? [typeValue] : [],
      deadlineType: meta?.deadlineType,
      bestTime: meta?.bestTime,
      energyLevel: meta?.energyLevel,
      effortMinutes: meta?.effortMinutes,
      ...carryFlags(task.gid),
    });
  }
  for (const t of adHocTasks) {
    if (t.completed || scheduledAdhocIds.has(t.id)) continue;
    if (activeDeferrals.has(t.id)) {
      bumpDeferred(adHocTypeSignals(t.taskType, customTypes));
      continue;
    }
    candidateTasks.push({
      adhocId: t.id,
      title: t.title,
      dueDate: t.dueDate,
      typeSignals: adHocTypeSignals(t.taskType, customTypes),
      ...carryFlags(t.id),
    });
  }

  return {
    config,
    weekStart,
    weekStartStr,
    weekEndStr,
    now,
    candidateTasks,
    asanaCandidates,
    asanaNameByGid: asanaData.nameByGid,
    busyIntervals,
    weekEvents,
    nextWeekEarlyEvents,
    nextWeekFirstWorkingDay,
    existingScheduledCounts,
    existingCategoryCountsByDate,
    outOfOfficeDates: oooDates,
    quotas,
    deferredCountsByCategory,
  };
}
