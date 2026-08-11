'use client';

import { useEffect } from 'react';
import {
  X,
  CalendarClock,
  Loader2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

import { TaskPeekModal } from './plan-week/TaskPeekModal';
import type { CalendarEvent } from '@/types';
import type { AsanaTypeFieldInfo } from '@/components/CreateAsanaTaskModal';

import { TypeStep } from './plan-week/TypeStep';
import { PrioritiesStep } from './plan-week/PrioritiesStep';
import { RemindersStep } from './plan-week/RemindersStep';
import { PrepStep } from './plan-week/PrepStep';
import { TasksStep } from './plan-week/TasksStep';
import { ReviewStep } from './plan-week/ReviewStep';
import { usePlanWeek } from './plan-week/usePlanWeek';

interface PlanWeekModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplied?: () => void; // called after a successful confirm so the caller can refresh
  // Incomplete Asana tasks + per-integration Type field info, used by the "type
  // unclassified tasks" pre-step to find untyped tasks and write labels back.
  asanaTasks?: CalendarEvent[];
  typeFieldInfoByIntegration?: Map<string, AsanaTypeFieldInfo>;
  // Asana integrations/workspaces (id + name), used by the reminders-triage step
  // to offer conversion destinations. Absent → the reminders step is skipped.
  asanaIntegrations?: Array<{ id: string; name: string }>;
  // The week to plan (yyyy-MM-dd Monday). Absent → the current week, as before.
  // Passed to EVERY wizard endpoint that reads it (prep candidates, task
  // candidates, priority matching, propose, confirm) so the whole wizard agrees
  // on which week it is planning.
  weekStart?: string;
}

export function PlanWeekModal({
  isOpen,
  onClose,
  weekStart,
  onApplied,
  asanaTasks,
  typeFieldInfoByIntegration,
  asanaIntegrations,
}: PlanWeekModalProps) {
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

  // Escape closes.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <CalendarClock className="w-5 h-5 text-orange-500" />
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Plan my week</h2>
              {weekLabel && <p className="text-xs text-gray-400">{weekLabel}</p>}
            </div>
          </div>
          <div className="flex items-center gap-4">
            {/* Step dots */}
            <div className="hidden sm:flex items-center gap-1.5">
              {screenOrder.map((s, i) => (
                <div key={s.key} className="flex items-center gap-1.5" title={s.title}>
                  <span
                    className={`w-2 h-2 rounded-full transition-colors ${
                      i < activeIndex
                        ? 'bg-orange-400'
                        : i === activeIndex
                          ? 'bg-orange-500 ring-2 ring-orange-200'
                          : 'bg-gray-200'
                    }`}
                  />
                </div>
              ))}
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {error && (
            <div className="mb-4 flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-orange-500" />
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
                <PrioritiesStep
                  matchRows={matchRows}
                  setMatchRows={setMatchRows}
                  priorityText={priorityText}
                  setPriorityText={setPriorityText}
                  matchMeta={matchMeta}
                  createdTasks={createdTasks}
                />
              )}
              {step === 'reminders' && (
                <RemindersStep
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
                <TasksStep
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
        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200">
          <div>
            {canBack && (
              <button
                onClick={handleBack}
                className="flex items-center gap-1 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step === 'done' ? (
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors"
              >
                Done
              </button>
            ) : (
              <>
                {canSkip && (
                  <button
                    onClick={handleSkip}
                    disabled={isLoading}
                    className="px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Skip
                  </button>
                )}
                <button
                  onClick={handleNext}
                  disabled={
                    isLoading ||
                    (step === 'type' && (typeLoading || isApplyingTypes)) ||
                    (step === 'reminders' && remindersLoading) ||
                    (step === 'priorities' && !prioritiesReady) ||
                    (step === 'review' && (acceptedCount === 0 || isConfirming || isConvertingReminders))
                  }
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {(isConfirming ||
                    isConvertingReminders ||
                    isApplyingTypes ||
                    (isLoading && (step === 'priorities' || step === 'prep'))) && (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  )}
                  {step === 'type' ? (
                    <>Apply types &amp; continue</>
                  ) : step === 'review' ? (
                    <>Add {acceptedCount > 0 ? acceptedCount : ''} to calendar</>
                  ) : (
                    <>
                      Next
                      <ChevronRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      {peekCandidate && (
        <TaskPeekModal candidate={peekCandidate} onClose={() => setPeekCandidate(null)} />
      )}
    </div>
  );
}
