import { NextRequest, NextResponse } from 'next/server';

import { gatherWeekContext } from '@/lib/scheduling/gather';
import { resolveWorkingWindow } from '@/lib/scheduling/engine';
import { proposePrepBlocks, type PrepMeeting } from '@/lib/scheduling/prep';
import { resolvePrepCandidates } from '@/lib/scheduling/prep-candidates';
import { placeWeekRituals, proposedBlockToBusyInterval } from '@/lib/scheduling/rituals';
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

    // Resolve which meetings (this week + early next week) warrant prep, deduped
    // against existing prep blocks (see resolvePrepCandidates).
    const prepBlocks = await getPrepBlocks();
    const candidates = await resolvePrepCandidates({
      weekEvents: ctx.weekEvents,
      nextWeekEarlyEvents: ctx.nextWeekEarlyEvents,
      nextWeekFirstWorkingDay: ctx.nextWeekFirstWorkingDay,
      nowMs,
      prepBlocks,
    });

    // A per-meeting preferred day is valid only when it is a working day THIS
    // week — prep for a next-week meeting is always placed this week, so a day
    // override pointing into next week is dropped (default placement then applies).
    const preferredDateFor = (c: (typeof candidates)[number]): string | undefined => {
      const raw = rawPrepDays[c.eventId];
      if (!raw) return undefined;
      return workingDaySet.has(raw) ? raw : undefined;
    };

    // Meetings needing prep → propose a slot for each event instance. Next-week
    // early meetings place their prep into this week's LATEST working days.
    const prepMeetings: PrepMeeting[] = [];
    for (const c of candidates) {
      if (!c.needsPrep) continue;
      const preferredDate = preferredDateFor(c);
      prepMeetings.push({
        eventId: c.eventId,
        title: c.title,
        startMs: c.startMs,
        date: c.date,
        ...(c.nextWeek ? { preferLatest: true } : {}),
        ...(prepDurations[c.eventId] ? { durationMinutes: prepDurations[c.eventId] } : {}),
        ...(preferredDate ? { preferredDate } : {}),
      });
    }

    // Rituals are the NUMBER ONE priority and are placed FIRST — before prep
    // slots — so prep never steals the 15:00 exercise slot. This uses the same
    // helper + inputs as the propose route (calendar busy only, no prep yet), so
    // the exercise/lunch/emails slots reserved here match the ones the propose
    // route re-derives later (the accepted prep it adds to busy never overlaps
    // them). Rituals then join the busy set before prep is proposed.
    const ritualBlocks = placeWeekRituals({
      config: ctx.config,
      weekEvents: ctx.weekEvents,
      busyIntervals: ctx.busyIntervals,
      weekStart: ctx.weekStart,
      now: ctx.now,
      outOfOfficeDates: ctx.outOfOfficeDates,
    });
    const prepBusyIntervals = [
      ...ctx.busyIntervals,
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
    // unplaced); needsPrep:false rows are toggleable in the UI. `nextWeek` flags a
    // meeting on an early day of next week so the UI can label it ("next Mon").
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
        nextWeek: c.nextWeek,
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
