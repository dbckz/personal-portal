'use client';

import { useState } from 'react';
import { ExternalLink, Loader2, X } from 'lucide-react';
import { BOARD_COLUMNS, type BoardCard, type BoardStatus } from '@/types';
import { asanaTaskUrl } from '@/lib/asana-url';
import { MobileSheet } from './MobileSheet';
import { dayLetterChips, plannedBlockLabel } from '@/lib/board-format';

// Card detail bottom sheet: title, type, planned days, four big status buttons
// (the current one highlighted) and an "Open in Asana" link for Asana cards.
// Moving a card is optimistic in useBoard; a failure surfaces a friendly error.
export function MobileBoardCardSheet({
  card,
  weekStart,
  busy,
  moveError,
  onMove,
  onClose,
}: {
  card: BoardCard;
  weekStart: string;
  busy: boolean;
  // Surfaced from useBoard: moveCard rolls back and sets this rather than
  // throwing, so the sheet reads it instead of catching.
  moveError: string | null;
  onMove: (card: BoardCard, status: BoardStatus) => Promise<void>;
  onClose: () => void;
}) {
  const [localError, setLocalError] = useState<string | null>(null);
  const error = moveError ?? localError;

  const handleMove = async (status: BoardStatus) => {
    if (status === card.status) return;
    setLocalError(null);
    try {
      await onMove(card, status);
    } catch {
      setLocalError('Could not move that card — check your connection and try again.');
    }
  };

  const sourceHint =
    card.source === 'asana'
      ? card.projectName || 'Asana'
      : card.source === 'adhoc'
        ? 'Ad hoc'
        : 'Ritual';

  return (
    <MobileSheet onClose={onClose}>
      <div className="flex items-start justify-between gap-2 border-b border-gray-200 px-4 pb-3">
        <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug text-gray-950">
          {card.title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors active:bg-gray-100"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
          {(card.typeEmoji || card.typeLabel) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1">
              {card.typeEmoji && <span>{card.typeEmoji}</span>}
              {card.typeLabel && <span>{card.typeLabel}</span>}
            </span>
          )}
          <span className="rounded-full bg-gray-100 px-2 py-1">{sourceHint}</span>
          {card.recurring && (
            <span className="rounded-full bg-gray-100 px-2 py-1">
              {card.cadence === 'weekly' ? 'Weekly' : 'Daily'}
            </span>
          )}
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
            Planned
          </div>
          {card.recurring ? (
            <div className="flex items-center gap-1">
              {dayLetterChips(weekStart, card.plannedDates).map((cell, i) => (
                <span
                  key={i}
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                    cell.filled ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  {cell.letter}
                </span>
              ))}
            </div>
          ) : card.plannedDates.length === 0 ? (
            <div className="text-sm text-gray-400">Unplanned</div>
          ) : (
            <div className="space-y-1">
              {card.blocks.map((block, i) => (
                <div key={i} className="text-sm text-gray-700">
                  {plannedBlockLabel(block)}
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        <div>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
            Status
          </div>
          <div className="grid grid-cols-2 gap-2">
            {BOARD_COLUMNS.map(col => {
              const isCurrent = col.id === card.status;
              return (
                <button
                  key={col.id}
                  type="button"
                  onClick={() => handleMove(col.id)}
                  disabled={busy}
                  aria-pressed={isCurrent}
                  className={`flex h-14 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-60 ${
                    isCurrent
                      ? 'bg-orange-600 text-white'
                      : 'border border-gray-300 text-gray-700 active:bg-gray-50'
                  }`}
                >
                  {busy && isCurrent && <Loader2 className="h-4 w-4 animate-spin" />}
                  {col.label}
                </button>
              );
            })}
          </div>
        </div>

        {card.source === 'asana' && card.gid && (
          <a
            href={asanaTaskUrl(card.gid)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 transition-colors active:bg-gray-50"
          >
            <ExternalLink className="h-4 w-4" />
            Open in Asana
          </a>
        )}
      </div>
    </MobileSheet>
  );
}
