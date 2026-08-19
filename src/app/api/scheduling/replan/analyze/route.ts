import { NextRequest, NextResponse } from 'next/server';
import { format } from 'date-fns';

import { classifyBlockCategory, classifyBlockCategoryWithCatchAll } from '@/lib/capacity';
import { isDeepWork } from '@/lib/scheduling/engine';
import { adHocTypeSignals, gatherWeekContext } from '@/lib/scheduling/gather';
import { eventsToBusyIntervals } from '@/lib/scheduling/free-busy';
import { mergeCarryBlocks, planReplan, type ReplanBlock, type ReplanCarryBlock, type ReplanCarryTask, type ReplanReviewBlock } from '@/lib/scheduling/replan';
import { isEndOfWeekReview, countMissedWorkingDays } from '@/lib/scheduling/end-of-week';
import { proposePrepBlocks, type PrepMeeting } from '@/lib/scheduling/prep';
import { resolvePrepCandidates } from '@/lib/scheduling/prep-candidates';
import type { BusyInterval, CandidateTask } from '@/lib/scheduling/types';
import {
  getScheduledAsanaTasks,
  getAdHocTasks,
  getCustomTaskTypes,
  getPrepBlocks,
  getRitualBlocks,
  getBlockDoneOverrides,
  getDailyReviewState,
  getCarryOvers,
  getAllTaskMetadata,
  getWeeklyStats,
} from '@/lib/user-data-storage';
import { logicalTodayDate, normalizeRolloverHour } from '@/lib/date-utils';
import { ritualKindForTitle, isBreakTitle, isRitualLikeTitle, existingRitualTitlesByDateFromEvents, RITUAL_TITLES } from '@/lib/scheduling/rituals';
import { selectCalendarReviewBlocks } from '@/lib/scheduling/calendar-review';
import { filterNonTaskReviewBlocks } from '@/lib/scheduling/review-task-filter';
import { prepTitle } from '@/lib/scheduling/event-titles';
import type { ScheduledAsanaTask } from '@/types';

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
// The review never looks back further than this, so a long absence (holiday) is
// a fresh start over the recent window rather than an unbounded guilt trip.
const REVIEW_LOOKBACK_DAYS = 7;

