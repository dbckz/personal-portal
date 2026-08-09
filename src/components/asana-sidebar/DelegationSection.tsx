'use client';

import { useState } from 'react';
import { Loader2, Bot, CheckCircle2, XCircle, Copy } from 'lucide-react';
import { DelegationQueueEntry, DelegationState } from '@/types';
import { TraceTimeline } from '../TraceTimeline';
import { LinkifiedText } from './LinkifiedText';
import { claudeAccountLabel } from '@/lib/claude-account';

const BADGE_STYLES: Record<DelegationState, string> = {
  done: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  running: 'bg-amber-100 text-amber-700',
  queued: 'bg-blue-100 text-blue-700',
};

// Renders the current delegation queue state + last result for a task, and a
// button to (re)open the compose modal.
export function DelegationSection({ entry, onDelegate }: { entry?: DelegationQueueEntry; onDelegate: () => void }) {
  const [copied, setCopied] = useState(false);
  const state = entry?.state;
  const result = entry?.result;

  const accountLabel = claudeAccountLabel(entry?.claudeAccount);
  // A queued/running entry that never got an account can't run — flag it so the
  // user re-delegates to pick one (the runner refuses it otherwise).
  const needsAccount = !!entry && !entry.claudeAccount && (state === 'queued' || state === 'running');

  const badge = state
    ? {
        cls: BADGE_STYLES[state],
        label: state === 'queued' && entry?.mode === 'now' ? 'queued (run now)' : state,
      }
    : null;

  // Headless sessions are keyed by working directory, so the resume must run
  // from the agent workspace the run used — otherwise Claude reports
  // "No conversation found with session ID".
  const resumeCmd = result?.sessionId
    ? `cd ~/.claude/data/portal/agent-workspace && claude --resume ${result.sessionId}`
    : null;

  return (
    <div className="space-y-2">
      {badge && (
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge.cls}`}>{badge.label}</span>
          {accountLabel && (
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600" title="Claude account this run uses">
              {accountLabel}
            </span>
          )}
          {needsAccount && (
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700" title="No Claude account set — re-delegate to choose one">
              needs account
            </span>
          )}
          {state === 'running' && <Loader2 className="w-3.5 h-3.5 text-amber-600 animate-spin" />}
        </div>
      )}

      {result && (
        <div className="border border-gray-200 rounded-lg p-2.5 space-y-2 bg-gray-50">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            {result.status === 'successful'
              ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              : <XCircle className="w-3.5 h-3.5 text-red-500" />}
            <span className="text-gray-700">Result</span>
          </div>
          <div className="text-xs text-gray-700 whitespace-pre-wrap max-h-56 overflow-y-auto">
            <LinkifiedText text={result.reportMarkdown || result.summary} />
          </div>
          {result.outputs.length > 0 && (
            <ul className="text-xs text-gray-600 list-disc pl-4">
              {result.outputs.map((o, i) => <li key={i}><LinkifiedText text={o} /></li>)}
            </ul>
          )}
          {result.traceFile && (
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-500 hover:text-gray-700">Trace</summary>
              <div className="mt-1.5">
                <TraceTimeline file={result.traceFile} live={state === 'running'} />
              </div>
            </details>
          )}
          {resumeCmd && (
            <button
              onClick={() => { navigator.clipboard?.writeText(resumeCmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 max-w-full"
              title={`Copies: ${resumeCmd}`}
            >
              <Copy className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{copied ? 'Copied!' : 'Copy resume command'}</span>
            </button>
          )}
        </div>
      )}

      <button
        onClick={onDelegate}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
      >
        <Bot className="w-4 h-4" />
        {entry ? 'Delegate again…' : 'Delegate to agent…'}
      </button>
    </div>
  );
}
