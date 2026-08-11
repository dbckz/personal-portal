'use client';

import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { Bot, Calendar, Check, Loader2 } from 'lucide-react';

import { api, type AiClaim } from '@/lib/api';
import { MobileSheet } from '../components/MobileSheet';

// Touch rebuild of the desktop AiClaimsModal review gate. Every new claim is
// ticked by default: confirming accepts the ticked ones into the AI-runnable
// list and records the unticked ones as "not AI-runnable" so they are never
// re-claimed. Closing or cancelling applies nothing.
export function MobileAiClaimsSheet({
  claims,
  onClose,
  onApplied,
}: {
  claims: AiClaim[];
  onClose: () => void;
  onApplied: () => void; // called after a successful confirm so the caller can refresh
}) {
  const [accepted, setAccepted] = useState<Set<string>>(() => new Set(claims.map(c => c.gid)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (gid: string) =>
    setAccepted(prev => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });

  const confirm = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.applyAiVerdicts(
        claims.filter(c => accepted.has(c.gid)).map(c => ({ gid: c.gid, integrationId: c.integrationId })),
        claims.filter(c => !accepted.has(c.gid)).map(c => ({ gid: c.gid, integrationId: c.integrationId }))
      );
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save your decisions');
    } finally {
      setSaving(false);
    }
  };

  const empty = claims.length === 0;

  return (
    <MobileSheet onClose={onClose}>
      <div className="flex flex-shrink-0 items-center gap-2 px-4 pb-3">
        <Bot className="h-5 w-5 text-indigo-600" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900">New AI-runnable tasks</h2>
          <p className="text-[11px] text-gray-400">
            {empty
              ? 'Nothing new to review.'
              : 'Untick anything an agent shouldn’t run — those are never suggested again.'}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4">
        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {empty ? (
          <div className="flex flex-col items-center gap-2 py-14 text-center">
            <Check className="h-8 w-8 text-emerald-500" />
            <p className="text-sm font-medium text-gray-700">No new AI-runnable tasks found.</p>
            <p className="text-[11px] text-gray-400">
              Everything the assessor flagged is already in your list or already ruled out.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {claims.map(claim => {
              const isIn = accepted.has(claim.gid);
              return (
                <li key={claim.gid}>
                  <button
                    type="button"
                    onClick={() => toggle(claim.gid)}
                    disabled={saving}
                    aria-pressed={isIn}
                    className={`flex min-h-11 w-full items-start gap-3 rounded-lg border p-3 text-left ${
                      isIn ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border ${
                        isIn ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 bg-white'
                      }`}
                    >
                      {isIn && <Check className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-gray-800">{claim.title}</span>
                        {claim.integrationName && (
                          <span className="flex-shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                            {claim.integrationName}
                          </span>
                        )}
                      </span>
                      <span className="mt-1 flex items-center gap-1 text-[11px] text-gray-400">
                        <Calendar className="h-3 w-3" />
                        {claim.dueOn ? format(parseISO(claim.dueOn), 'dd MMM') : 'No due date'}
                      </span>
                      {claim.reason && (
                        <span className="mt-1 block text-[11px] text-gray-400 line-clamp-2">{claim.reason}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-shrink-0 gap-2 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
        {empty ? (
          <button
            type="button"
            onClick={onClose}
            className="h-12 flex-1 rounded-md bg-indigo-600 text-sm font-semibold text-white active:bg-indigo-700"
          >
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-12 flex-1 rounded-md border border-gray-300 text-sm font-medium text-gray-600 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={saving}
              className="flex h-12 flex-[2] items-center justify-center gap-1.5 rounded-md bg-indigo-600 text-sm font-semibold text-white disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? 'Saving…' : 'Confirm'}
            </button>
          </>
        )}
      </div>
    </MobileSheet>
  );
}
