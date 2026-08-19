'use client';

import { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { CalendarDays, Check, Clock, Loader2, MapPin, Pencil, Trash2, X } from 'lucide-react';
import { SOURCE_STYLES, formatTimeRange, fullDescription, sourceLabel } from '@/lib/event-display';
import type { BlockMember } from '@/lib/scheduling/block-members';
import { CalendarEvent } from '@/types';

function renderLinkedText(text: string) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, index) => {
    if (!part.match(/^https?:\/\//)) return part;

    return (
      <a
        key={`${part}-${index}`}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="text-blue-700 underline underline-offset-2"
      >
        {part}
      </a>
    );
  });
}

type RowState = { busy?: boolean; error?: boolean };

// Grouped batch block: the member tasks scheduled into this block, each of which
// can be ticked done or removed from the block. Double-click has no touch
// analogue, so the members surface here in the tapped block's sheet. Owns the
// list while open so a per-action optimistic update survives a parent refetch.
function BlockMemberList({
  members: initialMembers,
  onMemberDone,
  onMemberRemove,
  onMemberPortalDone,
}: {
  members: BlockMember[];
  onMemberDone: (member: BlockMember) => Promise<void>;
  onMemberRemove: (member: BlockMember) => Promise<void>;
  onMemberPortalDone?: (member: BlockMember) => Promise<void>;
}) {
  const [members, setMembers] = useState<BlockMember[]>(initialMembers);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const handleDone = useCallback(async (member: BlockMember) => {
    if (member.done) return;
    setRows(prev => ({ ...prev, [member.key]: { busy: true } }));
    setMembers(prev => prev.map(m => (m.key === member.key ? { ...m, done: true } : m)));
    try {
      await onMemberDone(member);
      setRows(prev => ({ ...prev, [member.key]: {} }));
    } catch {
      setMembers(prev => prev.map(m => (m.key === member.key ? { ...m, done: false } : m)));
      setRows(prev => ({ ...prev, [member.key]: { error: true } }));
    }
  }, [onMemberDone]);

  const handlePortalDone = useCallback(async (member: BlockMember) => {
    if (member.done || member.portalDone || !onMemberPortalDone) return;
    setRows(prev => ({ ...prev, [member.key]: { busy: true } }));
    setMembers(prev => prev.map(m => (m.key === member.key ? { ...m, portalDone: true } : m)));
    try {
      await onMemberPortalDone(member);
      setRows(prev => ({ ...prev, [member.key]: {} }));
    } catch {
      setMembers(prev => prev.map(m => (m.key === member.key ? { ...m, portalDone: false } : m)));
      setRows(prev => ({ ...prev, [member.key]: { error: true } }));
    }
  }, [onMemberPortalDone]);

  const handleRemove = useCallback(async (member: BlockMember) => {
    setRows(prev => ({ ...prev, [member.key]: { busy: true } }));
    setMembers(prev => prev.filter(m => m.key !== member.key));
    try {
      await onMemberRemove(member);
    } catch {
      setMembers(prev => {
        if (prev.some(m => m.key === member.key)) return prev;
        const idx = initialMembers.findIndex(m => m.key === member.key);
        const next = [...prev];
        next.splice(idx < 0 ? next.length : idx, 0, member);
        return next;
      });
      setRows(prev => ({ ...prev, [member.key]: { error: true } }));
    }
  }, [onMemberRemove, initialMembers]);

  return (
    <section className="mt-5 border-t border-gray-200 pt-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Tasks in this block</h3>
      {members.length === 0 ? (
        <p className="mt-2 text-sm text-gray-400">No tasks left in this block.</p>
      ) : (
        <ul className="mt-2 divide-y divide-gray-100">
          {members.map(member => {
            const row = rows[member.key] ?? {};
            const canWait =
              !!onMemberPortalDone && member.source === 'asana' && !member.done && !member.portalDone;
            return (
              <li key={member.key} className="flex items-center gap-2 py-2.5">
                <button
                  type="button"
                  onClick={() => handleDone(member)}
                  disabled={member.done || row.busy}
                  aria-label={member.done ? 'Done' : member.portalDone ? 'Waiting on others' : 'Mark done'}
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border transition-colors ${
                    member.done
                      ? 'border-emerald-500 bg-emerald-500 text-white'
                      : member.portalDone
                        ? 'border-amber-400 bg-amber-50 text-amber-500'
                        : 'border-gray-300 text-transparent active:text-emerald-500'
                  } disabled:opacity-60`}
                >
                  {row.busy ? (
                    <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                  ) : member.portalDone && !member.done ? (
                    <Clock className="h-4 w-4" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                </button>
                <span
                  className={`min-w-0 flex-1 truncate text-sm ${
                    member.done ? 'text-gray-400 line-through' : 'text-gray-800'
                  }`}
                >
                  {member.title}
                  {member.portalDone && !member.done && (
                    <span className="ml-1.5 text-[11px] font-medium text-amber-600">waiting</span>
                  )}
                </span>
                {row.error && <span className="flex-shrink-0 text-xs text-red-500">Failed</span>}
                {canWait && (
                  <button
                    type="button"
                    onClick={() => handlePortalDone(member)}
                    disabled={row.busy}
                    aria-label="Done (waiting on others)"
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors active:bg-amber-50 active:text-amber-500 disabled:opacity-60"
                  >
                    <Clock className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleRemove(member)}
                  disabled={row.busy}
                  aria-label="Remove from block"
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors active:bg-red-50 active:text-red-500 disabled:opacity-60"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function EventDetailSheet({
  event,
  onClose,
  onEdit,
  onDelete,
  attribution,
  asanaIntegrations,
  onSetAttribution,
  onRemoveAttribution,
  members,
  onMemberDone,
  onMemberRemove,
  onMemberPortalDone,
}: {
  event: CalendarEvent;
  onClose: () => void;
  // Google events are editable/deletable; when omitted the sheet stays read-only.
  onEdit?: (event: CalendarEvent) => void;
  onDelete?: (event: CalendarEvent) => Promise<void>;
  // Time-tracking attribution for a Google event not linked to an Asana task.
  attribution?: { asanaIntegrationId: string };
  asanaIntegrations?: { id: string; name: string }[];
  onSetAttribution?: (asanaIntegrationId: string) => Promise<void>;
  onRemoveAttribution?: () => Promise<void>;
  // Present (non-empty) when the event is a grouped batch block.
  members?: BlockMember[];
  onMemberDone?: (member: BlockMember) => Promise<void>;
  onMemberRemove?: (member: BlockMember) => Promise<void>;
  onMemberPortalDone?: (member: BlockMember) => Promise<void>;
}) {
  const description = fullDescription(event.description);
  const sourceStyle = SOURCE_STYLES[event.source];
  const customFields = event.customFields?.filter(field => field.displayValue) || [];

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [attributionBusy, setAttributionBusy] = useState(false);

  // A stalled confirm reverts so a later tap can't delete by surprise.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  const isEditable = event.source === 'google' && !!onEdit;
  const isDeletable = event.source === 'google' && !!onDelete;
  const showAttribution =
    event.source === 'google' && !event.linkedAsanaTaskId && !!asanaIntegrations && asanaIntegrations.length > 0;
  const showMembers = !!members && members.length > 0 && !!onMemberDone && !!onMemberRemove;

  const currentAttributionName = attribution
    ? asanaIntegrations?.find(i => i.id === attribution.asanaIntegrationId)?.name
    : null;

  const handleDelete = async () => {
    if (!onDelete) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setIsDeleting(true);
    try {
      await onDelete(event);
    } catch {
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-3 py-[max(0.75rem,env(safe-area-inset-bottom))]"
      onClick={onClose}
    >
      <div
        className="mx-auto flex max-h-[min(82dvh,42rem)] w-full max-w-xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(eventClick) => eventClick.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 p-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-6 text-gray-950">{event.title}</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              <span className={`rounded-full border px-2 py-1 text-xs font-medium ${sourceStyle.className}`}>
                {sourceLabel(event)}
              </span>
              {event.completed && (
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                  Complete
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto overscroll-contain p-4">
          <dl className="space-y-3 text-sm">
            <div className="flex gap-3">
              <dt className="flex w-8 flex-shrink-0 justify-center pt-0.5 text-gray-400">
                <Clock className="h-4 w-4" />
              </dt>
              <dd className="min-w-0 flex-1 text-gray-800">
                <div>{format(event.startTime, 'EEEE, MMMM d, yyyy')}</div>
                <div>{formatTimeRange(event)}</div>
              </dd>
            </div>

            {event.location && (
              <div className="flex gap-3">
                <dt className="flex w-8 flex-shrink-0 justify-center pt-0.5 text-gray-400">
                  <MapPin className="h-4 w-4" />
                </dt>
                <dd className="min-w-0 flex-1 break-words text-gray-800">{event.location}</dd>
              </div>
            )}

            {(event.calendarName || event.integrationName || event.assignee) && (
              <div className="flex gap-3">
                <dt className="flex w-8 flex-shrink-0 justify-center pt-0.5 text-gray-400">
                  <CalendarDays className="h-4 w-4" />
                </dt>
                <dd className="min-w-0 flex-1 space-y-1 text-gray-800">
                  {event.integrationName && <div>{event.integrationName}</div>}
                  {event.calendarName && <div>{event.calendarName}</div>}
                  {event.assignee && <div>{event.assignee}</div>}
                </dd>
              </div>
            )}
          </dl>

          {description && (
            <section className="mt-5 border-t border-gray-200 pt-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Description</h3>
              <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">
                {renderLinkedText(description)}
              </div>
            </section>
          )}

          {event.projects && event.projects.length > 0 && (
            <section className="mt-5 border-t border-gray-200 pt-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Projects</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {event.projects.map(project => (
                  <span key={project.gid} className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-sm text-gray-700">
                    {project.name}
                  </span>
                ))}
              </div>
            </section>
          )}

          {customFields.length > 0 && (
            <section className="mt-5 border-t border-gray-200 pt-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Fields</h3>
              <dl className="mt-2 space-y-2 text-sm">
                {customFields.map(field => (
                  <div key={field.gid} className="flex justify-between gap-4">
                    <dt className="text-gray-500">{field.name}</dt>
                    <dd className="text-right font-medium text-gray-800">{field.displayValue}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {showMembers && (
            <BlockMemberList
              members={members!}
              onMemberDone={onMemberDone!}
              onMemberRemove={onMemberRemove!}
              onMemberPortalDone={onMemberPortalDone}
            />
          )}

          {showAttribution && (
            <section className="mt-5 border-t border-gray-200 pt-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Time tracking</h3>
              {currentAttributionName ? (
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-sm text-gray-700">
                    Counts toward <span className="font-medium">{currentAttributionName}</span>
                  </span>
                  <button
                    type="button"
                    disabled={attributionBusy}
                    onClick={async () => {
                      if (!onRemoveAttribution) return;
                      setAttributionBusy(true);
                      try {
                        await onRemoveAttribution();
                      } finally {
                        setAttributionBusy(false);
                      }
                    }}
                    className="flex-shrink-0 text-xs font-medium text-red-600 underline underline-offset-2 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm text-gray-500">Count toward:</span>
                  {asanaIntegrations!.map(integration => (
                    <button
                      key={integration.id}
                      type="button"
                      disabled={attributionBusy}
                      onClick={async () => {
                        if (!onSetAttribution) return;
                        setAttributionBusy(true);
                        try {
                          await onSetAttribution(integration.id);
                        } finally {
                          setAttributionBusy(false);
                        }
                      }}
                      className="rounded-full bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors active:bg-gray-200 disabled:opacity-50"
                    >
                      {integration.name}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        {(isEditable || isDeletable) && (
          <div className="flex gap-2 border-t border-gray-200 p-4">
            {isEditable && (
              <button
                type="button"
                onClick={() => onEdit!(event)}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors active:bg-blue-700"
              >
                <Pencil className="h-4 w-4" />
                Edit
              </button>
            )}
            {isDeletable && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                  confirmDelete
                    ? 'border-red-600 bg-red-600 text-white active:bg-red-700'
                    : 'border-red-300 text-red-600 active:bg-red-50'
                }`}
              >
                {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {confirmDelete ? 'Tap to confirm' : 'Delete'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
