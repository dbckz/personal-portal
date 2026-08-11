'use client';

import { Dispatch, SetStateAction, memo, useCallback, useMemo } from 'react';
import { AlertTriangle, ArrowRightToLine, Bell, CalendarClock, Check, Trash2 } from 'lucide-react';

import type { AsanaProject } from '@/types';
import type { AsanaTypeFieldInfo } from '@/components/CreateAsanaTaskModal';
import type { ReminderTriageRow } from '@/components/dashboard/plan-week/types';
import { typeChoicesFor } from '@/lib/type-choices';
import { MobileProjectSelect } from './MobileProjectSelect';

interface MobileRemindersStepProps {
  rows: ReminderTriageRow[] | null; // null = still loading suggestions
  setRows: Dispatch<SetStateAction<ReminderTriageRow[] | null>>;
  loading: boolean;
  error: string | null;
  progress?: { done: number; total: number } | null;
  integrations: Array<{ id: string; name: string }>;
  projects: AsanaProject[];
  typeFieldInfoByIntegration?: Map<string, AsanaTypeFieldInfo>;
}

const EMPTY_PROJECTS: AsanaProject[] = [];
const EMPTY_TYPES: string[] = [];

type UpdateFn = (id: string, patch: Partial<ReminderTriageRow>) => void;
type Action = ReminderTriageRow['action'];

function nameClassFor(action: Action): string {
  switch (action) {
    case 'done':
      return 'text-gray-500 line-through';
    case 'delete':
      return 'text-red-400 line-through';
    default:
      return 'text-gray-800';
  }
}

