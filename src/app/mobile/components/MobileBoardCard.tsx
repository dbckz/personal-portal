'use client';

import { Loader2 } from 'lucide-react';
import type { BoardCard } from '@/types';
import { boardWhenLabel } from '@/lib/board-format';

// One tappable card row in the mobile board's status list. Shows the title,
// type (emoji + label), the date/time chip (or "Unplanned") and a source hint.
// A grouped block shows an "n/m done" count.
export function MobileBoardCard({
  card,
  busy,
  onOpen,
}: {
  card: BoardCard;
  busy: boolean;
  onOpen: (card: BoardCard) => void;
}) {
  const sourceHint =
    card.source === 'ritual'
      ? 'Ritual'
      : card.source === 'prep'
        ? 'Prep'
        : card.source === 'group'
          ? `${card.members.length} tasks`
          : card.members.some(m => m.source === 'asana') || card.gid
            ? card.projectName || 'Asana'
            : 'Ad hoc';
  const whenLabel = boardWhenLabel(card);
  const doneCount = card.members.filter(m => m.done).length;

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
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        {(card.typeEmoji || card.typeLabel) && (
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
            {card.typeEmoji && <span>{card.typeEmoji}</span>}
            {card.typeLabel && <span>{card.typeLabel}</span>}
          </span>
        )}

        {whenLabel ? (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">{whenLabel}</span>
        ) : (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-400">Unplanned</span>
        )}

        {card.source === 'group' && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-500">
            {doneCount}/{card.members.length} done
          </span>
        )}

        <span className="text-gray-400">{sourceHint}</span>
      </div>
    </button>
  );
}
