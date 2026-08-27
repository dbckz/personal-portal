'use client';

import { useState } from 'react';
import { Check, ExternalLink, Loader2, X } from 'lucide-react';
import { BOARD_COLUMNS, type BoardCard, type BoardCardMember, type BoardStatus } from '@/types';
import { asanaTaskUrl } from '@/lib/asana-url';
import { MobileSheet } from './MobileSheet';
import { boardWhenLabel, rolledDetailLabel } from '@/lib/board-format';

// Card detail bottom sheet: title, type, the date/time chip, the member list
// (tap to tick each done, for grouped blocks), four big status buttons (the
// current one highlighted) and an "Open in Asana" link for Asana cards. Moving a
// card is optimistic in useBoard; a failure surfaces a friendly error.
export function MobileBoardCardSheet({
  card,
  busy,
  busyKeys,
  moveError,
  onMove,
  onToggleMember,
  onClose,
}: {
  card: BoardCard;
  busy: boolean;
  busyKeys: Set<string>;
  // Surfaced from useBoard: moveCard rolls back and sets this rather than
  // throwing, so the sheet reads it instead of catching.
  moveError: string | null;
  onMove: (card: BoardCard, status: BoardStatus) => Promise<void>;
  onToggleMember: (card: BoardCard, member: BoardCardMember) => Promise<void>;
  onClose: () => void;
}) {
  const [localError, setLocalError] = useState<string | null>(null);
  const error = moveError ?? localError;
  const whenLabel = boardWhenLabel(card);
  const rolledDetail = rolledDetailLabel(card);
  const doneCount = card.members.filter(m => m.done).length;

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
    card.source === 'ritual'
      ? 'Ritual'
      : card.source === 'prep'
        ? 'Meeting prep'
        : card.source === 'group'
          ? `${card.members.length} tasks`
          : card.members.some(m => m.source === 'asana') || card.gid
            ? card.projectName || 'Asana'
            : 'Ad hoc';

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
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
            Planned
          </div>
          <div className="text-sm text-gray-700">{whenLabel ?? 'Unplanned'}</div>
          {rolledDetail && <div className="mt-1 text-xs text-gray-400">{rolledDetail}</div>}
        </div>

        {card.source === 'group' && card.members.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-gray-400">
              <span>Tasks</span>
              <span className="normal-case tracking-normal text-gray-400">
                {doneCount}/{card.members.length} done
              </span>
            </div>
            <div className="space-y-1">
              {card.members.map(member => {
                const memberBusy = busyKeys.has(member.key);
                return (
                  <button
                    key={member.key}
                    type="button"
                    disabled={memberBusy}
                    onClick={() => onToggleMember(card, member)}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-gray-200 px-3 py-2.5 text-left text-sm text-gray-800 transition-colors active:bg-gray-50 disabled:opacity-50"
                  >
                    <span
                      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border ${
                        member.done ? 'border-orange-500 bg-orange-500 text-white' : 'border-gray-300 bg-white'
                      }`}
                    >
                      {memberBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
                      ) : (
                        member.done && <Check className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <span className={`min-w-0 flex-1 ${member.done ? 'text-gray-400 line-through' : ''}`}>
                      {member.title}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

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

        {card.gid && card.source !== 'group' && (
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
