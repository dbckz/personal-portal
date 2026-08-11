'use client';

import { useMemo, useState } from 'react';
import { Clock, Folder, Loader2, Tag, X } from 'lucide-react';
import {
  AdHocTask,
  AsanaProject,
  BuiltInTaskType,
  BUILT_IN_TASK_TYPE_EMOJIS,
  BUILT_IN_TASK_TYPE_LABELS,
  CalendarEvent,
  TaskType,
} from '@/types';
import { typeChoicesFor } from '@/lib/type-choices';
import { AsanaTypeFieldInfo } from '@/components/CreateAsanaTaskModal';
import { MobileSheet } from './MobileSheet';

const BUILT_IN_TASK_TYPES: BuiltInTaskType[] = [
  'flight', 'train', 'car', 'walk', 'writing', 'reading', 'focus', 'email', 'batch',
];

interface CreateAsanaTaskOptions {
  notes?: string;
  dueOn?: string;
  projectGid?: string;
  customFields?: Record<string, string>;
  localType?: string;
}

// Bottom-sheet task creator: an Asana task (workspace/project/type, written to
// Asana) or a quick ad-hoc task (a typed local to-do). The touch pickers replace
// the desktop modals' desktop-styled controls.
export function MobileCreateTaskSheet({
  integrations,
  projects,
  typeFieldInfoByIntegration,
  onClose,
  onCreateAsanaTask,
  onCreateAdhoc,
}: {
  integrations: { id: string; name: string }[];
  projects: AsanaProject[];
  typeFieldInfoByIntegration?: Map<string, AsanaTypeFieldInfo>;
  onClose: () => void;
  onCreateAsanaTask: (
    integrationId: string,
    name: string,
    options?: CreateAsanaTaskOptions,
  ) => Promise<CalendarEvent | null>;
  onCreateAdhoc: (
    task: Omit<AdHocTask, 'id' | 'createdAt' | 'updatedAt'>,
  ) => Promise<AdHocTask | null>;
}) {
  const [mode, setMode] = useState<'asana' | 'adhoc'>(integrations.length > 0 ? 'asana' : 'adhoc');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Asana form
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [integrationId, setIntegrationId] = useState(integrations[0]?.id || '');
  const [projectGid, setProjectGid] = useState('');
  const [selectedType, setSelectedType] = useState('');

  // Ad-hoc form
  const [adhocTitle, setAdhocTitle] = useState('');
  const [adhocDescription, setAdhocDescription] = useState('');
  const [adhocDueDate, setAdhocDueDate] = useState('');
  const [adhocType, setAdhocType] = useState<TaskType | null>(null);

  const typeFieldInfo = useMemo(() => {
    if (!typeFieldInfoByIntegration || !integrationId) return null;
    return typeFieldInfoByIntegration.get(integrationId) || null;
  }, [typeFieldInfoByIntegration, integrationId]);

  // Same rule as desktop: an Asana-writable workspace writes back to Asana; one
  // without (e.g. DBC) offers the local union and writes to the app-local store.
  const typeChoices = useMemo(
    () => typeChoicesFor(integrationId, typeFieldInfoByIntegration),
    [typeFieldInfoByIntegration, integrationId],
  );
  const typeValues = typeChoices.labels;
  const typeRequired = typeValues.length > 0;

  const filteredProjects = useMemo(
    () => projects.filter(p => p.integrationId === integrationId),
    [projects, integrationId],
  );

  const selectIntegration = (id: string) => {
    setIntegrationId(id);
    setProjectGid('');
    setSelectedType('');
  };

  const handleCreateAsana = async () => {
    if (!name.trim() || !integrationId) return;
    if (typeRequired && !selectedType) {
      setError('Type is required — please select a type for this task');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const options: CreateAsanaTaskOptions = {};
      if (notes.trim()) options.notes = notes.trim();
      if (dueOn) options.dueOn = dueOn;
      if (projectGid) options.projectGid = projectGid;
      if (selectedType) {
        if (typeChoices.writeTarget === 'local') {
          options.localType = selectedType;
        } else if (typeFieldInfo) {
          const enumOptionGid = typeFieldInfo.enumOptions.get(selectedType);
          if (enumOptionGid) options.customFields = { [typeFieldInfo.fieldGid]: enumOptionGid };
        }
      }
      await onCreateAsanaTask(integrationId, name.trim(), options);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateAdhoc = async () => {
    if (!adhocType) return;

    const emoji = BUILT_IN_TASK_TYPE_EMOJIS[adhocType as BuiltInTaskType];
    const label = BUILT_IN_TASK_TYPE_LABELS[adhocType as BuiltInTaskType];
    const title = adhocTitle.trim() ? `${emoji} ${label}: ${adhocTitle.trim()}` : `${emoji} ${label}`;

    setIsSubmitting(true);
    setError(null);
    try {
      await onCreateAdhoc({
        title,
        description: adhocDescription.trim() || undefined,
        dueDate: adhocDueDate || undefined,
        duration: 30,
        priority: 'medium',
        taskType: adhocType,
        completed: false,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass =
    'h-12 w-full rounded-lg border border-gray-300 px-3 text-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500';

  return (
    <MobileSheet onClose={onClose}>
      <div className="flex items-center justify-between border-b border-gray-200 px-4 pb-3">
        <h2 className="text-lg font-semibold text-gray-950">New Task</h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-md text-gray-500 transition-colors active:bg-gray-100"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {integrations.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMode('asana')}
              className={`h-11 rounded-lg text-sm font-medium transition-colors ${
                mode === 'asana' ? 'bg-orange-600 text-white' : 'border border-gray-300 text-gray-700 active:bg-gray-50'
              }`}
            >
              Asana task
            </button>
            <button
              type="button"
              onClick={() => setMode('adhoc')}
              className={`h-11 rounded-lg text-sm font-medium transition-colors ${
                mode === 'adhoc' ? 'bg-orange-600 text-white' : 'border border-gray-300 text-gray-700 active:bg-gray-50'
              }`}
            >
              Quick task
            </button>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
        )}

        {mode === 'asana' ? (
          <>
            {integrations.length > 1 && (
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Workspace</label>
                <div className="flex flex-wrap gap-2">
                  {integrations.map(int => (
                    <button
                      key={int.id}
                      type="button"
                      onClick={() => selectIntegration(int.id)}
                      className={`rounded-full px-3 py-2 text-sm transition-colors ${
                        integrationId === int.id
                          ? 'bg-orange-100 text-orange-700 ring-1 ring-orange-300'
                          : 'border border-gray-200 bg-white text-gray-600 active:bg-gray-100'
                      }`}
                    >
                      {int.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Task name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Enter task name"
                className={inputClass}
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Add notes (optional)"
                rows={3}
                className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
              />
            </div>

            <div>
              <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-700">
                <Clock className="h-3 w-3" /> Due date
              </label>
              <input type="date" aria-label="Due date" value={dueOn} onChange={e => setDueOn(e.target.value)} className={inputClass} />
            </div>

            {filteredProjects.length > 0 && (
              <div>
                <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-700">
                  <Folder className="h-3 w-3" /> Project
                </label>
                <div className="flex flex-wrap gap-2">
                  {filteredProjects.map(project => (
                    <button
                      key={project.gid}
                      type="button"
                      onClick={() => setProjectGid(prev => (prev === project.gid ? '' : project.gid))}
                      className={`rounded-full px-3 py-2 text-sm transition-colors ${
                        projectGid === project.gid
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

            {typeValues.length > 0 && (
              <div>
                <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-700">
                  <Tag className="h-3 w-3" /> Type <span className="text-red-500">*</span>
                </label>
                <select
                  value={selectedType}
                  onChange={e => setSelectedType(e.target.value)}
                  className={`${inputClass} bg-white`}
                >
                  <option value="">Select type (required)</option>
                  {typeValues.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
            )}

            <button
              type="button"
              onClick={handleCreateAsana}
              disabled={!name.trim() || isSubmitting}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-orange-600 font-medium text-white transition-colors active:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create Task
            </button>
          </>
        ) : (
          <>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Type <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                {BUILT_IN_TASK_TYPES.map(type => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setAdhocType(type)}
                    className={`flex h-14 flex-col items-center justify-center gap-0.5 rounded-lg text-xs transition-colors ${
                      adhocType === type
                        ? 'bg-orange-100 text-orange-700 ring-1 ring-orange-300'
                        : 'border border-gray-200 bg-white text-gray-600 active:bg-gray-100'
                    }`}
                  >
                    <span className="text-lg">{BUILT_IN_TASK_TYPE_EMOJIS[type]}</span>
                    <span>{BUILT_IN_TASK_TYPE_LABELS[type]}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Title {!adhocType && <span className="text-red-500">*</span>}
              </label>
              <input
                type="text"
                value={adhocTitle}
                onChange={e => setAdhocTitle(e.target.value)}
                placeholder={adhocType ? `Optional — defaults to "${BUILT_IN_TASK_TYPE_LABELS[adhocType as BuiltInTaskType]}"` : 'Enter task title'}
                className={inputClass}
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
              <textarea
                value={adhocDescription}
                onChange={e => setAdhocDescription(e.target.value)}
                placeholder="Enter task description"
                rows={3}
                className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
              />
            </div>

            <div>
              <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-700">
                <Clock className="h-3 w-3" /> Due date
              </label>
              <input type="date" aria-label="Due date" value={adhocDueDate} onChange={e => setAdhocDueDate(e.target.value)} className={inputClass} />
            </div>

            <button
              type="button"
              onClick={handleCreateAdhoc}
              disabled={!adhocType || isSubmitting}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-orange-600 font-medium text-white transition-colors active:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create Task
            </button>
          </>
        )}
      </div>
    </MobileSheet>
  );
}
