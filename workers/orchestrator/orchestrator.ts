import path from 'node:path';
import { config, resolveClaudeBin } from './config';
import {
  fetchTaskById,
  fetchTaskStories,
  claimNextEntry,
  fetchQueueEntry,
  markEntryRunning,
  reportResult,
  fetchAgentPacing,
} from './planner-client';
import { taskUrl } from './asana-task-utils';
import { runClaudeTask, UsageLimitError } from './claude-runner';
import { buildBriefPrompt } from './prompts';
import {
  acquireLock,
  appendHistory,
  heartbeat,
  readStatus,
  releaseLock,
  setCurrentTask,
  setPausedUntil,
} from './status';
import type {
  AgentPacing,
  AsanaStory,
  ContainerReport,
  DelegationQueueEntry,
  DelegationRunResult,
  PlannerTask,
} from './types';

export interface RunResult {
  ranAt: string;
  picked: { id: string; title: string; url: string } | null;
  finalStatus?: string;
  result?: DelegationRunResult;
  message?: string;
  skipped?: boolean;
}

function normalizeReport(report: Partial<ContainerReport> | null | undefined): ContainerReport {
  const status: ContainerReport['status'] = report?.status === 'successful' ? 'successful' : 'failed';
  return {
    status,
    summary: String(report?.summary || '').trim() || (status === 'successful' ? 'Completed.' : 'Failed without a usable summary.'),
    outputs: Array.isArray(report?.outputs) ? report.outputs.map(value => String(value)) : [],
    next: String(report?.next || '').trim() || (status === 'successful' ? 'Review the outputs.' : 'Inspect the task and resolve the blocker.'),
  };
}

// Execute one delegation entry end-to-end. Assumes the run lock is already held
// and the entry is marked `running`. Runs the headless agent, tees a live trace,
// and reports the full result back to the app queue. Deliberately writes NOTHING
// back to Asana — the result, output and brief are kept in this tool only.
export async function runTask(entry: DelegationQueueEntry): Promise<RunResult> {
  const { asanaTaskGid: gid, integrationId } = entry;
  const ranAt = new Date().toISOString();
  await setCurrentTask({ gid, title: entry.title });

  // Read-only: fetch task context to build the prompt. No Asana writes.
  const task: PlannerTask = (await fetchTaskById(config.plannerBaseUrl, gid)) || {
    id: gid,
    title: entry.title,
    integrationId,
  };
  const stories: AsanaStory[] = await fetchTaskStories(config.plannerBaseUrl, gid, integrationId).catch(() => []);

  await heartbeat();

  const traceFile = path.join(config.agentRunsDir, `${gid}-${Date.now()}.jsonl`);
  let report: ContainerReport;
  let sessionId: string | null = null;
  let resultText = '';
  let traceBasename: string | null = null;
  let finalStatus: 'successful' | 'failed' = 'successful';

  try {
    // Resolve the account-specific binary FIRST. A missing/unknown account
    // throws here (caught below) so the task fails with an actionable message
    // instead of falling back to any Claude binary.
    const claudeBin = resolveClaudeBin(entry.claudeAccount);
    const run = await runClaudeTask({
      prompt: buildBriefPrompt({ task, stories, brief: entry.brief }),
      timeoutSeconds: config.claudeTimeoutSeconds,
      allowedTools: config.claudeAllowedTools,
      traceFile,
      claudeBin,
      mcpServers: config.mcpServers,
      mcpConfigPath: config.mcpConfigPath,
    });
    report = normalizeReport(run.report);
    sessionId = run.sessionId;
    resultText = run.resultText;
    traceBasename = run.traceFile;
    finalStatus = report.status;
  } catch (error) {
    if (error instanceof UsageLimitError) {
      // Re-throw so the pacer can record the backoff and re-queue the entry.
      await setCurrentTask(null);
      throw error;
    }
    finalStatus = 'failed';
    report = {
      status: 'failed',
      summary: error instanceof Error ? error.message : String(error),
      outputs: [],
      next: 'Inspect the agent failure and retry after fixing the blocker.',
    };
    traceBasename = path.basename(traceFile);
  }

  const runResult: DelegationRunResult = {
    status: finalStatus,
    summary: report.summary,
    outputs: report.outputs,
    next: report.next,
    reportMarkdown: resultText || report.summary,
    sessionId,
    traceFile: traceBasename,
    finishedAt: new Date().toISOString(),
  };
  await reportResult(config.plannerBaseUrl, gid, integrationId, finalStatus === 'successful' ? 'done' : 'failed', runResult);

  await appendHistory({ ranAt, taskGid: gid, title: entry.title, finalStatus, summary: report.summary });
  await setCurrentTask(null);

  return {
    ranAt,
    picked: { id: gid, title: entry.title, url: taskUrl(gid) },
    finalStatus,
    result: runResult,
  };
}

