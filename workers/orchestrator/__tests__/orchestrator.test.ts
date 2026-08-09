// Dry-run tests for the app-queue delegation flow with a fully mocked planner
// client + status layer. No real HTTP, no claude CLI, no Asana side effects.
import { drainOnce, runSingle, resolveResetTime, effectiveHourlyCap } from '../orchestrator';
import * as planner from '../planner-client';
import * as claudeRunner from '../claude-runner';
import * as status from '../status';
import { UsageLimitError } from '../claude-runner';
import type { DelegationQueueEntry } from '../types';

jest.mock('../planner-client');
jest.mock('../claude-runner', () => {
  class UsageLimitError extends Error {
    resetsAt: string | null;
    constructor(message: string, resetsAt: string | null) {
      super(message);
      this.name = 'UsageLimitError';
      this.resetsAt = resetsAt;
    }
  }
  return { runClaudeTask: jest.fn(), UsageLimitError };
});
jest.mock('../status');

const mockedPlanner = planner as jest.Mocked<typeof planner>;
const mockedClaude = claudeRunner as jest.Mocked<typeof claudeRunner>;
const mockedStatus = status as jest.Mocked<typeof status>;

const ENTRY: DelegationQueueEntry = {
  asanaTaskGid: '100',
  integrationId: 'i1',
  title: 'Do the thing',
  brief: 'Draft a memo',
  mode: 'background',
  state: 'queued',
  priority: 0,
  claudeAccount: 'claude-dbc',
  enqueuedAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
};

const GOOD_RUN = {
  report: { status: 'successful' as const, summary: 'Wrote the memo.', outputs: ['memo.md'], next: 'Review it.' },
  sessionId: 'sess-1',
  resultText: '# Memo\nDone.',
  traceFile: '100-123.jsonl',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedStatus.readStatus.mockResolvedValue({ lastRunAt: null, running: null, history: [], pausedUntil: null });
  mockedStatus.acquireLock.mockResolvedValue({ lastRunAt: null, running: null, history: [] });
  mockedStatus.releaseLock.mockResolvedValue();
  mockedStatus.setCurrentTask.mockResolvedValue();
  mockedStatus.heartbeat.mockResolvedValue();
  mockedStatus.appendHistory.mockResolvedValue();
  mockedStatus.setPausedUntil.mockResolvedValue();

  mockedPlanner.fetchAgentPacing.mockResolvedValue({ maxRunsPerHour: 2, maxRunsPerDay: 12 });
  mockedPlanner.fetchTaskById.mockResolvedValue({ id: '100', title: 'Do the thing', integrationId: 'i1', tags: [] });
  mockedPlanner.fetchTaskStories.mockResolvedValue([]);
  mockedPlanner.reportResult.mockResolvedValue();
  mockedPlanner.markEntryRunning.mockResolvedValue();
});

