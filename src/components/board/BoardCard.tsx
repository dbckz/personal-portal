'use client';

import { useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';

import {
  BOARD_COLUMNS,
  type BoardCard as BoardCardModel,
  type BoardCardMember,
  type BoardStatus,
} from '@/types';
import { asanaTaskUrl } from '@/lib/asana-url';
import { boardWhenLabel } from '@/lib/board-format';
import { BoardCardDetailModal } from './BoardCardDetailModal';

const PRIORITY_DOT: Record<'low' | 'medium' | 'high', string> = {
  low: 'bg-gray-300',
  medium: 'bg-amber-400',
  high: 'bg-red-500',
};

interface BoardCardProps {
  card: BoardCardModel;
  busyKeys: Set<string>;
  onMove: (card: BoardCardModel, status: BoardStatus) => void;
  onToggleMember: (card: BoardCardModel, member: BoardCardMember) => void;
  onDragStart: (card: BoardCardModel) => void;
  onDragEnd: () => void;
}

// The source hint shown at the foot of a card.
function sourceHint(card: BoardCardModel): string {
  if (card.source === 'ritual') return 'Ritual';
  if (card.source === 'prep') return 'Prep';
  if (card.source === 'group') return `${card.members.length} tasks`;
  const asana = card.members.find(m => m.source === 'asana');
  if (card.gid || asana) return card.projectName || asana?.projectName || 'Asana';
  return 'Ad hoc';
}

export function BoardCard({
  card,
  busyKeys,
  onMove,
  onToggleMember,
  onDragStart,
  onDragEnd,
}: BoardCardProps) {
  const [showDetail, setShowDetail] = useState(false);
  const busy = busyKeys.has(card.key);
  const clickable = !!card.gid && card.source !== 'group';
  const whenLabel = boardWhenLabel(card);
  const doneCount = card.members.filter(m => m.done).length;

  const openAsana = () => {
    if (clickable && card.gid) window.open(asanaTaskUrl(card.gid), '_blank', 'noopener');
  };

  // Double-click opens the detail modal — but not when the double-click lands on
  // an interactive control (the title link, member checkboxes, the status
  // select), which have their own behaviour.
  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, select, a, input')) return;
    setShowDetail(true);
  };

  return (
    <>
    <div
      draggable={!busy}
      onDragStart={e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.stateKey);
        onDragStart(card);
      }}
      onDragEnd={onDragEnd}
      onDoubleClick={onDoubleClick}
      className={`group rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition ${
        busy ? 'opacity-50' : 'cursor-grab hover:border-gray-300 hover:shadow'
      }`}
      data-testid="board-card"
      data-card-key={card.key}
    >
      <button
        type="button"
        onClick={clickable ? openAsana : undefined}
        className={`block min-w-0 text-left text-sm font-medium text-gray-900 ${
          clickable ? 'hover:text-orange-600' : 'cursor-default'
        }`}
      >
        <span className="break-words">{card.title}</span>
        {clickable && (
          <ExternalLink className="ml-1 inline h-3 w-3 flex-shrink-0 text-gray-400 opacity-0 group-hover:opacity-100" />
        )}
      </button>

      {/* Type + when chips */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {(card.typeEmoji || card.typeLabel) && (
          <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
            {card.typeEmoji && <span>{card.typeEmoji}</span>}
            {card.typeLabel && <span>{card.typeLabel}</span>}
          </span>
        )}
        {whenLabel ? (
          <span className="inline-flex items-center rounded bg-orange-50 px-1.5 py-0.5 text-[11px] text-orange-700">
            {whenLabel}
          </span>
        ) : (
          <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">
            Unplanned
          </span>
        )}
      </div>

      {/* Group member list */}
      {card.source === 'group' && card.members.length > 0 && (
        <div className="mt-2 space-y-1">
          {card.members.map(member => {
            const memberBusy = busyKeys.has(member.key);
            return (
              <button
                key={member.key}
                type="button"
                disabled={memberBusy}
                onClick={() => onToggleMember(card, member)}
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <span
                  className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                    member.done ? 'border-orange-500 bg-orange-500 text-white' : 'border-gray-300 bg-white'
                  }`}
                >
                  {member.done && <Check className="h-3 w-3" />}
                </span>
                <span className={`min-w-0 flex-1 truncate ${member.done ? 'text-gray-400 line-through' : ''}`}>
                  {member.title}
                </span>
              </button>
            );
          })}
          <p className="px-1 text-[11px] text-gray-400">
            {doneCount}/{card.members.length} done
          </p>
        </div>
      )}

      {/* Footer: source hint, priority, status select fallback */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 truncate text-[11px] text-gray-400">
          {card.priority && (
            <span
              className={`h-2 w-2 flex-shrink-0 rounded-full ${PRIORITY_DOT[card.priority]}`}
              title={`${card.priority} priority`}
            />
          )}
          <span className="truncate">{sourceHint(card)}</span>
        </span>
        <select
          aria-label="Move card"
          value={card.status}
          disabled={busy}
          onChange={e => onMove(card, e.target.value as BoardStatus)}
          className="max-w-[7.5rem] rounded border border-gray-200 bg-white px-1 py-0.5 text-[11px] text-gray-600 focus:border-orange-400 focus:outline-none"
        >
          {BOARD_COLUMNS.map(col => (
            <option key={col.id} value={col.id}>
              {col.label}
            </option>
          ))}
        </select>
      </div>
    </div>

    {showDetail && (
      <BoardCardDetailModal
        card={card}
        busyKeys={busyKeys}
        onMove={onMove}
        onToggleMember={onToggleMember}
        onClose={() => setShowDetail(false)}
      />
    )}
    </>
  );
}
