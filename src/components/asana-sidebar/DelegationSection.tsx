'use client';

import { useState } from 'react';
import { Loader2, Bot, CheckCircle2, XCircle, Copy, Send, Trash2, MessageSquarePlus } from 'lucide-react';
import { DelegationDraftComment, DelegationQueueEntry, DelegationState } from '@/types';
import { api } from '@/lib/api';
import { TraceTimeline } from '../TraceTimeline';
import { LinkifiedText } from './LinkifiedText';
import { claudeAccountLabel } from '@/lib/claude-account';

const BADGE_STYLES: Record<DelegationState, string> = {
  done: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  running: 'bg-amber-100 text-amber-700',
  queued: 'bg-blue-100 text-blue-700',
};

// One pending draft comment: an editable textarea (edits committed on blur,
// optimistically) plus Post-to-Asana and Discard actions with per-draft busy /
// error state. Posting sends the latest edited text and, on success, the parent
// refresh drops the draft and reveals the posted comment in the Comments list.
function DraftCommentItem({
  gid,
  draft,
  onChanged,
}: {
  gid: string;
  draft: DelegationDraftComment;
  onChanged?: () => void;
}) {
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState<null | 'posting' | 'discarding'>(null);
  const [error, setError] = useState<string | null>(null);

  const commitEdit = () => {
    const trimmed = text.trim();
    if (!trimmed || trimmed === draft.text) return;
    // Optimistic: don't block typing on the save; surface an error if it fails.
    api.updateDraftComment(gid, draft.id, trimmed)
      .then(() => onChanged?.())
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to save edit'));
  };

  const handlePost = () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy('posting');
    setError(null);
    api.postDraftComment(gid, draft.id, trimmed)
      .then(() => onChanged?.())
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to post comment');
        setBusy(null);
      });
  };

  const handleDiscard = () => {
    if (busy) return;
    setBusy('discarding');
    setError(null);
    api.discardDraftComment(gid, draft.id)
      .then(() => onChanged?.())
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to discard');
        setBusy(null);
      });
  };

  return (
    <div className="border border-indigo-200 rounded-lg p-2.5 space-y-2 bg-indigo-50/50">
      <div className="flex items-center gap-1.5 text-xs font-medium text-indigo-700">
        <MessageSquarePlus className="w-3.5 h-3.5" />
        <span>Draft comment — not posted</span>
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={commitEdit}
        disabled={busy !== null}
        rows={3}
        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-y disabled:opacity-60"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={handlePost}
          disabled={!text.trim() || busy !== null}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy === 'posting' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
          Post to Asana
        </button>
        <button
          onClick={handleDiscard}
          disabled={busy !== null}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy === 'discarding' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          Discard
        </button>
      </div>
    </div>
  );
}

// Renders the current delegation queue state + last result for a task, any
// pending draft comments a run left for review, and a button to (re)open the
// compose modal. `roomy` gives the result a taller box and larger text for the
// wide desktop two-pane layout and the mobile sheet. `onDraftChange` refreshes
// the queue store after a draft is edited, posted or discarded.
export function DelegationSection({
  entry,
  onDelegate,
  roomy = false,
  onDraftChange,
}: {
  entry?: DelegationQueueEntry;
  onDelegate: () => void;
  roomy?: boolean;
  onDraftChange?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const state = entry?.state;
  const result = entry?.result;
  const draftComments = entry?.draftComments ?? [];

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
          <div className={`text-gray-700 whitespace-pre-wrap overflow-y-auto ${roomy ? 'text-sm max-h-[60vh]' : 'text-xs max-h-56'}`}>
            <LinkifiedText text={result.reportMarkdown || result.summary} />
          </div>
          {result.outputs.length > 0 && (
            <ul className={`text-gray-600 list-disc pl-4 ${roomy ? 'text-sm' : 'text-xs'}`}>
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

      {entry && draftComments.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-indigo-700">
            {draftComments.length === 1 ? '1 draft comment for review' : `${draftComments.length} draft comments for review`}
          </p>
          {draftComments.map(draft => (
            <DraftCommentItem
              key={draft.id}
              gid={entry.asanaTaskGid}
              draft={draft}
              onChanged={onDraftChange}
            />
          ))}
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
