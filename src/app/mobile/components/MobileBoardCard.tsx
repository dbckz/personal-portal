'use client';

import { Loader2, Repeat } from 'lucide-react';
import type { BoardCard } from '@/types';
import { dayLetterChips, plannedBlockLabel } from '@/lib/board-format';

// One tappable card row in the mobile board's status list. Shows the title,
// type (emoji + label), planned date(s) and a source hint. Recurring cards show
// M T W T F S S day-letter chips with the planned days filled.
export function MobileBoardCard({
  card,
  weekStart,
  busy,
  onOpen,
}: {
  card: BoardCard;
  weekStart: string;
  busy: boolean;
  onOpen: (card: BoardCard) => void;
}) {
  const sourceHint =
    card.source === 'asana'
      ? card.projectName || 'Asana'
      : card.source === 'adhoc'
        ? 'Ad hoc'
        : 'Ritual';

  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      className={`relative w-full rounded-lg border border-gray-200 bg-white p-3 text-left shadow-sm transition-colors active:bg-gray-50 ${
        busy ? 'opacity-60' : ''
      }`}
    >
      {busy && (
        <span className="absolute right-2 top-2 text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
        </span>
      )}

      <div className="flex items-start gap-2">
        {card.priority === 'high' && (
          <span
            className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-red-500"
            aria-label="High priority"
          />
        )}
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-gray-950">
          {card.title}
        </span>
        {card.recurring && (
          <Repeat className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400" aria-label="Recurring" />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        {(card.typeEmoji || card.typeLabel) && (
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
            {card.typeEmoji && <span>{card.typeEmoji}</span>}
            {card.typeLabel && <span>{card.typeLabel}</span>}
          </span>
        )}

        {card.recurring ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
            <span className="flex items-center gap-0.5">
              {dayLetterChips(weekStart, card.plannedDates).map((cell, i) => (
                <span
                  key={i}
                  className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold ${
                    cell.filled ? 'bg-orange-500 text-white' : 'bg-gray-200 text-gray-400'
                  }`}
                >
                  {cell.letter}
                </span>
              ))}
            </span>
            <span className="text-gray-500">{card.cadence === 'weekly' ? 'weekly' : 'daily'}</span>
          </span>
        ) : card.plannedDates.length === 0 ? (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-400">Unplanned</span>
        ) : card.blocks.length === 1 ? (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
            {plannedBlockLabel(card.blocks[0])}
          </span>
        ) : (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
            {plannedBlockLabel(card.blocks[0])} +{card.blocks.length - 1}
          </span>
        )}

        <span className="text-gray-400">{sourceHint}</span>
      </div>
    </button>
  );
}
