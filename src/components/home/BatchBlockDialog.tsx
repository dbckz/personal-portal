'use client';

import { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { X, Check, Trash2, Loader2, ChevronRight, Clock } from 'lucide-react';

import type { CalendarEvent } from '@/types';
import type { BlockMember } from '@/lib/scheduling/block-members';

interface BatchBlockDialogProps {
  event: CalendarEvent;
  members: BlockMember[];
  // Persist a per-member action. Both resolve on success and reject on failure,
  // so the dialog can roll its optimistic update back.
  onMemberDone: (member: BlockMember) => Promise<void>;
  onMemberRemove: (member: BlockMember) => Promise<void>;
  // Flag an Asana member "done (waiting on others)": the user's work is finished
  // but the task can't be closed in Asana yet. Optional so ad-hoc-only callers
  // need not supply it. Resolves/rejects like the others for optimistic rollback.
  onMemberPortalDone?: (member: BlockMember) => Promise<void>;
  // Open a member's full task detail dialog (Asana members only).
  onOpenTask: (member: BlockMember) => void;
  onClose: () => void;
}

type RowState = { busy?: boolean; error?: boolean };

// Desktop drill-down for a grouped/batch calendar block: lists the tasks
// scheduled into the block, each of which can be ticked done, removed from the
// block (returns to the backlog unscheduled), or clicked through to its full
// task detail dialog. Opened by double-clicking a grouped block on the calendar.
export function BatchBlockDialog({
  event,
  members: initialMembers,
  onMemberDone,
  onMemberRemove,
  onMemberPortalDone,
  onOpenTask,
  onClose,
}: BatchBlockDialogProps) {
  // The dialog owns the member list while open so a per-action optimistic update
  // isn't clobbered by a parent refetch. Re-seeded only when a different block is
  // opened (its Google event id changes).
  const [members, setMembers] = useState<BlockMember[]>(initialMembers);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  useEffect(() => {
    setMembers(initialMembers);
    setRows({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setRow = useCallback((key: string, state: RowState) => {
    setRows(prev => ({ ...prev, [key]: state }));
  }, []);

  const handleDone = useCallback(
    async (member: BlockMember) => {
      if (member.done) return;
      setRow(member.key, { busy: true });
      // Optimistically mark done.
      setMembers(prev => prev.map(m => (m.key === member.key ? { ...m, done: true } : m)));
      try {
        await onMemberDone(member);
        setRow(member.key, {});
      } catch {
        // Roll back.
        setMembers(prev => prev.map(m => (m.key === member.key ? { ...m, done: false } : m)));
        setRow(member.key, { error: true });
      }
    },
    [onMemberDone, setRow]
  );

  const handlePortalDone = useCallback(
    async (member: BlockMember) => {
      if (member.done || member.portalDone || !onMemberPortalDone) return;
      setRow(member.key, { busy: true });
      // Optimistically flag waiting.
      setMembers(prev => prev.map(m => (m.key === member.key ? { ...m, portalDone: true } : m)));
      try {
        await onMemberPortalDone(member);
        setRow(member.key, {});
      } catch {
        setMembers(prev => prev.map(m => (m.key === member.key ? { ...m, portalDone: false } : m)));
        setRow(member.key, { error: true });
      }
    },
    [onMemberPortalDone, setRow]
  );

  const handleRemove = useCallback(
    async (member: BlockMember) => {
      setRow(member.key, { busy: true });
      // Optimistically drop the row.
      setMembers(prev => prev.filter(m => m.key !== member.key));
      try {
        await onMemberRemove(member);
      } catch {
        // Restore the row in its original position.
        setMembers(prev => {
          if (prev.some(m => m.key === member.key)) return prev;
          const idx = initialMembers.findIndex(m => m.key === member.key);
          const next = [...prev];
          next.splice(idx < 0 ? next.length : idx, 0, member);
          return next;
        });
        setRow(member.key, { error: true });
      }
    },
    [onMemberRemove, initialMembers, setRow]
  );

  const timeLabel = `${format(event.startTime, 'EEE d MMM')} · ${format(event.startTime, 'h:mm a')} – ${format(event.endTime, 'h:mm a')}`;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col max-h-[85vh]"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Batch block tasks"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900 break-words">{event.title}</h2>
            <p className="text-xs text-gray-400 mt-0.5">{timeLabel}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded-lg transition-colors flex-shrink-0"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Member list */}
        <div className="flex-1 overflow-y-auto p-2">
          {members.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">
              No tasks left in this block.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {members.map(member => {
                const row = rows[member.key] ?? {};
                const clickable = member.source === 'asana' && !!member.gid;
                // "Done (waiting)" is Asana-only and only while the task is still
                // open (not done, not already waiting).
                const canWait =
                  !!onMemberPortalDone && member.source === 'asana' && !member.done && !member.portalDone;
                return (
                  <li
                    key={member.key}
                    className="flex items-center gap-2 px-2 py-2.5 group"
                  >
                    {/* Done checkbox — green when done, amber "waiting" when portal-done */}
                    <button
                      onClick={() => handleDone(member)}
                      disabled={member.done || row.busy}
                      aria-label={member.done ? 'Done' : member.portalDone ? 'Waiting on others' : 'Mark done'}
                      title={member.portalDone ? 'Waiting on others' : undefined}
                      className={`flex-shrink-0 w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                        member.done
                          ? 'bg-green-500 border-green-500 text-white'
                          : member.portalDone
                            ? 'border-amber-400 bg-amber-50 text-amber-500'
                            : 'border-gray-300 hover:border-green-500 text-transparent hover:text-green-500'
                      } disabled:opacity-60`}
                    >
                      {row.busy ? (
                        <Loader2 className="w-3 h-3 animate-spin text-gray-400" />
                      ) : member.portalDone && !member.done ? (
                        <Clock className="w-3.5 h-3.5" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                    </button>

                    {/* Title (click-through for Asana members) */}
                    <button
                      type="button"
                      onClick={() => clickable && onOpenTask(member)}
                      disabled={!clickable}
                      className={`flex-1 min-w-0 flex items-center gap-1 text-left text-sm ${
                        member.done ? 'line-through text-gray-400' : 'text-gray-800'
                      } ${clickable ? 'hover:text-orange-600 cursor-pointer' : 'cursor-default'}`}
                    >
                      <span className="truncate">{member.title}</span>
                      {member.portalDone && !member.done && (
                        <span className="flex-shrink-0 text-[11px] font-medium text-amber-600">waiting</span>
                      )}
                      {clickable && (
                        <ChevronRight className="w-4 h-4 flex-shrink-0 text-gray-300 group-hover:text-orange-400" />
                      )}
                    </button>

                    {row.error && (
                      <span className="text-xs text-red-500 flex-shrink-0">Failed</span>
                    )}

                    {/* Done (waiting on others) */}
                    {canWait && (
                      <button
                        onClick={() => handlePortalDone(member)}
                        disabled={row.busy}
                        aria-label="Done (waiting on others)"
                        title="Done — waiting on others (Asana untouched)"
                        className="flex-shrink-0 p-1 rounded hover:bg-amber-50 text-gray-300 hover:text-amber-500 transition-colors disabled:opacity-60"
                      >
                        <Clock className="w-4 h-4" />
                      </button>
                    )}

                    {/* Remove from block */}
                    <button
                      onClick={() => handleRemove(member)}
                      disabled={row.busy}
                      aria-label="Remove from block"
                      title="Remove from block (task returns to the backlog)"
                      className="flex-shrink-0 p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors disabled:opacity-60"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
