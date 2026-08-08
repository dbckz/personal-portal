// Pure attribution of calendar time to an Asana workspace (OM / DBC / …) and a
// work category. Shared by the LIVE client path (today, ticking as the day
// elapses) and the SERVER reconcile (past days, rebuilt from the calendar), so a
// day cannot change meaning as it ages out of "today".
//
// THE CALENDAR IS THE SOURCE OF TRUTH. Dave moves things around on his Google
// calendars to reflect how he actually worked, so an event counts toward the
// workspace whose calendar it sits on — however it got there. A meeting someone
// else booked on the OM calendar is OM work; a block he typed straight into that
// calendar is OM work; an app-scheduled block is OM work.
//
// I/O-free, so both callers apply identical rules and the rules stay testable.

import type { CalendarEvent } from '@/types';
import {
  isBreakLikeTitle,
  isPersonalLikeTitle,
  isRitualLikeTitle,
  ritualKindForTitle,
} from '@/lib/scheduling/rituals';
import {
  categoryForTitleEmoji,
  isPrepTitle,
  prepMeetingTitleFromEvent,
} from '@/lib/scheduling/event-titles';
import { DBC_ASANA_INTEGRATION_ID, resolveAttributionRule } from '@/lib/attribution-rules';
import { normalize } from '@/lib/capacity';
import type { EventAttributionRule } from '@/types';

// Google event types that are never work time. 'default' and 'focusTime' are.
//  * birthday / workingLocation — calendar furniture, not time spent,
//  * fromGmail — Gmail-derived reminders (flights, deliveries): a reminder, not
//    a meeting,
//  * outOfOffice — the opposite of working.
const NON_WORK_EVENT_TYPES = new Set(['birthday', 'workingLocation', 'fromGmail', 'outOfOffice']);

// --- Categories -------------------------------------------------------------
// The category set is the workflow's own categories (resolved from the emoji
// conventions the planner writes, or a linked task's classification), plus a
// Meetings bucket for real invites, the work rituals under their own labels, and
// a catch-all.
export const MEETINGS_CATEGORY = 'Meetings';
export const OTHER_CATEGORY = 'Other';
export const PREP_CATEGORY = 'Meeting prep';

// Work rituals get their own segment. Breaks never reach here (excluded as
// non-work), so this only needs the work kinds.
const RITUAL_CATEGORY_BY_KIND: Record<string, string> = {
  emails: 'Emails',
  kindleNotes: 'Kindle notes',
  grooming: 'Backlog grooming',
  retro: 'Retrospective',
  consulting: 'Consulting',
  sideProjects: 'Side projects',
  newBookies: 'New bookies',
  reading: 'Reading',
  learning: 'Learning',
};

const RITUAL_CATEGORIES = new Set(Object.values(RITUAL_CATEGORY_BY_KIND));

// The fixed categories the time-tracker can emit regardless of the workflow
// config: real meetings, meeting prep, the work rituals, and the catch-all.
// Offered as calendar-category goal suggestions alongside configured and
// observed ones.
export const ATTRIBUTION_CATEGORIES: string[] = [
  MEETINGS_CATEGORY,
  PREP_CATEGORY,
  OTHER_CATEGORY,
  ...RITUAL_CATEGORIES,
];

// Which segment wins when two counted events overlap. Dave's calendar stacks a
// meeting on top of a task block when a meeting lands mid-block; those minutes
// are real time spent ONCE, so they are attributed to the more interrupting
// thing: a meeting beats a task block, which beats a ritual. Lower rank wins.
const MEETING_RANK = 0;
const TASK_RANK = 1;
const RITUAL_RANK = 2;

export function categoryRank(category: string): number {
  if (category === MEETINGS_CATEGORY) return MEETING_RANK;
  if (RITUAL_CATEGORIES.has(category)) return RITUAL_RANK;
  return TASK_RANK;
}

// Which Asana workspace a calendar belongs to. Both maps are keyed by id and
// resolve to an Asana integration id.
export interface WorkspaceCalendarMap {
  // Google integration id → Asana integration id. Derived from each Asana
  // integration's `eventGoogleIntegrationId` (the routing that already decides
  // where that workspace's task events are created), so the mapping follows the
  // config Dave already maintains rather than a second source of truth.
  byGoogleIntegration: Record<string, string>;
  // Google SUB-calendar id → Asana integration id, for the case a single Google
  // account holds calendars for different workspaces (e.g. a consulting calendar
  // living inside the personal account). Optional, from
  // `scheduling.calendarWorkspaceMap`; takes precedence over the integration map.
  byCalendar: Record<string, string>;
}

