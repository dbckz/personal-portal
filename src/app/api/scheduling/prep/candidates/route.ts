import { NextRequest, NextResponse } from 'next/server';

import { gatherWeekContext } from '@/lib/scheduling/gather';
import { resolveWorkingWindow, localDateStr } from '@/lib/scheduling/engine';
import { proposePrepBlocks, type PrepMeeting } from '@/lib/scheduling/prep';
import { resolvePrepCandidates } from '@/lib/scheduling/prep-candidates';
import {
  placeWeekRituals,
  placeOfficeAndTravelBlocks,
  sanitizeDayLocations,
  existingRitualTitlesByDateFromEvents,
  isTravelTitle,
  proposedBlockToBusyInterval,
} from '@/lib/scheduling/rituals';
import { getPrepBlocks } from '@/lib/user-data-storage';

// POST {
//   weekStart?: string,
//   prepDurations?: Record<eventId, 15|30|60>,
//   prepDays?: Record<eventId, yyyy-MM-dd>,
// }
// Resolve which of the week's future meetings need a prep block (user decision >
// cached AI verdict > fresh classification) and propose a slot for each. AI
// verdicts are persisted. Meetings that already have a "Prep:" event are dropped.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const ctx = await gatherWeekContext(typeof body?.weekStart === 'string' ? body.weekStart : undefined);

    // Working days of the (remaining) week — used to validate day overrides and
    // returned so the UI can offer a per-meeting day dropdown.
    const { workingDays } = resolveWorkingWindow(ctx.config.scheduling, ctx.weekStart, ctx.now, ctx.outOfOfficeDates);
    const workingDayStrs = workingDays.map(d => d.dateStr);
    const workingDaySet = new Set(workingDayStrs);

    // Per-meeting prep-block length overrides, keyed by eventId. Only 15/30/60
    // are valid values; anything else is dropped (that meeting defaults to 15).
    const prepDurations: Record<string, number> = {};
    if (body?.prepDurations && typeof body.prepDurations === 'object') {
      for (const [eventId, value] of Object.entries(body.prepDurations)) {
        if ([15, 30, 60].includes(value as number)) {
          prepDurations[eventId] = value as number;
        }
      }
    }

    // Per-meeting preferred prep DAY overrides, keyed by eventId, collected raw
    // here and validated per-meeting once candidates are resolved (a next-week
    // meeting accepts an early-next-week day too, so validity depends on the
    // meeting).
    const rawPrepDays: Record<string, string> = {};
    if (body?.prepDays && typeof body.prepDays === 'object') {
      for (const [eventId, value] of Object.entries(body.prepDays)) {
        if (typeof value === 'string') rawPrepDays[eventId] = value;
      }
    }
    const nowMs = ctx.now.getTime();

    // Resolve which of this week's remaining meetings warrant prep, deduped
    // against existing prep blocks (see resolvePrepCandidates).
    const prepBlocks = await getPrepBlocks();
    const candidates = await resolvePrepCandidates({
      weekEvents: ctx.weekEvents,
      nowMs,
      prepBlocks,
    });

    // A per-meeting preferred day is valid only when it is a working day THIS week.
    const preferredDateFor = (c: (typeof candidates)[number]): string | undefined => {
      const raw = rawPrepDays[c.eventId];
      if (!raw) return undefined;
      return workingDaySet.has(raw) ? raw : undefined;
    };

    // Meetings needing prep → propose a slot for each event instance.
    const prepMeetings: PrepMeeting[] = [];
    for (const c of candidates) {
      if (!c.needsPrep) continue;
      const preferredDate = preferredDateFor(c);
      prepMeetings.push({
        eventId: c.eventId,
        title: c.title,
        startMs: c.startMs,
        date: c.date,
        ...(prepDurations[c.eventId] ? { durationMinutes: prepDurations[c.eventId] } : {}),
        ...(preferredDate ? { preferredDate } : {}),
      });
    }

    // Build the SAME busy timeline the propose route uses before it schedules
    // (office/travel blocks, then the daily rituals), so prep slots are proposed
    // against the identical picture the final plan will see — otherwise prep can
    // land where the get-ready/commute pair or a ritual will go and crowd the
    // mornings. The office/travel + daily-ritual placement mirrors propose/route.
    // (Weekly rituals are placed AFTER tasks in the propose route, so they are
    // deliberately excluded here — deep work claims the mornings first.)
    //
    // Per-day work location comes from the wizard's Location step (which runs
    // before the prep step); office days get a get-ready + commute pair (and cap
    // deep work), travel days a fixed travel block.
    const weekDateStrs = new Set<string>();
    for (let d = 0; d < 7; d++) {
      const day = new Date(ctx.weekStart);
      day.setDate(day.getDate() + d);
      weekDateStrs.add(localDateStr(day));
    }
    const dayLocations = sanitizeDayLocations(body?.dayLocations, weekDateStrs);
    const existingRitualTitlesByDate = existingRitualTitlesByDateFromEvents(ctx.weekEvents);
    const existingTravelDates = new Set<string>();
    for (const e of ctx.weekEvents) {
      if (!e.allDay && e.title && isTravelTitle(e.title)) {
        existingTravelDates.add(localDateStr(e.startTime));
      }
    }
    const { blocks: officeTravelBlocks } = placeOfficeAndTravelBlocks({
      config: ctx.config,
      busyIntervals: ctx.busyIntervals,
      weekStart: ctx.weekStart,
      now: ctx.now,
      dayLocations,
      existingRitualTitlesByDate,
      existingTravelDates,
      outOfOfficeDates: ctx.outOfOfficeDates,
    });
    const officeTravelIntervals = officeTravelBlocks.map(proposedBlockToBusyInterval);

    // Daily rituals (exercise is the NUMBER ONE priority) are placed FIRST — before
    // prep slots — so prep never steals the 15:00 exercise slot. Same helper +
    // inputs as the propose route, so the exercise/lunch/emails slots reserved here
    // match the ones the propose route re-derives later.
    const ritualBlocks = placeWeekRituals({
      config: ctx.config,
      weekEvents: ctx.weekEvents,
      busyIntervals: [...ctx.busyIntervals, ...officeTravelIntervals],
      weekStart: ctx.weekStart,
      now: ctx.now,
      outOfOfficeDates: ctx.outOfOfficeDates,
      phase: 'daily',
    });
    const prepBusyIntervals = [
      ...ctx.busyIntervals,
      ...officeTravelIntervals,
      ...ritualBlocks.map(proposedBlockToBusyInterval),
    ];

    const { placed, unplaced } = proposePrepBlocks({
      meetings: prepMeetings,
      config: ctx.config,
      busyIntervals: prepBusyIntervals,
      weekStart: ctx.weekStart,
      now: ctx.now,
      outOfOfficeDates: ctx.outOfOfficeDates,
    });
    const blockByEventId = new Map(placed.map(b => [b.meeting!.eventId, b]));
    const reasonByEventId = new Map(unplaced.map(u => [u.meeting.eventId, u.reason]));

    // One row per candidate event: needsPrep rows carry a proposed block (unless
    // unplaced); needsPrep:false rows are toggleable in the UI.
    const meetings = candidates.map(c => {
      const block = blockByEventId.get(c.eventId);
      return {
        key: c.key,
        eventId: c.eventId,
        title: c.title,
        date: c.date,
        start: c.start,
        needsPrep: c.needsPrep,
        decidedBy: c.decidedBy,
        reason: c.reason,
        ...(block ? { block } : {}),
      };
    });

    const unplacedRows = candidates
      .filter(c => reasonByEventId.has(c.eventId))
      .map(c => ({ key: c.key, title: c.title, reason: reasonByEventId.get(c.eventId)! }));

    return NextResponse.json({
      meetings,
      unplaced: unplacedRows,
      workingDays: workingDayStrs,
    });
  } catch (error) {
    console.error('Error resolving prep candidates:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to resolve prep candidates' },
      { status: 500 }
    );
  }
}
