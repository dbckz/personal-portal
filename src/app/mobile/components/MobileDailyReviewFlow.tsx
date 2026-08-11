'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X,
  Loader2,
  Check,
  AlertTriangle,
  ArrowRight,
  Sparkles,
  Ban,
  ChevronRight,
  Trash2,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';

import { api, type ReplanAnalyzeResponse } from '@/lib/api';
import type { ReplanReviewBlock, ReplanReviewTask } from '@/lib/scheduling/replan';
import {
  buildReviewApplyPayload,
  markOutcome,
  type ReviewOutcome,
  type ReviewReplacementInput,
  type ReviewTaskMark,
} from '@/lib/scheduling/daily-review';
import { categoryColor, slotLabelMs, titleLabel } from '@/components/dashboard/replanFormat';
import { ReplanSections, replanHasWork } from '@/components/dashboard/ReplanSections';
import { GoalCheckInPanel } from '@/components/goals/GoalCheckInPanel';
import {
  HabitCheckPanel,
  emptyHabitAnswers,
  habitLogsFrom,
  incompleteHabits,
  type HabitAnswers,
} from '@/components/dashboard/HabitCheckPanel';
import { logicalToday } from '@/lib/date-utils';
import { useReplanActions } from '@/components/dashboard/useReplanActions';

// Which flow the full-screen overlay opens on. 'review' is the two-step daily
// review (outcomes + habits → replan); 'replan' jumps straight to the plan view
// (the mobile ReplanWeekModal); 'reset' opens the destructive reset-week confirm.
export type MobileReviewEntry = 'review' | 'replan' | 'reset';

type Marks = Record<string, ReviewTaskMark[]>; // eventId -> per-task marks
type Replacements = Record<string, ReviewReplacementInput | undefined>;

// Mirrors DailyReviewModal.initialOutcome — the outcome a row opens on.
function initialOutcome(task: ReplanReviewTask): ReviewOutcome {
  if (task.done) return 'done';
  if (task.previouslyStarted) return 'started';
  return 'notDone';
}

function initMarks(blocks: ReplanReviewBlock[]): Marks {
  const marks: Marks = {};
  for (const b of blocks) {
    marks[b.googleEventId] = b.tasks.map(t => ({
      done: t.done,
      outcome: initialOutcome(t),
      completeInAsana: !!t.gid && !t.completedInAsana,
    }));
  }
  return marks;
}

// A block counts as "didn't do" — nothing finished and nothing started — the
// only state where the replacement answer means anything (matches the desktop
// modal and buildReviewApplyPayload).
function isBlockNotDone(block: ReplanReviewBlock, marks: ReviewTaskMark[]): boolean {
  if (block.tasks.length === 0) return false;
  const outcomes = block.tasks.map((t, i) => markOutcome(marks[i], t.done));
  return !outcomes.every(o => o === 'done') && !outcomes.some(o => o === 'started');
}

