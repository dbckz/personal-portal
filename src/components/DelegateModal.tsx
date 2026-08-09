'use client';

import { useEffect, useState } from 'react';
import { X, Bot, Zap, ListPlus, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { ClaudeAccount } from '@/types';
import { CLAUDE_ACCOUNT_LABELS } from '@/lib/claude-account';

// The two Claude Code accounts on this machine. No default: the user must pick
// one before delegating (the runner refuses a task with no account set).
const ACCOUNT_OPTIONS: { value: ClaudeAccount; label: string; hint: string }[] = [
  { value: 'claude-dbc', label: CLAUDE_ACCOUNT_LABELS['claude-dbc'], hint: 'davebuckleyconsulting' },
  { value: 'claude-om', label: CLAUDE_ACCOUNT_LABELS['claude-om'], hint: 'openmined.org' },
];

interface DelegateModalProps {
  asanaTaskGid: string;
  integrationId: string;
  taskTitle: string;
  // Seeds the brief textarea (task notes / description), if any.
  initialBrief?: string;
  onClose: () => void;
  // Called after a successful enqueue/run so the parent can refresh the queue.
  onDelegated?: () => void;
}

// Compose a plain-English brief for the agent at delegation time, then either
// run it now (spawns a detached agent immediately) or queue it for the
// budget-paced background drain. No magic syntax — the brief is the instruction.
export function DelegateModal({
  asanaTaskGid,
  integrationId,
  taskTitle,
  initialBrief = '',
  onClose,
  onDelegated,
}: DelegateModalProps) {
  const [brief, setBrief] = useState(initialBrief);
  const [account, setAccount] = useState<ClaudeAccount | null>(null);
  const [submitting, setSubmitting] = useState<false | 'now' | 'background'>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Submit stays gated until both a brief and an account are chosen.
  const disabled = !brief.trim() || !account || submitting !== false;

  const handleRunNow = async () => {
    if (disabled || !account) return;
    setSubmitting('now');
    setError(null);
    try {
      await api.runNowDelegation(asanaTaskGid, integrationId, brief.trim(), taskTitle, account);
      onDelegated?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start the agent.');
      setSubmitting(false);
    }
  };

  const handleQueue = async () => {
    if (disabled || !account) return;
    setSubmitting('background');
    setError(null);
    try {
      await api.upsertDelegationEntry(asanaTaskGid, integrationId, {
        title: taskTitle,
        brief: brief.trim(),
        mode: 'background',
        state: 'queued',
        claudeAccount: account,
      });
      onDelegated?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue the task.');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 flex items-center gap-2">
            <Bot className="w-5 h-5 text-indigo-600" /> Delegate to agent
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-gray-500 line-clamp-2">
            <span className="font-medium text-gray-700">Task:</span> {taskTitle}
          </p>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Brief</label>
            <textarea
              value={brief}
              onChange={e => setBrief(e.target.value)}
              placeholder="Tell the agent what to do, in plain English. Tip: start with ~skill-name to use one of your Claude skills."
              rows={7}
              autoFocus
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Run on account <span className="text-red-500">*</span>
            </label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Claude account">
              {ACCOUNT_OPTIONS.map(opt => {
                const selected = account === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setAccount(opt.value)}
                    className={`flex flex-col items-start px-3 py-2 rounded-lg border text-left transition-colors ${
                      selected
                        ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500'
                        : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <span className="text-sm font-medium text-gray-900">{opt.label}</span>
                    <span className="text-xs text-gray-500">{opt.hint}</span>
                  </button>
                );
              })}
            </div>
            {!account && (
              <p className="mt-1 text-xs text-gray-400">Pick which Claude account the agent runs on.</p>
            )}
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={handleQueue}
              disabled={disabled}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting === 'background' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ListPlus className="w-4 h-4" />}
              Queue for background
            </button>
            <button
              type="button"
              onClick={handleRunNow}
              disabled={disabled}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting === 'now' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              Run now
            </button>
          </div>
          <p className="text-xs text-gray-400">
            Run now spawns an agent immediately. Queue adds it to the background drain, which runs within your usage budget.
          </p>
        </div>
      </div>
    </div>
  );
}
