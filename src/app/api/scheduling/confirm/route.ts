import { NextRequest, NextResponse } from 'next/server';
import { format, startOfWeek } from 'date-fns';

import { createCalendarEvent, ensureValidCredentials } from '@/lib/google-calendar';
import { fetchWeekEvents } from '@/lib/scheduling/gather';
import { eventsToBusyIntervals } from '@/lib/scheduling/free-busy';
import {
  getEnabledAsanaIntegrations,
  getEnabledGoogleIntegrations,
  getGoogleIntegrationById,
} from '@/lib/integration-storage';
import {
  scheduleAsanaTask,
  updateAdHocTask,
  setGoogleEventAttribution,
  addPrepBlock,
  markCarryOversScheduled,
  recordWeeklyTasks,
  type WeeklyTaskInput,
} from '@/lib/user-data-storage';
import { getWorkflowConfig } from '@/lib/workflow-config-storage';
import type { GoogleCalendarCredentials, GoogleIntegration } from '@/types';
import type { ProposedBlock } from '@/lib/scheduling/types';
import { blockEventDescription, colorIdForBlock, eventTitleForBlock } from '@/lib/scheduling/event-titles';
import { createRitualEvent } from '@/lib/scheduling/ritual-events';
import { ritualIntegrationIdForBlock } from '@/lib/scheduling/rituals';

// An accepted proposal is a ProposedBlock, optionally with a user-edited date /
// start time.
type AcceptedProposal = ProposedBlock;

interface ConfirmResult {
  id: string;
  success: boolean;
  googleEventId?: string;
  error?: string;
}

