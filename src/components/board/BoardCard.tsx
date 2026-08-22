'use client';

import { ExternalLink, Repeat } from 'lucide-react';

import { BOARD_COLUMNS, type BoardCard as BoardCardModel, type BoardStatus } from '@/types';
import { asanaTaskUrl } from '@/lib/asana-url';
import { dayLetterChips, plannedBlockLabel } from '@/lib/board-format';

const PRIORITY_DOT: Record<'low' | 'medium' | 'high', string> = {
  low: 'bg-gray-300',
  medium: 'bg-amber-400',
  high: 'bg-red-500',
};

interface BoardCardProps {
  card: BoardCardModel;
  weekStart: string;
  busy: boolean;
  onMove: (card: BoardCardModel, status: BoardStatus) => void;
  onDragStart: (card: BoardCardModel) => void;
  onDragEnd: () => void;
}

// The source hint shown at the foot of a card.
function sourceHint(card: BoardCardModel): string {
  if (card.source === 'asana') return card.projectName || 'Asana';
  if (card.source === 'ritual') return 'Ritual';
  return 'Ad hoc';
}

export function BoardCard({ card, weekStart, busy, onMove, onDragStart, onDragEnd }: BoardCardProps) {
  const isAsana = card.source === 'asana';
  const clickable = isAsana && !!card.gid;

  const openAsana = () => {
    if (clickable && card.gid) window.open(asanaTaskUrl(card.gid), '_blank', 'noopener');
  };

  return (
    <div
      draggable={!busy}
      onDragStart={e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.stateKey);
        onDragStart(card);
      }}
      onDragEnd={onDragEnd}
      className={`group rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition ${
        busy ? 'opacity-50' : 'cursor-grab hover:border-gray-300 hover:shadow'
      }`}
      data-testid="board-card"
      data-card-key={card.key}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={clickable ? openAsana : undefined}
          className={`min-w-0 flex-1 text-left text-sm font-medium text-gray-900 ${
            clickable ? 'hover:text-orange-600' : 'cursor-default'
          }`}
        >
          <span className="break-words">{card.title}</span>
          {clickable && (
            <ExternalLink className="ml-1 inline h-3 w-3 flex-shrink-0 text-gray-400 opacity-0 group-hover:opacity-100" />
          )}
        </button>
        {card.recurring && (
          <span title="Recurring" className="flex-shrink-0 text-gray-400">
            <Repeat className="h-3.5 w-3.5" />
          </span>
        )}
      </div>

      {/* Type + planned chips */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {(card.typeEmoji || card.typeLabel) && (
          <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
            {card.typeEmoji && <span>{card.typeEmoji}</span>}
            {card.typeLabel && <span>{card.typeLabel}</span>}
          </span>
        )}

        {card.recurring ? (
          <span className="inline-flex items-center gap-1 rounded bg-gray-50 px-1 py-0.5">
            {dayLetterChips(weekStart, card.plannedDates).map((chip, i) => (
              <span
                key={`${chip.date}-${i}`}
                className={`flex h-4 w-4 items-center justify-center rounded text-[10px] font-semibold ${
                  chip.filled ? 'bg-orange-500 text-white' : 'bg-gray-200 text-gray-400'
                }`}
              >
                {chip.letter}
              </span>
            ))}
            {card.cadence && <span className="ml-1 text-[11px] text-gray-400">{card.cadence}</span>}
          </span>
        ) : card.blocks.length > 0 ? (
          card.blocks.slice(0, 3).map((block, i) => (
            <span
              key={`${block.date}-${block.start ?? ''}-${i}`}
              className="inline-flex items-center rounded bg-orange-50 px-1.5 py-0.5 text-[11px] text-orange-700"
            >
              {plannedBlockLabel(block)}
            </span>
          ))
        ) : (
          <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">
            Unplanned
          </span>
        )}
      </div>

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
  );
}