// Full-screen touch port of DailyReviewModal + ReplanWeekModal. Reuses the exact
// replan business logic (useReplanActions, buildReviewApplyPayload) and the
// shared ReplanSections render; only the review step's presentation is rebuilt
// for the phone. Mounts as a fixed overlay above the mobile shell.
export function MobileDailyReviewFlow({
  entry,
  workspaceOptions = [],
  onClose,
  onApplied,
}: {
  entry: MobileReviewEntry;
  workspaceOptions?: Array<{ id: string; name: string }>;
  onClose: () => void;
  onApplied?: () => void;
}) {
  // 'review1' → outcomes + habits, 'plan' → replan sections, 'reset' → the
  // destructive reset confirm. Seeded from `entry`; the reset view remembers
  // whether it can fall back to the plan view or must close.
  const [view, setView] = useState<'review1' | 'plan' | 'reset'>(
    entry === 'review' ? 'review1' : entry === 'replan' ? 'plan' : 'reset'
  );

  const [isLoading, setIsLoading] = useState(entry !== 'reset');
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ReplanAnalyzeResponse | null>(null);
  const [marks, setMarks] = useState<Marks>({});
  const [replacements, setReplacements] = useState<Replacements>({});
  const [isApplying, setIsApplying] = useState(false);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [reviewMessageLoading, setReviewMessageLoading] = useState(false);
  const [habitAnswers, setHabitAnswers] = useState<HabitAnswers>(emptyHabitAnswers);
  const [wellbeingNotes, setWellbeingNotes] = useState('');
  const [showHabitErrors, setShowHabitErrors] = useState(false);
  const [reviewDate] = useState(() => logicalToday());
  // Reset-week progress.
  const [isResetting, setIsResetting] = useState(false);

  // The replan step reuses the exact same review + confirm machinery. Fed data
  // only once the plan view is reached (or straight away in replan entry).
  const actions = useReplanActions(view === 'plan' ? data : null, onApplied);

  const analyze = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.analyzeReplan();
      setData(res);
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to analyze your week');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fresh analyze on mount (review + replan entries); seed step-1 marks. The
  // reset entry needs no analyze.
  useEffect(() => {
    if (entry === 'reset') return;
    analyze().then(res => {
      if (res && entry === 'review') setMarks(initMarks(res.reviewBlocks ?? []));
    });
  }, [entry, analyze]);

  const weekLabel = useMemo(() => {
    if (!data) return '';
    return `${format(parseISO(data.weekStart), 'MMM d')} – ${format(parseISO(data.weekEnd), 'MMM d')}`;
  }, [data]);

  const reviewSubtitle = useMemo(() => {
    const r = data?.review;
    if (r?.clamped) return 'Welcome back — reviewing the last 7 days.';
    if (r && r.missedWorkingDays >= 1 && r.sinceIso) {
      return `Catching up since ${format(parseISO(r.sinceIso), 'EEE d MMM')} — weekends and days off don’t count.`;
    }
    return 'What got done since your last review?';
  }, [data]);

  const reviewBlocks = useMemo(() => data?.reviewBlocks ?? [], [data]);

  const setTaskOutcome = (eventId: string, idx: number, outcome: ReviewOutcome) =>
    setMarks(prev => {
      const list = prev[eventId] ? [...prev[eventId]] : [];
      if (list[idx]) list[idx] = { ...list[idx], outcome, done: outcome === 'done' };
      return { ...prev, [eventId]: list };
    });

  const setTaskCompleteAsana = (eventId: string, idx: number, completeInAsana: boolean) =>
    setMarks(prev => {
      const list = prev[eventId] ? [...prev[eventId]] : [];
      if (list[idx]) list[idx] = { ...list[idx], completeInAsana };
      return { ...prev, [eventId]: list };
    });

  const dismissCalendarBlock = useCallback((block: ReplanReviewBlock) => {
    const title = block.titles[0] ?? '';
    setData(prev =>
      prev
        ? { ...prev, reviewBlocks: (prev.reviewBlocks ?? []).filter(b => b.googleEventId !== block.googleEventId) }
        : prev
    );
    setMarks(prev => {
      const next = { ...prev };
      delete next[block.googleEventId];
      return next;
    });
    setReplacements(prev => {
      const next = { ...prev };
      delete next[block.googleEventId];
      return next;
    });
    if (title) api.dismissReviewTitle(title).catch(() => {});
  }, []);

  const summariseOutcome = useCallback(() => {
    const doneTitles: string[] = [];
    const notDoneTitles: string[] = [];
    for (const block of reviewBlocks) {
      const list = marks[block.googleEventId] ?? [];
      const allDone =
        block.tasks.length > 0 && block.tasks.every((t, i) => list[i]?.done ?? t.done);
      const label = titleLabel(block.titles);
      if (allDone) doneTitles.push(label);
      else notDoneTitles.push(label);
    }
    return { doneCount: doneTitles.length, totalCount: reviewBlocks.length, doneTitles, notDoneTitles };
  }, [reviewBlocks, marks]);

  // Apply the step-1 marks, then re-analyze and advance to the plan view.
  const applyAndContinue = useCallback(async () => {
    if (incompleteHabits(habitAnswers).length > 0) {
      setShowHabitErrors(true);
      setError('Say why a habit didn’t happen before saving.');
      return;
    }
    setIsApplying(true);
    setError(null);
    if (reviewBlocks.length > 0) {
      setReviewMessage(null);
      setReviewMessageLoading(true);
      api.getReviewMessage(summariseOutcome())
        .then(res => setReviewMessage(res.message))
        .catch(() => setReviewMessage(null))
        .finally(() => setReviewMessageLoading(false));
    }
    try {
      const payload = buildReviewApplyPayload(
        reviewBlocks,
        Object.fromEntries(Object.entries(marks).map(([id, tasks]) => [id, { tasks }])),
        replacements
      );
      const hasWork =
        payload.done.length > 0 ||
        payload.notDone.length > 0 ||
        payload.started.length > 0 ||
        payload.completeAsana.length > 0 ||
        payload.adopt.length > 0 ||
        payload.replacements.length > 0;
      if (hasWork) {
        const res = await api.confirmReplan(
          [],
          payload.done,
          undefined,
          undefined,
          undefined,
          payload.notDone,
          payload.completeAsana,
          undefined,
          undefined,
          payload.adopt,
          undefined,
          undefined,
          payload.started,
          payload.replacements
        );
        const failed =
          [...(res.doneResults ?? []), ...(res.notDoneResults ?? []), ...(res.adoptResults ?? [])].filter(
            r => !r.success
          ).length + (res.asanaResults ?? []).filter(r => !r.success).length;
        if (failed > 0) setError(`${failed} update${failed === 1 ? '' : 's'} could not be saved.`);
        onApplied?.();
      }
      const habitLogs = habitLogsFrom(habitAnswers);
      if (habitLogs.length > 0 || wellbeingNotes.trim()) {
        try {
          await api.saveWellbeingDay({ date: reviewDate, habits: habitLogs, notes: wellbeingNotes });
        } catch (err) {
          console.error('Failed to save the day’s habits:', err);
          setError('Your review was saved, but the habit answers were not.');
        }
      }
      await api.completeDailyReview(payload.reviewedCalendarTitles).catch(() => {});
      await analyze();
      setView('plan');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save your review');
    } finally {
      setIsApplying(false);
    }
  }, [
    reviewBlocks,
    marks,
    replacements,
    analyze,
    onApplied,
    summariseOutcome,
    habitAnswers,
    wellbeingNotes,
    reviewDate,
  ]);

  const resetWeek = useCallback(async () => {
    setIsResetting(true);
    setError(null);
    try {
      await api.resetWeek();
      onApplied?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset the week');
      setIsResetting(false);
    }
  }, [onApplied, onClose]);

  const displayError = error ?? actions.error;
  const nothingToReplan = data && !replanHasWork(data);

  const title =
    view === 'reset'
      ? 'Reset week'
      : view === 'plan'
        ? data?.endOfWeek
          ? 'End of week'
          : 'Replan week'
        : 'Daily review';
  const subtitle =
    view === 'reset'
      ? 'Start this week’s plan from scratch'
      : view === 'plan'
        ? data
          ? `${data.endOfWeek ? 'Carry what didn’t into next week' : 'Reschedule what didn’t'} · ${weekLabel}`
          : ''
        : data
          ? reviewSubtitle
          : '';

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-slate-100">
      {/* Header */}
      <header className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-gray-900">{title}</h1>
          {subtitle && <p className="truncate text-xs text-gray-400">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-gray-500 active:bg-gray-100"
        >
          <X className="h-6 w-6" />
        </button>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {displayError && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{displayError}</span>
          </div>
        )}

        {view === 'reset' ? (
          <ResetWeekBody />
        ) : isLoading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20">
            <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
            <p className="text-sm text-gray-500">
              {view === 'review1' ? 'Gathering what you had planned…' : 'Checking what still needs a slot…'}
            </p>
          </div>
        ) : !data ? null : view === 'review1' ? (
          <>
            {reviewBlocks.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <Check className="h-8 w-8 text-emerald-500" />
                <p className="text-sm font-medium text-gray-700">Nothing to review yet.</p>
                <p className="text-xs text-gray-400">
                  No planned blocks have finished. Come back at the end of the day.
                </p>
              </div>
            ) : (
              <ul className="space-y-2.5">
                {reviewBlocks.map(block => (
                  <MobileReviewRow
                    key={block.googleEventId}
                    block={block}
                    priorWeek={block.date < data.weekStart}
                    marks={marks[block.googleEventId] ?? []}
                    onSetOutcome={(idx, outcome) => setTaskOutcome(block.googleEventId, idx, outcome)}
                    onToggleAsana={(idx, v) => setTaskCompleteAsana(block.googleEventId, idx, v)}
                    onDismiss={block.source === 'calendar' ? () => dismissCalendarBlock(block) : undefined}
                    replacement={replacements[block.googleEventId]}
                    onSetReplacement={value =>
                      setReplacements(prev => ({ ...prev, [block.googleEventId]: value }))
                    }
                    workspaceOptions={workspaceOptions}
                  />
                ))}
              </ul>
            )}
            <HabitCheckPanel
              date={reviewDate}
              answers={habitAnswers}
              onChange={setHabitAnswers}
              notes={wellbeingNotes}
              onNotesChange={setWellbeingNotes}
              showErrors={showHabitErrors}
            />
          </>
        ) : (
          <>
            {(reviewMessageLoading || reviewMessage) && (
              <ReviewMessageCard message={reviewMessage} loading={reviewMessageLoading} />
            )}
            {data.endOfWeek && (
              <div className="mb-4">
                <GoalCheckInPanel mode="check-in" />
              </div>
            )}
            {nothingToReplan ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                <Check className="h-8 w-8 text-emerald-500" />
                <p className="text-sm font-medium text-gray-700">Nothing left to reschedule.</p>
                <p className="text-xs text-gray-400">
                  Everything unfinished either has no home this week or is already handled.
                </p>
              </div>
            ) : (
              <ReplanSections data={data} actions={actions} />
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <footer className="flex flex-shrink-0 items-center gap-2 border-t border-gray-200 bg-white px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        {view === 'reset' ? (
          <>
            <button
              type="button"
              onClick={() => (entry === 'reset' ? onClose() : setView('plan'))}
              disabled={isResetting}
              className="flex h-12 flex-1 items-center justify-center rounded-lg text-sm font-medium text-gray-600 active:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={resetWeek}
              disabled={isResetting}
              className="flex h-12 flex-1 items-center justify-center gap-1.5 rounded-lg bg-red-500 text-sm font-semibold text-white active:bg-red-600 disabled:opacity-50"
            >
              {isResetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Reset week
            </button>
          </>
        ) : view === 'review1' ? (
          <>
            <button
              type="button"
              onClick={onClose}
              className="flex h-12 flex-1 items-center justify-center rounded-lg text-sm font-medium text-gray-600 active:bg-gray-100"
            >
              Cancel
            </button>
            {data && (
              <button
                type="button"
                onClick={applyAndContinue}
                disabled={isLoading || isApplying}
                className="flex h-12 flex-[2] items-center justify-center gap-2 rounded-lg bg-orange-500 text-sm font-semibold text-white active:bg-orange-600 disabled:opacity-50"
              >
                {isApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save &amp; continue
                <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </>
        ) : actions.done || nothingToReplan ? (
          <button
            type="button"
            onClick={onClose}
            className="flex h-12 flex-1 items-center justify-center rounded-lg bg-orange-500 text-sm font-semibold text-white active:bg-orange-600"
          >
            Done
          </button>
        ) : (
          <>
            {/* Reset-week escape hatch, mirroring the desktop replan footer. */}
            {data && !actions.hasResults && (
              <button
                type="button"
                onClick={() => setView('reset')}
                aria-label="Start week from scratch"
                className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 active:bg-gray-100"
              >
                <Trash2 className="h-5 w-5" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex h-12 flex-1 items-center justify-center rounded-lg text-sm font-medium text-gray-600 active:bg-gray-100"
            >
              Close
            </button>
            {data && replanHasWork(data) && (
              <button
                type="button"
                onClick={actions.confirm}
                disabled={isLoading || actions.isConfirming || actions.actionCount === 0}
                className="flex h-12 flex-[2] items-center justify-center gap-2 rounded-lg bg-orange-500 text-sm font-semibold text-white active:bg-orange-600 disabled:opacity-50"
              >
                {actions.isConfirming && <Loader2 className="h-4 w-4 animate-spin" />}
                Apply {actions.actionCount > 0 ? actions.actionCount : ''} change
                {actions.actionCount === 1 ? '' : 's'}
              </button>
            )}
          </>
        )}
      </footer>
    </div>
  );
}

// The reset-week confirm copy. The two-step gating (menu → this screen → the
// destructive Reset button) is the confirm; this explains exactly what goes.
function ResetWeekBody() {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50/70 p-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" />
        <div className="space-y-2 text-sm text-gray-700">
          <p className="font-medium text-gray-900">Start this week from scratch?</p>
          <p>
            Upcoming planned blocks are removed from your calendar and this week’s planning records
            are cleared.
          </p>
          <p className="text-gray-500">
            Past blocks and your meetings are left untouched. You can plan the week again afterwards.
          </p>
        </div>
      </div>
    </div>
  );
}

// The closing "how your day went" reflection at the top of the plan view.
function ReviewMessageCard({ message, loading }: { message: string | null; loading: boolean }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 p-3.5">
      <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500" />
      {message ? (
        <p className="text-sm leading-relaxed text-emerald-900">{message}</p>
      ) : loading ? (
        <div className="flex-1 space-y-1.5 py-0.5" aria-hidden>
          <div className="h-3 w-full animate-pulse rounded bg-emerald-200/70" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-emerald-200/70" />
        </div>
      ) : null}
    </div>
  );
}

const OUTCOME_OPTIONS: Array<{ value: ReviewOutcome; label: string; activeClass: string }> = [
  { value: 'done', label: 'Done', activeClass: 'bg-emerald-500 text-white' },
  { value: 'started', label: 'Started', activeClass: 'bg-amber-500 text-white' },
  { value: 'notDone', label: 'Didn’t do', activeClass: 'bg-gray-500 text-white' },
];

// Full-width Done / Started / Didn't-do control, sized for touch.
function OutcomeToggle({
  value,
  onChange,
  groupLabel,
}: {
  value: ReviewOutcome;
  onChange: (outcome: ReviewOutcome) => void;
  groupLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={groupLabel}
      className="inline-flex w-full overflow-hidden rounded-lg border border-gray-200 text-xs font-medium"
    >
      {OUTCOME_OPTIONS.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={`h-10 flex-1 transition-colors ${
            value === opt.value ? opt.activeClass : 'bg-white text-gray-600 active:bg-gray-50'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// One review row on the phone: a full-width card. Single-task blocks show one
// outcome control; grouped blocks give each member its own. Asana-done members
// offer "Complete in Asana"; wholly not-done blocks offer the replacement panel.
function MobileReviewRow({
  block,
  priorWeek,
  marks,
  onSetOutcome,
  onToggleAsana,
  onDismiss,
  replacement,
  onSetReplacement,
  workspaceOptions,
}: {
  block: ReplanReviewBlock;
  priorWeek: boolean;
  marks: ReviewTaskMark[];
  onSetOutcome: (idx: number, outcome: ReviewOutcome) => void;
  onToggleAsana: (idx: number, v: boolean) => void;
  onDismiss?: () => void;
  replacement?: ReviewReplacementInput;
  onSetReplacement: (value: ReviewReplacementInput | undefined) => void;
  workspaceOptions: Array<{ id: string; name: string }>;
}) {
  const color = categoryColor(block.category);
  const grouped = block.tasks.length > 1;
  const notDone = !priorWeek && isBlockNotDone(block, marks);

  return (
    <li className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${color.bg} ${color.text}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${color.dot}`} />
              {block.category}
            </span>
            {block.source === 'calendar' && (
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
                From your calendar
              </span>
            )}
            {priorWeek && (
              <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-600">
                Last week
              </span>
            )}
          </div>
          <p className="mt-1 text-sm font-medium text-gray-800">{titleLabel(block.titles)}</p>
          <p className="mt-0.5 text-xs text-gray-400">{slotLabelMs(block.startMs)}</p>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Not relevant — hide this and don’t ask again"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-400 active:bg-rose-50 active:text-rose-600"
          >
            <Ban className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Single-task block: one full-width outcome control. */}
      {!grouped && (
        <div className="mt-3">
          <OutcomeToggle
            value={markOutcome(marks[0], block.tasks[0]?.done ?? false)}
            onChange={outcome => onSetOutcome(0, outcome)}
            groupLabel={`Outcome for ${titleLabel(block.titles)}`}
          />
          {block.tasks[0]?.completedInAsana ? (
            <p className="mt-2 text-[11px] text-emerald-600">Already completed in Asana</p>
          ) : (
            block.tasks[0]?.gid &&
            marks[0]?.done && (
              <label className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={marks[0]?.completeInAsana ?? false}
                  onChange={e => onToggleAsana(0, e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                />
                Complete in Asana
              </label>
            )
          )}
        </div>
      )}

      {/* Grouped block: each member gets its own control. */}
      {grouped && (
        <ul className="mt-3 space-y-3">
          {block.tasks.map((t, i) => (
            <li key={i} className="rounded-lg border border-gray-100 bg-gray-50/60 p-2.5">
              <p className={`text-sm ${marks[i]?.done ? 'text-gray-800' : 'text-gray-600'}`}>{t.title}</p>
              <div className="mt-2">
                <OutcomeToggle
                  value={markOutcome(marks[i], t.done)}
                  onChange={outcome => onSetOutcome(i, outcome)}
                  groupLabel={`Outcome for ${t.title}`}
                />
              </div>
              {t.completedInAsana ? (
                <p className="mt-1.5 text-[11px] text-emerald-600">Already completed in Asana</p>
              ) : (
                t.gid &&
                marks[i]?.done && (
                  <label className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-500">
                    <input
                      type="checkbox"
                      checked={marks[i]?.completeInAsana ?? false}
                      onChange={e => onToggleAsana(i, e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                    />
                    Complete in Asana
                  </label>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      {notDone && (
        <MobileReplacementPanel
          block={block}
          value={replacement}
          onChange={onSetReplacement}
          workspaceOptions={workspaceOptions}
        />
      )}
    </li>
  );
}

// "What were you doing instead?" — the touch port of ReplacementPanel. Same
// optional behaviour: unanswered leaves the block to be rescheduled next step.
function MobileReplacementPanel({
  block,
  value,
  onChange,
  workspaceOptions,
}: {
  block: ReplanReviewBlock;
  value?: ReviewReplacementInput;
  onChange: (value: ReviewReplacementInput | undefined) => void;
  workspaceOptions: Array<{ id: string; name: string }>;
}) {
  const [isOpen, setIsOpen] = useState(!!value);
  const offerWork = workspaceOptions.length > 0;

  const slot = {
    googleEventId: block.googleEventId,
    googleIntegrationId: block.googleIntegrationId,
    date: block.date,
    start: block.start,
    durationMinutes: block.durationMinutes,
  };

  const choose = (mode: ReviewReplacementInput['mode']) => {
    if (mode === 'work') {
      const workspaceId = value?.workspaceId ?? workspaceOptions[0]?.id;
      onChange({ ...slot, mode, title: value?.title ?? '', workspaceId });
      return;
    }
    if (mode === 'personal') {
      onChange({ ...slot, mode, title: value?.mode === 'personal' ? value.title : '' });
      return;
    }
    onChange({ ...slot, mode });
  };

  const modeOptions: Array<{ mode: ReviewReplacementInput['mode']; label: string }> = [
    ...(offerWork ? [{ mode: 'work' as const, label: 'Worked on something else' }] : []),
    { mode: 'personal', label: 'Personal / rest' },
    { mode: 'none', label: 'Nothing — just remove it' },
  ];

  if (!isOpen) {
    const answered = modeOptions.find(o => o.mode === value?.mode);
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="mt-2.5 inline-flex items-center gap-1 text-xs text-gray-500 active:text-gray-700"
      >
        <ChevronRight className="h-3.5 w-3.5" />
        {answered ? `Instead: ${answered.label}` : 'What were you doing instead?'}
      </button>
    );
  }

  return (
    <div className="mt-2.5 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
      <p className="text-xs font-medium text-gray-600">What were you doing instead?</p>
      <div className="mt-2 flex flex-col gap-1.5">
        {modeOptions.map(opt => (
          <button
            key={opt.mode}
            type="button"
            onClick={() => choose(opt.mode)}
            aria-pressed={value?.mode === opt.mode}
            className={`flex h-10 items-center rounded-md border px-3 text-xs font-medium transition-colors ${
              value?.mode === opt.mode
                ? 'border-orange-300 bg-orange-100 text-orange-800'
                : 'border-gray-200 bg-white text-gray-600 active:bg-gray-100'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {value?.mode === 'work' && (
        <div className="mt-2 space-y-2">
          <input
            type="text"
            value={value.title ?? ''}
            onChange={e => onChange({ ...value, title: e.target.value })}
            placeholder="What did you work on?"
            aria-label="What did you work on instead?"
            className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
          />
          <select
            value={value.workspaceId ?? ''}
            onChange={e => onChange({ ...value, workspaceId: e.target.value })}
            aria-label="Workspace"
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
          >
            {workspaceOptions.map(w => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {value?.mode === 'personal' && (
        <input
          type="text"
          value={value.title ?? ''}
          onChange={e => onChange({ ...value, title: e.target.value })}
          placeholder="Personal time"
          aria-label="What were you doing?"
          className="mt-2 w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
        />
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-[10px] leading-relaxed text-gray-400">
          {value
            ? 'Answering removes this block and records what you did instead.'
            : 'Optional — leave it and the block stays, ready to reschedule.'}
        </p>
        {value && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="flex-shrink-0 text-[11px] text-gray-500 active:text-gray-700"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
