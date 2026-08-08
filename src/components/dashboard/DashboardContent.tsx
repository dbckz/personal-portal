'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Bot, Loader2, Archive, RefreshCw, ClipboardCheck, Search, ChevronDown } from 'lucide-react';

import { CalendarEvent, DelegationQueueEntry, TaskMetadata } from '@/types';
import type { AsanaTypeFieldInfo } from '@/components/CreateAsanaTaskModal';
import { api, DashboardCapacityResponse, type WeekStateResponse, type AiClaim } from '@/lib/api';
import type { UnscheduledTask } from '@/lib/weekly-stats';
import { WEEK_ACTION_LABELS, targetWeekForAction, type WeekAction } from '@/lib/scheduling/week-state';
import { usePlanningNudge } from '@/hooks/usePlanningNudge';
import { useReflectionNudge } from '@/hooks/useReflectionNudge';
import { TodayColumn } from './TodayColumn';
import { TopTasks } from './TopTasks';
import { CapacityWidget } from './CapacityWidget';
import { ClientTimeWidget, formatDuration } from './ClientTimeWidget';
import { DelegationWidget } from './DelegationWidget';
import { LeftUnscheduledWidget } from './LeftUnscheduledWidget';
import { AiRunnableTasks } from './AiRunnableTasks';
import { StaleTasksModal } from './StaleTasksModal';
import { PlanWeekModal } from './PlanWeekModal';
import { ReplanWeekModal } from './ReplanWeekModal';
import { DailyReviewModal } from './DailyReviewModal';
import { TaskSearchModal } from './TaskSearchModal';
import { AiClaimsModal } from './AiClaimsModal';
import { GoalNudgeCard } from './GoalNudgeCard';
import type { GoalNudge } from '@/lib/goal-progress';

interface Integration {
  id: string;
  name: string;
}

interface DashboardContentProps {
  todayEvents: CalendarEvent[]; // today's timed events (reused from page.tsx)
  asanaTasks: CalendarEvent[]; // incomplete Asana tasks
  metadataByGid: Record<string, TaskMetadata>;
  // Delegation queue from the page-level useDelegationQueue store, rendered by
  // the DelegationWidget. Passed in (rather than fetched in the widget) so a
  // delegate action refreshing that store updates the widget immediately.
  delegationByGid: Record<string, DelegationQueueEntry>;
  // Weekly-capacity data lifted to page.tsx so page-level mutations (task
  // complete/delete, delegation) can trigger a refetch to keep it current.
  capacityData: DashboardCapacityResponse | null;
  capacityLoading: boolean;
  onRefetchCapacity: () => void;
  timeWorkedByIntegration: Record<string, number>;
  // Minutes scheduled today per integration (the denominator of the Time Worked
  // Today bars). Absent → the bars show worked time with nothing to fill toward.
  timeScheduledByIntegration?: Record<string, number>;
  rolloverHour?: number; // logical-day rollover hour, for the Today column label
  asanaIntegrations: Integration[];
  // Per-integration Type field info, for the Plan-my-week "type unclassified
  // tasks" pre-step (find untyped tasks + write chosen Types back to Asana).
  typeFieldInfoByIntegration?: Map<string, AsanaTypeFieldInfo>;
  onOpenTask?: (taskId: string, navIds?: string[]) => void;
  onDelegateTask?: (task: CalendarEvent) => void; // open the compose-brief modal directly
  // GIDs of tasks already completed in Asana — their finished runs are hidden
  // from the For-review inbox (completed elsewhere, nothing left to triage).
  completedTaskGids?: Set<string>;
  onReloadMetadata?: () => Promise<void> | void; // refresh aiDelegable flags after re-assessment
  onDeleteTask?: (taskId: string, integrationId: string) => void; // optimistic delete (stale triage)
  onPlanApplied?: () => void; // refresh calendar/asana data after applying a plan
  // Stale-triage modal open state is lifted to page.tsx so the in-place task
  // dialog (rendered there) can sit on top of it with a Back affordance.
  staleModalOpen?: boolean;
  onStaleModalOpenChange?: (open: boolean) => void;
  // A task dialog is open on top of the triage modal (suppresses its Escape).
  taskDialogOpen?: boolean;
  // Double-clicking the Today heading switches to the Daily Calendar tab.
  onExpandToCalendar?: () => void;
  // Mid-period goal nudges, lifted to page.tsx so the Goals section's badge and
  // this card read from one fetch.
  goalNudges?: GoalNudge[];
  onOpenGoals?: () => void;
}

