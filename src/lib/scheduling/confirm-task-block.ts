// Shared task-block creation for the confirm routes.
//
// The weekly-plan confirm and the mid-week replan backfill both turn a proposed
// TASK / reserved / grouped block into a real Google Calendar event plus the
// scheduling records (scheduled-Asana / ad-hoc updates, event attribution) and
// the durable weekly-task inputs. Extracted here so the two routes create these
// blocks identically instead of drifting. Rituals, breaks and meeting-prep blocks
// have their own creators and are never passed here.

import { createCalendarEvent } from '@/lib/google-calendar';
import {
  scheduleAsanaTask,
  updateAdHocTask,
  setGoogleEventAttribution,
  type WeeklyTaskInput,
} from '@/lib/user-data-storage';
import type { AsanaIntegration, GoogleCalendarCredentials, GoogleIntegration } from '@/types';

import { blockEventDescription, colorIdForBlock, eventTitleForBlock } from './event-titles';
import type { ProposedBlock } from './types';

export interface TaskBlockRoute {
  googleIntegrationId: string;
  transparency: 'opaque' | 'transparent';
}

// Per-Asana-integration event routing: a task from an Asana integration with
// `eventGoogleIntegrationId` set has its event created on that Google
// integration's primary calendar, with the integration's `eventTransparency`.
export function buildAsanaEventRouting(
  asanaIntegrations: AsanaIntegration[]
): Map<string, TaskBlockRoute> {
  return new Map(
    asanaIntegrations
      .filter(a => a.eventGoogleIntegrationId)
      .map(a => [
        a.id,
        {
          googleIntegrationId: a.eventGoogleIntegrationId!,
          transparency: (a.eventTransparency ?? 'opaque') as 'opaque' | 'transparent',
        },
      ])
  );
}

// Decide which Google integration + transparency a TASK/reserved/grouped block's
// event should use. A block routes to a special calendar only when EVERY task on
// it comes from the SAME Asana integration that declares an event-routing
// override; reserved / ad-hoc / mixed blocks fall back to the default (opaque).
export function routeTaskBlock(
  proposal: ProposedBlock,
  asanaRouting: Map<string, TaskBlockRoute>,
  defaultGoogleId: string
): TaskBlockRoute {
  const fallback: TaskBlockRoute = { googleIntegrationId: defaultGoogleId, transparency: 'opaque' };
  const tasks = Array.isArray(proposal.tasks)
    ? proposal.tasks
    : proposal.task
      ? [proposal.task]
      : [];
  if (tasks.length === 0) return fallback;
  const first = tasks[0].integrationId;
  if (!first || !tasks.every(t => t.integrationId === first)) return fallback;
  return asanaRouting.get(first) ?? fallback;
}

export interface AppliedTaskBlock {
  eventId: string;
  // Task ids (gid / ad-hoc id) actually placed on the calendar by this block, so
  // the caller can drop their carry-over markers.
  scheduledTaskIds: string[];
  // The tasks with their category + scheduled minutes, for the durable weekly record.
  weeklyTasks: WeeklyTaskInput[];
}

function toStartEnd(date: string, start: string, durationMinutes: number): { start: Date; end: Date } {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = start.split(':').map(Number);
  const startDate = new Date(y, mo - 1, d, h, m, 0, 0);
  return { start: startDate, end: new Date(startDate.getTime() + durationMinutes * 60 * 1000) };
}

// Create the calendar event for a TASK / reserved / grouped block and store its
// scheduling records. A grouped block records each listed task against the shared
// container event (its time split evenly across members); a single-task block
// records its one task; a reserved block (no task) just creates the event.
export async function createTaskBlockEvent(params: {
  proposal: ProposedBlock;
  credentials: GoogleCalendarCredentials;
  googleIntegration: GoogleIntegration;
  transparency: 'opaque' | 'transparent';
}): Promise<AppliedTaskBlock> {
  const { proposal, credentials, googleIntegration, transparency } = params;
  const scheduledTaskIds: string[] = [];
  const weeklyTasks: WeeklyTaskInput[] = [];

  const { start, end } = toStartEnd(proposal.date, proposal.start, proposal.durationMinutes);
  const event = await createCalendarEvent(
    credentials,
    googleIntegration.clientId,
    googleIntegration.clientSecret,
    eventTitleForBlock(proposal),
    start,
    end,
    blockEventDescription(proposal),
    'default',
    'primary',
    { transparency, colorId: colorIdForBlock(proposal) }
  );

  if (Array.isArray(proposal.tasks)) {
    // Grouped container: each member scheduled against the shared event, its time
    // split evenly across the members for estimate-vs-actual evidence.
    const groupedMinutes = Math.round(proposal.durationMinutes / Math.max(1, proposal.tasks.length));
    for (const t of proposal.tasks) {
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
          t.title,
          proposal.category
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
          category: proposal.category,
        });
      }
    }
  } else if (proposal.task) {
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
        proposal.task.title,
        proposal.category
      );
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
        category: proposal.category,
      });
    }
  }
  // Reserved block (no task / no tasks): the event is enough; nothing to store.

  return { eventId: event.id, scheduledTaskIds, weeklyTasks };
}
