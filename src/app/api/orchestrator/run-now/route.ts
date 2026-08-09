import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { upsertDelegationEntry } from '@/lib/user-data-storage';
import { AGENT_RUNS_DIR } from '@/lib/data-paths';
import { ClaudeAccount } from '@/types';

const VALID_ACCOUNTS: ClaudeAccount[] = ['claude-dbc', 'claude-om'];

// POST { asanaTaskGid, integrationId, claudeAccount, brief?, title? }
// Enqueue the task as mode='now' and immediately spawn the runner as a DETACHED
// background process. A 15-minute agent run can't live inside an HTTP request,
// so we return right away; the child reports its result back over HTTP.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { asanaTaskGid, integrationId, brief, title, claudeAccount } = body as {
      asanaTaskGid?: string;
      integrationId?: string;
      brief?: string;
      title?: string;
      claudeAccount?: ClaudeAccount;
    };

    if (!asanaTaskGid || typeof asanaTaskGid !== 'string') {
      return NextResponse.json({ error: 'asanaTaskGid is required' }, { status: 400 });
    }
    if (!integrationId || typeof integrationId !== 'string') {
      return NextResponse.json({ error: 'integrationId is required' }, { status: 400 });
    }
    // A "run now" task starts executing immediately, so the account is
    // mandatory here — never guess a default.
    if (!claudeAccount || !VALID_ACCOUNTS.includes(claudeAccount)) {
      return NextResponse.json(
        { error: 'claudeAccount must be one of claude-dbc | claude-om' },
        { status: 400 }
      );
    }

    await upsertDelegationEntry(asanaTaskGid, integrationId, {
      mode: 'now',
      state: 'queued',
      claudeAccount,
      ...(brief !== undefined ? { brief } : {}),
      ...(title !== undefined ? { title } : {}),
    });

    // Detached child: scripts/run-task.sh sets PATH (incl. ~/.local/bin for the
    // claude binary) then execs `tsx workers/orchestrator/run-task.ts <gid>`.
    const repoRoot = process.cwd();
    mkdirSync(AGENT_RUNS_DIR, { recursive: true });
    const logFile = path.join(AGENT_RUNS_DIR, `run-now-${asanaTaskGid}.log`);
    const out = openSync(logFile, 'a');
    const script = path.join(repoRoot, 'scripts', 'run-task.sh');

    const child = spawn('/bin/bash', [script, asanaTaskGid], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, CALENDAR_APP_DIR: repoRoot },
    });
    child.unref();

    return NextResponse.json({ started: true });
  } catch (error) {
    console.error('Error starting run-now delegation:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to start run-now delegation' },
      { status: 500 }
    );
  }
}
