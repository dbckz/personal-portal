'use client';

import { Check, AlertTriangle, ArrowRight, ChevronRight, Trash2, Dumbbell, BookOpen, CornerUpRight, Bot, ListPlus } from 'lucide-react';

import type { ReplanAnalyzeResponse } from '@/lib/api';
import type { ReplanCarryTask } from '@/lib/scheduling/replan';
import { categoryColor, formatDuration, slotLabel, titleLabel } from './replanFormat';
import type { CarryMode, MoveMode, StaleMode, UnplaceableMode, ReplanActions } from './useReplanActions';
import { carryTaskKey } from './useReplanActions';

// Shared render of the replan "plan view": moves / stale / missing rituals /
// break deletions / couldn't-fit / unchanged. State + confirm live in the
// useReplanActions hook so both ReplanWeekModal and the daily-review step 2 can
// render exactly the same UI.
export function ReplanSections({
  data,
  actions,
}: {
  data: ReplanAnalyzeResponse;
  actions: ReplanActions;
}) {
  const {
    included,
    moveMode,
    setMoveMode,
    staleMode,
    setStaleMode,
    unplaceableMode,
    setUnplaceableMode,
    unplaceableVictim,
    setUnplaceableVictim,
    additionIncluded,
    additionResults,
    backfill,
    backfillIncluded,
    backfillResults,
    deletionIncluded,
    removalIncluded,
    showUnchanged,
    setShowUnchanged,
    carryBlocks,
    carriedEventIds,
    carryMode,
    setCarryMode,
    toggle,
    toggleAddition,
    toggleBackfill,
    toggleDeletion,
    toggleRemoval,
    results,
    hasResults,
  } = actions;

  const stale = data.stale ?? [];
  const additions = data.additions ?? [];
  const deletions = data.deletions ?? [];
  const removals = data.removals ?? [];
  const tomorrowBlocks = data.tomorrowBlocks ?? [];
  // End-of-week mode: missed + couldn't-fit task blocks move into the carry-over
  // section, so they are filtered out of their usual sections here.
  const moves = data.moves.filter(m => !carriedEventIds.has(m.googleEventId));
  const unplaceable = data.unplaceable.filter(u => !carriedEventIds.has(u.googleEventId));

  // Additions come in two flavours: missing rituals and prep blocks for
  // early-next-week meetings. Same toggle/result plumbing, separate sections.
  const ritualAdditions = additions.filter(a => a.kind !== 'prep');
  const prepAdditions = additions.filter(a => a.kind === 'prep');

  // Task-backfill blocks: the tasks (or agenda) placed into freed/free time.
  const backfillTitles = (b: (typeof backfill)[number]): string[] =>
    Array.isArray(b.tasks) ? b.tasks.map(t => t.title) : b.task ? [b.task.title] : [];

  const backfillRow = (b: (typeof backfill)[number]) => {
    const color = categoryColor(b.category);
    const result = backfillResults[b.id];
    const isIn = backfillIncluded.has(b.id);
    return (
      <li
        key={b.id}
        className={`flex items-start gap-3 rounded-lg border p-3 ${
          isIn ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'
        }`}
      >
        <input
          type="checkbox"
          checked={isIn}
          onChange={() => toggleBackfill(b.id)}
          disabled={hasResults}
          className="mt-1 w-4 h-4 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
        />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${color.bg} ${color.text}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${color.dot}`} />
              {b.category}
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-700">
              add
            </span>
            <span className="text-sm font-medium text-gray-800 truncate">
              {titleLabel(backfillTitles(b))}
            </span>
          </div>
          <div className="mt-1 text-xs text-gray-500">
            <span className="font-medium text-slate-600">{slotLabel(b.date, b.start)}</span>
            <span className="ml-1.5 text-gray-400">· {formatDuration(b.durationMinutes)}</span>
          </div>
        </div>
        {result &&
          (result.success ? (
            <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle
              className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
              aria-label={result.error}
            />
          ))}
      </li>
    );
  };

  const additionRow = (a: (typeof additions)[number]) => {
    const color = categoryColor(a.category);
    const result = additionResults[a.id];
    const isIn = additionIncluded.has(a.id);
    return (
      <li
        key={a.id}
        className={`flex items-start gap-3 rounded-lg border p-3 ${
          isIn ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'
        }`}
      >
        <input
          type="checkbox"
          checked={isIn}
          onChange={() => toggleAddition(a.id)}
          disabled={hasResults}
          className="mt-1 w-4 h-4 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
        />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${color.bg} ${color.text}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${color.dot}`} />
              {a.category}
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-700">
              add
            </span>
            <span className="text-sm font-medium text-gray-800 truncate">
              {a.title ?? a.category}
            </span>
          </div>
          <div className="mt-1 text-xs text-gray-500">
            <span className="font-medium text-slate-600">{slotLabel(a.date, a.start)}</span>
            {a.kind === 'prep' && a.meeting && (
              <> · for {titleLabel([a.meeting.title])}</>
            )}
          </div>
        </div>
        {result &&
          (result.success ? (
            <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle
              className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
              aria-label={result.error}
            />
          ))}
      </li>
    );
  };

  return (
    <div className="space-y-6">
      {/* Moving */}
      {moves.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
            Moving ({moves.length})
          </h3>
          <ul className="space-y-2">
            {moves.map(m => {
              const color = categoryColor(m.category);
              const result = results[m.googleEventId];
              const isIn = included.has(m.googleEventId);
              const isMissed = m.reason === 'missed';
              const mode = moveMode[m.googleEventId] ?? 'reschedule';
              const markingDone = isMissed && mode === 'done';
              return (
                <li
                  key={m.googleEventId}
                  className={`flex items-start gap-3 rounded-lg border p-3 ${
                    isIn ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isIn}
                    onChange={() => toggle(m.googleEventId)}
                    disabled={hasResults}
                    className="mt-1 w-4 h-4 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${color.bg} ${color.text}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${color.dot}`} />
                        {m.category}
                      </span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                          isMissed ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {isMissed ? 'missed' : 'conflict'}
                      </span>
                      <span className="text-sm font-medium text-gray-800 truncate">
                        {titleLabel(m.titles)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
                      <span className="line-through">{slotLabel(m.oldDate, m.oldStart)}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-gray-400" />
                      {markingDone ? (
                        <span className="font-medium text-emerald-600">Mark done (no reschedule)</span>
                      ) : (
                        <span className="font-medium text-slate-600">
                          {slotLabel(m.newDate, m.newStart)}
                        </span>
                      )}
                    </div>
                    {/* Missed rows: choose reschedule or mark done. */}
                    {isMissed && isIn && !hasResults && (
                      <div className="mt-2 inline-flex rounded-md border border-gray-200 overflow-hidden text-[11px] font-medium">
                        {(['reschedule', 'done'] as MoveMode[]).map(opt => (
                          <button
                            key={opt}
                            onClick={() =>
                              setMoveMode(prev => ({ ...prev, [m.googleEventId]: opt }))
                            }
                            className={`px-2.5 py-1 transition-colors ${
                              mode === opt
                                ? 'bg-orange-500 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            {opt === 'reschedule' ? 'Reschedule' : 'Done'}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {result &&
                    (result.success ? (
                      <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle
                        className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
                        aria-label={result.error}
                      />
                    ))}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Stale prep — meeting already happened */}
      {stale.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
            Meeting already happened ({stale.length})
          </h3>
          <ul className="space-y-2">
            {stale.map(s => {
              const result = results[s.googleEventId];
              const mode = staleMode[s.googleEventId] ?? 'leave';
              return (
                <li
                  key={s.googleEventId}
                  className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-gray-800 truncate">
                        {titleLabel(s.titles)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-gray-400">
                      No slot before the meeting — prep can no longer be rescheduled.
                    </p>
                    {!hasResults && (
                      <div className="mt-2 inline-flex rounded-md border border-gray-200 overflow-hidden text-[11px] font-medium">
                        {(['leave', 'done', 'dismiss'] as StaleMode[]).map(opt => (
                          <button
                            key={opt}
                            onClick={() =>
                              setStaleMode(prev => ({ ...prev, [s.googleEventId]: opt }))
                            }
                            className={`px-2.5 py-1 transition-colors ${
                              mode === opt
                                ? opt === 'dismiss'
                                  ? 'bg-red-500 text-white'
                                  : 'bg-orange-500 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            {opt === 'leave' ? 'Leave' : opt === 'done' ? 'Mark done' : 'Dismiss'}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {result &&
                    (result.success ? (
                      <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle
                        className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
                        aria-label={result.error}
                      />
                    ))}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Missing rituals — add on remaining working days */}
      {ritualAdditions.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1.5">
            <Dumbbell className="w-3.5 h-3.5 text-emerald-500" />
            Missing rituals ({ritualAdditions.length})
          </h3>
          <ul className="space-y-2">{ritualAdditions.map(additionRow)}</ul>
        </div>
      )}

      {/* Prep for early-next-week meetings — add on remaining working days */}
      {prepAdditions.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1.5">
            <BookOpen className="w-3.5 h-3.5 text-indigo-500" />
            Prep for next week ({prepAdditions.length})
          </h3>
          <ul className="space-y-2">{prepAdditions.map(additionRow)}</ul>
        </div>
      )}

      {/* Backfill — new task blocks for the remaining week's free time */}
      {backfill.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1.5">
            <ListPlus className="w-3.5 h-3.5 text-orange-500" />
            New task blocks ({backfill.length})
          </h3>
          <ul className="space-y-2">{backfill.map(backfillRow)}</ul>
        </div>
      )}

      {/* Conflicted breaks — remove (a break has no fixed home) */}
      {deletions.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1.5">
            <Trash2 className="w-3.5 h-3.5 text-red-500" />
            Breaks to remove ({deletions.length})
          </h3>
          <ul className="space-y-2">
            {deletions.map(d => {
              const result = results[d.googleEventId];
              const isIn = deletionIncluded.has(d.googleEventId);
              return (
                <li
                  key={d.googleEventId}
                  className={`flex items-start gap-3 rounded-lg border p-3 ${
                    isIn ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isIn}
                    onChange={() => toggleDeletion(d.googleEventId)}
                    disabled={hasResults}
                    className="mt-1 w-4 h-4 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-100 text-red-700">
                        remove
                      </span>
                      <span className="text-sm font-medium text-gray-800 truncate">
                        {titleLabel(d.titles)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      <span className="line-through">{slotLabel(d.oldDate, d.oldStart)}</span>
                      <span className="ml-1.5 text-gray-400">now clashes with a meeting</span>
                    </div>
                  </div>
                  {result &&
                    (result.success ? (
                      <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle
                        className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
                        aria-label={result.error}
                      />
                    ))}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Retired rituals + mis-placed new-bookies — remove (no new slot) */}
      {removals.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1.5">
            <Trash2 className="w-3.5 h-3.5 text-red-500" />
            Rituals to remove ({removals.length})
          </h3>
          <ul className="space-y-2">
            {removals.map(r => {
              const result = results[r.googleEventId];
              const isIn = removalIncluded.has(r.googleEventId);
              const label = r.reason === 'retired' ? 'removed (retired)' : 'removed (mis-placed)';
              const note =
                r.reason === 'retired'
                  ? 'this ritual is no longer scheduled'
                  : 'wrong slot — re-added in the evening (Mon/Fri)';
              return (
                <li
                  key={r.googleEventId}
                  className={`flex items-start gap-3 rounded-lg border p-3 ${
                    isIn ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isIn}
                    onChange={() => toggleRemoval(r.googleEventId)}
                    disabled={hasResults}
                    className="mt-1 w-4 h-4 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-100 text-red-700">
                        {label}
                      </span>
                      <span className="text-sm font-medium text-gray-800 truncate">
                        {titleLabel(r.titles)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      <span className="line-through">{slotLabel(r.oldDate, r.oldStart)}</span>
                      <span className="ml-1.5 text-gray-400">{note}</span>
                    </div>
                  </div>
                  {result &&
                    (result.success ? (
                      <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle
                        className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
                        aria-label={result.error}
                      />
                    ))}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* End of week — carry the leftovers into next week's plan */}
      {carryBlocks.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1.5">
            <CornerUpRight className="w-3.5 h-3.5 text-orange-500" />
            End of week ({carryBlocks.length})
          </h3>
          <p className="mb-2 text-xs text-gray-400">
            No week left to reschedule into. Recurring rituals are scheduled fresh next week.
          </p>
          <ul className="space-y-2">
            {carryBlocks.map(b => {
              const color = categoryColor(b.category);
              const result = results[b.googleEventId];
              const grouped = b.tasks.length > 1;
              const blockMode = carryMode[b.googleEventId] ?? 'carry';
              // A single-task block's decision belongs to its one task, so its
              // streak / delegability drive the block-level option set.
              const only = grouped ? undefined : b.tasks[0];
              return (
                <li
                  key={b.googleEventId}
                  className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${color.bg} ${color.text}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${color.dot}`} />
                        {b.category}
                      </span>
                      <span className="text-sm font-medium text-gray-800 truncate">
                        {titleLabel(b.titles)}
                      </span>
                      {only?.aiDelegable && <AiDelegableIcon />}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      <span className="line-through">{slotLabel(b.date, b.start)}</span>
                      <span className="ml-1.5 text-gray-400">
                        {b.reason === 'missed' ? 'missed' : 'no slot left this week'}
                      </span>
                    </div>
                    <CarryStreakNote task={only} />
                    {/* Single-task block: one choice for the whole block. */}
                    {!grouped && !hasResults && (
                      <CarryOptions
                        task={only}
                        value={blockMode}
                        onChange={v => setCarryMode(prev => ({ ...prev, [b.googleEventId]: v }))}
                      />
                    )}
                    {/* Grouped block: the decision belongs to each member task.
                        Completed members stay checked and inert, as in step 1. */}
                    {grouped && (
                      <ul className="mt-2 space-y-1.5 pl-1">
                        {b.tasks.map(t => {
                          const key = carryTaskKey(b.googleEventId, t.id);
                          const mode = carryMode[key] ?? 'carry';
                          return (
                            <li key={t.id} className="flex flex-wrap items-center gap-2">
                              <input
                                type="checkbox"
                                checked={t.done}
                                disabled
                                readOnly
                                className="w-4 h-4 rounded border-gray-300 text-emerald-500 disabled:opacity-60"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span
                                    className={`text-sm truncate ${
                                      t.done ? 'text-gray-400 line-through' : 'text-gray-700'
                                    }`}
                                  >
                                    {t.title}
                                  </span>
                                  {t.aiDelegable && <AiDelegableIcon />}
                                </div>
                                <CarryStreakNote task={t} className="mt-0.5" />
                              </div>
                              {!t.done && !hasResults && (
                                <CarryOptions
                                  className="mt-0"
                                  task={t}
                                  value={mode}
                                  onChange={v => setCarryMode(prev => ({ ...prev, [key]: v }))}
                                />
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                  {result &&
                    (result.success ? (
                      <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle
                        className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
                        aria-label={result.error}
                      />
                    ))}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Couldn't fit — choose what to do with each block */}
      {unplaceable.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
            Couldn&apos;t fit ({unplaceable.length})
          </h3>
          <ul className="space-y-2">
            {unplaceable.map(u => {
              const color = categoryColor(u.category);
              const result = results[u.googleEventId];
              const mode = unplaceableMode[u.googleEventId] ?? 'defer';
              const hasOverflow = !!u.overflowOption;
              // Evening overflow is configured but this block found no slot — the
              // window filled up. Explain rather than silently dropping the option.
              const overflowFull = !hasOverflow && !!data.overflowConfigured;
              // Only tomorrow's blocks at least as long as this one can host it
              // without overlapping what follows; the mode is offered only when one
              // exists, and shorter blocks are shown disabled (see below).
              const canPrioritise = tomorrowBlocks.some(t => t.durationMinutes >= u.durationMinutes);
              const chosenVictim = tomorrowBlocks.find(
                t => t.googleEventId === unplaceableVictim[u.googleEventId]
              );
              // End-of-week: task-backed rows have moved to the carry-over
              // section, so anything left here (meeting prep) has no week to be
              // rescheduled or bumped into — leaving it unscheduled is the only
              // sensible action.
              // "Delete task" is always offered — mid-week and end-of-week alike —
              // but never the default, and styled distinctly because it is
              // destructive.
              const options: Array<{ v: UnplaceableMode; label: string }> = data.endOfWeek
                ? [
                    { v: 'leave', label: 'Leave unscheduled' },
                    { v: 'drop', label: 'Delete task' },
                  ]
                : [
                    { v: 'defer', label: 'Defer to next week' },
                    { v: 'leave', label: 'Leave unscheduled' },
                    ...(hasOverflow ? [{ v: 'overflow' as UnplaceableMode, label: 'Try evening overflow' }] : []),
                    ...(canPrioritise ? [{ v: 'prioritise' as UnplaceableMode, label: 'Prioritise tomorrow' }] : []),
                    { v: 'drop', label: 'Delete task' },
                  ];
              return (
                <li
                  key={u.googleEventId}
                  className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${color.bg} ${color.text}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${color.dot}`} />
                        {u.category}
                      </span>
                      <span className="text-sm font-medium text-gray-800 truncate">
                        {titleLabel(u.titles)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-amber-600">
                      No free {formatDuration(u.durationMinutes)} slot in working hours this week.
                    </p>
                    {overflowFull && (
                      <p className="mt-0.5 text-xs text-amber-500">
                        Evening overflow is full this week — no free {formatDuration(u.durationMinutes)} evening slot left.
                      </p>
                    )}
                    {mode === 'overflow' && u.overflowOption && (
                      <p className="mt-0.5 text-xs text-slate-600">
                        Evening slot: {slotLabel(u.overflowOption.date, u.overflowOption.start)}
                      </p>
                    )}
                    {mode === 'prioritise' && (
                      <div className="mt-2">
                        {chosenVictim ? (
                          <p className="text-xs text-slate-600">
                            Takes {chosenVictim.category}&apos;s slot ({slotLabel(chosenVictim.date, chosenVictim.start)});
                            it&apos;s deferred to next week.
                          </p>
                        ) : (
                          <p className="text-xs text-amber-600">Pick a block below to bump to next week:</p>
                        )}
                        {!hasResults && (
                          <ul className="mt-1.5 space-y-1">
                            {tomorrowBlocks.map(t => {
                              const tColor = categoryColor(t.category);
                              const picked = chosenVictim?.googleEventId === t.googleEventId;
                              const vResult = results[t.googleEventId];
                              // Too short to hold the prioritised block → not selectable.
                              const tooShort = t.durationMinutes < u.durationMinutes;
                              return (
                                <li key={t.googleEventId}>
                                  <button
                                    disabled={tooShort}
                                    title={tooShort ? 'Too short to hold this block' : undefined}
                                    onClick={() =>
                                      setUnplaceableVictim(prev => ({
                                        ...prev,
                                        [u.googleEventId]: picked ? '' : t.googleEventId,
                                      }))
                                    }
                                    className={`flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-[11px] transition-colors ${
                                      tooShort
                                        ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                                        : picked
                                          ? 'border-orange-300 bg-orange-50'
                                          : 'border-gray-200 bg-white hover:bg-gray-50'
                                    }`}
                                  >
                                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tColor.dot}`} />
                                    <span className="font-medium text-gray-700 truncate">
                                      {titleLabel(t.titles)}
                                    </span>
                                    <span className="ml-auto flex-shrink-0 text-gray-400">
                                      {slotLabel(t.date, t.start)} · {formatDuration(t.durationMinutes)}
                                      {tooShort && ' · too short'}
                                    </span>
                                    {vResult &&
                                      (vResult.success ? (
                                        <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                                      ) : (
                                        <AlertTriangle
                                          className="w-3.5 h-3.5 text-red-500 flex-shrink-0"
                                          aria-label={vResult.error}
                                        />
                                      ))}
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                    {mode === 'drop' && !hasResults && (
                      <p className="mt-0.5 text-xs text-rose-600">
                        Deletes the calendar block and the Asana task.
                      </p>
                    )}
                    {!hasResults && (
                      <div className="mt-2 inline-flex rounded-md border border-gray-200 overflow-hidden text-[11px] font-medium">
                        {options.map(opt => (
                          <button
                            key={opt.v}
                            onClick={() =>
                              setUnplaceableMode(prev => ({ ...prev, [u.googleEventId]: opt.v }))
                            }
                            className={`px-2.5 py-1 transition-colors ${
                              mode === opt.v
                                ? opt.v === 'drop'
                                  ? 'bg-rose-600 text-white'
                                  : 'bg-orange-500 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {result &&
                    (result.success ? (
                      <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle
                        className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
                        aria-label={result.error}
                      />
                    ))}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Unchanged (subdued, collapsed) */}
      {data.kept.length > 0 && (
        <div>
          <button
            onClick={() => setShowUnchanged(v => !v)}
            className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-600"
          >
            <ChevronRight
              className={`w-3.5 h-3.5 transition-transform ${showUnchanged ? 'rotate-90' : ''}`}
            />
            Unchanged ({data.kept.length})
          </button>
          {showUnchanged && (
            <ul className="mt-2 space-y-1">
              {data.kept.map(k => (
                <li key={k.googleEventId} className="flex items-center gap-2 text-sm text-gray-500">
                  <span className="truncate flex-1">{titleLabel(k.titles)}</span>
                  <span className="text-[11px] text-gray-400 flex-shrink-0">
                    {slotLabel(k.date, k.start)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// The end-of-week choice for one block or one member task: carry it into next
// week's plan (default), drop it back to the backlog unbadged, or mark it done.
const CARRY_OPTIONS: Array<{ v: CarryMode; label: string }> = [
  { v: 'carry', label: 'Carry over to next week' },
  { v: 'backlog', label: 'Back to backlog' },
  { v: 'done', label: 'Mark done' },
];

// A task carried two or more weeks running keeps sliding, so plain "carry it
// again" is no longer the headline choice: lead with committing to it, and offer
// handing it to an agent when it is AI-runnable.
const ESCALATED_CARRY_OPTIONS: Array<{ v: CarryMode; label: string }> = [
  { v: 'mustDo', label: 'Must do next week' },
  { v: 'delegate', label: 'Delegate' },
  { v: 'carry', label: 'Carry again' },
  { v: 'backlog', label: 'Drop to backlog' },
  { v: 'done', label: 'Mark done' },
];

const carryStreakOf = (task?: ReplanCarryTask) => task?.carryStreak ?? 0;
// Delegating needs an Asana-backed task the AI assessment flagged as runnable.
const canDelegate = (task?: ReplanCarryTask) =>
  !!(task?.aiDelegable && task.gid && task.integrationId);

// Small indigo robot marking an AI-runnable task, matching the dashboard's
// AI-runnable card.
function AiDelegableIcon() {
  return (
    <Bot className="w-3.5 h-3.5 text-indigo-600 flex-shrink-0" aria-label="AI-runnable" />
  );
}

function CarryStreakNote({ task, className = 'mt-1' }: { task?: ReplanCarryTask; className?: string }) {
  const streak = carryStreakOf(task);
  if (streak < 2) return null;
  return <p className={`${className} text-[11px] text-gray-400`}>carried {streak} weeks running</p>;
}

function CarryOptions({
  value,
  onChange,
  task,
  className = 'mt-2',
}: {
  value: CarryMode;
  onChange: (v: CarryMode) => void;
  task?: ReplanCarryTask;
  className?: string;
}) {
  const options =
    carryStreakOf(task) >= 2
      ? ESCALATED_CARRY_OPTIONS.filter(opt => opt.v !== 'delegate' || canDelegate(task))
      : CARRY_OPTIONS;
  return (
    <div
      className={`${className} inline-flex rounded-md border border-gray-200 overflow-hidden text-[11px] font-medium flex-shrink-0`}
    >
      {options.map(opt => (
        <button
          key={opt.v}
          onClick={() => onChange(opt.v)}
          className={`px-2.5 py-1 transition-colors ${
            value === opt.v
              ? opt.v === 'done'
                ? 'bg-emerald-500 text-white'
                : opt.v === 'delegate'
                  ? 'bg-indigo-500 text-white'
                  : 'bg-orange-500 text-white'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Whether an analyze result has anything to act on in the plan view.
export function replanHasWork(data: ReplanAnalyzeResponse): boolean {
  return (
    data.moves.length > 0 ||
    data.unplaceable.length > 0 ||
    (data.stale?.length ?? 0) > 0 ||
    (data.additions?.length ?? 0) > 0 ||
    (data.backfill?.length ?? 0) > 0 ||
    (data.deletions?.length ?? 0) > 0 ||
    (data.removals?.length ?? 0) > 0
  );
}