// One segmented action button. Full-height touch target, pressed state coloured
// per action so the current choice is obvious without a radio dot.
function ActionButton({
  active,
  onClick,
  activeClass,
  children,
}: {
  active: boolean;
  onClick: () => void;
  activeClass: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
        active ? activeClass : 'border-gray-200 bg-white text-gray-500'
      }`}
    >
      {children}
    </button>
  );
}

interface ReminderRowProps {
  row: ReminderTriageRow;
  rowProjects: AsanaProject[];
  rowTypes: string[];
  integrations: Array<{ id: string; name: string }>;
  onUpdate: UpdateFn;
}

// One triage row. memo'd so changing one row re-renders only that row, not all
// ~37 — the same performance contract as the desktop step (stable props: the
// unchanged row keeps identity, project/type arrays are memoized, onUpdate is a
// useCallback).
const ReminderRow = memo(function ReminderRow({
  row,
  rowProjects,
  rowTypes,
  integrations,
  onUpdate,
}: ReminderRowProps) {
  const converting = row.action === 'convert';
  const fromCalendar = row.source === 'calendar';
  return (
    <div className={`rounded-xl border p-3 ${fromCalendar ? 'border-blue-200 bg-blue-50/40' : 'border-gray-200'}`}>
      <div className="mb-2 flex items-start gap-2">
        {fromCalendar ? (
          <CalendarClock className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-500" />
        ) : (
          <Bell className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400" />
        )}
        <p className={`flex-1 text-sm ${converting ? 'text-gray-800' : nameClassFor(row.action)}`}>{row.name}</p>
      </div>
      {fromCalendar && (
        <p className="mb-2 text-xs text-blue-800">
          On your calendar {row.occurrences ?? 0} days this week. Converting it creates the task and leaves
          the recurring event alone.
        </p>
      )}

      {/* Action choice — segmented buttons instead of radios. */}
      <div className="flex flex-wrap gap-1.5">
        <ActionButton
          active={row.action === 'keep'}
          onClick={() => onUpdate(row.id, { action: 'keep' })}
          activeClass="border-gray-400 bg-gray-100 text-gray-800"
        >
          <Bell className="h-3.5 w-3.5" />
          {fromCalendar ? 'Leave' : 'Keep'}
        </ActionButton>
        <ActionButton
          active={converting}
          onClick={() => onUpdate(row.id, { action: 'convert' })}
          activeClass="border-orange-400 bg-orange-100 text-orange-700"
        >
          <ArrowRightToLine className="h-3.5 w-3.5" />
          Convert
        </ActionButton>
        {!fromCalendar && (
          <>
            <ActionButton
              active={row.action === 'done'}
              onClick={() => onUpdate(row.id, { action: 'done' })}
              activeClass="border-green-400 bg-green-100 text-green-700"
            >
              <Check className="h-3.5 w-3.5" />
              Done
            </ActionButton>
            <ActionButton
              active={row.action === 'delete'}
              onClick={() => onUpdate(row.id, { action: 'delete' })}
              activeClass="border-red-400 bg-red-100 text-red-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </ActionButton>
          </>
        )}
      </div>

      {converting && (
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={row.name}
            onChange={e => onUpdate(row.id, { name: e.target.value })}
            placeholder="Task name"
            aria-label="Task name"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500"
          />
          <textarea
            value={row.notes}
            onChange={e => onUpdate(row.id, { notes: e.target.value })}
            placeholder="Notes (optional)"
            aria-label="Notes"
            rows={2}
            className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500"
          />
          {integrations.length > 1 && (
            <div>
              <label className="mb-1 block text-[11px] text-gray-500">Workspace</label>
              <select
                value={row.integrationId}
                onChange={e =>
                  // Changing workspace invalidates the project/type picks.
                  onUpdate(row.id, { integrationId: e.target.value, projectGid: '', taskType: '' })
                }
                aria-label="Workspace"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-orange-500"
              >
                {integrations.map(intg => (
                  <option key={intg.id} value={intg.id}>
                    {intg.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {rowProjects.length > 0 && (
            <div>
              <label className="mb-1 block text-[11px] text-gray-500">Project</label>
              <MobileProjectSelect
                value={row.projectGid}
                onChange={gid => onUpdate(row.id, { projectGid: gid })}
                projects={rowProjects}
                placeholder="No project"
              />
            </div>
          )}
          {rowTypes.length > 0 && (
            <div>
              <label className="mb-1 block text-[11px] text-gray-500">Type</label>
              <select
                value={row.taskType}
                onChange={e => onUpdate(row.id, { taskType: e.target.value })}
                aria-label="Type"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-orange-500"
              >
                <option value="">No type</option>
                {rowTypes.map(t => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-[11px] text-gray-500">Due</label>
            <input
              type="date"
              value={row.dueOn}
              onChange={e => onUpdate(row.id, { dueOn: e.target.value })}
              aria-label="Due date"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
        </div>
      )}
    </div>
  );
});

export function MobileRemindersStep({
  rows,
  setRows,
  loading,
  error,
  progress,
  integrations,
  projects,
  typeFieldInfoByIntegration,
}: MobileRemindersStepProps) {
  const update = useCallback<UpdateFn>(
    (id, patch) => setRows(prev => (prev ? prev.map(r => (r.id === id ? { ...r, ...patch } : r)) : prev)),
    [setRows]
  );

  const projectsByIntegration = useMemo(() => {
    const m = new Map<string, AsanaProject[]>();
    for (const p of projects) {
      const arr = m.get(p.integrationId);
      if (arr) arr.push(p);
      else m.set(p.integrationId, [p]);
    }
    return m;
  }, [projects]);

  const typesByIntegration = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const intg of integrations) {
      m.set(intg.id, typeChoicesFor(intg.id, typeFieldInfoByIntegration).labels);
    }
    return m;
  }, [integrations, typeFieldInfoByIntegration]);

  if (loading || rows === null) {
    const done = progress?.done ?? 0;
    const total = progress?.total ?? 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return (
      <div className="py-8 text-center text-sm text-gray-500">
        <p>Reviewing your reminders and suggesting where each could go…</p>
        {total > 0 && (
          <div className="mx-auto mt-4 max-w-xs">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Reminder review progress"
            >
              <div
                className="h-full rounded-full bg-orange-500 transition-all duration-300 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-gray-400">
              {done} of {total} batches
            </p>
          </div>
        )}
      </div>
    );
  }

  const convertCount = rows.filter(r => r.action === 'convert').length;
  const doneCount = rows.filter(r => r.action === 'done').length;
  const deleteCount = rows.filter(r => r.action === 'delete').length;
  const summaryParts: string[] = [];
  if (convertCount > 0) summaryParts.push(`${convertCount} will become Asana task${convertCount === 1 ? '' : 's'}`);
  if (doneCount > 0) summaryParts.push(`${doneCount} marked done`);
  if (deleteCount > 0) summaryParts.push(`${deleteCount} deleted`);

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Tidy up your reminders before planning. For each, keep it, convert it into an Asana task, mark it
        done, or delete it. Changes are applied when you add the plan to your calendar.
      </p>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            AI suggestions weren&apos;t available — pick a workspace and details for any reminder you want to
            convert.
          </span>
        </div>
      )}

      {rows.map(row => (
        <ReminderRow
          key={row.id}
          row={row}
          rowProjects={projectsByIntegration.get(row.integrationId) ?? EMPTY_PROJECTS}
          rowTypes={typesByIntegration.get(row.integrationId) ?? EMPTY_TYPES}
          integrations={integrations}
          onUpdate={update}
        />
      ))}

      <p className="text-xs text-gray-400">
        {summaryParts.length > 0
          ? `${summaryParts.join('; ')}; the rest stay as reminders.`
          : 'Nothing selected to change — press Next (or Skip) to leave your reminders untouched.'}
      </p>
    </div>
  );
}
