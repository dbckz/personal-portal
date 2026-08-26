'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';

import { api } from '@/lib/api';
import { useBoard } from '@/hooks/useBoard';
import {
  boardKeyForAdhoc,
  boardKeyForAsana,
  asanaTypeLabel,
  filterCardsForDay,
  weekStartFor,
} from '@/lib/board';
import { addDaysStr, todayStr } from '@/lib/board-format';
import {
  BOARD_COLUMNS,
  type AdHocTask,
  type BoardCard,
  type BoardStatus,
  type CalendarEvent,
  type CustomTaskType,
  type ScheduledAsanaTask,
  type TaskMetadata,
} from '@/types';
import { BoardColumn } from '@/components/board/BoardColumn';
import { DayFilterChips, type DayFilter } from '@/components/board/DayFilterChips';
import { WeekNav } from '@/components/board/WeekNav';
import { AddBoardTaskModal, type NewBoardTask } from '@/components/board/AddBoardTaskModal';

interface BoardTabProps {
  asanaTasks: CalendarEvent[]; // live incomplete Asana tasks
  adHocTasks: AdHocTask[];
  scheduledAsanaTasks: ScheduledAsanaTask[];
  metadataByGid: Record<string, TaskMetadata>;
  saveMetadata: (
    gid: string,
    integrationId: string,
    updates: Partial<Omit<TaskMetadata, 'asanaTaskGid' | 'integrationId' | 'updatedAt'>>
  ) => Promise<void>;
  completeAsanaTask: (gid: string, integrationId: string, completed: boolean) => Promise<unknown>;
  addTask: (task: Omit<AdHocTask, 'id' | 'createdAt' | 'updatedAt'>) => Promise<AdHocTask | null>;
  updateTask: (id: string, updates: Partial<AdHocTask>) => Promise<AdHocTask | null>;
}

export function BoardTab({
  asanaTasks,
  adHocTasks,
  scheduledAsanaTasks,
  metadataByGid,
  saveMetadata,
  completeAsanaTask,
  addTask,
  updateTask,
}: BoardTabProps) {
  const [weekStart, setWeekStart] = useState(() => weekStartFor(new Date()));
  const [dayFilter, setDayFilter] = useState<DayFilter>('all');
  const [customTypes, setCustomTypes] = useState<CustomTaskType[]>([]);
  const [draggingCard, setDraggingCard] = useState<BoardCard | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const thisWeek = weekStartFor(new Date());
  const today = todayStr();

  useEffect(() => {
    api.getCustomTaskTypes().then(r => setCustomTypes(r.customTypes)).catch(console.error);
  }, []);

  const onCompleteAsana = useCallback(
    async (gid: string, integrationId: string, completed: boolean) => {
      await completeAsanaTask(gid, integrationId, completed);
    },
    [completeAsanaTask]
  );

  const onToggleAdhocComplete = useCallback(
    async (card: BoardCard, completed: boolean) => {
      if (card.adhocId) await updateTask(card.adhocId, { completed });
    },
    [updateTask]
  );

  const { cards, isLoading, error, moveCard, toggleMember, pinToWeek, busyKeys } = useBoard({
    weekStart,
    asanaTasks,
    adHocTasks,
    scheduledAsanaTasks,
    metadataByGid,
    customTypes,
    onCompleteAsana,
    onToggleAdhocComplete,
    saveMetadata,
  });

  // Per-chip counts, from the full (unfiltered) week.
  const counts = useMemo(() => {
    const byDate: Record<string, number> = {};
    let unplanned = 0;
    for (const card of cards) {
      if (!card.date) unplanned += 1;
      else byDate[card.date] = (byDate[card.date] ?? 0) + 1;
    }
    return { all: cards.length, unplanned, byDate };
  }, [cards]);

  const visibleCards = useMemo(() => filterCardsForDay(cards, dayFilter), [cards, dayFilter]);

  const cardsByStatus = useMemo(() => {
    const map: Record<BoardStatus, BoardCard[]> = {
      todo: [],
      agents_running: [],
      in_progress: [],
      waiting: [],
      done: [],
    };
    for (const card of visibleCards) map[card.status].push(card);
    return map;
  }, [visibleCards]);

  const goWeek = useCallback((next: string) => {
    setWeekStart(next);
    setDayFilter('all');
  }, []);

  const handleAddNew = useCallback(
    async (task: NewBoardTask) => {
      const created = await addTask({
        title: task.title,
        dueDate: task.dueDate,
        duration: task.duration,
        priority: task.priority,
        taskType: task.taskType,
        completed: false,
      });
      if (created) {
        await pinToWeek({
          key: boardKeyForAdhoc(created.id),
          title: task.title,
          typeLabel: task.typeLabel,
          status: 'todo',
        });
      }
    },
    [addTask, pinToWeek]
  );

  const handleAddAsana = useCallback(
    async (task: CalendarEvent) => {
      await pinToWeek({
        key: boardKeyForAsana(task.id),
        title: task.title,
        typeLabel: asanaTypeLabel(task),
        integrationId: task.integrationId,
        status: 'todo',
      });
    },
    [pinToWeek]
  );

  const defaultDay =
    dayFilter !== 'all' && dayFilter !== 'unplanned' ? dayFilter : undefined;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-gray-900">Board</h2>
          <p className="text-sm text-gray-500">This week&apos;s tasks by status.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <WeekNav
            weekStart={weekStart}
            isThisWeek={weekStart === thisWeek}
            onPrev={() => goWeek(addDaysStr(weekStart, -7))}
            onNext={() => goWeek(addDaysStr(weekStart, 7))}
            onThisWeek={() => goWeek(thisWeek)}
          />
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-sm font-medium text-white hover:bg-orange-600"
          >
            <Plus className="h-4 w-4" />
            Add task
          </button>
        </div>
      </div>

      <div className="mb-4">
        <DayFilterChips
          weekStart={weekStart}
          selected={dayFilter}
          today={today}
          counts={counts}
          onSelect={setDayFilter}
        />
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {isLoading && cards.length === 0 ? (
        <div className="flex items-center justify-center gap-3 py-16 text-sm text-gray-500">
          <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-orange-500" />
          Loading the board…
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {BOARD_COLUMNS.map(col => (
            <BoardColumn
              key={col.id}
              label={col.label}
              status={col.id}
              cards={cardsByStatus[col.id]}
              busyKeys={busyKeys}
              onMove={moveCard}
              onToggleMember={toggleMember}
              onCardDragStart={setDraggingCard}
              onCardDragEnd={() => setDraggingCard(null)}
              draggingCard={draggingCard}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <AddBoardTaskModal
          weekStart={weekStart}
          defaultDay={defaultDay}
          customTypes={customTypes}
          asanaTasks={asanaTasks}
          onClose={() => setShowAdd(false)}
          onAddNew={handleAddNew}
          onAddAsana={handleAddAsana}
        />
      )}
    </div>
  );
}