export function buildWorkspaceCalendarMap(
  asanaIntegrations: Array<{ id: string; eventGoogleIntegrationId?: string }>,
  calendarWorkspaceMap?: Record<string, string>
): WorkspaceCalendarMap {
  const byGoogleIntegration: Record<string, string> = {};
  for (const asana of asanaIntegrations) {
    // Only an EXPLICIT routing claims a calendar. A workspace with no routing
    // falls back to the default Google integration when creating events, but
    // that default is usually the personal account — claiming it wholesale
    // would count birthdays and family events as client work.
    if (asana.eventGoogleIntegrationId) {
      byGoogleIntegration[asana.eventGoogleIntegrationId] = asana.id;
    }
  }
  return { byGoogleIntegration, byCalendar: { ...(calendarWorkspaceMap ?? {}) } };
}

// Is this event time spent working at all? Attribution is a separate question —
// an event can be countable here and still belong to no workspace.
export function isCountableWorkEvent(event: CalendarEvent): boolean {
  // All-day entries are not a measurable slice of the day. This is also what
  // keeps reminders out: Google Tasks / reminders surface as all-day items, and
  // this app's own Reminders feature is Google Tasks-backed, so it never
  // produces a timed calendar event in the first place.
  if (event.allDay) return false;
  // Declined meetings are free time — the same rule the planner's free/busy uses.
  if (event.selfResponseStatus === 'declined') return false;
  if (event.eventType && NON_WORK_EVENT_TYPES.has(event.eventType)) return false;
  // Breaks are not work: lunch, exercise and the post-run break, whether the app
  // created them (emoji title) or Dave typed them in himself. The WORK rituals
  // (emails, kindle notes, grooming, retrospective) deliberately DO count.
  if (isBreakLikeTitle(event.title)) return false;
  // Personal / visibility events never count, whatever calendar they sit on: a
  // cycle to football, the match, a flight parked on the OM calendar for
  // availability visibility. A stored attribution rule cannot rescue these
  // because this filter runs before attribution — intended, they are not work.
  if (isPersonalLikeTitle(event.title)) return false;
  // Zero-length or malformed intervals contribute nothing.
  const ms = event.endTime.getTime() - event.startTime.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return false;
  return true;
  // Note: an event Dave dismissed as "not a task" in the daily review still
  // counts. Dismissing means "don't ask me to tick this off", not "this time
  // didn't happen" — it was still time spent on that workspace's calendar.
}

export interface AttributionContext {
  map: WorkspaceCalendarMap;
  // Manual Google-event → workspace attributions (googleEventAttributions).
  attributionByEventId?: Record<string, { asanaIntegrationId: string } | undefined>;
  // Optional task id → quota category, so a block backed by a known task is
  // categorised by its real classification rather than only its title emoji.
  categoryByTaskId?: Record<string, string | undefined>;
  // Durable series/title attribution overrides (see lib/attribution-rules.ts).
  // Built-in rules always apply; these are the user's stored additions.
  attributionRules?: readonly EventAttributionRule[];
  // Meeting-prep blocks ("📖 Prep: <meeting>") sit on the personal calendar but
  // should count toward the workspace of the MEETING they prep for. The meeting's
  // own calendar/integration is not durably stored on the prep block, so each
  // caller resolves the meeting's workspace from that week's fetched events and
  // passes it here keyed by the meeting's normalized title (meetingTitleKey). The
  // prep title carries the meeting title after the "📖 Prep: " prefix.
  meetingWorkspaceByNormalizedTitle?: Record<string, string>;
}

// The map key for matching a prep block to its meeting: the meeting title reduced
// with the shared whitespace/case-insensitive normalize, so the two callers build
// the map with the SAME key the prep-block attribution looks up. Prep titles are
// stripped of their "📖 Prep: " prefix (via prepMeetingTitleFromEvent) before
// keying, so a prep resolves to the same key its meeting was recorded under.
export function meetingTitleKey(title: string): string {
  return normalize(title);
}

