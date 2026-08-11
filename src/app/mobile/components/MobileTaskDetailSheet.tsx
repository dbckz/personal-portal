'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { format, parseISO, isPast, isToday } from 'date-fns';
import {
  Bot,
  Check,
  Clock,
  ExternalLink,
  Folder,
  Layers,
  Loader2,
  MessageSquare,
  Pencil,
  PlayCircle,
  Send,
  Tag,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { AsanaProject, AsanaStory, CalendarEvent, DelegationQueueEntry, TaskMetadata } from '@/types';
import { api } from '@/lib/api';
import { getAsanaTaskUrl } from '@/lib/asana';
import { typeChoicesFor } from '@/lib/type-choices';
import { AsanaTypeFieldInfo } from '@/components/CreateAsanaTaskModal';
import { UpdateTaskOptions } from '@/components/asana-sidebar/types';
import { TaskMetadataEditor } from '@/components/TaskMetadataEditor';
import { LinkifiedText } from '@/components/asana-sidebar/LinkifiedText';
import { DelegationSection } from '@/components/asana-sidebar/DelegationSection';
import { MobileSheet } from './MobileSheet';

function getDueDateStyles(dueOn: string): string {
  const date = parseISO(dueOn);
  if (isPast(date) && !isToday(date)) return 'text-red-600 font-medium';
  if (isToday(date)) return 'text-orange-600 font-medium';
  return 'text-gray-900';
}

// Full read/write task sheet — the mobile counterpart of the desktop
// TaskDetailDialog: read details, comments and delegation status; complete/
// reopen, comment, delegate, move-to-backlog; and edit (due/start dates, Type,
// projects), enrich metadata, or delete the task.
export function MobileTaskDetailSheet({
  task,
  delegationEntry,
  onClose,
  onToggleComplete,
  onAddComment,
  onUpdateTask,
  onDeleteTask,
  projects = [],
  typeFieldInfoByIntegration,
  metadata,
  onSaveMetadata,
  onDelegate,
  onMoveToBacklog,
  onReturnToAiQueue,
}: {
  task: CalendarEvent;
  delegationEntry?: DelegationQueueEntry;
  onClose: () => void;
  onToggleComplete?: (taskId: string, integrationId: string, completed: boolean) => void;
  onAddComment?: (taskId: string, integrationId: string, text: string) => Promise<void>;
  onUpdateTask?: (taskId: string, integrationId: string, updates: UpdateTaskOptions) => void;
  onDeleteTask?: (taskId: string, integrationId: string) => void;
  projects?: AsanaProject[];
  typeFieldInfoByIntegration?: Map<string, AsanaTypeFieldInfo>;
  metadata?: TaskMetadata;
  onSaveMetadata?: (
    asanaTaskGid: string,
    integrationId: string,
    updates: Partial<Omit<TaskMetadata, 'asanaTaskGid' | 'integrationId' | 'updatedAt'>>
  ) => Promise<void>;
  onDelegate?: (task: CalendarEvent) => void;
  onMoveToBacklog?: (entry: DelegationQueueEntry) => void;
  onReturnToAiQueue?: (entry: DelegationQueueEntry) => void;
}) {
  const [comment, setComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [stories, setStories] = useState<AsanaStory[]>([]);
  const [isLoadingStories, setIsLoadingStories] = useState(false);
  const [storiesError, setStoriesError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editDueOn, setEditDueOn] = useState(task.dueOn || '');
  const [editStartOn, setEditStartOn] = useState(task.startOn || '');
  const [editType, setEditType] = useState('');
  const [editProjectIds, setEditProjectIds] = useState<string[]>(task.projects?.map(p => p.gid) || []);
  const wasEditingRef = useRef(false);

  const typeField = task.customFields?.find(cf => cf.name.toLowerCase() === 'type');

  // Type field info for this task's integration (Asana enum) — used to resolve a
  // chosen label back to its enum-option gid when the write target is Asana.
  const typeFieldInfo = useMemo(() => {
    if (!typeFieldInfoByIntegration || !task.integrationId) return null;
    return typeFieldInfoByIntegration.get(task.integrationId) || null;
  }, [typeFieldInfoByIntegration, task.integrationId]);

  // One rule for which Type labels are offered and where a chosen one is written
  // (Asana enum vs the app-local store for a workspace with no writable field).
  const typeChoices = useMemo(
    () => typeChoicesFor(task.integrationId, typeFieldInfoByIntegration),
    [typeFieldInfoByIntegration, task.integrationId],
  );
  const typeValues = typeChoices.labels;

  const availableProjects = useMemo(
    () => projects.filter(p => p.integrationId === task.integrationId),
    [projects, task.integrationId],
  );

  // Seed the edit fields only when ENTERING edit mode, not on every task change.
  useEffect(() => {
    if (isEditing && !wasEditingRef.current) {
      setEditType(typeField?.displayValue || '');
      setEditDueOn(task.dueOn || '');
      setEditStartOn(task.startOn || '');
      setEditProjectIds(task.projects?.map(p => p.gid) || []);
    }
    wasEditingRef.current = isEditing;
  }, [isEditing, typeField?.displayValue, task.dueOn, task.startOn, task.projects]);

  useEffect(() => {
    if (!task.integrationId) return;

    setIsLoadingStories(true);
    setStoriesError(null);
    api.getTaskStories(task.id, task.integrationId)
      .then(({ stories: fetched }) => {
        setStories(fetched.filter(s => s.resourceSubtype === 'comment_added'));
      })
      .catch(err => {
        console.error('Failed to fetch stories:', err);
        setStoriesError('Failed to load comments');
      })
      .finally(() => setIsLoadingStories(false));
  }, [task.id, task.integrationId]);

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!comment.trim() || !onAddComment || !task.integrationId) return;

    setIsSubmitting(true);
    try {
      await onAddComment(task.id, task.integrationId, comment.trim());
      setComment('');
      const { stories: fetched } = await api.getTaskStories(task.id, task.integrationId);
      setStories(fetched.filter(s => s.resourceSubtype === 'comment_added'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleComplete = () => {
    if (!onToggleComplete || !task.integrationId) return;

    const isCompleting = !task.completed;
    onToggleComplete(task.id, task.integrationId, isCompleting);
    if (isCompleting) onClose();
  };

  // Mirror the desktop save: collect only changed fields. A local-only workspace
  // remembers its Type label in the app-local store (best-effort, outside the
  // Asana `updates`); an Asana-writable one resolves the label to its enum gid.
  const handleSaveChanges = () => {
    if (!onUpdateTask || !task.integrationId) return;

    const updates: UpdateTaskOptions = {};

    if (editDueOn !== (task.dueOn || '')) {
      updates.dueOn = editDueOn || null;
    }
    if (editStartOn !== (task.startOn || '')) {
      updates.startOn = editStartOn || null;
    }

    if (editType !== (typeField?.displayValue || '')) {
      if (typeChoices.writeTarget === 'local') {
        api
          .setLocalTaskTypes({ [task.id]: editType || null })
          .catch(err => console.error('Failed to save local Type:', err));
      } else if (typeFieldInfo && editType) {
        const enumOptionGid = typeFieldInfo.enumOptions.get(editType);
        if (enumOptionGid) {
          updates.customFields = { [typeFieldInfo.fieldGid]: enumOptionGid };
        }
      } else if (typeFieldInfo && !editType) {
        updates.customFields = { [typeFieldInfo.fieldGid]: null };
      }
    }

    const currentProjectIds = task.projects?.map(p => p.gid) || [];
    const addProjects = editProjectIds.filter(id => !currentProjectIds.includes(id));
    const removeProjects = currentProjectIds.filter(id => !editProjectIds.includes(id));
    if (addProjects.length > 0) updates.addProjects = addProjects;
    if (removeProjects.length > 0) updates.removeProjects = removeProjects;

    if (Object.keys(updates).length > 0) {
      onUpdateTask(task.id, task.integrationId, updates);
      // A task retyped as "NOT A TASK" drops out of the view — close the sheet.
      if (editType === 'NOT A TASK') {
        onClose();
        return;
      }
    }
    setIsEditing(false);
    wasEditingRef.current = false;
  };

  const handleProjectToggle = (projectGid: string) => {
    setEditProjectIds(prev =>
      prev.includes(projectGid) ? prev.filter(id => id !== projectGid) : [...prev, projectGid]
    );
  };

  const handleDelete = () => {
    if (!onDeleteTask || !task.integrationId) return;
    // Two-tap inline confirm: first tap arms, second tap deletes.
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    onDeleteTask(task.id, task.integrationId);
    onClose();
  };

  const isReviewable =
    !!delegationEntry &&
    (delegationEntry.state === 'done' || delegationEntry.state === 'failed') &&
    !delegationEntry.reviewedAt;

  const canEdit = !!onUpdateTask && !!task.integrationId;

  return (
    <MobileSheet onClose={onClose}>
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-6 text-gray-950 line-clamp-2">{task.title}</h2>
          {!isEditing && (
            <div className="mt-2 flex flex-wrap gap-2">
              {typeField?.displayValue && (
                <span className="inline-flex items-center gap-1 rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700">
                  <Tag className="h-3 w-3" />
                  {typeField.displayValue}
                </span>
              )}
              {task.completed && (
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                  Complete
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {canEdit && !isEditing && (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="flex h-11 w-11 items-center justify-center rounded-md text-gray-500 transition-colors active:bg-gray-100"
              aria-label="Edit task"
            >
              <Pencil className="h-5 w-5" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-md text-gray-500 transition-colors active:bg-gray-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {isEditing ? (
        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
          {typeValues.length > 0 && (
            <div>
              <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-700">
                <Tag className="h-3 w-3" /> Type
              </label>
              <select
                value={editType}
                onChange={e => setEditType(e.target.value)}
                className="h-12 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
              >
                <option value="">No type</option>
                {typeValues.map(type => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-700">
              <PlayCircle className="h-3 w-3" /> Start date
            </label>
            <input
              type="date"
              aria-label="Start date"
              value={editStartOn}
              onChange={e => setEditStartOn(e.target.value)}
              className="h-12 w-full rounded-lg border border-gray-300 px-3 text-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
            />
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-700">
              <Clock className="h-3 w-3" /> Due date
            </label>
            <input
              type="date"
              aria-label="Due date"
              value={editDueOn}
              onChange={e => setEditDueOn(e.target.value)}
              className="h-12 w-full rounded-lg border border-gray-300 px-3 text-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
            />
          </div>

          {availableProjects.length > 0 && (
            <div>
              <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-700">
                <Folder className="h-3 w-3" /> Projects
              </label>
              <div className="flex flex-wrap gap-2">
                {availableProjects.map(project => (
                  <button
                    key={project.gid}
                    type="button"
                    onClick={() => handleProjectToggle(project.gid)}
                    className={`rounded-full px-3 py-2 text-sm transition-colors ${
                      editProjectIds.includes(project.gid)
                        ? 'bg-orange-100 text-orange-700 ring-1 ring-orange-300'
                        : 'border border-gray-200 bg-white text-gray-600 active:bg-gray-100'
                    }`}
                  >
                    {project.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="h-12 flex-1 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 transition-colors active:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveChanges}
              className="h-12 flex-1 rounded-lg bg-orange-600 text-sm font-medium text-white transition-colors active:bg-orange-700"
            >
              Save Changes
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
            {task.description && (
              <div>
                <label className="text-xs font-medium uppercase tracking-wide text-gray-500">Notes</label>
                <div className="mt-1 whitespace-pre-wrap text-sm text-gray-700">
                  <LinkifiedText text={task.description} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <label className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                  <PlayCircle className="h-3 w-3" /> Start
                </label>
                <p className="mt-0.5 text-gray-900">
                  {task.startOn ? format(parseISO(task.startOn), 'MMM d, yyyy') : <span className="italic text-gray-400">Not set</span>}
                </p>
              </div>

              <div>
                <label className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                  <Clock className="h-3 w-3" /> Due
                </label>
                {task.dueOn ? (
                  <p className={`mt-0.5 ${getDueDateStyles(task.dueOn)}`}>
                    {format(parseISO(task.dueOn), 'MMM d, yyyy')}
                  </p>
                ) : (
                  <p className="mt-0.5 italic text-gray-400">Not set</p>
                )}
              </div>

              {task.createdAt && (
                <div>
                  <label className="text-xs font-medium uppercase tracking-wide text-gray-500">Created</label>
                  <p className="mt-0.5 text-gray-900">{format(parseISO(task.createdAt), 'MMM d, yyyy')}</p>
                </div>
              )}

              {task.integrationName && (
                <div>
                  <label className="text-xs font-medium uppercase tracking-wide text-gray-500">Integration</label>
                  <p className="mt-0.5 text-gray-900">{task.integrationName}</p>
                </div>
              )}
            </div>

            {task.projects && task.projects.length > 0 && (
              <div>
                <label className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                  <Folder className="h-3 w-3" /> Projects
                </label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {task.projects.map(project => (
                    <span key={project.gid} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                      {project.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {onDelegate && task.integrationId && (
              <div>
                <label className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                  <Bot className="h-3 w-3" /> Agent delegation
                </label>
                <DelegationSection entry={delegationEntry} onDelegate={() => onDelegate(task)} />
              </div>
            )}

            {onSaveMetadata && task.integrationId && (
              <div>
                <label className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                  <Layers className="h-3 w-3" /> Metadata
                </label>
                <TaskMetadataEditor
                  metadata={metadata}
                  onChange={updates => onSaveMetadata(task.id, task.integrationId!, updates)}
                />
              </div>
            )}

            <div>
              <label className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                <MessageSquare className="h-3 w-3" /> Comments
                {stories.length > 0 && <span className="text-gray-400">({stories.length})</span>}
              </label>

              {isLoadingStories ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                </div>
              ) : storiesError ? (
                <p className="mt-1 text-sm text-red-500">{storiesError}</p>
              ) : stories.length === 0 ? (
                <p className="mt-1 text-sm italic text-gray-500">No comments yet</p>
              ) : (
                <div className="mt-2 space-y-3">
                  {stories.map(story => (
                    <div key={story.gid} className="rounded-lg bg-gray-50 p-3">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-700">
                          {story.createdBy?.name || 'Unknown'}
                        </span>
                        <span className="text-xs text-gray-400">
                          {format(parseISO(story.createdAt), 'MMM d, h:mm a')}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-sm text-gray-700">
                        <LinkifiedText text={story.text} />
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex-shrink-0 space-y-3 border-t border-gray-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {onToggleComplete && task.integrationId && (
              <button
                type="button"
                onClick={handleToggleComplete}
                className={`flex h-12 w-full items-center justify-center gap-2 rounded-lg font-medium transition-colors ${
                  task.completed
                    ? 'bg-gray-100 text-gray-700 active:bg-gray-200'
                    : 'bg-green-600 text-white active:bg-green-700'
                }`}
              >
                <Check className="h-4 w-4" />
                {task.completed ? 'Reopen Task' : 'Mark Complete'}
              </button>
            )}

            {isReviewable && onMoveToBacklog && delegationEntry && (
              <button
                type="button"
                onClick={() => {
                  onMoveToBacklog(delegationEntry);
                  onClose();
                }}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-amber-300 font-medium text-amber-700 transition-colors active:bg-amber-50"
              >
                <UserRound className="h-4 w-4" />
                Move to backlog
              </button>
            )}

            {isReviewable && onReturnToAiQueue && delegationEntry && (
              <button
                type="button"
                onClick={() => {
                  onReturnToAiQueue(delegationEntry);
                  onClose();
                }}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-indigo-300 font-medium text-indigo-700 transition-colors active:bg-indigo-50"
              >
                <Bot className="h-4 w-4" />
                Return to AI queue
              </button>
            )}

            {onAddComment && task.integrationId && (
              <form onSubmit={handleSubmitComment} className="flex gap-2">
                <input
                  type="text"
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder="Write a comment..."
                  className="h-12 min-w-0 flex-1 rounded-lg border border-gray-300 px-3 text-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
                  disabled={isSubmitting}
                />
                <button
                  type="submit"
                  disabled={!comment.trim() || isSubmitting}
                  className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-600 text-white active:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Send comment"
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </form>
            )}

            <a
              href={getAsanaTaskUrl(task.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-gray-300 text-gray-700 transition-colors active:bg-gray-50"
            >
              <ExternalLink className="h-4 w-4" />
              Open in Asana
            </a>

            {onDeleteTask && task.integrationId && (
              <button
                type="button"
                onClick={handleDelete}
                onBlur={() => setDeleteArmed(false)}
                className={`flex h-12 w-full items-center justify-center gap-2 rounded-lg border font-medium transition-colors ${
                  deleteArmed
                    ? 'border-red-600 bg-red-600 text-white active:bg-red-700'
                    : 'border-red-300 text-red-600 active:bg-red-50'
                }`}
              >
                <Trash2 className="h-4 w-4" />
                {deleteArmed ? 'Tap again to delete' : 'Delete Task'}
              </button>
            )}
          </div>
        </>
      )}
    </MobileSheet>
  );
}