// "Run now": execute one explicit task GID immediately (invoked by the detached
// child spawned from the run-now API route).
export async function runSingle(gid: string): Promise<RunResult> {
  const lock = await acquireLock();
  if (!lock) {
    return { ranAt: new Date().toISOString(), picked: null, skipped: true, message: 'Another run is already in progress; skipping.' };
  }
  try {
    const entry = await fetchQueueEntry(config.plannerBaseUrl, gid);
    if (!entry) {
      return { ranAt: new Date().toISOString(), picked: null, message: `No queue entry for task ${gid}.` };
    }
    await markEntryRunning(config.plannerBaseUrl, entry).catch(() => { /* claim is best-effort */ });
    return await runTask({ ...entry, state: 'running' });
  } finally {
    await releaseLock();
  }
}

function isWithinWindow(window: { start: string; end: string } | undefined, now: Date): boolean {
  if (!window) return false;
  const [sh, sm] = window.start.split(':').map(Number);
  const [eh, em] = window.end.split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + (sm || 0);
  const end = eh * 60 + (em || 0);
  // Windows that wrap past midnight (start > end) are treated as overnight.
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end;
}

// The hourly cap in effect right now: the daytime `maxRunsPerHour` inside the
// active window, or the higher `sleepMaxRunsPerHour` outside it (biasing work
// toward the hours you're asleep). No activeHours set => the single flat rate.
export function effectiveHourlyCap(pacing: AgentPacing, now: Date): number {
  if (!pacing.activeHours) return pacing.maxRunsPerHour;
  return isWithinWindow(pacing.activeHours, now)
    ? pacing.maxRunsPerHour
    : (pacing.sleepMaxRunsPerHour ?? pacing.maxRunsPerHour);
}

// Pacer tick: budget-gate, then claim and run at most one queued entry.
export async function drainOnce(): Promise<RunResult> {
  const now = new Date();
  const status = await readStatus();

  if (status.pausedUntil && Date.parse(status.pausedUntil) > now.getTime()) {
    return { ranAt: now.toISOString(), picked: null, skipped: true, message: `Paced: paused until ${status.pausedUntil}.` };
  }
  // Clear an expired pause.
  if (status.pausedUntil) {
    await setPausedUntil(null);
  }

  const pacing: AgentPacing = (await fetchAgentPacing(config.plannerBaseUrl).catch(() => null)) || {
    maxRunsPerHour: config.defaultMaxRunsPerHour,
    maxRunsPerDay: config.defaultMaxRunsPerDay,
  };

  const runsInWindow = (ms: number) =>
    status.history.filter(h => h.taskGid && now.getTime() - Date.parse(h.ranAt) < ms).length;
  const hourlyCap = effectiveHourlyCap(pacing, now);
  if (runsInWindow(60 * 60 * 1000) >= hourlyCap) {
    return { ranAt: now.toISOString(), picked: null, skipped: true, message: `Paced: hourly run budget reached (${hourlyCap}/h).` };
  }
  if (runsInWindow(24 * 60 * 60 * 1000) >= pacing.maxRunsPerDay) {
    return { ranAt: now.toISOString(), picked: null, skipped: true, message: 'Paced: daily run budget reached.' };
  }

  const lock = await acquireLock();
  if (!lock) {
    return { ranAt: now.toISOString(), picked: null, skipped: true, message: 'Another run is already in progress; skipping.' };
  }

  try {
    const entry = await claimNextEntry(config.plannerBaseUrl);
    if (!entry) {
      return { ranAt: now.toISOString(), picked: null, message: 'No queued delegation entries.' };
    }
    try {
      return await runTask(entry);
    } catch (error) {
      if (error instanceof UsageLimitError) {
        const resetIso = resolveResetTime(error.resetsAt, now);
        await setPausedUntil(resetIso);
        // Re-queue so the entry is retried after the backoff.
        await reportResult(config.plannerBaseUrl, entry.asanaTaskGid, entry.integrationId, 'queued').catch(() => {});
        return { ranAt: now.toISOString(), picked: null, skipped: true, message: `Usage limit hit; paused until ${resetIso}.` };
      }
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

// Turn a parsed "resets 3:45pm" fragment into a concrete ISO instant. Falls back
// to a 1-hour backoff when the time can't be parsed.
export function resolveResetTime(resetsAt: string | null, now: Date): string {
  const fallback = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  if (!resetsAt) return fallback;
  const match = resetsAt.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return fallback;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1); // reset is later today or tomorrow
  }
  return target.toISOString();
}
