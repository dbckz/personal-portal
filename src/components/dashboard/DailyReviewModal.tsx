'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X,
  ClipboardCheck,
  Loader2,
  Check,
  AlertTriangle,
  ArrowRight,
  Sparkles,
  Ban,
  ChevronDown,
  ChevronRight,
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
import { categoryColor, slotLabelMs, titleLabel } from './replanFormat';
import { ReplanSections, replanHasWork } from './ReplanSections';
import { GoalCheckInPanel } from '@/components/goals/GoalCheckInPanel';
import {
  HabitCheckPanel,
  incompleteHabitDays,
  saveableHabitDays,
  type HabitDayState,
} from './HabitCheckPanel';
import { logicalToday } from '@/lib/date-utils';
import { useReplanActions } from './useReplanActions';

interface DailyReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplied?: () => void; // called after any successful mutation so the caller can refresh
  // Asana workspaces offered when the user says they worked on something else in a
  // block's slot. Empty (the default) hides that option entirely.
  workspaceOptions?: Array<{ id: string; name: string }>;
}

type Marks = Record<string, ReviewTaskMark[]>; // eventId -> per-task marks
// eventId -> the user's "what were you doing instead" answer. Only answered
// blocks appear; an unanswered didn't-do block is left entirely alone.
type Replacements = Record<string, ReviewReplacementInput | undefined>;

// The outcome a task's row opens on. A task already recorded 'started' earlier
// this week seeds as 'started' (not blank), so a later block for the same work
// doesn't ask from scratch.
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
      // Default the "complete in Asana" box on for Asana tasks the user might tick
      // done — but not for ones already complete in Asana (nothing to complete).
      completeInAsana: !!t.gid && !t.completedInAsana,
    }));
  }
  return marks;
}

// Whether a block counts as "didn't do" — nothing finished and nothing started —
// which is the only state where a replacement answer means anything (matching
// buildReviewApplyPayload, which drops replacements for done/started blocks).
function isBlockNotDone(block: ReplanReviewBlock, marks: ReviewTaskMark[]): boolean {
  if (block.tasks.length === 0) return false;
  const outcomes = block.tasks.map((t, i) => markOutcome(marks[i], t.done));
  return !outcomes.every(o => o === 'done') && !outcomes.some(o => o === 'started');
}

