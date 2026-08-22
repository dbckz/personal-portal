'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Plus } from 'lucide-react';
import {
  AdHocTask,
  BOARD_COLUMNS,
  type BoardCard,
  type BoardStatus,
  CalendarEvent,
  CustomTaskType,
  ScheduledAsanaTask,
  TaskMetadata,
} from '@/types';
import { filterCardsForDay, weekStartFor } from '@/lib/board';
import { addDaysStr, dayFilterChips, todayStr, weekRangeLabel } from '@/lib/board-format';
import { useBoard } from '@/hooks/useBoard';
import { MobileBoardCard } from '../components/MobileBoardCard';
import { MobileBoardCardSheet } from '../components/MobileBoardCardSheet';
import { MobileBoardAddSheet } from '../components/MobileBoardAddSheet';

function shiftWeek(weekStart: string, weeks: number): string {
  return addDaysStr(weekStart, weeks * 7);
}

type DayFilter = 'all' | 'unplanned' | string;

// The mobile weekly task board: week nav, a day-chips filter, a status segment
// and the selected column's cards as a tappable list. Reuses useBoard /
// buildBoardCards / BOARD_COLUMNS so it stays in step with desktop.
export function MobileBoardTab({
  asanaTasks,
  adHocTasks,
  scheduledAsanaTasks,
  metadataByGid,
  customTypes,
  saveMetadata,
  onCompleteAsana,
  onUpdateAdhoc,
  onCreateAdhoc,
}: {
  asanaTasks: CalendarEvent[]; // live incomplete Asana tasks
  adHocTasks: AdHocTask[];
  scheduledAsanaTasks: ScheduledAsanaTask[];
  metadataByGid: Record<string, TaskMetadata>;
  customTypes: CustomTaskType[];
  saveMetadata: (
    gid: string,
    integrationId: string,
    updates: Partial<Omit<TaskMetadata, 'asanaTaskGid' | 'integrationId' | 'updatedAt'>>
  ) => Promise<void>;
  onCompleteAsana: (gid: string, integrationId: string, completed: boolean) => Promise<void>;
  onUpdateAdhoc: (id: string, updates: Partial<AdHocTask>) => Promise<AdHocTask | null>;
  onCreateAdhoc: (task: Omit<AdHocTask, 'id' | 'createdAt' | 'updatedAt'>) => Promise<AdHocTask | null>;
}) {
  const today = todayStr();
  const [weekStart, setWeekStart] = useState(() => weekStartFor(new Date()));
  const [dayFilter, setDayFilter] = useState<DayFilter>('all');
  const [status, setStatus] = useState<BoardStatus>('todo');
  const [openStateKey, setOpenStateKey] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const { cards, isLoading, error, moveCard, pinToWeek, busyKeys } = useBoard({
    weekStart,
    asanaTasks,
    adHocTasks,
    scheduledAsanaTasks,
    metadataByGid,
    customTypes,
    saveMetadata,
    onCompleteAsana,
    onToggleAdhocComplete: async (card: BoardCard, completed: boolean) => {
      if (card.adhocId) await onUpdateAdhoc(card.adhocId, { completed });
    },
  });

  const days = useMemo(() => dayFilterChips(weekStart), [weekStart]);

  // Counts for the day chips: how many cards touch each day (all statuses).
  const dayCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: cards.length,
      unplanned: filterCardsForDay(cards, 'unplanned').length,
    };
    for (const day of days) counts[day.date] = filterCardsForDay(cards, day.date).length;
    return counts;
  }, [cards, days]);

  const filteredCards = useMemo(
    () => filterCardsForDay(cards, dayFilter),
    [cards, dayFilter]
  );

  const statusCounts = useMemo(() => {
    const counts: Record<BoardStatus, number> = { todo: 0, in_progress: 0, waiting: 0, done: 0 };
    for (const card of filteredCards) counts[card.status] += 1;
    return counts;
  }, [filteredCards]);

  const columnCards = useMemo(
    () => filteredCards.filter(c => c.status === status),
    [filteredCards, status]
  );

  // Re-resolve the open card from the freshly-built list so its highlighted
  // status button follows a move.
  const openCard = useMemo(
    () => (openStateKey ? cards.find(c => c.stateKey === openStateKey) ?? null : null),
    [cards, openStateKey]
  );

  // A day within the visible week to pre-select in the add form.
  const addInitialDay = useMemo(() => {
    if (dayFilter !== 'all' && dayFilter !== 'unplanned') return dayFilter;
    if (today >= weekStart && today <= days[6].date) return today;
    return undefined;
  }, [dayFilter, today, weekStart, days]);

  const chipClass = (active: boolean) =>
    `flex flex-shrink-0 flex-col items-center rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
      active
        ? 'bg-orange-600 text-white'
        : 'border border-gray-200 bg-white text-gray-600 active:bg-gray-100'
    }`;

  return (
    <div className="space-y-3">
      {/* Week nav */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setWeekStart(w => shiftWeek(w, -1))}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 active:bg-gray-100"
          aria-label="Previous week"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 text-center text-sm font-semibold text-gray-950">
          {weekRangeLabel(weekStart)}
        </div>
        <button
          type="button"
          onClick={() => setWeekStart(w => shiftWeek(w, 1))}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 active:bg-gray-100"
          aria-label="Next week"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setWeekStart(weekStartFor(new Date()))}
          className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 active:bg-gray-100"
        >
          This week
        </button>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1 rounded-full bg-orange-600 px-3 py-1.5 text-xs font-medium text-white active:bg-orange-700"
        >
          <Plus className="h-4 w-4" /> Add task
        </button>
      </div>

      {/* Day chips */}
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
        <button type="button" onClick={() => setDayFilter('all')} className={chipClass(dayFilter === 'all')}>
          <span>All</span>
          <span className="text-[10px] opacity-70">{dayCounts.all}</span>
        </button>
        {days.map(day => (
          <button
            key={day.date}
            type="button"
            onClick={() => setDayFilter(day.date)}
            className={`${chipClass(dayFilter === day.date)} ${
              day.date === today && dayFilter !== day.date ? 'ring-1 ring-orange-400' : ''
            }`}
          >
            <span>{day.label}</span>
            <span className="text-[10px] opacity-70">{dayCounts[day.date] ?? 0}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setDayFilter('unplanned')}
          className={chipClass(dayFilter === 'unplanned')}
        >
          <span>Unplanned</span>
          <span className="text-[10px] opacity-70">{dayCounts.unplanned}</span>
        </button>
      </div>

      {/* Status segment */}
      <div className="grid grid-cols-4 gap-1 rounded-lg bg-gray-100 p-1">
        {BOARD_COLUMNS.map(col => {
          const active = col.id === status;
          return (
            <button
              key={col.id}
              type="button"
              onClick={() => setStatus(col.id)}
              className={`flex flex-col items-center justify-center rounded-md px-1 py-1.5 text-[11px] font-medium leading-tight transition-colors ${
                active ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 active:text-gray-700'
              }`}
            >
              <span>{col.label}</span>
              <span className="text-[10px] opacity-70">{statusCounts[col.id]}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
      )}

      {/* Column cards */}
      {isLoading && cards.length === 0 ? (
        <div className="flex justify-center py-10 text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : columnCards.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-400">Nothing here.</p>
      ) : (
        <div className="space-y-2">
          {columnCards.map(card => (
            <MobileBoardCard
              key={card.stateKey}
              card={card}
              weekStart={weekStart}
              busy={busyKeys.has(card.key)}
              onOpen={c => setOpenStateKey(c.stateKey)}
            />
          ))}
        </div>
      )}

      {openCard && (
        <MobileBoardCardSheet
          card={openCard}
          weekStart={weekStart}
          busy={busyKeys.has(openCard.key)}
          moveError={error}
          onMove={moveCard}
          onClose={() => setOpenStateKey(null)}
        />
      )}

      {showAdd && (
        <MobileBoardAddSheet
          weekStart={weekStart}
          initialDay={addInitialDay}
          customTypes={customTypes}
          asanaTasks={asanaTasks}
          onCreateAdhoc={onCreateAdhoc}
          pinToWeek={pinToWeek}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}