// The Asana workspace an event's time belongs to, or null for "counts toward
// neither" (e.g. a personal-calendar event with no explicit link).
//
// Precedence, most specific first:
//   1. an explicit task link / Asana-sourced event — the app knows the exact
//      workspace, and it wins even if the event sits on another calendar,
//   2. a manual attribution Dave set on that specific event,
//   2b. a durable series/title rule (a recurring meeting attributed once). A
//       rule of 'none' pins the event to "counts toward nothing", which beats the
//       calendar it sits on,
//   3. the calendar it lives on (sub-calendar mapping, then integration).
export function attributeEventToWorkspace(
  event: CalendarEvent,
  ctx: AttributionContext
): string | null {
  const direct =
    event.linkedAsanaIntegrationId || (event.source === 'asana' ? event.integrationId : undefined);
  if (direct) return direct;

  const manual = ctx.attributionByEventId?.[event.id]?.asanaIntegrationId;
  if (manual) return manual;

  const ruled = resolveAttributionRule(event, ctx.attributionRules);
  if (ruled) return ruled === 'none' ? null : ruled;

  const title = event.title ?? '';

  // Dave's standing decision: backlog grooming always counts toward DBC. The
  // grooming ritual ("🧹 Backlog grooming") sits on an unmapped personal
  // calendar, so without this it counts toward nothing. Placed AFTER the rule
  // check so a stored rule can still override it (including to 'none').
  if (ritualKindForTitle(title) === 'grooming') return DBC_ASANA_INTEGRATION_ID;

  // Dave's standing decision: a meeting-prep block counts toward the workspace of
  // the meeting it preps for. Prep blocks stay on the personal calendar, so they
  // otherwise count toward nothing. Resolve the prepped meeting's workspace from
  // the caller-supplied title map; prep tied to an OM meeting counts as OM, and
  // prep whose meeting is unknown (or is itself DBC) falls back to DBC.
  if (isPrepTitle(title)) {
    const key = meetingTitleKey(prepMeetingTitleFromEvent(title));
    return ctx.meetingWorkspaceByNormalizedTitle?.[key] ?? DBC_ASANA_INTEGRATION_ID;
  }

  if (event.calendarId && ctx.map.byCalendar[event.calendarId]) {
    return ctx.map.byCalendar[event.calendarId];
  }
  if (event.integrationId && ctx.map.byGoogleIntegration[event.integrationId]) {
    return ctx.map.byGoogleIntegration[event.integrationId];
  }
  return null;
}

// Build the meeting-title → workspace map that prep-block attribution reads, from
// a window of fetched events. Each caller passes THAT WEEK's events (the client
// its loaded window, the reconcile the whole fetched span) and the BASE context
// (no meeting map — a prep never preps for a prep). A prep block is then
// attributed to the workspace of the meeting whose normalized title matches.
// Prep titles are skipped, as are events that resolve to no workspace; a title
// clash lets the later entry win.
export function buildMeetingWorkspaceByTitle(
  events: CalendarEvent[],
  ctx: AttributionContext
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const event of events) {
    const title = event.title ?? '';
    if (!title || isPrepTitle(title)) continue;
    if (!isCountableWorkEvent(event)) continue;
    const workspaceId = attributeEventToWorkspace(event, ctx);
    if (workspaceId) out[meetingTitleKey(title)] = workspaceId;
  }
  return out;
}

// Which work category an event's time falls under.
//
// App-created blocks are recognised by the conventions the planner itself
// writes — the prep prefix, ritual titles, the category emoji — so this can
// never drift from how events are created. A linked task's own classification
// wins over the emoji when the caller supplies one. Anything carrying an
// attendee list is an invite, i.e. a meeting. Whatever is left is a hand-made
// block with no marking, which lands in the catch-all rather than being guessed.
export function categoriseEvent(event: CalendarEvent, ctx: AttributionContext): string {
  const title = event.title ?? '';

  if (isPrepTitle(title)) return PREP_CATEGORY;
  if (isRitualLikeTitle(title)) {
    return RITUAL_CATEGORY_BY_KIND[ritualKindForTitle(title)] ?? OTHER_CATEGORY;
  }

  const linkedTaskId = event.linkedAsanaTaskId;
  const taskCategory = linkedTaskId ? ctx.categoryByTaskId?.[linkedTaskId] : undefined;
  if (taskCategory) return taskCategory;

  const emojiCategory = categoryForTitleEmoji(title);
  if (emojiCategory) return emojiCategory;

  // An attendee list means someone invited someone: a real meeting. A solo block
  // Dave typed himself carries no attendees.
  if ((event.attendeeCount ?? 0) >= 1) return MEETINGS_CATEGORY;

  return OTHER_CATEGORY;
}

// One event's counted contribution, after overlap resolution.
export interface AttributedEvent {
  eventId: string;
  title: string;
  workspaceId: string;
  category: string;
  startMs: number;
  endMs: number;
  fullMinutes: number; // the event's own length
  countedMinutes: number; // what it contributes once overlaps are resolved
}

export interface AttributedTime {
  // Overlap-deduped minutes per workspace. Equals the sum of its categories.
  scheduled: Record<string, number>;
  worked: Record<string, number>;
  // workspace → category → minutes.
  scheduledByCategory: Record<string, Record<string, number>>;
  workedByCategory: Record<string, Record<string, number>>;
  // Per-event detail (scheduled basis) for the durable per-event records and the
  // Analysis drill-down. An event wholly covered by a higher-precedence overlap
  // has countedMinutes 0 and is still listed, so the log shows it happened.
  events: AttributedEvent[];
}