export function DailyReviewModal({
  isOpen,
  onClose,
  onApplied,
  workspaceOptions = [],
}: DailyReviewModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ReplanAnalyzeResponse | null>(null);
  const [marks, setMarks] = useState<Marks>({});
  const [replacements, setReplacements] = useState<Replacements>({});
  const [isApplying, setIsApplying] = useState(false);
  // Closing "how your day went" message, shown at the top of the replan step.
  // Fired (best-effort) when the review is confirmed; never blocks the apply.
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [reviewMessageLoading, setReviewMessageLoading] = useState(false);
  // The daily habits, asked alongside "what got done" — the review is the one
  // moment the day is being thought about, so it is where the answers come from.
  // Keyed by day: usually just today, but a review skipped for a day or two asks
  // for each missed day too. The panel owns seeding and the day list.
  const [habitDays, setHabitDays] = useState<HabitDayState>({});
  const [showHabitErrors, setShowHabitErrors] = useState(false);
  // Fixed for the life of the modal so the panel doesn't re-seed if the review
  // is left open across the rollover hour.
  const [reviewDate] = useState(() => logicalToday());

  // Step 2 reuses the exact replan review + confirm behaviour.
  const actions = useReplanActions(step === 2 ? data : null, onApplied);

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

  // Fresh analyze on open; seed step-1 marks from current done state.
  useEffect(() => {
    if (!isOpen) return;
    setStep(1);
    setData(null);
    setMarks({});
    setReplacements({});
    setError(null);
    setIsApplying(false);
    setReviewMessage(null);
    setReviewMessageLoading(false);
    setHabitDays({});
    setShowHabitErrors(false);
    analyze().then(res => {
      if (res) setMarks(initMarks(res.reviewBlocks ?? []));
    });
  }, [isOpen, analyze]);

  // Escape closes.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const weekLabel = useMemo(() => {
    if (!data) return '';
    return `${format(parseISO(data.weekStart), 'MMM d')} – ${format(parseISO(data.weekEnd), 'MMM d')}`;
  }, [data]);

  // Step-1 subtitle. When the review is catching up across missed working days
  // it says so — and reassures that weekends and days off don't count — rather
  // than the generic prompt. A long absence (the 7-day cap bit) reads as a fresh
  // start over the recent window instead of a backlog to feel guilty about.
  const reviewSubtitle = useMemo(() => {
    const r = data?.review;
    if (r?.clamped) return 'Welcome back — reviewing the last 7 days.';
    if (r && r.missedWorkingDays >= 1 && r.sinceIso) {
      return `Catching up since ${format(parseISO(r.sinceIso), 'EEE d MMM')} — no rush, weekends and days off don’t count.`;
    }
    return 'What got done since your last review?';
  }, [data]);

  const reviewBlocks = useMemo(() => data?.reviewBlocks ?? [], [data]);

  // `done` stays in lockstep with the outcome so the payload builder and the
  // complete-in-Asana affordance (both keyed off `done`) keep working.
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

  // Dismiss a bare calendar event as "not a task": remove it from the current
  // review and remember its title so it never resurfaces. Optimistic — the
  // remember call is best-effort (if it fails, the row simply returns next time).
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

  // Summarise the final marks into done/total + task titles. A block counts done
  // only if every one of its tasks is marked done (matching the apply logic).
  const summariseOutcome = useCallback(() => {
    let doneCount = 0;
    const doneTitles: string[] = [];
    const notDoneTitles: string[] = [];
    for (const block of reviewBlocks) {
      const list = marks[block.googleEventId] ?? [];
      const allDone =
        block.tasks.length > 0 &&
        block.tasks.every((t, i) => list[i]?.done ?? t.done);
      const label = titleLabel(block.titles);
      if (allDone) doneTitles.push(label);
      else notDoneTitles.push(label);
    }
    doneCount = doneTitles.length;
    return { doneCount, totalCount: reviewBlocks.length, doneTitles, notDoneTitles };
  }, [reviewBlocks, marks]);

  // Apply the step-1 marks, then re-analyze and advance to the replan step.
  const applyAndContinue = useCallback(async () => {
    // A habit answered "no" without a reason blocks the save: the reason is the
    // only part of a skip worth having later, so an empty one is worse than no
    // answer at all. Checked across every day being caught up, not just today.
    if (incompleteHabitDays(habitDays).length > 0) {
      setShowHabitErrors(true);
      setError('Say why a habit didn’t happen before saving.');
      return;
    }
    setIsApplying(true);
    setError(null);
    // Fire the closing-message request now (from the marks the user just
    // confirmed) but don't await it — it must not delay or block the apply. If
    // the modal closes before it resolves, the setState is simply ignored.
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
        const failed = [
          ...(res.doneResults ?? []),
          ...(res.notDoneResults ?? []),
          ...(res.adoptResults ?? []),
        ].filter(r => !r.success).length + (res.asanaResults ?? []).filter(r => !r.success).length;
        if (failed > 0) setError(`${failed} update${failed === 1 ? '' : 's'} could not be saved.`);
        onApplied?.();
      }
      // The habits and notes for each day being caught up. Awaited rather than
      // fired-and-forgotten: unlike the closing message this is data being
      // recorded, and a silent loss would leave a hole in the record that
      // nothing else can refill. Days left fully untouched aren't saved.
      const daysToSave = saveableHabitDays(habitDays);
      if (daysToSave.length > 0) {
        try {
          for (const day of daysToSave) {
            await api.saveWellbeingDay(day);
          }
        } catch (err) {
          console.error('Failed to save the day’s habits:', err);
          setError('Your review was saved, but the habit answers were not.');
        }
      }
      // Stamp the review as completed so the next one only covers what finishes
      // after now, and record the calendar rows he reviewed (rather than
      // dismissed) as implicit "this IS a task" verdicts. Best-effort — a failure
      // here must not block the replan step.
      await api.completeDailyReview(payload.reviewedCalendarTitles).catch(() => {});
      // Re-gather so the replan step sees the just-applied done/not-done state
      // (Asana-completed tasks drop out of the fresh incomplete fetch).
      await analyze();
      setStep(2);
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
    habitDays,
  ]);

  if (!isOpen) return null;

  const displayError = error ?? actions.error;
  const nothingToReplan = data && !replanHasWork(data);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="w-5 h-5 text-orange-500" />
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                Daily review{step === 2 ? (data?.endOfWeek ? ' — end of week' : ' — replan') : ''}
              </h2>
              {data && (
                <p className="text-xs text-gray-400">
                  {step === 1
                    ? reviewSubtitle
                    : `${data.endOfWeek ? 'Carry what didn’t into next week' : 'Reschedule what didn’t'} · ${weekLabel}`}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {displayError && (
            <div className="mb-4 flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{displayError}</span>
            </div>
          )}

          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-orange-500" />
              <p className="text-sm text-gray-500">
                {step === 1 ? 'Gathering what you had planned…' : 'Checking what still needs a slot…'}
              </p>
            </div>
          ) : !data ? null : step === 1 ? (
            <>
            {reviewBlocks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
                <Check className="w-8 h-8 text-emerald-500" />
                <p className="text-sm font-medium text-gray-700">Nothing to review yet.</p>
                <p className="text-xs text-gray-400">
                  No planned blocks have finished. Come back at the end of the day.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {reviewBlocks.map(block => (
                  <ReviewRow
                    key={block.googleEventId}
                    block={block}
                    // A block dated before this week's Monday is a catch-up from a
                    // prior week: badged, and its "what were you doing instead"
                    // replacement UI is withheld (that path rewrites the current
                    // week's calendar; a prior-week block is history to record, not
                    // reschedule).
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
            {/* The habits ride along with the review for the same reason the
                goal check-in does: this is the one moment the day is already
                being thought about. Shown even when there was nothing to
                review — a quiet day still had a morning. */}
            <HabitCheckPanel
              today={reviewDate}
              state={habitDays}
              onChange={setHabitDays}
              showErrors={showHabitErrors}
            />
            </>
          ) : (
            <>
              {(reviewMessageLoading || reviewMessage) && (
                <ReviewMessageCard message={reviewMessage} loading={reviewMessageLoading} />
              )}
              {/* The end-of-week review is the one ritual that reliably happens,
                  so the monthly/quarterly goal check-in rides along with it
                  rather than needing a habit of its own. */}
              {data.endOfWeek && (
                <div className="mb-4">
                  <GoalCheckInPanel mode="check-in" />
                </div>
              )}
              {nothingToReplan ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
                  <Check className="w-8 h-8 text-emerald-500" />
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
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-200">
          {step === 1 ? (
            <>
              <button
                onClick={onClose}
                className="px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              {data && (
                <button
                  onClick={applyAndContinue}
                  disabled={isLoading || isApplying}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isApplying ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Save &amp; replan
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </>
          ) : actions.done || nothingToReplan ? (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors"
            >
              Done
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Close
              </button>
              {data && replanHasWork(data) && (
                <button
                  onClick={actions.confirm}
                  disabled={isLoading || actions.isConfirming || actions.actionCount === 0}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {actions.isConfirming && <Loader2 className="w-4 h-4 animate-spin" />}
                  Apply {actions.actionCount > 0 ? actions.actionCount : ''} change
                  {actions.actionCount === 1 ? '' : 's'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// The closing "how your day went" reflection, shown at the top of the replan
// step. A soft emerald card; while the message is still generating it shows a
// subtle shimmer placeholder so the space doesn't jump when the text arrives.
function ReviewMessageCard({ message, loading }: { message: string | null; loading: boolean }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 p-3.5">
      <Sparkles className="w-4 h-4 mt-0.5 flex-shrink-0 text-emerald-500" />
      {message ? (
        <p className="text-sm text-emerald-900 leading-relaxed">{message}</p>
      ) : loading ? (
        <div className="flex-1 space-y-1.5 py-0.5" aria-hidden>
          <div className="h-3 w-full rounded bg-emerald-200/70 animate-pulse" />
          <div className="h-3 w-2/3 rounded bg-emerald-200/70 animate-pulse" />
        </div>
      ) : null}
    </div>
  );
}

// The three outcomes, in the order they appear in the segmented control.
const OUTCOME_OPTIONS: Array<{ value: ReviewOutcome; label: string; activeClass: string }> = [
  { value: 'done', label: 'Done', activeClass: 'bg-emerald-500 text-white' },
  { value: 'started', label: 'Started', activeClass: 'bg-amber-500 text-white' },
  { value: 'notDone', label: 'Didn’t do', activeClass: 'bg-gray-500 text-white' },
];

// Done / Started / Didn't-do segmented control. "Started" means worked on but not
// finished: it stays not-done for planning, but never deletes the block's event.
function OutcomeToggle({
  value,
  onChange,
  groupLabel,
  compact,
}: {
  value: ReviewOutcome;
  onChange: (outcome: ReviewOutcome) => void;
  groupLabel: string;
  compact?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={groupLabel}
      className={`inline-flex rounded-md border border-gray-200 overflow-hidden font-medium flex-shrink-0 ${
        compact ? 'text-[10px]' : 'text-[11px]'
      }`}
    >
      {OUTCOME_OPTIONS.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          title={opt.value === 'started' ? 'Started but didn’t finish' : undefined}
          className={`${compact ? 'px-1.5 py-0.5' : 'px-2.5 py-1'} transition-colors ${
            value === opt.value ? opt.activeClass : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// One review row. Every task gets a Done / Started / Didn't-do segmented control:
// single-task blocks show it inline in the header, grouped blocks give each member
// its own compact copy (a shared block can be partially done). Asana-backed tasks
// marked done show a default-on "Complete in Asana" checkbox. A block that is
// wholly not done offers the "what were you doing instead?" panel.
function ReviewRow({
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
  // The block belongs to a week before this one (a catch-up). Badged, and its
  // replacement UI is withheld.
  priorWeek: boolean;
  marks: ReviewTaskMark[];
  onSetOutcome: (idx: number, outcome: ReviewOutcome) => void;
  onToggleAsana: (idx: number, v: boolean) => void;
  // Present only for bare calendar events: dismiss the row as "not a task".
  onDismiss?: () => void;
  replacement?: ReviewReplacementInput;
  onSetReplacement: (value: ReviewReplacementInput | undefined) => void;
  workspaceOptions: Array<{ id: string; name: string }>;
}) {
  const color = categoryColor(block.category);
  const grouped = block.tasks.length > 1;
  // A prior-week block never offers the replacement panel: answering it deletes
  // and recreates the event in the current week's slot, which would corrupt a
  // past week. Its date is already shown (slotLabelMs), so it stays reviewable.
  const notDone = !priorWeek && isBlockNotDone(block, marks);

  return (
    <li className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${color.bg} ${color.text}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${color.dot}`} />
              {block.category}
            </span>
            <span className="text-sm font-medium text-gray-800 truncate">
              {titleLabel(block.titles)}
            </span>
            {block.source === 'calendar' && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500">
                From your calendar
              </span>
            )}
            {priorWeek && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-100 text-indigo-600">
                Last week
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-gray-400">
            <span>{slotLabelMs(block.startMs)}</span>
          </div>
        </div>

        {/* Row action area. The "Not relevant" dismissal (calendar rows only) sits
            beside the outcome control — the escape hatch is the safety net for the
            loosened filter, so it must be obvious, not buried under the timestamp.
            Single-task blocks show their outcome control here; grouped blocks show
            one per member below. */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Not relevant — hide this and don’t ask again"
              title="Not relevant — hide this and don’t ask again"
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-500 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 focus:outline-none focus:ring-2 focus:ring-rose-300 transition-colors"
            >
              <Ban className="w-4 h-4" />
              <span className="hidden sm:inline">Not relevant</span>
            </button>
          )}
          {!grouped && (
            <OutcomeToggle
              value={markOutcome(marks[0], block.tasks[0]?.done ?? false)}
              onChange={outcome => onSetOutcome(0, outcome)}
              groupLabel={`Outcome for ${titleLabel(block.titles)}`}
            />
          )}
        </div>
      </div>

      {/* Grouped block: each member gets its own compact outcome control. */}
      {grouped && (
        <ul className="mt-2 space-y-1.5 pl-1">
          {block.tasks.map((t, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className={`text-sm ${marks[i]?.done ? 'text-gray-800' : 'text-gray-500'} truncate flex-1`}>
                {t.title}
              </span>
              {t.completedInAsana ? (
                <span className="text-[11px] text-emerald-600 flex-shrink-0">Already completed in Asana</span>
              ) : (
                t.gid && marks[i]?.done && (
                  <label className="flex items-center gap-1 text-[11px] text-gray-500 flex-shrink-0">
                    <input
                      type="checkbox"
                      checked={marks[i]?.completeInAsana ?? false}
                      onChange={e => onToggleAsana(i, e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                    />
                    Complete in Asana
                  </label>
                )
              )}
              <OutcomeToggle
                compact
                value={markOutcome(marks[i], t.done)}
                onChange={outcome => onSetOutcome(i, outcome)}
                groupLabel={`Outcome for ${t.title}`}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Single Asana task already complete in Asana: explain the pre-ticked Done. */}
      {!grouped && block.tasks[0]?.completedInAsana && (
        <div className="mt-2 text-[11px] text-emerald-600">Already completed in Asana</div>
      )}

      {/* Single Asana task marked done (and not already complete): complete-in-Asana affordance. */}
      {!grouped && block.tasks[0]?.gid && !block.tasks[0]?.completedInAsana && marks[0]?.done && (
        <label className="mt-2 flex items-center gap-1.5 text-[11px] text-gray-500">
          <input
            type="checkbox"
            checked={marks[0]?.completeInAsana ?? false}
            onChange={e => onToggleAsana(0, e.target.checked)}
            className="w-3.5 h-3.5 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
          />
          Complete in Asana
        </label>
      )}

      {/* Wholly not-done blocks: what were you doing instead? Optional. */}
      {notDone && (
        <ReplacementPanel
          block={block}
          value={replacement}
          onChange={onSetReplacement}
          workspaceOptions={workspaceOptions}
        />
      )}
    </li>
  );
}

// "What were you doing instead?" — shown under a block marked Didn't do. Entirely
// optional: while it is unanswered the block behaves exactly as before (nothing
// deleted, rescheduled in step 2). Answering replaces the slot, which means the
// original block leaves the calendar, so the copy says so.
function ReplacementPanel({
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

  // The slot being replaced. Always the STORED slot, which is what the apply
  // deletes and re-creates.
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
        className="mt-2 inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 transition-colors"
      >
        <ChevronRight className="w-3 h-3" />
        {answered ? `Instead: ${answered.label}` : 'What were you doing instead?'}
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
      <button
        type="button"
        onClick={() => setIsOpen(false)}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-600 hover:text-gray-800 transition-colors"
      >
        <ChevronDown className="w-3 h-3" />
        What were you doing instead?
      </button>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {modeOptions.map(opt => (
          <button
            key={opt.mode}
            type="button"
            onClick={() => choose(opt.mode)}
            aria-pressed={value?.mode === opt.mode}
            className={`px-2 py-1 rounded-md border text-[11px] font-medium transition-colors ${
              value?.mode === opt.mode
                ? 'border-orange-300 bg-orange-100 text-orange-800'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100'
            }`}
          >
            {opt.label}
          </button>
        ))}
        {value && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="px-2 py-1 rounded-md border border-transparent text-[11px] text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            Leave unanswered
          </button>
        )}
      </div>

      {value?.mode === 'work' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={value.title ?? ''}
            onChange={e => onChange({ ...value, title: e.target.value })}
            placeholder="What did you work on?"
            aria-label="What did you work on instead?"
            className="flex-1 min-w-[10rem] px-2 py-1 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-orange-400"
          />
          <select
            value={value.workspaceId ?? ''}
            onChange={e => onChange({ ...value, workspaceId: e.target.value })}
            aria-label="Workspace"
            className="px-2 py-1 text-xs border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-orange-400"
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
        <div className="mt-2">
          <input
            type="text"
            value={value.title ?? ''}
            onChange={e => onChange({ ...value, title: e.target.value })}
            placeholder="Personal time"
            aria-label="What were you doing?"
            className="w-full px-2 py-1 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-orange-400"
          />
        </div>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-gray-400">
        {value
          ? 'Answering removes this block from your calendar and records what you did instead.'
          : 'Optional. Leave this unanswered and the block stays put, ready to reschedule in the next step.'}
      </p>
    </div>
  );
}
