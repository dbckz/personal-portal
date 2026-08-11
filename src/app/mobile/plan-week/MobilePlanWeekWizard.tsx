'use client';

import { useEffect } from 'react';
import { X, Loader2, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';

import type { CalendarEvent } from '@/types';
import type { AsanaTypeFieldInfo } from '@/components/CreateAsanaTaskModal';
import { usePlanWeek } from '@/components/dashboard/plan-week/usePlanWeek';
import { TypeStep } from '@/components/dashboard/plan-week/TypeStep';
import { PrepStep } from '@/components/dashboard/plan-week/PrepStep';
import { ReviewStep } from '@/components/dashboard/plan-week/ReviewStep';
import { TaskPeekModal } from '@/components/dashboard/plan-week/TaskPeekModal';
import { MobilePrioritiesStep } from './MobilePrioritiesStep';
import { MobileRemindersStep } from './MobileRemindersStep';
import { MobileTasksStep } from './MobileTasksStep';

interface MobilePlanWeekWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onApplied?: () => void;
  asanaTasks?: CalendarEvent[];
  typeFieldInfoByIntegration?: Map<string, AsanaTypeFieldInfo>;
  asanaIntegrations?: Array<{ id: string; name: string }>;
  weekStart?: string;
}

// Full-screen touch build of the plan-my-week wizard: one step per screen, a top
// progress bar, and a sticky Back / Skip / Next footer. All orchestration comes
// from the shared usePlanWeek hook (identical API sequencing to the desktop
// modal); only the presentation is rebuilt for touch. The Type/Prep/Review steps
// reuse the desktop components (already touch-adequate — checkboxes and native
// selects); Priorities/Reminders/Tasks are touch rebuilds.
export function MobilePlanWeekWizard({
  isOpen,
  onClose,
  weekStart,
  onApplied,
  asanaTasks,
  typeFieldInfoByIntegration,
  asanaIntegrations,
}: MobilePlanWeekWizardProps) {
  const plan = usePlanWeek({
    isOpen,
    weekStart,
    onApplied,
    asanaTasks,
    typeFieldInfoByIntegration,
    asanaIntegrations,
  });

  const {
    step,
    isLoading,
    error,
    weekLabel,
    screenOrder,
    activeIndex,
    untypedTasks,
    typeRows,
    setTypeRows,
    typeLoading,
    typeError,
    isApplyingTypes,
    priorityText,
    setPriorityText,
    matchRows,
    setMatchRows,
    matchMeta,
    createdTasks,
    prioritiesReady,
    reminderRows,
    setReminderRows,
    remindersLoading,
    remindersError,
    remindersProgress,
    reminderProjects,
    isConvertingReminders,
    prepData,
    showOtherMeetings,
    setShowOtherMeetings,
    prepDurations,
    prepDays,
    setPrepDecision,
    changePrepDuration,
    changePrepDay,
    taskCats,
    selections,
    taskDurations,
    setTaskDurations,
    taskDurationOverrides,
    setTaskDurationOverrides,
    mustDoIds,
    walkDays,
    toggleWalkDay,
    completingIds,
    addMoreMode,
    spareCapacity,
    toggleSelection,
    toggleMustDo,
    completeAsana,
    deletingIds,
    deleteTask,
    peekCandidate,
    setPeekCandidate,
    proposals,
    quotaSummary,
    unplaceable,
    overflowDayOptions,
    exerciseMissingDays,
    grouped,
    overflowProposals,
    acceptedCount,
    hasResults,
    results,
    isConfirming,
    toggleAccept,
    editStart,
    editDate,
    addMoreTasks,
    handleNext,
    handleSkip,
    handleBack,
    canBack,
    canSkip,
  } = plan;

  // Escape closes; lock the page behind the overlay while open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Progress: the current screen's position within the pageable screens. 'done'
  // fills the bar. Guard the first render where activeIndex can be -1.
  const totalScreens = screenOrder.length;
  const shownIndex = step === 'done' ? totalScreens : Math.max(activeIndex, 0);
  const currentTitle =
    step === 'done' ? 'Done' : screenOrder[activeIndex]?.title ?? '';
  const progressPct =
    totalScreens > 0 ? Math.round(((step === 'done' ? totalScreens : shownIndex + 1) / totalScreens) * 100) : 0;

  const nextDisabled =
    isLoading ||
    (step === 'type' && (typeLoading || isApplyingTypes)) ||
    (step === 'reminders' && remindersLoading) ||
    (step === 'priorities' && !prioritiesReady) ||
    (step === 'review' && (acceptedCount === 0 || isConfirming || isConvertingReminders));

  const nextBusy =
    isConfirming || isConvertingReminders || isApplyingTypes || (isLoading && (step === 'priorities' || step === 'prep'));

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-100">
      {/* Header */}
      <div className="flex-shrink-0 bg-white pt-[env(safe-area-inset-top)] shadow-sm">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900">Plan my week</h2>
            <p className="text-xs text-gray-400">
              {step === 'done'
                ? weekLabel || 'All set'
                : `${currentTitle}${totalScreens > 0 ? ` · Step ${Math.min(shownIndex + 1, totalScreens)} of ${totalScreens}` : ''}`}
              {weekLabel && step !== 'done' ? ` · ${weekLabel}` : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-2 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-gray-500 active:bg-gray-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* Progress bar */}
        <div className="h-1 w-full bg-gray-200">
          <div
            className="h-full bg-orange-500 transition-all duration-300 ease-out"
            style={{ width: `${progressPct}%` }}
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Plan week progress"
          />
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
          </div>
        ) : (
          <>
            {step === 'type' && (
              <TypeStep
                untypedTasks={untypedTasks}
                typeRows={typeRows}
                setTypeRows={setTypeRows}
                typeLoading={typeLoading}
                typeError={typeError}
              />
            )}
            {step === 'priorities' && (
              <MobilePrioritiesStep
                matchRows={matchRows}
                setMatchRows={setMatchRows}
                priorityText={priorityText}
                setPriorityText={setPriorityText}
                matchMeta={matchMeta}
                createdTasks={createdTasks}
              />
            )}
            {step === 'reminders' && (
              <MobileRemindersStep
                rows={reminderRows}
                setRows={setReminderRows}
                loading={remindersLoading}
                error={remindersError}
                progress={remindersProgress}
                integrations={asanaIntegrations ?? []}
                projects={reminderProjects}
                typeFieldInfoByIntegration={typeFieldInfoByIntegration}
              />
            )}
            {step === 'prep' && (
              <PrepStep
                prepData={prepData}
                isLoading={isLoading}
                showOtherMeetings={showOtherMeetings}
                setShowOtherMeetings={setShowOtherMeetings}
                prepDurations={prepDurations}
                prepDays={prepDays}
                setPrepDecision={setPrepDecision}
                changePrepDuration={changePrepDuration}
                changePrepDay={changePrepDay}
              />
            )}
            {step === 'tasks' && (
              <MobileTasksStep
                taskCats={taskCats}
                selections={selections}
                taskDurations={taskDurations}
                setTaskDurations={setTaskDurations}
                taskDurationOverrides={taskDurationOverrides}
                setTaskDurationOverrides={setTaskDurationOverrides}
                mustDoIds={mustDoIds}
                walkDays={walkDays}
                weekWorkingDays={prepData?.workingDays ?? []}
                toggleWalkDay={toggleWalkDay}
                completingIds={completingIds}
                addMoreMode={addMoreMode}
                spareCapacity={spareCapacity}
                toggleSelection={toggleSelection}
                toggleMustDo={toggleMustDo}
                completeAsana={completeAsana}
                deletingIds={deletingIds}
                deleteTask={deleteTask}
                onOpenTask={setPeekCandidate}
              />
            )}
            {(step === 'review' || step === 'done') && (
              <ReviewStep
                proposals={proposals}
                unplaceable={unplaceable}
                grouped={grouped}
                overflowProposals={overflowProposals}
                mustDoIds={mustDoIds}
                taskCats={taskCats}
                exerciseMissingDays={exerciseMissingDays}
                quotaSummary={quotaSummary}
                results={results}
                hasResults={hasResults}
                spareCapacity={spareCapacity}
                overflowDayOptions={overflowDayOptions}
                toggleAccept={toggleAccept}
                editStart={editStart}
                editDate={editDate}
                addMoreTasks={addMoreTasks}
              />
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-gray-200 bg-white px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        {step === 'done' ? (
          <button
            onClick={onClose}
            className="flex w-full items-center justify-center rounded-xl bg-orange-500 py-3 text-sm font-semibold text-white active:bg-orange-600"
          >
            Done
          </button>
        ) : (
          <div className="flex items-center gap-2">
            {canBack ? (
              <button
                onClick={handleBack}
                className="flex items-center gap-1 rounded-xl px-4 py-3 text-sm font-medium text-gray-600 active:bg-gray-100"
              >
                <ChevronLeft className="h-4 w-4" />
                Back
              </button>
            ) : (
              <span />
            )}
            <div className="ml-auto flex items-center gap-2">
              {canSkip && (
                <button
                  onClick={handleSkip}
                  disabled={isLoading}
                  className="rounded-xl px-4 py-3 text-sm font-medium text-gray-500 active:bg-gray-100 disabled:opacity-50"
                >
                  Skip
                </button>
              )}
              <button
                onClick={handleNext}
                disabled={nextDisabled}
                className="flex items-center justify-center gap-2 rounded-xl bg-orange-500 px-5 py-3 text-sm font-semibold text-white active:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {nextBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {step === 'type' ? (
                  <>Apply types</>
                ) : step === 'review' ? (
                  <>Add {acceptedCount > 0 ? acceptedCount : ''} to calendar</>
                ) : (
                  <>
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {peekCandidate && <TaskPeekModal candidate={peekCandidate} onClose={() => setPeekCandidate(null)} />}
    </div>
  );
}