// Build local start/end Dates from a yyyy-MM-dd date + HH:mm start + duration.
function toStartEnd(date: string, start: string, durationMinutes: number): { start: Date; end: Date } {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = start.split(':').map(Number);
  const startDate = new Date(y, mo - 1, d, h, m, 0, 0);
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
  return { start: startDate, end: endDate };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const proposals: AcceptedProposal[] = Array.isArray(body?.proposals) ? body.proposals : [];
    if (proposals.length === 0) {
      return NextResponse.json({ error: 'No proposals provided' }, { status: 400 });
    }

    // Pre-flight conflict check: proposals can be minutes-to-hours stale (the
    // wizard may sit open while other runs / manual edits change the calendar).
    // Re-fetch the live week and refuse any proposal whose slot now overlaps a
    // real busy event, instead of blindly double-booking it. (Declined and
    // all-day events don't count as busy, matching the planner.)
    // The week being planned: taken from the caller when supplied (the wizard
    // can be planning NEXT week), else derived from the earliest proposal so
    // older callers behave exactly as before.
    const weekStartParam = typeof body?.weekStart === 'string' ? body.weekStart : undefined;
    const earliestDate = weekStartParam ?? proposals.map(p => p.date).sort()[0];
    const [ey, em, ed] = earliestDate.split('-').map(Number);
    const liveWeekStart = startOfWeek(new Date(ey, em - 1, ed), { weekStartsOn: 1 });
    const { events: liveEvents } = await fetchWeekEvents(liveWeekStart);
    const liveBusy = eventsToBusyIntervals(liveEvents).map(i => ({
      start: i.start.getTime(),
      end: i.end.getTime(),
    }));
    const slotTaken = (p: AcceptedProposal): boolean => {
      const { start, end } = toStartEnd(p.date, p.start, p.durationMinutes);
      const s = start.getTime();
      const e = end.getTime();
      return liveBusy.some(b => b.start < e && b.end > s);
    };

    // Pick the DEFAULT Google integration to create events on. The app's default
    // event-creation calendar is the (first) enabled Google integration's
    // primary calendar; the drag-drop flow uses the single integration directly
    // and only prompts when several exist. For batch auto-scheduling we take the
    // first enabled integration unless the caller specifies one.
    let defaultGoogle: GoogleIntegration | null = null;
    if (typeof body?.googleIntegrationId === 'string') {
      defaultGoogle = await getGoogleIntegrationById(body.googleIntegrationId);
    }
    if (!defaultGoogle) {
      const enabled = await getEnabledGoogleIntegrations();
      defaultGoogle = enabled[0] ?? null;
    }
    if (!defaultGoogle || !defaultGoogle.credentials) {
      return NextResponse.json(
        { error: 'No authenticated Google integration available to create events' },
        { status: 400 }
      );
    }

    // Per-Asana-integration event routing: a task from an Asana integration with
    // `eventGoogleIntegrationId` set has its event created on that Google
    // integration's primary calendar, with the integration's `eventTransparency`
    // (e.g. OM tasks → OM Google calendar, marked Free). Everything else uses the
    // default integration and opaque (busy) availability.
    // Ritual + break events (Lunch / Exercise / Emails / Break) go on the
    // configured per-kind ritual Google calendar (lunch+emails → OM work calendar,
    // exercise+break → personal) when set, else the default. They stay opaque/busy
    // so the blocks reserve time.
    const config = await getWorkflowConfig();

    const asanaIntegrations = await getEnabledAsanaIntegrations();
    const asanaRouting = new Map(
      asanaIntegrations
        .filter(a => a.eventGoogleIntegrationId)
        .map(a => [
          a.id,
          {
            googleIntegrationId: a.eventGoogleIntegrationId!,
            transparency: a.eventTransparency ?? 'opaque',
          },
        ])
    );

    // Cache resolved Google integration + validated credentials, keyed by id, so
    // each integration is loaded and token-refreshed at most once per request.
    const googleCache = new Map<
      string,
      { integration: GoogleIntegration; credentials: GoogleCalendarCredentials }
    >();
    const resolveGoogle = async (
      id: string
    ): Promise<{ integration: GoogleIntegration; credentials: GoogleCalendarCredentials } | null> => {
      const cached = googleCache.get(id);
      if (cached) return cached;
      const integration =
        id === defaultGoogle!.id ? defaultGoogle! : await getGoogleIntegrationById(id);
      if (!integration || !integration.credentials) return null;
      const credentials = await ensureValidCredentials(integration);
      const resolved = { integration, credentials };
      googleCache.set(id, resolved);
      return resolved;
    };
    // Seed the cache with the (already validated) default.
    googleCache.set(defaultGoogle.id, {
      integration: defaultGoogle,
      credentials: await ensureValidCredentials(defaultGoogle),
    });

    // Decide which Google integration + transparency a proposal's event should
    // use. A block routes to a special calendar only when EVERY task on it comes
    // from the SAME Asana integration that declares an event-routing override;
    // prep/reserved/ad-hoc/mixed blocks fall back to the default (opaque).
    const routeProposal = (
      proposal: ProposedBlock
    ): { googleIntegrationId: string; transparency: 'opaque' | 'transparent' } => {
      const fallback = { googleIntegrationId: defaultGoogle!.id, transparency: 'opaque' as const };
      if (proposal.kind === 'ritual' || proposal.kind === 'break') {
        const ritualId = ritualIntegrationIdForBlock(
          config.scheduling,
          proposal.title ?? ''
        );
        return ritualId
          ? { googleIntegrationId: ritualId, transparency: 'opaque' as const }
          : fallback;
      }
      if (proposal.kind === 'prep') return fallback;
      const tasks = Array.isArray(proposal.tasks)
        ? proposal.tasks
        : proposal.task
          ? [proposal.task]
          : [];
      if (tasks.length === 0) return fallback;
      const first = tasks[0].integrationId;
      if (!first || !tasks.every(t => t.integrationId === first)) return fallback;
      const routing = asanaRouting.get(first);
      if (!routing) return fallback;
      return { googleIntegrationId: routing.googleIntegrationId, transparency: routing.transparency };
    };

    const results: ConfirmResult[] = [];
    // Task ids (gid / ad-hoc id) actually placed on the calendar by this confirm.
    // A carried-over task that now has a slot is no longer carried over, so its
    // marker is dropped once the run finishes.
    const scheduledTaskIds: string[] = [];
    // The same tasks with their category, for the durable weekly record: this is
    // the moment a task enters the week's plan, and therefore the denominator of
    // the week's progress (see WeeklyStatsRecord).
    const weeklyTasks: WeeklyTaskInput[] = [];

    for (const proposal of proposals) {
      try {
        if (slotTaken(proposal)) {
          results.push({
            id: proposal.id,
            success: false,
            error: 'Slot is no longer free — the calendar changed since this was proposed. Re-run planning.',
          });
          continue;
        }
        const { start, end } = toStartEnd(proposal.date, proposal.start, proposal.durationMinutes);
        const isPrep = proposal.kind === 'prep';
        // Break blocks are created + tracked exactly like rituals (opaque event +
        // ritualBlocks record), so they route through the shared ritual creator.
        const isRitual = proposal.kind === 'ritual' || proposal.kind === 'break';
        // A grouped block (e.g. Engagement / Outreach) carries a `tasks` list
        // instead of a single `task`: one container event titled with the
        // category, its agenda listed in the description.
        const isGrouped = Array.isArray(proposal.tasks);
        const isReserved = !isPrep && !isRitual && !isGrouped && !proposal.task;
        // All app-created events are titled via the shared module (emoji prefix
        // by category / prep / ritual, one source of truth).
        const title = eventTitleForBlock(proposal);

        // Descriptions are built centrally: grouped blocks list their assigned
        // tasks as a bulleted agenda beneath the reason, and every Asana-backed
        // task (single or grouped) gets a direct link to its Asana task;
        // everything else just uses the reason.
        const description = blockEventDescription(proposal);

        // Route this proposal to its target Google integration + availability.
        const route = routeProposal(proposal);
        const resolved = (await resolveGoogle(route.googleIntegrationId)) ?? googleCache.get(defaultGoogle.id)!;
        const googleIntegration = resolved.integration;

        // Rituals go through the shared creator (opaque event + ritual record),
        // reused by the replan confirm route so the two never drift.
        if (isRitual) {
          const eventId = await createRitualEvent(resolved, proposal);
          results.push({ id: proposal.id, success: true, googleEventId: eventId });
          continue;
        }

        const event = await createCalendarEvent(
          resolved.credentials,
          googleIntegration.clientId,
          googleIntegration.clientSecret,
          title,
          start,
          end,
          description,
          'default',
          'primary',
          { transparency: route.transparency, colorId: colorIdForBlock(proposal) }
        );

        if (isPrep) {
          // Record the prep block so the planner can dedupe against it, reconcile
          // it if the user deletes the event, and reason about it during replan.
          if (proposal.meeting) {
            await addPrepBlock({
              googleEventId: event.id,
              googleIntegrationId: googleIntegration.id,
              meetingEventId: proposal.meeting.eventId,
              meetingTitle: proposal.meeting.title,
              meetingStart: proposal.meeting.meetingStart,
              date: proposal.date,
              start: proposal.start,
              durationMinutes: proposal.durationMinutes,
            });
          }
        } else if (isGrouped) {
          // Record each listed task as scheduled to the shared container event, so
          // they show as scheduled and drop out of future candidate pools. The
          // block's time is split evenly across its members for estimate-vs-actual
          // evidence (a 90-minute block of 3 tasks → 30m each).
          const groupedMinutes = Math.round(
            proposal.durationMinutes / Math.max(1, proposal.tasks!.length)
          );
          for (const t of proposal.tasks!) {
            if (t.gid || t.adhocId) {
              const taskId = (t.gid ?? t.adhocId)!;
              scheduledTaskIds.push(taskId);
              weeklyTasks.push({
                taskId,
                category: proposal.category,
                title: t.title,
                scheduledMinutes: groupedMinutes,
                ...(t.integrationId ? { integrationId: t.integrationId } : {}),
              });
            }
            if (t.gid) {
              await scheduleAsanaTask(
                t.gid,
                t.integrationId,
                proposal.date,
                proposal.start,
                proposal.durationMinutes,
                event.id,
                googleIntegration.id,
                t.title
              );
              if (t.integrationId) {
                await setGoogleEventAttribution(event.id, googleIntegration.id, t.integrationId);
              }
            } else if (t.adhocId) {
              await updateAdHocTask(t.adhocId, {
                dueDate: proposal.date,
                dueTime: proposal.start,
                duration: proposal.durationMinutes,
                googleEventId: event.id,
                googleIntegrationId: googleIntegration.id,
              });
            }
          }
        } else if (!isReserved && proposal.task) {
          const { gid, adhocId, integrationId } = proposal.task;
          if (gid || adhocId) {
            const taskId = (gid ?? adhocId)!;
            scheduledTaskIds.push(taskId);
            weeklyTasks.push({
              taskId,
              category: proposal.category,
              title: proposal.task.title,
              scheduledMinutes: proposal.durationMinutes,
              ...(integrationId ? { integrationId } : {}),
            });
          }
          if (gid) {
            await scheduleAsanaTask(
              gid,
              integrationId,
              proposal.date,
              proposal.start,
              proposal.durationMinutes,
              event.id,
              googleIntegration.id,
              proposal.task.title
            );
            // Attribute the Google event to the task's Asana workspace so
            // client-time tracking counts it.
            if (integrationId) {
              await setGoogleEventAttribution(event.id, googleIntegration.id, integrationId);
            }
          } else if (adhocId) {
            await updateAdHocTask(adhocId, {
              dueDate: proposal.date,
              dueTime: proposal.start,
              duration: proposal.durationMinutes,
              googleEventId: event.id,
              googleIntegrationId: googleIntegration.id,
            });
          }
        }

        results.push({ id: proposal.id, success: true, googleEventId: event.id });
      } catch (err) {
        console.error(`[Scheduling Confirm] Failed to apply proposal ${proposal.id}:`, err);
        results.push({
          id: proposal.id,
          success: false,
          error: err instanceof Error ? err.message : 'Failed to create event',
        });
      }
    }

    // Durable weekly record: everything this confirm scheduled into the week.
    // Additive, so re-running a plan never lowers the week's task count.
    if (weeklyTasks.length > 0) {
      try {
        await recordWeeklyTasks(format(liveWeekStart, 'yyyy-MM-dd'), weeklyTasks);
      } catch (err) {
        console.error('[Scheduling Confirm] Failed to record weekly stats:', err);
      }
    }

    // Scheduled work KEEPS its carry-over marker, stamped with the week it was
    // scheduled into. Clearing it here would reset the streak on every
    // schedule → not-done → carry cycle, which is exactly the cycle worth
    // counting; completion is what removes the marker. The badge stays quiet
    // because a task scheduled into the week being planned is not a candidate in
    // that week's wizard. Best-effort: never fail an otherwise good confirm.
    if (scheduledTaskIds.length > 0) {
      try {
        await markCarryOversScheduled(scheduledTaskIds, format(liveWeekStart, 'yyyy-MM-dd'));
      } catch (err) {
        console.error('[Scheduling Confirm] Failed to stamp carry-over markers:', err);
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error('Error confirming weekly plan:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to confirm plan' },
      { status: 500 }
    );
  }
}
