'use client';

import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, Star, Flag, ExternalLink, Trash2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';

import type { WeekCandidateCategory, WeekCandidate, SpareCapacity } from '@/lib/api';
import {
  categoryColor,
  roughDuration,
  blockLengthOptions,
  RowSelect,
} from '@/components/dashboard/plan-week/helpers';

// 1 → "1st", 2 → "2nd", 3 → "3rd", 4+ → "4th" (11-13 are always "th").
function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

interface MobileTasksStepProps {
  taskCats: WeekCandidateCategory[] | null;
  selections: Record<string, Set<string>>;
  taskDurations: Record<string, number>;
  setTaskDurations: Dispatch<SetStateAction<Record<string, number>>>;
  taskDurationOverrides: Record<string, number>;
  setTaskDurationOverrides: Dispatch<SetStateAction<Record<string, number>>>;
  mustDoIds: Set<string>;
  walkDays: Set<string>;
  weekWorkingDays: string[];
  toggleWalkDay: (dateStr: string) => void;
  completingIds: Set<string>;
  addMoreMode: boolean;
  spareCapacity: SpareCapacity | null;
  toggleSelection: (category: string, id: string, remainingQuota: number | null) => void;
  toggleMustDo: (category: string, id: string) => void;
  completeAsana: (id: string, gid: string, integrationId: string) => void;
  deletingIds: Set<string>;
  deleteTask: (category: string, candidate: WeekCandidate) => void;
  onOpenTask: (candidate: WeekCandidate) => void;
}

