import { NextRequest, NextResponse } from 'next/server';
import { format, startOfWeek } from 'date-fns';

import { completeTask, refreshAsanaToken } from '@/lib/asana';
import { getIntegrationById, updateIntegration } from '@/lib/integration-storage';
import {
  getScheduledAsanaTasks,
  getAdHocTasks,
  unscheduleAsanaTask,
  updateAdHocTask,
  removeCarryOvers,
  setWeeklyTaskOutcomes,
  getAllTaskMetadata,
  upsertTaskMetadata,
} from '@/lib/user-data-storage';
import type { AsanaIntegration, WeeklyTaskOutcomeKind } from '@/types';

// Per-member actions for the desktop batch drill-down dialog. A grouped block
// (several tasks sharing one Google event) is drilled into on the calendar, and
// each member can be ticked done or removed from the block individually — the
// review flow only ever settles a whole block at once, so this is the one place
// a single member is settled.
//
// Both actions reuse the SAME primitives the replan confirm route uses so the
// recorded state is identical to a review:
//   * done   → complete the Asana task (completeTask) / mark the ad-hoc done,
//              drop any carry-over, and record a 'done' weekly outcome — mirrors
//              the confirm route's completeAsana path.
//   * remove → take the member out of the block (unschedule the Asana record /
//              clear the ad-hoc's slot, leaving the task open and unscheduled)
//              and record an 'unscheduled' weekly outcome — mirrors the confirm
//              route's leaveUnscheduled path, but for one member rather than the
//              whole block. NOT a hard delete: the task returns to the backlog.
//   * portalDone       → flag the Asana task "done in the portal, waiting on
//              others" (metadata only, Asana untouched); the planner stops
//              scheduling it and it surfaces in the "Waiting on others" widget.
//   * reopenPortalDone → clear that flag so the task returns to scheduling.
// Both portal-done actions are Asana-only (ad-hoc tasks have no Asana side).
//
// The Google event itself is left untouched: other members keep their block, and
// an emptied block stays on the calendar for the existing delete affordance.

interface MemberInput {
  source: 'asana' | 'adhoc';
  taskId: string; // Asana gid or ad-hoc id — the weekly-stats key
  gid?: string;
  integrationId?: string;
  scheduleId?: string; // ScheduledAsanaTask.id (asana)
  adhocId?: string; // AdHocTask.id (adhoc)
  title?: string; // live title, snapshotted when flagging portal-done
}

type MemberAction = 'done' | 'remove' | 'portalDone' | 'reopenPortalDone';

// The Monday of the week a date falls in — the same key the analyze route used to
// seed the task's high-water-mark entry, so the outcome lands in that week.
function weekStartForDate(date?: string): string {
  const base = date ? new Date(`${date}T00:00:00`) : new Date();
  return format(startOfWeek(base, { weekStartsOn: 1 }), 'yyyy-MM-dd');
}