describe('drainOnce', () => {
  it('skips when a usage-limit pause is still in effect', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockedStatus.readStatus.mockResolvedValue({ lastRunAt: null, running: null, history: [], pausedUntil: future });

    const result = await drainOnce();

    expect(result.skipped).toBe(true);
    expect(result.message).toMatch(/paused until/i);
    expect(mockedPlanner.claimNextEntry).not.toHaveBeenCalled();
  });

  it('skips when the hourly run budget is reached', async () => {
    mockedStatus.readStatus.mockResolvedValue({
      lastRunAt: null,
      running: null,
      pausedUntil: null,
      history: [
        { ranAt: new Date().toISOString(), taskGid: 'a', title: 'a', finalStatus: 'successful', summary: '' },
        { ranAt: new Date().toISOString(), taskGid: 'b', title: 'b', finalStatus: 'successful', summary: '' },
      ],
    });

    const result = await drainOnce();

    expect(result.skipped).toBe(true);
    expect(result.message).toMatch(/hourly run budget/i);
    expect(mockedPlanner.claimNextEntry).not.toHaveBeenCalled();
  });

  it('reports nothing to do when the queue is empty', async () => {
    mockedPlanner.claimNextEntry.mockResolvedValue(null);

    const result = await drainOnce();

    expect(result.picked).toBeNull();
    expect(result.message).toMatch(/no queued/i);
    expect(mockedClaude.runClaudeTask).not.toHaveBeenCalled();
    expect(mockedStatus.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('claims, runs, reports done locally, and appends history — with NO Asana writes', async () => {
    mockedPlanner.claimNextEntry.mockResolvedValue({ ...ENTRY, state: 'running' });
    mockedClaude.runClaudeTask.mockResolvedValue(GOOD_RUN);

    const result = await drainOnce();

    expect(result.finalStatus).toBe('successful');
    expect(result.picked).toEqual({ id: '100', title: 'Do the thing', url: 'https://app.asana.com/0/0/100' });
    // Results stay local — nothing is written back to Asana.
    expect(mockedPlanner.updateTaskTags).not.toHaveBeenCalled();
    expect(mockedPlanner.addTaskComment).not.toHaveBeenCalled();
    expect(mockedPlanner.reportResult).toHaveBeenCalledWith(expect.any(String), '100', 'i1', 'done', expect.objectContaining({ sessionId: 'sess-1' }));
    expect(mockedStatus.appendHistory).toHaveBeenCalledWith(expect.objectContaining({ taskGid: '100', finalStatus: 'successful' }));
    expect(mockedStatus.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('records a backoff and re-queues on a usage-limit error', async () => {
    mockedPlanner.claimNextEntry.mockResolvedValue({ ...ENTRY, state: 'running' });
    mockedClaude.runClaudeTask.mockRejectedValue(new UsageLimitError('limit', '3:45pm'));

    const result = await drainOnce();

    expect(result.skipped).toBe(true);
    expect(mockedStatus.setPausedUntil).toHaveBeenCalledTimes(1);
    expect(mockedPlanner.reportResult).toHaveBeenCalledWith(expect.any(String), '100', 'i1', 'queued');
    expect(mockedStatus.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('marks the entry failed when the run throws a normal error', async () => {
    mockedPlanner.claimNextEntry.mockResolvedValue({ ...ENTRY, state: 'running' });
    mockedClaude.runClaudeTask.mockRejectedValue(new Error('boom'));

    const result = await drainOnce();

    expect(result.finalStatus).toBe('failed');
    expect(mockedPlanner.reportResult).toHaveBeenCalledWith(expect.any(String), '100', 'i1', 'failed', expect.objectContaining({ status: 'failed' }));
  });

  it('runs the account-specific binary resolved from claudeAccount', async () => {
    mockedPlanner.claimNextEntry.mockResolvedValue({ ...ENTRY, claudeAccount: 'claude-om', state: 'running' });
    mockedClaude.runClaudeTask.mockResolvedValue(GOOD_RUN);

    await drainOnce();

    expect(mockedClaude.runClaudeTask).toHaveBeenCalledWith(
      expect.objectContaining({ claudeBin: expect.stringMatching(/claude-om$/) }),
    );
  });

  it('refuses (fails) an entry with no claudeAccount, without spawning the CLI', async () => {
    const legacy = { ...ENTRY, state: 'running' as const };
    delete legacy.claudeAccount;
    mockedPlanner.claimNextEntry.mockResolvedValue(legacy);

    const result = await drainOnce();

    expect(result.finalStatus).toBe('failed');
    expect(mockedClaude.runClaudeTask).not.toHaveBeenCalled();
    expect(mockedPlanner.reportResult).toHaveBeenCalledWith(
      expect.any(String),
      '100',
      'i1',
      'failed',
      expect.objectContaining({ status: 'failed', summary: expect.stringMatching(/No Claude account/i) }),
    );
  });
});

describe('runSingle', () => {
  it('skips when the lock is already held', async () => {
    mockedStatus.acquireLock.mockResolvedValue(null);

    const result = await runSingle('100');

    expect(result.skipped).toBe(true);
    expect(mockedPlanner.fetchQueueEntry).not.toHaveBeenCalled();
  });

  it('runs an explicit queued task and reports done', async () => {
    mockedPlanner.fetchQueueEntry.mockResolvedValue(ENTRY);
    mockedClaude.runClaudeTask.mockResolvedValue(GOOD_RUN);

    const result = await runSingle('100');

    expect(result.finalStatus).toBe('successful');
    expect(mockedPlanner.markEntryRunning).toHaveBeenCalledTimes(1);
    expect(mockedPlanner.reportResult).toHaveBeenCalledWith(expect.any(String), '100', 'i1', 'done', expect.anything());
    expect(mockedStatus.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('returns a message when the task has no queue entry', async () => {
    mockedPlanner.fetchQueueEntry.mockResolvedValue(null);

    const result = await runSingle('404');

    expect(result.picked).toBeNull();
    expect(result.message).toMatch(/no queue entry/i);
  });
});

describe('resolveResetTime', () => {
  const now = new Date('2026-07-13T10:00:00.000Z');

  it('parses a 12-hour reset time later today', () => {
    // 3:45pm local relative to the test runner; assert it lands in the future.
    const iso = resolveResetTime('3:45pm', now);
    expect(Date.parse(iso)).toBeGreaterThan(now.getTime());
  });

  it('falls back to a one-hour backoff when unparseable', () => {
    const iso = resolveResetTime('gibberish', now);
    expect(iso).toBe(new Date(now.getTime() + 60 * 60 * 1000).toISOString());
  });

  it('falls back when no reset time is given', () => {
    const iso = resolveResetTime(null, now);
    expect(iso).toBe(new Date(now.getTime() + 60 * 60 * 1000).toISOString());
  });
});

describe('effectiveHourlyCap', () => {
  const pacing = { maxRunsPerHour: 2, sleepMaxRunsPerHour: 6, maxRunsPerDay: 40, activeHours: { start: '07:00', end: '01:00' } };
  // Local-time constructor (the pacer reads now.getHours()).
  const at = (h: number) => new Date(2026, 6, 13, h, 0, 0);

  it('uses the daytime cap inside the active window', () => {
    expect(effectiveHourlyCap(pacing, at(10))).toBe(2);   // 10:00 — active
    expect(effectiveHourlyCap(pacing, at(0))).toBe(2);    // 00:30-ish — still active (wraps past midnight)
  });

  it('uses the higher sleep cap outside the active window', () => {
    expect(effectiveHourlyCap(pacing, at(3))).toBe(6);    // 03:00 — asleep
    expect(effectiveHourlyCap(pacing, at(6))).toBe(6);    // 06:00 — asleep
  });

  it('falls back to the flat rate when no active window is set', () => {
    expect(effectiveHourlyCap({ maxRunsPerHour: 2, maxRunsPerDay: 12 }, at(3))).toBe(2);
  });
});
