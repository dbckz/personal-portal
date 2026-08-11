'use client';

import { Dispatch, SetStateAction } from 'react';
import { Check, AlertTriangle } from 'lucide-react';

import { categoryColor } from '@/components/dashboard/plan-week/helpers';
import { ActiveProjectsPanel } from '@/components/dashboard/plan-week/ActiveProjectsPanel';
import type { MatchMeta, MatchRow } from '@/components/dashboard/plan-week/types';
import { MobileProjectSelect } from './MobileProjectSelect';

interface MobilePrioritiesStepProps {
  matchRows: MatchRow[] | null;
  setMatchRows: Dispatch<SetStateAction<MatchRow[] | null>>;
  priorityText: string;
  setPriorityText: Dispatch<SetStateAction<string>>;
  matchMeta: MatchMeta;
  createdTasks: Array<{ text: string; gid: string; title: string; integrationId: string }>;
}

// Touch build of the priorities step. Input phase is a full-width textarea; the
// match-review phase stacks each row's controls vertically (full-width selects)
// instead of the desktop's inline wrap, and swaps ProjectCombobox for
// MobileProjectSelect.
export function MobilePrioritiesStep({
  matchRows,
  setMatchRows,
  priorityText,
  setPriorityText,
  matchMeta,
  createdTasks,
}: MobilePrioritiesStepProps) {
  const projectsForIntegration = (integrationId: string) =>
    matchMeta.projects.filter(p => p.integrationId === integrationId);

  const categorySelect = (value: string, onChange: (v: string) => void) => (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label="Category"
      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-orange-500"
    >
      {matchMeta.categories.map(c => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );

  if (matchRows === null) {
    return (
      <div>
        <ActiveProjectsPanel />
        <p className="mb-3 text-sm text-gray-600">
          What matters most this week? These get matched against your Asana tasks (or created as new
          ones) and scheduled first.
        </p>
        <textarea
          value={priorityText}
          onChange={e => setPriorityText(e.target.value)}
          rows={6}
          placeholder={'One priority per line…\ne.g. Finish grant report\nPrep board deck'}
          className="w-full resize-none rounded-lg border border-gray-300 p-3 text-base outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
        />
        <p className="mt-2 text-xs text-gray-400">
          Leave blank and press Skip (or Next) to plan without pinned priorities.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {matchMeta.aiUnavailable && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            AI matching is unavailable right now — every line will be created as a new Asana task.
          </span>
        </div>
      )}
      {matchRows.map((row, i) => {
        const color = row.category ? categoryColor(row.category) : null;
        const rowProjects = projectsForIntegration(row.createIntegrationId);
        const needsProject = row.include && rowProjects.length > 0 && !row.createProjectGid;
        return (
          <div key={i} className="rounded-xl border border-gray-200 p-3">
            <div className="flex items-start gap-2.5">
              {!row.match && (
                <input
                  type="checkbox"
                  checked={row.include}
                  onChange={() =>
                    setMatchRows(prev => prev!.map((r, j) => (j === i ? { ...r, include: !r.include } : r)))
                  }
                  aria-label={`Include "${row.text}"`}
                  className="mt-1 h-5 w-5 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                />
              )}
              <p className="flex-1 text-sm font-medium text-gray-800">{row.text}</p>
            </div>

            {row.match ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-0.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  <Check className="h-3 w-3" />
                  Matched: {row.match.title}
                </span>
                {(() => {
                  const name = matchMeta.asanaIntegrations.find(a => a.id === row.match!.integrationId)?.name;
                  return name ? (
                    <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                      {name}
                    </span>
                  ) : null;
                })()}
                {row.match.category ? (
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${color!.bg} ${color!.text}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${color!.dot}`} />
                    {row.match.category}
                  </span>
                ) : (
                  <div className="mt-1 w-full">
                    <label className="mb-1 block text-[11px] text-gray-500">Category</label>
                    {categorySelect(row.category, val =>
                      setMatchRows(prev => prev!.map((r, j) => (j === i ? { ...r, category: val } : r)))
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-2 space-y-2 pl-0.5">
                <span className="text-[11px] text-gray-400">New Asana task</span>
                {matchMeta.asanaIntegrations.length > 1 && (
                  <div>
                    <label className="mb-1 block text-[11px] text-gray-500">Workspace</label>
                    <select
                      value={row.createIntegrationId}
                      onChange={e =>
                        setMatchRows(prev =>
                          prev!.map((r, j) =>
                            // Integration change invalidates the chosen project.
                            j === i ? { ...r, createIntegrationId: e.target.value, createProjectGid: '' } : r
                          )
                        )
                      }
                      aria-label="Workspace"
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-orange-500"
                    >
                      {matchMeta.asanaIntegrations.map(intg => (
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
                      value={row.createProjectGid}
                      onChange={gid =>
                        setMatchRows(prev => prev!.map((r, j) => (j === i ? { ...r, createProjectGid: gid } : r)))
                      }
                      projects={rowProjects}
                      invalid={needsProject}
                    />
                    {needsProject && (
                      <p className="mt-1 text-[11px] text-red-500">Choose a project for this new task.</p>
                    )}
                  </div>
                )}
                <div>
                  <label className="mb-1 block text-[11px] text-gray-500">Category</label>
                  {categorySelect(row.category, val =>
                    setMatchRows(prev => prev!.map((r, j) => (j === i ? { ...r, category: val } : r)))
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      {createdTasks.length > 0 && (
        <p className="text-xs text-gray-400">
          {createdTasks.length} new task{createdTasks.length === 1 ? '' : 's'} already created in Asana —
          they won&apos;t be recreated.
        </p>
      )}
    </div>
  );
}