async function resolveAsanaToken(integrationId: string): Promise<string> {
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
  return credentials.accessToken;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action: unknown = body?.action;
    const member: MemberInput | undefined = body?.member;

    const VALID_ACTIONS: MemberAction[] = ['done', 'remove', 'portalDone', 'reopenPortalDone'];
    if (!VALID_ACTIONS.includes(action as MemberAction)) {
      return NextResponse.json(
        { error: "action must be 'done', 'remove', 'portalDone' or 'reopenPortalDone'" },
        { status: 400 }
      );
    }
    // Portal-done state lives on the Asana task's metadata (gid-keyed), so it is
    // meaningless for ad-hoc members, which have no Asana side.
    if (
      (action === 'portalDone' || action === 'reopenPortalDone') &&
      (member?.source !== 'asana' || !member?.gid || !member?.integrationId)
    ) {
      return NextResponse.json(
        { error: `gid and integrationId on an Asana member are required for '${action}'` },
        { status: 400 }
      );
    }
    if (!member || (member.source !== 'asana' && member.source !== 'adhoc')) {
      return NextResponse.json({ error: "member.source must be 'asana' or 'adhoc'" }, { status: 400 });
    }
    if (typeof member.taskId !== 'string' || !member.taskId) {
      return NextResponse.json({ error: 'member.taskId is required' }, { status: 400 });
    }

    const [scheduledAsana, adHocTasks] = await Promise.all([
      getScheduledAsanaTasks(),
      getAdHocTasks(),
    ]);

    // The week the member's block belongs to, so a prior-week block's outcome is
    // attributed to its own week (where the high-water-mark entry lives).
    let outcomeWeek = weekStartForDate();
    if (member.source === 'asana') {
      const record = scheduledAsana.find(
        s => s.id === member.scheduleId || s.asanaTaskId === member.gid
      );
      outcomeWeek = weekStartForDate(record?.scheduledDate);
    } else {
      const adhoc = adHocTasks.find(t => t.id === member.adhocId || t.id === member.taskId);
      outcomeWeek = weekStartForDate(adhoc?.dueDate);
    }

    let outcome: WeeklyTaskOutcomeKind;

    if (action === 'portalDone') {
      // Done in the portal only — Asana is deliberately untouched. Snapshot the
      // title so the "Waiting on others" widget can render without an Asana
      // fetch, drop any carry-over, and record a 'portalDone' outcome.
      outcome = 'portalDone';
      await upsertTaskMetadata(member.gid!, member.integrationId!, {
        portalDone: true,
        portalDoneAt: new Date().toISOString(),
        ...(member.title ? { portalDoneTitle: member.title } : {}),
      });
      await removeCarryOvers([member.taskId]);
    } else if (action === 'reopenPortalDone') {
      // Needs more work — clear the flag so the planner schedules it again.
      outcome = 'scheduled';
      await upsertTaskMetadata(member.gid!, member.integrationId!, {
        portalDone: false,
        portalDoneAt: undefined,
        portalDoneTitle: undefined,
      });
    } else if (action === 'done') {
      outcome = 'done';
      if (member.source === 'asana') {
        if (!member.gid || !member.integrationId) {
          return NextResponse.json(
            { error: 'gid and integrationId are required to complete an Asana task' },
            { status: 400 }
          );
        }
        const accessToken = await resolveAsanaToken(member.integrationId);
        await completeTask(accessToken, member.gid, true);
        // Completing in Asana also settles any portal-done "waiting" state.
        const metadata = await getAllTaskMetadata();
        if (metadata[member.gid]?.portalDone) {
          await upsertTaskMetadata(member.gid, member.integrationId, {
            portalDone: false,
            portalDoneAt: undefined,
            portalDoneTitle: undefined,
          });
        }
      } else {
        const adhocId = member.adhocId ?? member.taskId;
        await updateAdHocTask(adhocId, { completed: true });
      }
      // A completed task is no longer carried over.
      await removeCarryOvers([member.taskId]);
    } else {
      // remove-from-block: the task leaves the block but stays open, so it shows
      // up in the dashboard's "Left unscheduled" list rather than vanishing.
      outcome = 'unscheduled';
      if (member.source === 'asana') {
        if (member.scheduleId) await unscheduleAsanaTask(member.scheduleId);
      } else {
        const adhocId = member.adhocId ?? member.taskId;
        // Clear the slot + block link; the task returns to the backlog unscheduled.
        await updateAdHocTask(adhocId, { googleEventId: undefined, dueTime: undefined });
      }
    }

    // Only updates an existing high-water-mark entry (setWeeklyTaskOutcomes is a
    // no-op when the task was never scheduled into that week's record) — exactly
    // as the confirm route records it.
    await setWeeklyTaskOutcomes(outcomeWeek, [{ taskId: member.taskId, outcome }]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating block member:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update block member' },
      { status: 500 }
    );
  }
}