// Touch build of the tasks step. Each candidate stacks into two lines — a
// selection line (checkbox + tappable title) and a controls line (badges, due,
// must-do, Asana actions, delete, block length) — so nothing is cramped on a
// phone. The desktop double-click peek becomes a single tap on the title.
export function MobileTasksStep({
  taskCats,
  selections,
  taskDurations,
  setTaskDurations,
  taskDurationOverrides,
  setTaskDurationOverrides,
  mustDoIds,
  walkDays,
  weekWorkingDays,
  toggleWalkDay,
  completingIds,
  addMoreMode,
  spareCapacity,
  toggleSelection,
  toggleMustDo,
  completeAsana,
  deletingIds,
  deleteTask,
  onOpenTask,
}: MobileTasksStepProps) {
  // Inline delete confirm: first tap arms (icon → "Delete?"), second within a few
  // seconds executes; auto-disarms so a stray tap never leaves it primed.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armDelete = (id: string) => {
    setConfirmDeleteId(id);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmDeleteId(null), 3000);
  };
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    []
  );

  const renderWalksRow = () => {
    if (weekWorkingDays.length === 0) return null;
    return (
      <div className="rounded-xl border border-gray-200 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm font-medium text-gray-700">🚶 Walks</span>
          {weekWorkingDays.map(dateStr => {
            const on = walkDays.has(dateStr);
            return (
              <button
                key={dateStr}
                type="button"
                onClick={() => toggleWalkDay(dateStr)}
                aria-pressed={on}
                title={`${on ? 'Remove' : 'Add a'} walk on ${format(parseISO(dateStr), 'EEEE d MMM')}`}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  on
                    ? 'border-emerald-300 bg-emerald-100 text-emerald-700'
                    : 'border-gray-200 text-gray-500'
                }`}
              >
                {format(parseISO(dateStr), 'EEE')}
              </button>
            );
          })}
          <span className="ml-1 text-[11px] text-gray-400">
            {walkDays.size === 0 ? 'None' : `${walkDays.size} selected`}
          </span>
        </div>
      </div>
    );
  };

  if (!taskCats) {
    return (
      <div className="space-y-4">
        {renderWalksRow()}
        <p className="py-8 text-center text-sm italic text-gray-400">No candidates available.</p>
      </div>
    );
  }
  if (taskCats.length === 0) {
    return (
      <div className="space-y-4">
        {renderWalksRow()}
        <p className="py-8 text-center text-sm italic text-gray-400">No quota categories to fill this week.</p>
      </div>
    );
  }

  const renderCarriedBadge = (c: WeekCandidate) => {
    if (!c.carriedOver) return null;
    const streak = c.carryStreak ?? 1;
    const escalated = streak >= 2;
    return (
      <span
        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
          escalated ? 'bg-amber-100 text-amber-800' : 'bg-orange-100 text-orange-700'
        }`}
      >
        {escalated ? `↩ ${ordinal(streak)} week` : '↩ last week'}
      </span>
    );
  };

  const renderIntegrationBadge = (name?: string) =>
    name ? (
      <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
        {name}
      </span>
    ) : null;

  const renderMustDo = (category: string, id: string) => {
    const on = mustDoIds.has(id);
    return (
      <button
        type="button"
        onClick={() => toggleMustDo(category, id)}
        aria-pressed={on}
        className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
          on ? 'border-amber-300 bg-amber-100 text-amber-700' : 'border-gray-200 text-gray-400'
        }`}
      >
        <Flag className={`h-3 w-3 ${on ? 'fill-amber-500' : ''}`} />
        Must do
      </button>
    );
  };

  const renderAsanaControls = (c: WeekCandidate) => {
    if (!c.gid) return null;
    const completing = completingIds.has(c.id);
    return (
      <>
        <a
          href={`https://app.asana.com/0/0/${c.gid}/f`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open "${c.title}" in Asana`}
          className="rounded p-1.5 text-gray-400"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        {c.integrationId && (
          <button
            type="button"
            disabled={completing}
            onClick={() => completeAsana(c.id, c.gid!, c.integrationId!)}
            aria-label={`Mark "${c.title}" done in Asana`}
            className="rounded p-1.5 text-gray-400 disabled:opacity-50"
          >
            {completing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          </button>
        )}
      </>
    );
  };

  const renderDelete = (category: string, c: WeekCandidate) => {
    if (deletingIds.has(c.id)) {
      return (
        <span className="p-1.5" aria-label={`Deleting "${c.title}"`}>
          <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
        </span>
      );
    }
    if (confirmDeleteId === c.id) {
      return (
        <button
          type="button"
          onClick={() => {
            setConfirmDeleteId(null);
            deleteTask(category, c);
          }}
          aria-label={`Confirm delete "${c.title}"`}
          className="rounded border border-red-300 bg-red-100 px-2 py-1 text-[10px] font-medium text-red-700"
        >
          Delete?
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => armDelete(c.id)}
        aria-label={`Delete "${c.title}"`}
        className="rounded p-1.5 text-gray-400"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    );
  };

  const renderCalibration = (cat: WeekCandidateCategory) => {
    const cal = cat.calibration;
    if (!cal) return null;
    const showQuota = cal.weeksOfData >= 3;
    const showBlock = cal.blockSamples >= 5 && typeof cal.suggestedBlockMinutes === 'number';
    if (!showQuota && !showBlock) return null;
    return (
      <div className="mb-2 space-y-0.5">
        {showQuota && (
          <p className="text-[11px] text-gray-400">
            Completed {Math.round(cal.avgCompletionRate * 100)}% of scheduled over {cal.weeksOfData} wks
            {typeof cal.suggestedQuota === 'number' && (
              <span className="text-gray-500"> · suggest {cal.suggestedQuota}/wk instead of {cal.currentQuota}</span>
            )}
          </p>
        )}
        {showBlock && (
          <p className="text-[11px] text-gray-400">Done tasks here usually got {cal.suggestedBlockMinutes}m</p>
        )}
      </div>
    );
  };

  // Tappable title → read-only peek (the desktop double-click, made a single tap).
  const renderTitle = (c: WeekCandidate, className: string) => (
    <button
      type="button"
      onClick={() => onOpenTask(c)}
      className={`${className} text-left`}
      title="Tap to view details"
    >
      {c.title}
    </button>
  );

  const renderDurationSelect = (candidateId: string, defaultDuration: number) => (
    <RowSelect
      value={taskDurationOverrides[candidateId] ?? defaultDuration}
      options={blockLengthOptions(defaultDuration)}
      onChange={v => setTaskDurationOverrides(prev => ({ ...prev, [candidateId]: Number(v) }))}
      ariaLabel="Block length"
    />
  );

  return (
    <div className="space-y-4">
      {renderWalksRow()}
      {addMoreMode && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
          {spareCapacity && spareCapacity.totalMinutes > 0
            ? `You have ~${roughDuration(spareCapacity.totalMinutes)} spare — pick extra tasks to fill it. Quota caps are lifted here.`
            : `Pick extra tasks to fill your remaining free time. Quota caps are lifted here.`}
        </div>
      )}
      {taskCats.map(cat => {
        const color = categoryColor(cat.category);
        const picked = selections[cat.category] ?? new Set<string>();
        const autoN =
          cat.remainingQuota === null
            ? cat.candidates.length
            : Math.min(cat.remainingQuota, cat.candidates.length);
        const defaultDuration = cat.targetLengthMinutes || 30;
        const cap = addMoreMode && !cat.hasMaxSelection ? null : cat.remainingQuota;
        return (
          <div key={cat.category} className="rounded-xl border border-gray-200 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${color.bg} ${color.text}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${color.dot}`} />
                  {cat.category}
                </span>
                {(cat.deferredCount ?? 0) > 0 && (
                  <span className="text-[11px] italic text-gray-400">{cat.deferredCount} deferred to next week</span>
                )}
              </div>
              {cat.autoSelect ? (
                <span className="text-[11px] text-gray-400">
                  Auto-picking {autoN} task{autoN === 1 ? '' : 's'}
                </span>
              ) : cap === null ? (
                <span className="text-[11px] text-gray-400">Pick any · {picked.size} selected</span>
              ) : (
                <span className="text-[11px] text-gray-400">
                  Pick up to {cap} · {picked.size} selected
                </span>
              )}
            </div>

            {/* Grouped categories set one shared block length for the container. */}
            {cat.grouped && (
              <label className="mb-2 flex items-center gap-2 text-[11px] text-gray-500">
                Block length
                <select
                  value={taskDurations[cat.category] ?? defaultDuration}
                  onChange={e => setTaskDurations(prev => ({ ...prev, [cat.category]: Number(e.target.value) }))}
                  className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-orange-500"
                >
                  {blockLengthOptions(defaultDuration).map(o => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {renderCalibration(cat)}

            {cat.candidates.length === 0 ? (
              <p className="text-xs italic text-gray-400">No candidate tasks.</p>
            ) : cat.autoSelect ? (
              <ul className="space-y-2">
                {cat.candidates.slice(0, autoN).map(c => (
                  <li key={c.id} className="rounded-lg bg-gray-50 p-2">
                    {renderTitle(c, 'block w-full text-sm text-gray-500')}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {renderCarriedBadge(c)}
                      {renderIntegrationBadge(c.integrationName)}
                      {renderAsanaControls(c)}
                      {renderDelete(cat.category, c)}
                      {!cat.grouped && renderDurationSelect(c.id, defaultDuration)}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <ul className="space-y-2">
                  {cat.candidates.map(c => {
                    const isMustDo = mustDoIds.has(c.id);
                    const checked = picked.has(c.id) || isMustDo;
                    const atCap = cap !== null && picked.size >= cap;
                    return (
                      <li key={c.id} className="rounded-lg border border-gray-100 p-2">
                        <div className="flex items-start gap-2.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isMustDo || (!checked && atCap)}
                            onChange={() => toggleSelection(cat.category, c.id, cap)}
                            aria-label={`Select "${c.title}"`}
                            className="mt-0.5 h-5 w-5 rounded border-gray-300 text-orange-500 focus:ring-orange-500 disabled:opacity-40"
                          />
                          {c.isPriority && (
                            <Star className="mt-0.5 h-4 w-4 flex-shrink-0 fill-amber-400 text-amber-400" />
                          )}
                          {renderTitle(c, 'flex-1 text-sm text-gray-700')}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7">
                          {renderCarriedBadge(c)}
                          {renderIntegrationBadge(c.integrationName)}
                          {c.dueDate && (
                            <span className="text-[11px] text-gray-400">{format(parseISO(c.dueDate), 'MMM d')}</span>
                          )}
                          {renderMustDo(cat.category, c.id)}
                          {renderAsanaControls(c)}
                          {renderDelete(cat.category, c)}
                          {!cat.grouped && renderDurationSelect(c.id, defaultDuration)}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {cap !== null && picked.size < cap && (
                  <p className="mt-2 text-[11px] text-gray-400">
                    {cap - picked.size} unpicked slot{cap - picked.size === 1 ? '' : 's'} will be kept as reserved
                    time.
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
