'use client';

import { useState } from 'react';
import { Archive, Bot, Loader2 } from 'lucide-react';

import { CalendarEvent } from '@/types';
import { api, type AiClaim } from '@/lib/api';
import { MobileAiClaimsSheet } from './MobileAiClaimsSheet';
import { MobileStaleTasksSheet } from './MobileStaleTasksSheet';

// The two Command Center triage tools on the phone: "Assess AI-runnable" (runs
// the cached classifier, then opens a review sheet of the new claims) and
// "Triage stale" (opens a sheet that self-loads the staleness classifier). The
// desktop counterparts are DashboardContent's header buttons + AiClaimsModal /
// StaleTasksModal.
export function MobileTriageActions({
  tasks,
  onOpenTask,
  onReloadMetadata,
  onDeleteTask,
  onDataChanged,
}: {
  tasks: CalendarEvent[]; // incomplete Asana tasks
  onOpenTask?: (taskId: string) => void;
  onReloadMetadata: () => Promise<void>; // refresh aiDelegable flags after applying verdicts
  onDeleteTask: (taskId: string, integrationId: string) => Promise<boolean>;
  onDataChanged: () => void; // refresh capacity / delegation after a change
}) {
  const [assessing, setAssessing] = useState(false);
  const [assessError, setAssessError] = useState<string | null>(null);
  // Set (not null) means the review sheet is open — an empty array shows the
  // sheet's own empty state rather than the button appearing to do nothing.
  const [claims, setClaims] = useState<AiClaim[] | null>(null);
  const [staleOpen, setStaleOpen] = useState(false);

  const assess = async () => {
    setAssessing(true);
    setAssessError(null);
    try {
      const payload = tasks
        .filter(t => !t.completed && t.integrationId)
        .map(t => ({
          gid: t.id,
          integrationId: t.integrationId as string,
          title: t.title,
          description: t.description,
          integrationName: t.integrationName,
          dueOn: t.dueOn,
        }));
      // 'review' holds new claims back until confirmed in the sheet.
      const r = await api.classifyAiTasks(payload, 'review');
      await onReloadMetadata();
      setClaims(r.claims ?? []);
    } catch (err) {
      setAssessError(err instanceof Error ? err.message : 'Re-assessment failed.');
    } finally {
      setAssessing(false);
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="mb-2 text-base font-semibold text-gray-900">Triage</h2>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={assess}
          disabled={assessing}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-indigo-300 px-3 text-sm font-medium text-indigo-700 active:bg-indigo-50 disabled:opacity-50"
        >
          {assessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
          {assessing ? 'Assessing…' : 'Assess AI-runnable'}
        </button>
        <button
          type="button"
          onClick={() => setStaleOpen(true)}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-amber-300 px-3 text-sm font-medium text-amber-700 active:bg-amber-50"
        >
          <Archive className="h-4 w-4" /> Triage stale
        </button>
      </div>
      {assessError && <p className="mt-2 text-[11px] text-red-600">{assessError}</p>}

      {claims !== null && (
        <MobileAiClaimsSheet
          claims={claims}
          onClose={() => setClaims(null)}
          onApplied={() => {
            void onReloadMetadata();
            onDataChanged();
          }}
        />
      )}

      {staleOpen && (
        <MobileStaleTasksSheet
          tasks={tasks}
          onClose={() => setStaleOpen(false)}
          onOpenTask={onOpenTask}
          onDeleteTask={async (taskId, integrationId) => {
            const ok = await onDeleteTask(taskId, integrationId);
            onDataChanged();
            return ok;
          }}
        />
      )}
    </section>
  );
}
