import { NextRequest, NextResponse } from 'next/server';

import { classifyBlockCategoryWithCatchAll } from '@/lib/capacity';
import { gatherWeekContext } from '@/lib/scheduling/gather';
import { proposeBlocks, localDateStr, computeSpareCapacity, resolveWorkingWindow, effectiveWeeklyCount, type UnplaceableTask } from '@/lib/scheduling/engine';
import {
  placeWeekRituals,
  placeOfficeAndTravelBlocks,
  sanitizeDayLocations,
  proposedBlockToBusyInterval,
  existingRitualTitlesByDateFromEvents,
  isTravelTitle,
  EXERCISE_TITLE,
} from '@/lib/scheduling/rituals';
import { proposeBreakBlocks } from '@/lib/scheduling/breaks';
import type { CandidateTask, ProposedBlock } from '@/lib/scheduling/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const selections: Record<string, string[]> | undefined =
      body?.selections && typeof body.selections === 'object' ? body.selections : undefined;
    const priorityGids: string[] = Array.isArray(body?.priorityGids) ? body.priorityGids : [];
    // Task ids (gid or adhocId) flagged "must do this week" in the wizard. Marked
    // isPriority so they sort first within their category (taskSortKey) and are
    // never dropped by a selection cap.
    const mustDoIds: string[] = Array.isArray(body?.mustDoIds) ? body.mustDoIds : [];
    const categoryOverrides: Record<string, string> =
      body?.categoryOverrides && typeof body.categoryOverrides === 'object' ? body.categoryOverrides : {};
    const prepBlocks: ProposedBlock[] = Array.isArray(body?.prepBlocks) ? body.prepBlocks : [];

    // Per-week block-length overrides (minutes). `durationOverrides` is keyed by
    // category (now used only for grouped categories, whose blocks are shared
    // containers); `taskDurationOverrides` is keyed by task id (gid/adhocId) for
    // single-task blocks. Keep only positive finite numbers, round to int, cap at
    // 480 (8h). Neither modifies the saved workflow config.
    const sanitizeDurations = (raw: unknown): Record<string, number> => {
      const out: Record<string, number> = {};
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          const n = Number(value);
          if (Number.isFinite(n) && n > 0) out[key] = Math.min(480, Math.round(n));
        }
      }
      return out;
    };
    const durationOverrides = sanitizeDurations(body?.durationOverrides);
    const taskDurationOverrides = sanitizeDurations(body?.taskDurationOverrides);

    // Days (yyyy-MM-dd) the user opted a 🚶 walk into, from the wizard. Kept only
    // when they are well-formed date strings inside this plan's week; the ritual
    // placer further restricts them to actual working days.
    const rawWalkDays: string[] = Array.isArray(body?.walkDays)
      ? body.walkDays.filter((d: unknown): d is string => typeof d === 'string')
      : [];

    const ctx = await gatherWeekContext(typeof body?.weekStart === 'string' ? body.weekStart : undefined);

    const weekDateStrs = new Set<string>();
    for (let d = 0; d < 7; d++) {
      const day = new Date(ctx.weekStart);
      day.setDate(day.getDate() + d);
      weekDateStrs.add(localDateStr(day));
    }
    const walkDays = rawWalkDays.filter(d => weekDateStrs.has(d));

    // Per-day work location (Home / Office / Travelling), from the wizard's
    // Location step. Office days get a get-ready + commute pair (and cap deep
    // work); travel days get a fixed travel block. The placer further restricts to
    // actual working days.
    const dayLocations = sanitizeDayLocations(body?.dayLocations, weekDateStrs);

    // DAILY rituals (walk / lunch / exercise / emails) are placed FIRST (before
    // task allocation), around the calendar's existing busy time + any accepted
    // prep blocks, so tasks flow around them. A day that already has a ritual event
    // ("🍽️ Lunch" / "🏋️ Exercise" / "📧 Emails") is skipped for that ritual
    // (dedupe by exact title from the week's events). The prep-candidates route
    // places rituals with the SAME helper + inputs BEFORE proposing prep, so prep
    // never steals the exercise slot; the accepted prep it hands back here never
    // overlaps the ritual slots, so this pass re-derives identical placements.
    //
    // The WEEKLY WORK rituals (kindle / delegation review / grooming / retro /
    // new bookies / reading) are placed LATER — AFTER task blocks — so deep work
    // claims the mornings first and the weekly rituals fit around it (Dave's rule:
    // deep work has first claim on the mornings, everything else fits around it).
    const prepIntervals = prepBlocks.map(proposedBlockToBusyInterval);

    // Office / travel blocks are placed FIRST (before the daily rituals), around
    // the calendar's existing busy time + accepted prep, so the get-ready/commute
    // pair takes its late-morning slot and travel blocks reserve their time before
    // anything else fills in. Office days also yield a per-day deep-work end cap
    // (the get-ready block's start), passed to the engine so deep work stops there.
    const existingRitualTitlesByDate = existingRitualTitlesByDateFromEvents(ctx.weekEvents);
    const existingTravelDates = new Set<string>();
    for (const e of ctx.weekEvents) {
      if (!e.allDay && e.title && isTravelTitle(e.title)) {
        existingTravelDates.add(localDateStr(e.startTime));
      }
    }
    const { blocks: officeTravelBlocks, deepWorkEndByDate } = placeOfficeAndTravelBlocks({
      config: ctx.config,
      busyIntervals: [...ctx.busyIntervals, ...prepIntervals],
      weekStart: ctx.weekStart,
      now: ctx.now,
      dayLocations,
      existingRitualTitlesByDate,
      existingTravelDates,
      outOfOfficeDates: ctx.outOfOfficeDates,
    });
    const officeTravelIntervals = officeTravelBlocks.map(proposedBlockToBusyInterval);

    const dailyRituals = placeWeekRituals({
      config: ctx.config,
      weekEvents: ctx.weekEvents,
      busyIntervals: [...ctx.busyIntervals, ...prepIntervals, ...officeTravelIntervals],
      weekStart: ctx.weekStart,
      now: ctx.now,
      outOfOfficeDates: ctx.outOfOfficeDates,
      walkDays,
      phase: 'daily',
    });

    // Accepted prep + office/travel + placed daily ritual blocks occupy time
    // before task placement (breaks tagged so they split work runs).
    const busyIntervals = [
      ...ctx.busyIntervals,
      ...prepIntervals,
      ...officeTravelIntervals,
      ...dailyRituals.map(proposedBlockToBusyInterval),
    ];

    const priorityIds = new Set(priorityGids);
    const mustDoSet = new Set(mustDoIds);
    const autoSelectByCategory = new Map(
      Object.entries(ctx.config.taskQuotas).map(([category, quota]) => [category, quota.autoSelect === true])
    );
    const selectionSets = selections
      ? new Map(Object.entries(selections).map(([cat, ids]) => [cat, new Set(ids)]))
      : null;

    // Apply priority flags + category overrides, then (when the caller supplied
    // selections) drop candidates the user did not pick for manual categories.
    // Count the surviving manual picks per category so the engine can honour
    // explicit over-quota selection (place a block per pick, not just up to quota).
    const candidateTasks: CandidateTask[] = [];
    const selectedCountsByCategory: Record<string, number> = {};
    for (const task of ctx.candidateTasks) {
      const id = task.gid ?? task.adhocId ?? '';
      const overrideCategory = categoryOverrides[id];
      const typeSignals = overrideCategory ? [overrideCategory] : task.typeSignals;
      const withFlags: CandidateTask = {
        ...task,
        typeSignals,
        isPriority:
          mustDoSet.has(id) || (task.gid ? priorityIds.has(task.gid) : task.isPriority),
      };

      if (selectionSets) {
        const category = classifyBlockCategoryWithCatchAll(typeSignals, ctx.quotas);
        if (category && !autoSelectByCategory.get(category)) {
          const picked = selectionSets.get(category);
          // Manual category the user didn't pick for at all → no candidates
          // (its quota fills as Reserved time). Picked category → only its ids.
          if (!picked || !picked.has(id)) continue;
          selectedCountsByCategory[category] = (selectedCountsByCategory[category] ?? 0) + 1;
        }
      }

      candidateTasks.push(withFlags);
    }

    // Real tasks the engine could place nowhere (not even evening overflow), so
    // the review step can explain why a must-do went unscheduled.
    const unplaceable: UnplaceableTask[] = [];
    const taskBlocks = proposeBlocks({
      config: ctx.config,
      busyIntervals,
      candidateTasks,
      existingScheduledCounts: ctx.existingScheduledCounts,
      existingCategoryCountsByDate: ctx.existingCategoryCountsByDate,
      durationOverridesByCategory: Object.keys(durationOverrides).length ? durationOverrides : undefined,
      durationOverridesByTask: Object.keys(taskDurationOverrides).length ? taskDurationOverrides : undefined,
      selectedCountsByCategory: selectionSets ? selectedCountsByCategory : undefined,
      weekStart: ctx.weekStart,
      now: ctx.now,
      outOfOfficeDates: ctx.outOfOfficeDates,
      perDayDeepWorkEndMs: Object.keys(deepWorkEndByDate).length ? deepWorkEndByDate : undefined,
    }, unplaceable);

    // WEEKLY WORK rituals placed AFTER task blocks: deep work (placed first inside
    // proposeBlocks) has already claimed the mornings, so these fit around it —
    // afternoon-preferred with a morning fallback only for space deep work left.
    const busyWithTasks = [
      ...busyIntervals,
      ...taskBlocks.map(proposedBlockToBusyInterval),
    ];
    const weeklyRituals = placeWeekRituals({
      config: ctx.config,
      weekEvents: ctx.weekEvents,
      busyIntervals: busyWithTasks,
      weekStart: ctx.weekStart,
      now: ctx.now,
      outOfOfficeDates: ctx.outOfOfficeDates,
      walkDays,
      phase: 'weekly',
    });
    const ritualBlocks = [...officeTravelBlocks, ...dailyRituals, ...weeklyRituals];

    const { workRun, workingDays, configuredWorkingDaysPerWeek, availableWorkingDaysPerWeek } =
      resolveWorkingWindow(ctx.config.scheduling, ctx.weekStart, ctx.now, ctx.outOfOfficeDates);

    // --- Break gaps (post-placement) ---
    // After ALL proposals are placed (rituals + prep + tasks), turn the buffer the
    // work-run rule leaves after each ~2h run into visible "☕ Break" events. Fed
    // the FINAL busy timeline (calendar busy + prep + daily + weekly rituals +
    // every task block).
    const finalBusyForBreaks = [
      ...busyWithTasks,
      ...weeklyRituals.map(proposedBlockToBusyInterval),
    ];
    const breakBlocks = proposeBreakBlocks({
      workingDays,
      busyIntervals: finalBusyForBreaks,
      workRun,
      now: ctx.now,
    });

    // Prep + ritual + break blocks are shown first, ahead of the task/reserved blocks.
    const proposals = [...prepBlocks, ...ritualBlocks, ...breakBlocks, ...taskBlocks];

    // --- Spare-capacity assessment (computed AFTER all proposals) ---
    // Busy = calendar busy + accepted prep + daily rituals (in busyWithTasks) +
    // every proposed task/reserved block + weekly rituals + break gaps. Measure the
    // usable free work time left in the remaining week under the same
    // working-window and work-run model the engine used.
    const spareBusyMs = [
      ...busyWithTasks,
      ...weeklyRituals.map(proposedBlockToBusyInterval),
      ...breakBlocks.map(proposedBlockToBusyInterval),
    ].map(i => ({
      start: i.start.getTime(),
      end: i.end.getTime(),
      isBreak: i.isBreak,
    }));
    const spareCapacity = computeSpareCapacity(workingDays, spareBusyMs, workRun, ctx.now.getTime());

    // --- Unmet-quota summary (task categories only; prep isn't a quota) ---
    // Optional evening-overflow blocks are default-rejected, so they don't count
    // toward a category's met quota (a category short on working-hours time still
    // reads as unmet even if overflow blocks were offered).
    const proposedByCategory: Record<string, number> = {};
    for (const p of taskBlocks) {
      if (p.overflow) continue;
      proposedByCategory[p.category] = (proposedByCategory[p.category] ?? 0) + 1;
    }
    // Per-category count of candidate tasks the engine received, so the summary's
    // effective target for a scaleToTasks category matches the block count the
    // engine derived from the selection.
    const candidateCountByCategory: Record<string, number> = {};
    for (const t of candidateTasks) {
      const cat = classifyBlockCategoryWithCatchAll(t.typeSignals, ctx.quotas);
      if (cat) candidateCountByCategory[cat] = (candidateCountByCategory[cat] ?? 0) + 1;
    }
    // Effective weekly target honours the daily / scaleToTasks overrides so the
    // summary agrees with how many blocks the engine actually schedules.
    const quotaSummary = ctx.quotas
      .map(q => {
        const cfg = ctx.config.taskQuotas[q.category];
        const weeklyCount = cfg
          ? effectiveWeeklyCount(cfg, {
              remainingWorkingDays: workingDays.length,
              configuredWorkingDaysPerWeek,
              availableWorkingDaysPerWeek,
              selectedTaskCount: candidateCountByCategory[q.category] ?? 0,
            })
          : q.weeklyCount ?? 0;
        const existing = ctx.existingScheduledCounts[q.category] ?? 0;
        const proposed = proposedByCategory[q.category] ?? 0;
        return {
          category: q.category,
          weeklyCount,
          existing,
          proposed,
          unmet: Math.max(0, weeklyCount - existing - proposed),
        };
      })
      .filter(row => row.weeklyCount > 0);

    // --- Exercise coverage (priority-one ritual) ---
    // Working days with no exercise placement in the final proposals OR an
    // existing calendar exercise event. Surfaced so the review step can warn when
    // exercise couldn't be scheduled on a day (no free hour).
    const daysWithExercise = new Set<string>();
    for (const b of ritualBlocks) if (b.title === EXERCISE_TITLE) daysWithExercise.add(b.date);
    for (const e of ctx.weekEvents) {
      if (!e.allDay && e.title?.trim() === EXERCISE_TITLE) daysWithExercise.add(localDateStr(e.startTime));
    }
    const exerciseMissingDays = workingDays
      .map(d => d.dateStr)
      .filter(dateStr => !daysWithExercise.has(dateStr));

    return NextResponse.json({
      weekStart: ctx.weekStartStr,
      weekEnd: ctx.weekEndStr,
      proposals,
      quotaSummary,
      spareCapacity,
      exerciseMissingDays,
      unplaceable,
      // Remaining working days (OOO excluded) — the review step's evening-overflow
      // rows use these as the day-picker options.
      workingDays: workingDays.map(d => d.dateStr),
    });
  } catch (error) {
    console.error('Error proposing weekly plan:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to propose plan' },
      { status: 500 }
    );
  }
}