// Fixed, viewport-height three-column layout — nothing scrolls the page itself;
// each box scrolls or paginates internally.
export function DashboardContent({
  todayEvents,
  asanaTasks,
  metadataByGid,
  delegationByGid,
  capacityData,
  capacityLoading,
  onRefetchCapacity,
  timeWorkedByIntegration,
  timeScheduledByIntegration,
  rolloverHour,
  asanaIntegrations,
  typeFieldInfoByIntegration,
  onOpenTask,
  onDelegateTask,
  completedTaskGids,
  onReloadMetadata,
  onDeleteTask,
  onPlanApplied,
  staleModalOpen = false,
  onStaleModalOpenChange,
  taskDialogOpen,
  onExpandToCalendar,
  goalNudges = [],
  onOpenGoals,
}: DashboardContentProps) {
  const data = capacityData;
  const isLoading = capacityLoading;
  // Every connected workspace appears, including one with no time this week — a
  // zero is information, a missing row reads as a bug.
  const weekWorked = useMemo(() => {
    const byId = new Map((capacityData?.weekWorkedByIntegration ?? []).map(r => [r.integrationId, r]));
    return asanaIntegrations.map(i => ({
      integrationId: i.id,
      integrationName: i.name,
      totalMinutes: byId.get(i.id)?.totalMinutes ?? 0,
    }));
  }, [capacityData, asanaIntegrations]);
  const refetch = onRefetchCapacity;
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showReplanModal, setShowReplanModal] = useState(false);
  const [showDailyReviewModal, setShowDailyReviewModal] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(false);
  // Which week the plan / replan modals are working on. Set by whichever entry
  // point opened them, so "Plan next week" plans next week and nothing else has
  // to know about the state machine.
  const [planWeekStart, setPlanWeekStart] = useState<string | undefined>(undefined);
  const [replanWeekStart, setReplanWeekStart] = useState<string | undefined>(undefined);

  // The adaptive primary button's state. Cheap (local stores only), refetched
  // whenever a plan/review is applied so the button keeps up.
  const [weekState, setWeekState] = useState<WeekStateResponse | null>(null);
  const [showActionMenu, setShowActionMenu] = useState(false);

  // Friday wrap-up / Sunday plan-next-week reminders, through the same
  // notification toggle as the event alerts.
  usePlanningNudge(weekState, rolloverHour);
  // Month-end / quarter-end reflection reminders, through the same toggle.
  useReflectionNudge(weekState?.workingDays);

  const loadWeekState = useCallback(() => {
    api.getWeekState()
      .then(setWeekState)
      .catch(() => setWeekState(null));
  }, []);
  useEffect(() => loadWeekState(), [loadWeekState]);

  // Tasks planned into this week that then slid out of the schedule (deferred /
  // carried) — surfaced in the "Left unscheduled" widget so they aren't lost.
  // Refetched whenever a plan / replan / review applies, since those are what
  // move a task out of the schedule.
  const [unscheduled, setUnscheduled] = useState<UnscheduledTask[]>([]);
  const loadUnscheduled = useCallback(() => {
    api.getUnscheduledTasks()
      .then(r => setUnscheduled(r.tasks))
      .catch(() => setUnscheduled([]));
  }, []);
  useEffect(() => loadUnscheduled(), [loadUnscheduled]);

  // Open the wizard / replan on a given week. `week` is 'current' or 'next';
  // undefined weekStart means "the current week" to every downstream endpoint.
  const openPlan = useCallback((week: 'current' | 'next') => {
    setPlanWeekStart(week === 'next' ? weekState?.nextWeekStart : undefined);
    setShowPlanModal(true);
  }, [weekState]);
  const openReplan = useCallback((week: 'current' | 'next') => {
    setReplanWeekStart(week === 'next' ? weekState?.nextWeekStart : undefined);
    setShowReplanModal(true);
  }, [weekState]);

  // Fall back to "Plan this week" until the state loads (or if it fails) — the
  // menu below still offers every action, so nothing is ever unreachable.
  const action: WeekAction = weekState?.action ?? 'plan-this-week';
  const actionCopy = WEEK_ACTION_LABELS[action];

  const runAction = useCallback((a: WeekAction) => {
    const week = targetWeekForAction(a);
    if (a === 'wrap-up') setShowDailyReviewModal(true);
    else if (a === 'replan' || a === 'replan-next-week') openReplan(week);
    else openPlan(week);
  }, [openPlan, openReplan]);

  // Escape hatch: every action, always, whatever the derived state says. Dave
  // comes back from a week off to a state machine that can't know what he wants.
  const menuItems: Array<{ label: string; run: () => void }> = [
    { label: 'Plan this week', run: () => openPlan('current') },
    { label: 'Plan next week', run: () => openPlan('next') },
    { label: 'Replan this week', run: () => openReplan('current') },
    { label: 'Replan next week', run: () => openReplan('next') },
    { label: 'Daily review', run: () => setShowDailyReviewModal(true) },
  ];

  // Incomplete Asana tasks for the Cmd/Ctrl+F search palette.
  const searchTasks = useMemo(() => asanaTasks.filter(t => !t.completed), [asanaTasks]);

  // Cmd/Ctrl+F opens the task search palette (preventing the browser's native
  // find). Suppressed while the stale-triage modal or a task dialog is open so
  // we don't stack over their own inputs. Pressing it again while search is
  // open keeps it open and refocuses the input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'f' || !(e.metaKey || e.ctrlKey)) return;
      if (staleModalOpen || taskDialogOpen) return;
      e.preventDefault();
      if (showSearchModal) {
        document.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')?.focus();
      } else {
        setShowSearchModal(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [staleModalOpen, taskDialogOpen, showSearchModal]);

  const [isReassessing, setIsReassessing] = useState(false);
  const [reassessNote, setReassessNote] = useState<string | null>(null);
  // Manual assessment is GATED: new AI-runnable claims wait in this modal for
  // Dave to confirm before they join the list.
  const [aiClaims, setAiClaims] = useState<AiClaim[] | null>(null);

  const handleReassess = useCallback(async () => {
    setIsReassessing(true);
    setReassessNote(null);
    try {
      const payload = asanaTasks
        .filter(t => !t.completed && t.integrationId)
        .map(t => ({
          gid: t.id,
          integrationId: t.integrationId as string,
          title: t.title,
          description: t.description,
          integrationName: t.integrationName,
          dueOn: t.dueOn,
        }));
      // 'review' mode: nothing newly claimed lands in the list until confirmed.
      const r = await api.classifyAiTasks(payload, 'review');
      await onReloadMetadata?.();
      setReassessNote(
        `Assessed ${r.assessed}, ${r.cached} unchanged${r.changed ? `, ${r.changed} updated` : ''}.`
      );
      // Always open the review — an empty result gets its own empty state rather
      // than the button appearing to do nothing.
      setAiClaims(r.claims ?? []);
    } catch (err) {
      setReassessNote(err instanceof Error ? err.message : 'Re-assessment failed.');
    } finally {
      setIsReassessing(false);
    }
  }, [asanaTasks, onReloadMetadata]);

  return (
    <div className="h-full flex flex-col p-4 md:p-6 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0 gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-xl font-semibold text-gray-900">Command Center</h1>
          {/* Work done this week (Mon–Sun) per client, from the durable weekly
              record so it survives a week reset. */}
          {weekWorked.length > 0 && (
            <p className="text-xs text-gray-500 truncate">
              <span className="text-gray-400">Work done this week: </span>
              {weekWorked.map((row, i) => (
                <span key={row.integrationId}>
                  {i > 0 && <span className="text-gray-300"> · </span>}
                  <span className="font-medium text-gray-700">{row.integrationName}</span>{' '}
                  {formatDuration(row.totalMinutes)}
                </span>
              ))}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {reassessNote && <span className="text-xs text-gray-500 hidden lg:inline">{reassessNote}</span>}
          <button
            onClick={() => setShowSearchModal(true)}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            title="Search all tasks (⌘F)"
          >
            <Search className="w-4 h-4" /> Search
          </button>
          <button
            onClick={() => onStaleModalOpenChange?.(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
            title="Review tasks that look old / stale and delete or keep them"
          >
            <Archive className="w-4 h-4" /> Triage stale
          </button>
          <button
            onClick={handleReassess}
            disabled={isReassessing}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Re-assess which incomplete tasks an agent could run (cached — only changed tasks are re-checked)"
          >
            {isReassessing
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Assessing AI-runnable…</>
              : <><Bot className="w-4 h-4" /> Assess AI-runnable</>}
          </button>
          <button
            onClick={() => setShowDailyReviewModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border border-orange-300 text-orange-700 rounded-lg hover:bg-orange-50 transition-colors"
            title="Review what got done today, then replan the rest of the week"
          >
            <ClipboardCheck className="w-4 h-4" />
            Daily review
          </button>
          {/* One adaptive planning button: its label follows the week state
              (plan / replan / wrap up / plan next week). The ▾ beside it always
              lists every action, so no state can trap the user. */}
          <div className="flex items-center">
            {/* The caption hangs below the button (absolute) so the split button
                stays on the same baseline as the rest of the header row. */}
            <div className="relative">
              <div className="flex">
                <button
                  onClick={() => runAction(action)}
                  title={actionCopy.title}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-orange-500 text-white rounded-l-lg hover:bg-orange-600 transition-colors"
                >
                  {action === 'replan' || action === 'replan-next-week' ? (
                    <RefreshCw className="w-4 h-4" />
                  ) : action === 'wrap-up' ? (
                    <ClipboardCheck className="w-4 h-4" />
                  ) : (
                    <CalendarClock className="w-4 h-4" />
                  )}
                  {actionCopy.label}
                </button>
                <div className="relative">
                  <button
                    onClick={() => setShowActionMenu(v => !v)}
                    aria-haspopup="menu"
                    aria-expanded={showActionMenu}
                    aria-label="All planning actions"
                    title="All planning actions"
                    className="inline-flex items-center px-2 py-2 text-sm font-medium bg-orange-500 text-white rounded-r-lg border-l border-orange-400 hover:bg-orange-600 transition-colors h-full"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                  {showActionMenu && (
                    <>
                      {/* Click-away layer */}
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setShowActionMenu(false)}
                      />
                      <div
                        role="menu"
                        className="absolute right-0 top-full mt-1 z-50 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
                      >
                        {menuItems.map(item => (
                          <button
                            key={item.label}
                            role="menuitem"
                            onClick={() => {
                              setShowActionMenu(false);
                              item.run();
                            }}
                            className="block w-full px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50"
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
              {actionCopy.caption && (
                <span className="absolute right-0 top-full mt-0.5 whitespace-nowrap text-[11px] text-gray-400">
                  {actionCopy.caption}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Goals past halfway through their period with nothing to show. Renders
          nothing when there is nothing to flag, so it costs no height most days. */}
      {goalNudges.length > 0 && onOpenGoals && (
        <div className="mb-4 flex-shrink-0">
          <GoalNudgeCard nudges={goalNudges} onOpenGoals={onOpenGoals} />
        </div>
      )}

      {/* Fixed 3-column grid filling the remaining height. min-w-0 on every grid
          item lets columns shrink to their track instead of being forced wider by
          long unbroken content (e.g. a bare URL), which would clash with the next
          column. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        {/* Left: Today (single box, internal scroll) */}
        <div className="min-h-0 min-w-0 h-full">
          <TodayColumn
            events={todayEvents}
            rolloverHour={rolloverHour}
            onTaskClick={onOpenTask}
            onExpandToCalendar={onExpandToCalendar}
          />
        </div>

        {/* Middle: Top Tasks + AI-runnable, each half height, paginated */}
        <div className="min-h-0 min-w-0 grid grid-rows-2 gap-4 md:gap-6">
          <div className="min-h-0 min-w-0">
            <TopTasks tasks={asanaTasks} metadataByGid={metadataByGid} onTaskClick={onOpenTask} />
          </div>
          <div className="min-h-0 min-w-0">
            <AiRunnableTasks
              tasks={asanaTasks}
              metadataByGid={metadataByGid}
              delegationByGid={delegationByGid}
              onTaskClick={onOpenTask}
              onDelegate={onDelegateTask}
            />
          </div>
        </div>

        {/* Right: Weekly Capacity + Time Worked size to their content (no scroll);
            Delegation takes the remaining height and scrolls internally. */}
        <div className="min-h-0 min-w-0 flex flex-col gap-4 md:gap-6">
          <div className="flex-shrink-0 min-w-0">
            <CapacityWidget
              rows={data?.weekProgress ?? []}
              planned={data?.weekPlanned ?? false}
              isLoading={isLoading}
            />
          </div>
          <div className="flex-shrink-0 min-w-0">
            <ClientTimeWidget
              timeWorkedByIntegration={timeWorkedByIntegration}
              timeScheduledByIntegration={timeScheduledByIntegration}
              integrations={asanaIntegrations}
            />
          </div>
          {unscheduled.length > 0 && (
            <div className="flex-shrink-0 min-w-0">
              <LeftUnscheduledWidget tasks={unscheduled} />
            </div>
          )}
          <div className="flex-1 min-h-0 min-w-0">
            <DelegationWidget
              delegationByGid={delegationByGid}
              onTaskClick={onOpenTask}
              completedTaskGids={completedTaskGids}
            />
          </div>
        </div>
      </div>

      <AiClaimsModal
        isOpen={aiClaims !== null}
        claims={aiClaims ?? []}
        onClose={() => setAiClaims(null)}
        onApplied={() => {
          onReloadMetadata?.();
          refetch();
        }}
      />

      {showSearchModal && (
        <TaskSearchModal
          tasks={searchTasks}
          onClose={() => setShowSearchModal(false)}
          onOpenTask={onOpenTask}
        />
      )}

      {staleModalOpen && (
        <StaleTasksModal
          tasks={asanaTasks}
          onClose={() => onStaleModalOpenChange?.(false)}
          onOpenTask={onOpenTask}
          onDeleteTask={onDeleteTask}
          childDialogOpen={taskDialogOpen}
        />
      )}

      <PlanWeekModal
        isOpen={showPlanModal}
        onClose={() => setShowPlanModal(false)}
        weekStart={planWeekStart}
        asanaTasks={asanaTasks}
        typeFieldInfoByIntegration={typeFieldInfoByIntegration}
        asanaIntegrations={asanaIntegrations}
        onApplied={() => {
          refetch();
          loadWeekState();
          loadUnscheduled();
          onPlanApplied?.();
        }}
      />

      <DailyReviewModal
        // The workspaces offered by the "worked on something else" answer. The
        // picker defaults to the first; there is no per-event default because the
        // review's blocks are fetched inside the modal, so the mapping from an
        // event to its calendar's workspace isn't available out here.
        workspaceOptions={asanaIntegrations}
        isOpen={showDailyReviewModal}
        onClose={() => setShowDailyReviewModal(false)}
        onApplied={() => {
          refetch();
          loadWeekState();
          loadUnscheduled();
          onPlanApplied?.();
        }}
      />

      <ReplanWeekModal
        isOpen={showReplanModal}
        onClose={() => setShowReplanModal(false)}
        weekStart={replanWeekStart}
        onApplied={() => {
          refetch();
          loadWeekState();
          loadUnscheduled();
          onPlanApplied?.();
        }}
        onStartFromScratch={() => {
          // Reset chained into a fresh plan: refresh data, close replan, open the
          // wizard on the same week that was just reset.
          refetch();
          loadWeekState();
          loadUnscheduled();
          onPlanApplied?.();
          setShowReplanModal(false);
          setPlanWeekStart(replanWeekStart);
          setShowPlanModal(true);
        }}
      />
    </div>
  );
}