interface Candidate {
  event: CalendarEvent;
  workspaceId: string;
  category: string;
  rank: number;
  startMs: number;
  endMs: number;
}

// Resolve overlaps within ONE workspace and total the result.
//
// Time is only spent once, so overlapping counted intervals must not both count.
// A sweep over the interval boundaries assigns each elementary slice to the
// single covering event with the best precedence (meeting > task block > ritual;
// ties broken by the earlier start, then input order). Each event therefore
// accrues only the slices it owns, and the per-category totals sum exactly to
// the workspace total.
function resolveWorkspace(
  candidates: Candidate[],
  clampMs: number
): { total: number; byCategory: Record<string, number>; counted: Map<CalendarEvent, number> } {
  const byCategory: Record<string, number> = {};
  const counted = new Map<CalendarEvent, number>();
  let total = 0;

  const intervals = candidates
    .map((c, index) => ({ ...c, index, endMs: Math.min(c.endMs, clampMs) }))
    .filter(c => c.endMs > c.startMs);
  if (intervals.length === 0) return { total, byCategory, counted };

  const boundaries = [...new Set(intervals.flatMap(i => [i.startMs, i.endMs]))].sort(
    (a, b) => a - b
  );

  for (let i = 0; i < boundaries.length - 1; i++) {
    const sliceStart = boundaries[i];
    const sliceEnd = boundaries[i + 1];
    if (sliceEnd <= sliceStart) continue;

    let winner: (typeof intervals)[number] | null = null;
    for (const interval of intervals) {
      if (interval.startMs > sliceStart || interval.endMs < sliceEnd) continue; // doesn't cover
      if (
        !winner ||
        interval.rank < winner.rank ||
        (interval.rank === winner.rank && interval.startMs < winner.startMs) ||
        (interval.rank === winner.rank &&
          interval.startMs === winner.startMs &&
          interval.index < winner.index)
      ) {
        winner = interval;
      }
    }
    if (!winner) continue;

    const minutes = (sliceEnd - sliceStart) / 60000;
    total += minutes;
    byCategory[winner.category] = (byCategory[winner.category] ?? 0) + minutes;
    counted.set(winner.event, (counted.get(winner.event) ?? 0) + minutes);
  }

  return { total, byCategory, counted };
}

// Split a day's events into scheduled and worked minutes per workspace and
// category. Both figures come from the SAME filter, attribution and overlap
// resolution, so they can never disagree; `worked` simply clamps every interval
// to `nowMs`. A fully-elapsed (past) day therefore yields worked === scheduled.
export function attributeMinutes(
  events: CalendarEvent[],
  ctx: AttributionContext,
  nowMs: number
): AttributedTime {
  const byWorkspace = new Map<string, Candidate[]>();

  for (const event of events) {
    if (!isCountableWorkEvent(event)) continue;
    const workspaceId = attributeEventToWorkspace(event, ctx);
    if (!workspaceId) continue;
    const category = categoriseEvent(event, ctx);
    const list = byWorkspace.get(workspaceId) ?? [];
    list.push({
      event,
      workspaceId,
      category,
      rank: categoryRank(category),
      startMs: event.startTime.getTime(),
      endMs: event.endTime.getTime(),
    });
    byWorkspace.set(workspaceId, list);
  }

  const scheduled: Record<string, number> = {};
  const worked: Record<string, number> = {};
  const scheduledByCategory: Record<string, Record<string, number>> = {};
  const workedByCategory: Record<string, Record<string, number>> = {};
  const attributedEvents: AttributedEvent[] = [];

  for (const [workspaceId, candidates] of byWorkspace) {
    const full = resolveWorkspace(candidates, Number.POSITIVE_INFINITY);
    const elapsed = resolveWorkspace(candidates, nowMs);

    if (full.total > 0) {
      scheduled[workspaceId] = full.total;
      scheduledByCategory[workspaceId] = full.byCategory;
    }
    if (elapsed.total > 0) {
      worked[workspaceId] = elapsed.total;
      workedByCategory[workspaceId] = elapsed.byCategory;
    }

    for (const candidate of candidates) {
      attributedEvents.push({
        eventId: candidate.event.id,
        title: candidate.event.title,
        workspaceId,
        category: candidate.category,
        startMs: candidate.startMs,
        endMs: candidate.endMs,
        fullMinutes: (candidate.endMs - candidate.startMs) / 60000,
        countedMinutes: full.counted.get(candidate.event) ?? 0,
      });
    }
  }

  return { scheduled, worked, scheduledByCategory, workedByCategory, events: attributedEvents };
}
