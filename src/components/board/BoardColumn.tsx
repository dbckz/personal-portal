'use client';

import { useState } from 'react';

import type { BoardCard as BoardCardModel, BoardCardMember, BoardStatus } from '@/types';
import { BoardCard } from './BoardCard';

interface BoardColumnProps {
  label: string;
  status: BoardStatus;
  cards: BoardCardModel[];
  busyKeys: Set<string>;
  onMove: (card: BoardCardModel, status: BoardStatus) => void;
  onToggleMember: (card: BoardCardModel, member: BoardCardMember) => void;
  onCardDragStart: (card: BoardCardModel) => void;
  onCardDragEnd: () => void;
  // The card currently being dragged (null when none), so a drop onto its own
  // column is a no-op and the highlight only shows for a real target.
  draggingCard: BoardCardModel | null;
}

export function BoardColumn({
  label,
  status,
  cards,
  busyKeys,
  onMove,
  onToggleMember,
  onCardDragStart,
  onCardDragEnd,
  draggingCard,
}: BoardColumnProps) {
  const [isOver, setIsOver] = useState(false);
  const canDrop = !!draggingCard && draggingCard.status !== status;
  // 'Agents running' is the one manually-set, automation column — give it an
  // indigo accent (unused elsewhere) so it reads distinctly; the other columns
  // keep the shared neutral treatment.
  const accented = status === 'agents_running';

  return (
    <div
      onDragOver={e => {
        if (!canDrop) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!isOver) setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={e => {
        e.preventDefault();
        setIsOver(false);
        if (draggingCard && draggingCard.status !== status) onMove(draggingCard, status);
      }}
      className={`flex min-h-[8rem] flex-col rounded-xl border p-2 transition-colors ${
        isOver && canDrop ? 'border-orange-300 bg-orange-50' : 'border-transparent bg-gray-50'
      }`}
      data-testid={`board-column-${status}`}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <h3
          className={`text-xs font-semibold uppercase tracking-wide ${
            accented ? 'text-indigo-500' : 'text-gray-500'
          }`}
        >
          {label}
        </h3>
        <span
          className={`rounded-full px-1.5 text-[11px] font-medium ${
            accented ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-200 text-gray-600'
          }`}
        >
          {cards.length}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2">
        {cards.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-gray-400">Nothing here</p>
        ) : (
          cards.map(card => (
            <BoardCard
              key={card.stateKey}
              card={card}
              busyKeys={busyKeys}
              onMove={onMove}
              onToggleMember={onToggleMember}
              onDragStart={onCardDragStart}
              onDragEnd={onCardDragEnd}
            />
          ))
        )}
      </div>
    </div>
  );
}