// Analyze this week's app-created blocks and propose moves for the ones that
// have been missed (past + not done) or now conflict with a meeting. Pure logic
// lives in planReplan(); this route just assembles its inputs from the week
// context + stored schedule.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const weekStartParam = typeof body?.weekStart === 'string' ? body.weekStart : undefined;

    const ctx = await gatherWeekContext(weekStartParam);
    const [
      scheduledAsana,
      adHocTasks,
      customTypes,
      prepBlocks,
      ritualBlocks,
      doneOverrides,
      reviewState,
      carryOvers,
      taskMetadata,
      weeklyStats,
    ] = await Promise.all([
      getScheduledAsanaTasks(),
      getAdHocTasks(),
      getCustomTaskTypes(),
      getPrepBlocks(),
      getRitualBlocks(),
      getBlockDoneOverrides(),
      getDailyReviewState(),
      getCarryOvers(),
      getAllTaskMetadata(),
      getWeeklyStats(ctx.weekStartStr),
    ]);

    // How many weeks running a task has been carried, and whether an agent could
    // run it — both surfaced on the end-of-week carry cards so a task that keeps
    // sliding can be escalated (must-do / delegate) instead of carried again.
    const carryStreakFor = (taskId: string): number | undefined => {
      const entry = carryOvers[taskId];
      return entry ? entry.carries ?? 1 : undefined;
    };

    const inWeek = (d?: string) => !!d && d >= ctx.weekStartStr && d <= ctx.weekEndStr;

    // Look up each app block's actual interval from the matched calendar event
    // where possible; fall back to the stored schedule if the event isn't in the
    // fetched week (e.g. moved out of range) so we can still reason about it.
    const eventById = new Map(ctx.weekEvents.map(e => [e.id, e]));
    const intervalFor = (eventId: string, date: string, time: string, duration: number) => {
      const ev = eventById.get(eventId);
      if (ev && !ev.allDay) {
        const s = new Date(ev.startTime).getTime();
        const e = new Date(ev.endTime).getTime();
        if (!Number.isNaN(s) && !Number.isNaN(e) && e > s) return { startMs: s, endMs: e };
      }
      const [y, mo, d] = date.split('-').map(Number);
      const [h, m] = time.split(':').map(Number);
      const startMs = new Date(y, mo - 1, d, h, m, 0, 0).getTime();
      return { startMs, endMs: startMs + duration * MS_PER_MINUTE };
    };

    // Incomplete Asana tasks (from the shared fetch): drives title + done status.
    // A scheduled gid absent from this set is complete.
    const incompleteByGid = new Map(ctx.asanaCandidates.map(c => [c.task.gid, c.task]));
    const asanaTypeByGid = new Map(ctx.asanaCandidates.map(c => [c.task.gid, c.typeValue]));
    // Portal-done gids stay incomplete in Asana (the user only finished HIS part),
    // so the shared incomplete fetch still lists them. For the review they must
    // read as done, or a block whose members are all portal-done would resurface
    // as "missed" and be offered for carry-over. Drop them from the incomplete set
    // so every done check (block done-ness, carryTasksByEvent) treats them as done.
    for (const gid of ctx.portalDoneGids ?? []) incompleteByGid.delete(gid);

    const blocks: ReplanBlock[] = [];
    const appEventIds = new Set<string>();

    // Past app blocks (task/prep, never ritual) for the daily-review step. Built
    // here where each block's task refs are still in hand; filtered to blocks
    // that ended within the review window: after the last completed review (or
    // the start of the logical day when none) and at/before now. This keeps the
    // review to "what happened since you last reviewed" rather than the whole
    // week — the replan planning below still spans the full week.
    const nowMs = ctx.now.getTime();
    const rolloverHour = normalizeRolloverHour(ctx.config.scheduling?.dayRolloverHour);
    const logicalDayStart = logicalTodayDate(ctx.now, rolloverHour);
    logicalDayStart.setHours(rolloverHour, 0, 0, 0);
    const lastReviewedMs = reviewState.lastReviewedAt
      ? Date.parse(reviewState.lastReviewedAt)
      : NaN;
    const hadReview = !Number.isNaN(lastReviewedMs);
    // The window starts at the last completed review, but never earlier than the
    // 7-day cap (so a fortnight's holiday only surfaces the recent week), and
    // falls back to the start of the logical day when there's been no review at
    // all. `clamped` records when the cap actually bit, so the modal can read as
    // a fresh start rather than a backlog.
    const capMs = nowMs - REVIEW_LOOKBACK_DAYS * MS_PER_DAY;
    const reviewStartMs = hadReview ? Math.max(lastReviewedMs, capMs) : logicalDayStart.getTime();
    const clamped = hadReview && lastReviewedMs < capMs;
    // Coarse outer bound (local date of the window start) for selecting which
    // stored records to even consider. The precise cut is pushReview's
    // endMs > reviewStartMs; this only widens record selection across the week
    // boundary. Records dated on/after this and BEFORE this week feed the review
    // ONLY — never planning (see the prior-week passes below).
    const reviewRangeStartStr = format(new Date(reviewStartMs), 'yyyy-MM-dd');
    const dismissedTitles = new Set(reviewState.dismissedTitles);
    // eventId → backing task ids (Asana gid / ad-hoc id), so unplaceable rows can
    // carry what to defer. Preps have no deferrable task.
    const taskIdsByEvent = new Map<string, string[]>();
    // eventId → the same tasks with their titles and done state, so the
    // end-of-week review can ask per incomplete member task. Populated only for
    // task-backed blocks (never rituals, never meeting prep).
    const carryTasksByEvent = new Map<string, ReplanCarryTask[]>();
    const reviewBlocks: ReplanReviewBlock[] = [];
    const pushReview = (b: ReplanReviewBlock) => {
      if (b.endMs > reviewStartMs && b.endMs <= nowMs) reviewBlocks.push(b);
    };

    // Group scheduled Asana tasks by their Google event: a grouped block records
    // several tasks against one event. Used for this week (planning + review) and
    // again for the prior-week review-only pass, with a different date range.
    const groupAsanaByEvent = (inRange: (date?: string) => boolean) => {
      const groups = new Map<string, ScheduledAsanaTask[]>();
      for (const s of scheduledAsana) {
        if (!s.googleEventId || !inRange(s.scheduledDate)) continue;
        const list = groups.get(s.googleEventId) ?? [];
        list.push(s);
        groups.set(s.googleEventId, list);
      }
      return groups;
    };
    const asanaGroups = groupAsanaByEvent(inWeek);

    // Recover a task title from the app-created calendar event for legacy
    // scheduled entries with no stored taskName: a single-task event is titled
    // with the task name (category emoji prefix), and a grouped event's
    // description carries a "• <title>\n  <asana url>" agenda line per task
    // (see event-titles.ts).
    const titleFromEvent = (eventId: string, gid: string, single: boolean): string | undefined => {
      const ev = eventById.get(eventId);
      if (!ev) return undefined;
      if (single) {
        const stripped = ev.title.replace(/^\s*\p{Extended_Pictographic}️?\s*/u, '').trim();
        return stripped || undefined;
      }
      const m = (ev.description ?? '').match(
        new RegExp(`•\\s*(.+)\\s*\\n\\s*https://app\\.asana\\.com/0/\\d+/${gid}\\b`)
      );
      return m?.[1]?.trim() || undefined;
    };

    // --- Review-block builders (pure, no planning side-effects) -------------
    // One source of truth for each review block — and, since it resolves the same
    // titles / done state / category / slot, for the planning block the in-week
    // loops derive from it. The prior-week passes below call the SAME builders so
    // a block dated in last week reviews identically — without ever entering
    // planning, carry or move computation.
    //
    // Prefer the live Asana name — the incomplete fetch first, then the
    // completed-inclusive name map so a member completed this week still resolves;
    // then the title captured at scheduling time; then a title recovered from the
    // calendar event — so a task already completed (and thus absent from the
    // incomplete fetch) still shows its name rather than a generic placeholder.
    const asanaReviewTitles = (eventId: string, entries: ScheduledAsanaTask[]): string[] =>
      entries.map(
        e =>
          incompleteByGid.get(e.asanaTaskId)?.name ??
          ctx.asanaNameByGid.get(e.asanaTaskId) ??
          e.taskName ??
          titleFromEvent(eventId, e.asanaTaskId, entries.length === 1) ??
          'Scheduled task'
      );
    const buildAsanaReviewBlock = (
      eventId: string,
      entries: ScheduledAsanaTask[]
    ): ReplanReviewBlock => {
      const first = entries[0];
      const titles = asanaReviewTitles(eventId, entries);
      // Done when the Asana task(s) are complete, OR the user marked this block
      // "done for planning" in a prior replan (Asana task stays open).
      const done =
        !!doneOverrides[eventId] || entries.every(e => !incompleteByGid.has(e.asanaTaskId));
      // Prefer the category the wizard / replan stored on any entry at
      // scheduling time — it reflects what the user actually placed. Only fall
      // back to re-deriving the category from the Asana Type field for legacy
      // records that carry no stored category (that re-derivation can disagree
      // with the placement, e.g. a deep-work task whose Type isn't Writing).
      let category: string | null = entries.find(e => e.category)?.category ?? null;
      if (!category) {
        for (const e of entries) {
          const tv = asanaTypeByGid.get(e.asanaTaskId);
          category = classifyBlockCategory(tv ? [tv] : [], ctx.quotas);
          if (category) break;
        }
      }
      const { startMs, endMs } = intervalFor(
        eventId,
        first.scheduledDate,
        first.scheduledTime,
        first.duration
      );
      return {
        googleEventId: eventId,
        googleIntegrationId: first.googleIntegrationId,
        kind: 'task',
        category: category ?? 'Scheduled',
        date: first.scheduledDate,
        start: first.scheduledTime,
        durationMinutes: first.duration,
        startMs,
        endMs,
        done,
        titles,
        tasks: entries.map((e, i) => {
          // Done here means "complete in Asana": the gid is absent from the live
          // incomplete fetch. Distinct from a block-level "done for planning"
          // override, which never marks the individual task done.
          const asanaComplete = !incompleteByGid.has(e.asanaTaskId);
          return {
            title: titles[i],
            done: asanaComplete,
            gid: e.asanaTaskId,
            ...(e.integrationId ? { integrationId: e.integrationId } : {}),
            ...(asanaComplete ? { completedInAsana: true } : {}),
          };
        }),
      };
    };
    const buildAdhocReviewBlock = (t: (typeof adHocTasks)[number]): ReplanReviewBlock => {
      // Prefer the stored category (placed by the wizard / replan); re-derive
      // from the ad-hoc task's type signals only for legacy records without one.
      const category =
        t.category ??
        classifyBlockCategory(adHocTypeSignals(t.taskType, customTypes), ctx.quotas) ??
        'Scheduled';
      const duration = t.duration ?? 30;
      const { startMs, endMs } = intervalFor(t.googleEventId!, t.dueDate!, t.dueTime!, duration);
      const adhocDone = t.completed || !!doneOverrides[t.googleEventId!];
      return {
        googleEventId: t.googleEventId!,
        googleIntegrationId: t.googleIntegrationId,
        kind: 'task',
        category,
        date: t.dueDate!,
        start: t.dueTime!,
        durationMinutes: duration,
        startMs,
        endMs,
        done: adhocDone,
        titles: [t.title],
        tasks: [{ title: t.title, done: adhocDone, adhocId: t.id }],
      };
    };
    const buildPrepReviewBlock = (p: (typeof prepBlocks)[number]): ReplanReviewBlock => {
      const { startMs, endMs } = intervalFor(p.googleEventId, p.date, p.start, p.durationMinutes);
      const prepDone = p.done || !!doneOverrides[p.googleEventId];
      const prepTitleStr = prepTitle(p.meetingTitle);
      return {
        googleEventId: p.googleEventId,
        googleIntegrationId: p.googleIntegrationId,
        kind: 'prep',
        category: 'Meeting prep',
        date: p.date,
        start: p.start,
        durationMinutes: p.durationMinutes,
        startMs,
        endMs,
        done: prepDone,
        titles: [prepTitleStr],
        tasks: [{ title: prepTitleStr, done: prepDone }],
      };
    };

    for (const [eventId, entries] of asanaGroups) {
      appEventIds.add(eventId);
      taskIdsByEvent.set(eventId, entries.map(e => e.asanaTaskId));
      // The review block already resolves the titles, done state, category and
      // slot the planning block needs, so both derive from one build.
      const review = buildAsanaReviewBlock(eventId, entries);
      carryTasksByEvent.set(
        eventId,
        entries.map((e, i) => {
          const streak = carryStreakFor(e.asanaTaskId);
          return {
            id: e.asanaTaskId,
            title: review.titles[i],
            done: !incompleteByGid.has(e.asanaTaskId),
            gid: e.asanaTaskId,
            ...(e.integrationId ? { integrationId: e.integrationId } : {}),
            ...(streak ? { carryStreak: streak } : {}),
            ...(taskMetadata[e.asanaTaskId]?.aiDelegable ? { aiDelegable: true } : {}),
          };
        })
      );
      blocks.push({
        googleEventId: eventId,
        googleIntegrationId: review.googleIntegrationId,
        category: review.category,
        date: review.date,
        start: review.start,
        durationMinutes: review.durationMinutes,
        titles: review.titles,
        done: review.done,
        startMs: review.startMs,
        endMs: review.endMs,
        // Several tasks sharing one block = a category container (deep work,
        // outreach). Held to the week, not to the day it sat on.
        ...(entries.length > 1 ? { isCategoryContainer: true } : {}),
      });
      pushReview(review);
    }

    // Ad-hoc tasks placed on the calendar (each is its own block).
    for (const t of adHocTasks) {
      if (!t.googleEventId || !t.dueTime || !inWeek(t.dueDate)) continue;
      appEventIds.add(t.googleEventId);
      taskIdsByEvent.set(t.googleEventId, [t.id]);
      carryTasksByEvent.set(t.googleEventId, [
        {
          id: t.id,
          title: t.title,
          done: !!t.completed,
          adhocId: t.id,
          ...(carryStreakFor(t.id) ? { carryStreak: carryStreakFor(t.id) } : {}),
        },
      ]);
      const review = buildAdhocReviewBlock(t);
      blocks.push({
        googleEventId: t.googleEventId,
        googleIntegrationId: review.googleIntegrationId,
        category: review.category,
        date: review.date,
        start: review.start,
        durationMinutes: review.durationMinutes,
        titles: review.titles,
        done: review.done,
        startMs: review.startMs,
        endMs: review.endMs,
      });
      pushReview(review);
    }

    // Meeting-prep blocks (from the prep store). Each re-slots under the extra
    // constraint that it must end before its meeting starts (mustEndBeforeMs).
    for (const p of prepBlocks) {
      if (!inWeek(p.date)) continue;
      appEventIds.add(p.googleEventId);
      const meetingStartMs = new Date(p.meetingStart).getTime();
      const review = buildPrepReviewBlock(p);
      blocks.push({
        googleEventId: p.googleEventId,
        googleIntegrationId: review.googleIntegrationId,
        category: review.category,
        date: review.date,
        start: review.start,
        durationMinutes: review.durationMinutes,
        titles: review.titles,
        done: review.done,
        startMs: review.startMs,
        endMs: review.endMs,
        ...(Number.isNaN(meetingStartMs) ? {} : { mustEndBeforeMs: meetingStartMs }),
      });
      pushReview(review);
    }

    // Daily ritual blocks (lunch/exercise/emails). Never "missed" — only a future
    // ritual that now conflicts with a meeting is moved (re-slotted to its window).
    const RITUAL_CATEGORY = {
      lunch: 'Lunch',
      exercise: 'Exercise',
      emails: 'Emails',
      kindleNotes: 'Kindle notes',
      grooming: 'Backlog grooming',
      retro: 'Retrospective',
      delegationReview: 'Delegation review',
      walk: 'Walk',
      getReady: 'Get ready',
      commute: 'Commute',
      travel: 'Travel',
      consulting: 'Consulting',
      sideProjects: 'Side projects',
      newBookies: 'New bookies',
      reading: 'Reading',
      learning: 'Learning',
      break: 'Break',
    } as const;
    for (const r of ritualBlocks) {
      if (!inWeek(r.date)) continue;
      appEventIds.add(r.googleEventId);
      const kind = ritualKindForTitle(r.title);
      // Only lunch / exercise / break split work runs; emails + the WORK rituals
      // (kindle / grooming / retro / delegation review) count as work.
      const isBreak = isBreakTitle(r.title);
      const { startMs, endMs } = intervalFor(r.googleEventId, r.date, r.start, r.durationMinutes);
      blocks.push({
        googleEventId: r.googleEventId,
        googleIntegrationId: r.googleIntegrationId,
        category: RITUAL_CATEGORY[kind],
        date: r.date,
        start: r.start,
        durationMinutes: r.durationMinutes,
        titles: [r.title],
        done: false, // rituals are never "done"
        startMs,
        endMs,
        ritualKind: kind,
        isBreak,
      });
    }

    // --- Prior-week review-only passes --------------------------------------
    // Records dated BEFORE this week but on/after the review-window start (i.e. a
    // Friday block a Monday review must still account for). These produce review
    // blocks ONLY — they deliberately skip appEventIds, taskIdsByEvent,
    // carryTasksByEvent and blocks[], so they can never enter replan planning,
    // the end-of-week carry computation, or any move/defer. pushReview's precise
    // endMs > reviewStartMs gate still applies; intervalFor falls back to the
    // stored slot for these (their events aren't in this week's fetch), so no
    // second Google fetch is needed. Bare calendar rows stay current-week only —
    // they need live event data we don't have for prior weeks.
    const inPriorWeekReviewRange = (d?: string) =>
      !!d && d >= reviewRangeStartStr && d < ctx.weekStartStr;

    for (const [eventId, entries] of groupAsanaByEvent(inPriorWeekReviewRange)) {
      pushReview(buildAsanaReviewBlock(eventId, entries));
    }
    for (const t of adHocTasks) {
      if (!t.googleEventId || !t.dueTime || !inPriorWeekReviewRange(t.dueDate)) continue;
      pushReview(buildAdhocReviewBlock(t));
    }
    for (const p of prepBlocks) {
      if (!inPriorWeekReviewRange(p.date)) continue;
      pushReview(buildPrepReviewBlock(p));
    }

    // Ad-hoc Google Calendar events with no local record (added straight into
    // Google). Reviewed as solo work: skip meetings, all-day events, rituals and
    // app blocks; match each to an incomplete Asana task where possible.
    for (const b of selectCalendarReviewBlocks({
      events: ctx.weekEvents,
      appEventIds,
      ritualTitles: new Set(RITUAL_TITLES),
      dismissedTitles,
      nowMs,
      reviewStartMs,
      inWeek,
      doneOverrides,
      asanaTasks: ctx.asanaCandidates.map(c => ({
        gid: c.task.gid,
        name: c.task.name,
        integrationId: c.integrationId,
      })),
    })) {
      reviewBlocks.push(b);
    }

    // Second pass over the bare calendar events: drop anything that isn't a task
    // at all (a wake-up marker, a personal ritual, a name standing in for a
    // catch-up). Fails open — a classifier problem leaves the blocks in place.
    const reviewableBlocks = await filterNonTaskReviewBlocks({
      blocks: reviewBlocks,
      verdicts: reviewState.titleVerdicts,
    });
    reviewBlocks.length = 0;
    reviewBlocks.push(...reviewableBlocks);

    // Busy intervals from everything that is NOT an app block (real meetings).
    const otherBusy = eventsToBusyIntervals(ctx.weekEvents.filter(e => !appEventIds.has(e.id)));

    // The week's already-selected deep-work tasks: the tasks behind this week's
    // EXISTING deep-work blocks (grouped Asana containers / ad-hoc), whatever their
    // state (kept, moved, done or ended). Mid-week the planner only ADDS deep-work
    // blocks and rotates these across the new mornings — it never introduces a new
    // deep-work task from the general pool. Deduped by task id (first-seen order);
    // tasks already complete are dropped so a finished one doesn't reappear on a
    // later morning.
    const deepWorkWeekTasks: CandidateTask[] = [];
    const seenDeepWorkTaskIds = new Set<string>();
    for (const b of blocks) {
      if (!isDeepWork(b.category)) continue;
      for (const t of carryTasksByEvent.get(b.googleEventId) ?? []) {
        if (t.done) continue; // finished work never rotates back onto a morning
        const id = t.gid ?? t.adhocId ?? t.id;
        if (!id || seenDeepWorkTaskIds.has(id)) continue;
        seenDeepWorkTaskIds.add(id);
        deepWorkWeekTasks.push({
          gid: t.gid,
          adhocId: t.adhocId,
          title: t.title,
          integrationId: t.integrationId,
          // typeSignals are unused on the rotation override (it bypasses the
          // category classifier), so an empty list is fine.
          typeSignals: [],
        });
      }
    }

    // The unscheduled General-Todos candidates — the quota-less catch-all pool the
    // user goes and picks from to fill the week's free space. The planner never
    // auto-picks these; the review lists them with the free slots for manual
    // selection.
    const catchAllCategories = new Set(
      Object.entries(ctx.config.taskQuotas ?? {})
        .filter(([, q]) => !q.daily && !q.scaleToTasks && (q.weeklyCount ?? 0) <= 0)
        .map(([category]) => category)
    );
    const todoCandidates = (ctx.candidateTasks ?? [])
      .map(t => ({ t, category: classifyBlockCategoryWithCatchAll(t.typeSignals, ctx.quotas) }))
      .filter(({ category }) => category !== null && catchAllCategories.has(category))
      .map(({ t, category }) => ({
        gid: t.gid,
        adhocId: t.adhocId,
        title: t.title,
        integrationId: t.integrationId,
        category: category!,
      }));

    const result = planReplan({
      config: ctx.config,
      weekStart: ctx.weekStart,
      now: ctx.now,
      blocks,
      otherBusy,
      // Live ritual titles per date (includes manually-added ritual events) so a
      // remaining working day missing a ritual gets an addition proposed.
      existingRitualTitlesByDate: existingRitualTitlesByDateFromEvents(ctx.weekEvents),
      outOfOfficeDates: ctx.outOfOfficeDates,
      // Task backfill: fill the remaining week's free time (including the slots
      // freed by removed rituals) with additional task blocks for each category's
      // unmet weekly quota. candidateTasks already exclude anything scheduled this
      // week or completed; existingScheduledCounts (kept + moved + done + ended)
      // reduces each quota so a met category adds nothing.
      candidateTasks: ctx.candidateTasks,
      // The week's already-chosen deep-work tasks to rotate across new mornings —
      // the backfill never draws a NEW deep-work task from candidateTasks.
      deepWorkWeekTasks,
      existingScheduledCounts: ctx.existingScheduledCounts,
      existingCategoryCountsByDate: ctx.existingCategoryCountsByDate,
    });

    // --- Prep additions for early-next-week meetings ------------------------
    // A meeting early next week (e.g. next Mon/Tue) can only realistically be
    // prepped THIS week. Discover those that warrant prep and have no prep block
    // yet, then place them into this week's remaining days AFTER the replan has
    // settled — the busy set is the final post-replan timeline (meetings + kept
    // blocks + moved blocks + ritual additions), so prep never collides with them
    // and never steals a ritual slot. Placed latest-first (freshest prep sits
    // closest to the meeting) by proposePrepBlocks' preferLatest path.
    const toBusy = (date: string, start: string, durationMinutes: number): BusyInterval => {
      const [y, mo, d] = date.split('-').map(Number);
      const [h, m] = start.split(':').map(Number);
      const s = new Date(y, mo - 1, d, h, m, 0, 0);
      return { start: s, end: new Date(s.getTime() + durationMinutes * MS_PER_MINUTE) };
    };
    const nextWeekEarlyEvents = ctx.nextWeekEarlyEvents ?? [];
    let prepAdditions: typeof result.additions = [];
    // Only consult the prep classifier when there IS an early-next-week meeting to
    // consider — the common replan (mid-week, nothing next week yet) does no extra
    // work or AI call.
    if (nextWeekEarlyEvents.length > 0) {
      const prepCandidates = await resolvePrepCandidates({
        weekEvents: ctx.weekEvents,
        nextWeekEarlyEvents,
        nextWeekFirstWorkingDay: ctx.nextWeekFirstWorkingDay,
        nowMs,
        prepBlocks,
      });
      const nextWeekPrepMeetings: PrepMeeting[] = prepCandidates
        .filter(c => c.nextWeek && c.needsPrep)
        .map(c => ({ eventId: c.eventId, title: c.title, startMs: c.startMs, date: c.date, preferLatest: true }));
      const prepBusy: BusyInterval[] = [
        ...otherBusy,
        ...result.kept.map(k => toBusy(k.date, k.start, k.durationMinutes)),
        ...result.moves.map(m => toBusy(m.newDate, m.newStart, m.durationMinutes)),
        ...result.additions.map(a => toBusy(a.date, a.start, a.durationMinutes)),
        ...result.backfill.map(b => toBusy(b.date, b.start, b.durationMinutes)),
      ];
      prepAdditions = proposePrepBlocks({
        meetings: nextWeekPrepMeetings,
        config: ctx.config,
        busyIntervals: prepBusy,
        weekStart: ctx.weekStart,
        now: ctx.now,
      }).placed;
    }

    // Earliest-first so the review reads chronologically.
    reviewBlocks.sort((a, b) => a.endMs - b.endMs);

    // Seed the review from this week's durable stats: any not-done task already
    // recorded 'started' (worked on in an earlier review, e.g. a deep-work task
    // begun Monday) presents as 'started' when its later block comes up again,
    // rather than blank/not-done. Covers every review-block source that carries a
    // task id — grouped scheduled-Asana, ad-hoc, and calendar rows matched to an
    // Asana task; meeting-prep tasks carry no id and are skipped. Post-processed
    // over the assembled array so the flag needn't thread through each build site.
    const startedTaskIds = new Set(
      Object.values(weeklyStats?.tasks ?? {})
        .filter(t => t.outcome === 'started')
        .map(t => t.taskId)
    );
    if (startedTaskIds.size > 0) {
      for (const block of reviewBlocks) {
        for (const task of block.tasks) {
          const taskId = task.gid ?? task.adhocId;
          if (taskId && !task.done && startedTaskIds.has(taskId)) {
            task.previouslyStarted = true;
          }
        }
      }
    }

    // Attach the deferrable task ids — and the Asana-backed tasks (for a "Mark
    // done" that completes each in Asana) — to each unplaceable block. Mirrors
    // carryTasksByEvent: only tasks with a gid are Asana-completable.
    const unplaceable = result.unplaceable.map(u => ({
      ...u,
      deferTaskIds: taskIdsByEvent.get(u.googleEventId) ?? [],
      tasks: (carryTasksByEvent.get(u.googleEventId) ?? [])
        .filter((t): t is ReplanCarryTask & { gid: string } => !!t.gid)
        .map(t => ({ gid: t.gid, ...(t.integrationId ? { integrationId: t.integrationId } : {}) })),
    }));

    // Attach each stale prep block's meeting start + title from the prep record,
    // so the UI can offer "Make room" only while the meeting is still ahead.
    const prepByEventId = new Map(prepBlocks.map(p => [p.googleEventId, p]));
    const stale = result.stale.map(s => {
      const p = prepByEventId.get(s.googleEventId);
      if (!p) return s;
      const meetingStartMs = new Date(p.meetingStart).getTime();
      return {
        ...s,
        ...(Number.isNaN(meetingStartMs) ? {} : { meetingStartMs }),
        ...(p.meetingTitle ? { meetingTitle: p.meetingTitle } : {}),
      };
    });

    // Displaceable app blocks across the REMAINING week, offered as bump targets
    // for the "Make room" / "Prioritise tomorrow" options on couldn't-fit and
    // stale-prep cards. Only future, not-done app blocks backed by deferrable work
    // qualify — task/ad-hoc blocks (they have entries in taskIdsByEvent); rituals,
    // breaks and meeting-prep are excluded (no taskIdsByEvent entry), and real
    // Google meetings are never app blocks. `startMs` lets the client apply the
    // "before HH:mm" / "ends before the meeting" constraints.
    const moveCandidates = blocks
      .filter(
        b =>
          !b.done &&
          b.startMs > nowMs &&
          (taskIdsByEvent.get(b.googleEventId)?.length ?? 0) > 0
      )
      .map(b => ({
        googleEventId: b.googleEventId,
        googleIntegrationId: b.googleIntegrationId,
        category: b.category,
        titles: b.titles,
        date: b.date,
        start: b.start,
        durationMinutes: b.durationMinutes,
        startMs: b.startMs,
        taskIds: taskIdsByEvent.get(b.googleEventId) ?? [],
      }))
      .sort((a, b) => a.startMs - b.startMs);

    // The existing "prioritise tomorrow" flow only bumps TOMORROW's blocks; derive
    // that subset from the week-wide candidates so both share one source.
    const tomorrow = new Date(ctx.now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = format(tomorrow, 'yyyy-MM-dd');
    const tomorrowBlocks = moveCandidates.filter(b => b.date === tomorrowStr);

    // --- End-of-week review ---------------------------------------------
    // On the last working day (and the weekend after it) there is no week left
    // to reschedule into, so unfinished task-backed work is offered as a single
    // carry-over decision per incomplete task instead. Uses the LOGICAL day so
    // the small hours before rollover still belong to the previous day.
    const endOfWeek = isEndOfWeekReview(logicalDayStart, ctx.config.scheduling?.workingDays);
    // Portal-done tasks ("waiting on others"): finished the user's part, awaiting
    // someone else to close in Asana. Reviewed at end of week so he can complete
    // them in Asana too, leave them waiting, or reopen them. Title comes from the
    // live Asana name where the task is still fetchable, else the snapshot taken
    // when it was flagged, so the row renders without an extra fetch.
    const waiting = endOfWeek
      ? Object.entries(taskMetadata)
          .filter(([, m]) => m?.portalDone)
          .map(([gid, m]) => ({
            gid,
            integrationId: m.integrationId,
            title: ctx.asanaNameByGid.get(gid) ?? m.portalDoneTitle ?? 'Task',
            portalDoneAt: m.portalDoneAt ?? m.updatedAt,
          }))
      : [];
    // Missed + unplaceable blocks that are task-backed. Rituals and meeting-prep
    // blocks have no entry in carryTasksByEvent, so they are excluded by
    // construction — next week's plan recreates rituals, and prep belongs to its
    // meeting. mergeCarryBlocks then folds a grouped category's sibling blocks
    // (several blocks over one shared agenda) into a single card and lists each
    // task exactly once, so the review never asks about the same task twice.
    const carryCandidates: Array<Omit<ReplanCarryBlock, 'mergedEventIds'>> = endOfWeek
      ? [
          ...result.moves
            .filter(m => m.reason === 'missed')
            .map(m => ({
              googleEventId: m.googleEventId,
              googleIntegrationId: m.googleIntegrationId,
              category: m.category,
              titles: m.titles,
              date: m.oldDate,
              start: m.oldStart,
              durationMinutes: m.durationMinutes,
              reason: 'missed' as const,
              tasks: carryTasksByEvent.get(m.googleEventId) ?? [],
            })),
          ...unplaceable.map(u => ({
            googleEventId: u.googleEventId,
            googleIntegrationId: u.googleIntegrationId,
            category: u.category,
            titles: u.titles,
            date: u.oldDate,
            start: u.oldStart,
            durationMinutes: u.durationMinutes,
            reason: 'unplaceable' as const,
            tasks: carryTasksByEvent.get(u.googleEventId) ?? [],
          })),
        ]
      : [];
    // Belt and braces: never ask about a ritual. A ritual block has no backing
    // task so it cannot reach here — but a ritual the user created by hand with
    // no emoji ("Emails") may have been ADOPTED as an ad-hoc task by an earlier
    // review, and that task would otherwise show up as a carry card.
    const carryBlocks: ReplanCarryBlock[] = mergeCarryBlocks(
      carryCandidates
        .filter(
          b =>
            !(b.titles.length > 0 && b.titles.every(isRitualLikeTitle)) &&
            !(b.tasks.length > 0 && b.tasks.every(t => isRitualLikeTitle(t.title)))
        )
        .map(b => ({ ...b, mergedEventIds: [] }))
    );

    // Catch-up context for the modal. `missedWorkingDays` counts only configured
    // working days (weekends/OOO don't count) strictly between the window start
    // and today, so the copy can reassure rather than guilt. OOO covers just the
    // current week (all we fetched) — prior-week days simply aren't excludable.
    const reviewWindowStartDate = logicalTodayDate(new Date(reviewStartMs), rolloverHour);
    const review = {
      sinceIso: hadReview ? new Date(reviewStartMs).toISOString() : null,
      missedWorkingDays: countMissedWorkingDays(
        reviewWindowStartDate,
        logicalDayStart,
        ctx.config.scheduling?.workingDays,
        ctx.outOfOfficeDates
      ),
      clamped,
    };

    return NextResponse.json({
      weekStart: ctx.weekStartStr,
      weekEnd: ctx.weekEndStr,
      ...result,
      endOfWeek,
      review,
      // Only present in end-of-week mode; the rest of the payload is byte-for-byte
      // what a mid-week analyze has always returned.
      ...(endOfWeek ? { carryBlocks, waiting } : {}),
      // Ritual additions (from planReplan) plus prep additions for early-next-week
      // meetings. Both are ProposedBlocks; the confirm route creates each by kind.
      additions: [...result.additions, ...prepAdditions],
      unplaceable,
      stale,
      tomorrowBlocks,
      moveCandidates,
      reviewBlocks,
      // The unscheduled General-Todos pool the user picks from to fill `freeSlots`
      // (from planReplan). freeSlots rides through in `...result`.
      todoCandidates,
    });
  } catch (error) {
    console.error('Error analyzing mid-week replan:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to analyze replan' },
      { status: 500 }
    );
  }
}
