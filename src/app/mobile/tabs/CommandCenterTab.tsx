'use client';

import { CalendarClock } from 'lucide-react';
import { CalendarEvent, DelegationQueueEntry, TaskMetadata } from '@/types';
import { DashboardCapacityResponse } from '@/lib/api';
import { CapacityWidget } from '@/components/dashboard/CapacityWidget';
import { ClientTimeWidget } from '@/components/dashboard/ClientTimeWidget';
import { DelegationWidget } from '@/components/dashboard/DelegationWidget';
import { WaitingWidget } from '@/components/dashboard/WaitingWidget';
import { MobileReviewCard } from '../command-center/MobileReviewCard';
import { MobileTodayCard } from '../command-center/MobileTodayCard';
import { MobileTopTasks } from '../command-center/MobileTopTasks';
import { MobileAiRunnable } from '../command-center/MobileAiRunnable';
import { MobileTriageActions } from '../command-center/MobileTriageActions';

interface Integration {
  id: string;
  name: string;
}

// Single-column phone adaptation of the desktop Command Center. CapacityWidget,
// ClientTimeWidget and DelegationWidget are the desktop components (content-
// sized, touch-safe); Today / Top Tasks / AI-runnable are mobile rebuilds.
export function CommandCenterTab({
  todayEvents,
  asanaTasks,
  metadataByGid,
  delegationByGid,
  capacityData,
  capacityLoading,
  timeWorkedByIntegration,
  timeScheduledByIntegration,
  rolloverHour,
  asanaIntegrations,
  completedTaskGids,
  onExpandToDay,
  onOpenTask,
  onDelegateTask,
  onReloadMetadata,
  onDeleteTask,
  onDataChanged,
  reviewDue,
  onStartReview,
  onReplan,
  onResetWeek,
  onPlanWeek,
}: {
  todayEvents: CalendarEvent[]; // logical today's timed events
  asanaTasks: CalendarEvent[]; // incomplete Asana tasks
  metadataByGid: Record<string, TaskMetadata>;
  delegationByGid: Record<string, DelegationQueueEntry>;
  capacityData: DashboardCapacityResponse | null;
  capacityLoading: boolean;
  timeWorkedByIntegration: Record<string, number>;
  timeScheduledByIntegration: Record<string, number>;
  rolloverHour: number;
  asanaIntegrations: Integration[];
  completedTaskGids: Set<string>;
  onExpandToDay: () => void;
  onOpenTask: (taskOrGid: CalendarEvent | string) => void;
  onDelegateTask: (task: CalendarEvent) => void;
  onReloadMetadata: () => Promise<void>;
  onDeleteTask: (taskId: string, integrationId: string) => Promise<boolean>;
  onDataChanged: () => void;
  reviewDue: boolean;
  onStartReview: () => void;
  onReplan: () => void;
  onResetWeek: () => void;
  // Opens the full-screen plan-my-week wizard. Optional so callers that don't
  // wire it simply omit the entry point.
  onPlanWeek?: () => void;
}) {
  return (
    <div className="space-y-4">
      <MobileReviewCard
        reviewDue={reviewDue}
        onStartReview={onStartReview}
        onReplan={onReplan}
        onResetWeek={onResetWeek}
      />

      {onPlanWeek && (
        <button
          type="button"
          onClick={onPlanWeek}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-orange-500 py-3 text-sm font-semibold text-white shadow-sm active:bg-orange-600"
        >
          <CalendarClock className="h-4 w-4" />
          Plan my week
        </button>
      )}

      <MobileTodayCard
        events={todayEvents}
        rolloverHour={rolloverHour}
        onExpand={onExpandToDay}
      />

      <MobileTriageActions
        tasks={asanaTasks}
        onOpenTask={onOpenTask}
        onReloadMetadata={onReloadMetadata}
        onDeleteTask={onDeleteTask}
        onDataChanged={onDataChanged}
      />

      <ClientTimeWidget
        timeWorkedByIntegration={timeWorkedByIntegration}
        timeScheduledByIntegration={timeScheduledByIntegration}
        integrations={asanaIntegrations}
      />

      <CapacityWidget
        rows={capacityData?.weekProgress ?? []}
        planned={capacityData?.weekPlanned ?? false}
        isLoading={capacityLoading}
      />

      <MobileTopTasks
        tasks={asanaTasks}
        metadataByGid={metadataByGid}
        onTaskClick={onOpenTask}
      />

      <MobileAiRunnable
        tasks={asanaTasks}
        metadataByGid={metadataByGid}
        delegationByGid={delegationByGid}
        onTaskClick={onOpenTask}
        onDelegate={onDelegateTask}
      />

      <WaitingWidget
        onTaskClick={onOpenTask}
        onChanged={() => {
          onReloadMetadata();
          onDataChanged();
        }}
      />

      {/* Plain wrapper (no h-full flex parent) so the widget sizes to content. */}
      <div>
        <DelegationWidget
          delegationByGid={delegationByGid}
          onTaskClick={onOpenTask}
          completedTaskGids={completedTaskGids}
        />
      </div>
    </div>
  );
}
