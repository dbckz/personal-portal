'use client';

import { useEffect } from 'react';
import { Check, ExternalLink, X } from 'lucide-react';

import {
  BOARD_COLUMNS,
  type BoardCard as BoardCardModel,
  type BoardCardMember,
  type BoardStatus,
} from '@/types';
import { asanaTaskUrl } from '@/lib/asana-url';
import { boardWhenLabel, formatDuration } from '@/lib/board-format';

const PRIORITY_DOT: Record<'low' | 'medium' | 'high', string> = {
  low: 'bg-gray-300',
  medium: 'bg-amber-400',
  high: 'bg-red-500',
};

// The source hint shown at the foot of a card (mirrors BoardCard.sourceHint).
function sourceHint(card: BoardCardModel): string {
  if (card.source === 'ritual') return 'Ritual';
  if (card.source === 'prep') return 'Meeting prep';
  if (card.source === 'group') return `${card.members.length} tasks`;
  const asana = card.members.find(m => m.source === 'asana');
  if (card.gid || asana) return card.projectName || asana?.projectName || 'Asana';
  return 'Ad hoc';
}

interface BoardCardDetailModalProps {
  card: BoardCardModel;
  busyKeys: Set<string>;
  onMove: (card: BoardCardModel, status: BoardStatus) => void;
  onToggleMember: (card: BoardCardModel, member: BoardCardMember) => void;
  onClose: () => void;
}

// Desktop double-click detail view for a board card: everything the card shows
// but untruncated, plus per-member Asana links and the status mover. Backdrop +
// Escape + close button match AddBoardTaskModal.
export function BoardCardDetailModal({
  card,
  busyKeys,
  onMove,
  onToggleMember,
  onClose,
}: BoardCardDetailModalProps) {
  const busy = busyKeys.has(card.key);
  const whenLabel = boardWhenLabel(card);
  const doneCount = card.members.filter(m => m.done).length;
  const statusLabel = BOARD_COLUMNS.find(c => c.id === card.status)?.label ?? card.status;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="board-card-detail"
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <h2 className="min-w-0 break-words text-lg font-semibold text-gray-900">{card.title}</h2>
          <button
            onClick={onClose}
            className="flex-shrink-0 rounded-lg p-1 hover:bg-gray-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-4">
          {/* Type / when / duration / status chips */}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {(card.typeEmoji || card.typeLabel) && (
              <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">
                {card.typeEmoji && <span>{card.typeEmoji}</span>}
                {card.typeLabel && <span>{card.typeLabel}</span>}
              </span>
            )}
            {whenLabel ? (
              <span className="inline-flex items-center rounded bg-orange-50 px-1.5 py-0.5 text-orange-700">
                {whenLabel}
              </span>
            ) : (
              <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">
                Unplanned
              </span>
            )}
            {card.durationMinutes != null && !whenLabel?.includes(formatDuration(card.durationMinutes)) && (
              <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">
                {formatDuration(card.durationMinutes)}
              </span>
            )}
            <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">
              {statusLabel}
            </span>
          </div>

          {/* Members */}
          {card.members.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-gray-400">
                <span>Tasks</span>
                <span className="normal-case tracking-normal">
                  {doneCount}/{card.members.length} done
                </span>
              </div>
              <div className="space-y-1.5">
                {card.members.map(member => {
                  const memberBusy = busyKeys.has(member.key);
                  return (
                    <div
                      key={member.key}
                      className="flex items-start gap-2 rounded-lg border border-gray-100 px-2 py-1.5"
                    >
                      <button
                        type="button"
                        disabled={memberBusy}
                        onClick={() => onToggleMember(card, member)}
                        aria-label={member.done ? 'Mark not done' : 'Mark done'}
                        className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border disabled:opacity-50 ${
                          member.done
                            ? 'border-orange-500 bg-orange-500 text-white'
                            : member.portalDone
                              ? 'border-amber-400 bg-amber-400 text-white'
                              : 'border-gray-300 bg-white'
                        }`}
                      >
                        {(member.done || member.portalDone) && <Check className="h-3 w-3" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <span
                          className={`block break-words text-sm ${
                            member.done ? 'text-gray-400 line-through' : 'text-gray-800'
                          }`}
                        >
                          {member.title}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-400">
                          {member.portalDone && !member.done && (
                            <span className="text-amber-600">Waiting on others</span>
                          )}
                          {member.typeLabel && <span>{member.typeLabel}</span>}
                          {member.projectName && <span>· {member.projectName}</span>}
                          {member.source === 'asana' && member.gid && (
                            <a
                              href={asanaTaskUrl(member.gid)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-orange-600 hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Open in Asana
                            </a>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Card-level detail */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Source</dt>
              <dd className="text-gray-700">{sourceHint(card)}</dd>
            </div>
            {card.priority && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Priority</dt>
                <dd className="flex items-center gap-1.5 capitalize text-gray-700">
                  <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[card.priority]}`} />
                  {card.priority}
                </dd>
              </div>
            )}
            {card.projectName && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Project</dt>
                <dd className="break-words text-gray-700">{card.projectName}</dd>
              </div>
            )}
            {card.dueOn && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Due</dt>
                <dd className="text-gray-700">{card.dueOn}</dd>
              </div>
            )}
          </dl>

          {/* Status mover */}
          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
              Move to
            </div>
            <div className="grid grid-cols-2 gap-2">
              {BOARD_COLUMNS.map(col => {
                const isCurrent = col.id === card.status;
                return (
                  <button
                    key={col.id}
                    type="button"
                    onClick={() => onMove(card, col.id)}
                    disabled={busy || isCurrent}
                    aria-pressed={isCurrent}
                    className={`rounded-lg py-2 text-sm font-medium transition-colors disabled:cursor-default ${
                      isCurrent
                        ? 'bg-orange-500 text-white'
                        : 'border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-60'
                    }`}
                  >
                    {col.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Single-task Asana link */}
          {card.gid && card.source !== 'group' && (
            <a
              href={asanaTaskUrl(card.gid)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <ExternalLink className="h-4 w-4" />
              Open in Asana
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
