import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ClaudeAccount } from './types';

// The launchd wrapper and the `orchestrator:run` npm script both invoke this
// worker with the calendar repo root as the working directory, so cwd is the
// repo root. Using cwd (rather than import.meta.url) keeps config.ts loadable
// under both tsx (ESM) at runtime and ts-jest (CJS) in tests.
const repoRoot = process.env.CALENDAR_APP_DIR || process.cwd();

// Mirror src/lib/data-paths.ts. The worker deliberately does NOT import app
// code (avoids pulling in server modules that touch integrations.json).
// Prefer the post-rename directory, falling back to the legacy `calendar` one on
// a machine that has not been migrated yet.
const DATA_DIR = (() => {
  const current = path.join(homedir(), '.claude', 'data', 'portal');
  const legacy = path.join(homedir(), '.claude', 'data', 'calendar');
  // Runs at module load; a test that mocks node:fs leaves existsSync undefined,
  // and a throw here would stop the module importing at all.
  const exists = (dir: string): boolean => {
    try {
      return existsSync(dir);
    } catch {
      return false;
    }
  };
  if (exists(current)) return current;
  if (exists(legacy)) return legacy;
  return current;
})();

// Tool allowlist for the headless `claude -p` agent runner. MCP entries MUST use
// the `mcp__<server>__*` glob form — Claude Code silently skips a bare
// `mcp__<server>` (no tool segment), so those connectors would never be
// approved. Bash is deliberately excluded here AND disallowed outright (see
// claudeDisallowedTools) so shell access is never available, even under the
// bypass permission mode below. Override via CLAUDE_ALLOWED_TOOLS if needed.
const DEFAULT_ALLOWED_TOOLS = [
  'Skill',
  'Read',
  'Write',
  'WebSearch',
  'WebFetch',
  'mcp__claude_ai_Google_Calendar__*',
  'mcp__claude_ai_Gmail__*',
  'mcp__claude_ai_Asana__*',
  'mcp__claude_ai_Slack__*',
  'mcp__claude_ai_HubSpot__*',
  'mcp__claude_ai_Google_Drive__*',
  'mcp__claude_ai_Notion__*',
  // Local calendar-asana MCP server (workers/mcp/asana-mcp-server.ts): lets the
  // agent read/comment on Asana tasks in EITHER the DBC or OM workspace via the
  // app's own stored tokens, covering the gap where the claude.ai Asana
  // connector is OM-only. Must use the mcp__<server>__* glob (see note above).
  'mcp__calendar-asana__*',
].join(',');

function resolvePlannerBaseUrl(): string {
  if (process.env.PLANNER_BASE_URL) {
    return process.env.PLANNER_BASE_URL;
  }
  // The production service writes its chosen port here (see scripts/start-production.sh).
  const portFile = path.join(repoRoot, '.data', 'current-port');
  try {
    const port = readFileSync(portFile, 'utf8').trim();
    if (port) {
      return `http://localhost:${port}`;
    }
  } catch {
    // fall through to default
  }
  return 'http://localhost:3001';
}

export const config = {
  repoRoot,
  dataDir: DATA_DIR,
  plannerBaseUrl: resolvePlannerBaseUrl(),
  runLogPath: path.join(DATA_DIR, 'orchestrator-last-run.json'),
  statusPath: path.join(DATA_DIR, 'orchestrator-status.json'),
  targetIntegrationName: process.env.ASANA_INTEGRATION_NAME || 'DBC',
  readyTagName: process.env.ASANA_READY_TAG || 'agent_ready',
  inProgressTagName: process.env.ASANA_IN_PROGRESS_TAG || 'agent_in_progress',
  completeTagName: process.env.ASANA_COMPLETE_TAG || 'agent_complete',
  failedTagName: process.env.ASANA_FAILED_TAG || 'agent_failed',
  // Headless Claude Code agent runner (see claude-runner.ts).
  claudeBin: process.env.CLAUDE_BIN || path.join(homedir(), '.local', 'bin', 'claude'),
  // Pin agent runs to Opus for the strongest reasoning; override via CLAUDE_MODEL.
  claudeModel: process.env.CLAUDE_MODEL || 'opus',
  claudeTimeoutSeconds: Number(process.env.CLAUDE_TIMEOUT_SECONDS || 900),
  claudeAllowedTools: process.env.CLAUDE_ALLOWED_TOOLS || DEFAULT_ALLOWED_TOOLS,
  // `auto` mode: decisions are made by background safety checks that approve
  // legitimate writes (including scoped MCP/connector writes) without prompting,
  // while blocking risky actions — the sweet spot for unattended runs. Combined
  // with the scoped `--allowedTools` list (correct mcp__server__* globs) and no
  // shell (Bash disallowed). NOT `bypassPermissions` (which disables the safety
  // checks entirely). Override with CLAUDE_PERMISSION_MODE (e.g. `acceptEdits`
  // for files-only, or `bypassPermissions` as a last resort).
  claudePermissionMode: process.env.CLAUDE_PERMISSION_MODE || 'auto',
  claudeDisallowedTools: process.env.CLAUDE_DISALLOWED_TOOLS || 'Bash',
  // Scratch workspace so the agent's Write output lands here, not in the repo.
  agentWorkspace: path.join(DATA_DIR, 'agent-workspace'),
  // Per-run stream-json trace files (mirrors src/lib/data-paths.ts AGENT_RUNS_DIR).
  agentRunsDir: path.join(DATA_DIR, 'agent-runs'),
  // Local calendar-asana MCP server config passed to `claude -p` via
  // --mcp-config. Written to this path at run time (see claude-runner.ts) then
  // referenced by the CLI; it MERGES with the user's existing connectors (no
  // --strict-mcp-config, so the claude.ai connectors above stay available). The
  // server is spawned with cwd=repoRoot so its resolvePlannerBaseUrl can read
  // .data/current-port. The server name MUST be `calendar-asana` to match the
  // mcp__calendar-asana__* allowlist entry.
  mcpConfigPath: path.join(DATA_DIR, 'orchestrator-mcp.json'),
  mcpServers: {
    'calendar-asana': {
      command: 'npx',
      args: ['tsx', path.join(repoRoot, 'workers', 'mcp', 'asana-mcp-server.ts')],
      cwd: repoRoot,
      ...(process.env.PLANNER_BASE_URL
        ? { env: { PLANNER_BASE_URL: process.env.PLANNER_BASE_URL } }
        : {}),
    },
  } as Record<string, unknown>,
  // Fallback pacing budget when the app's workflow-config is unreachable. The
  // pacer prefers the live workflow-config.agentPacing values.
  defaultMaxRunsPerHour: Number(process.env.AGENT_MAX_RUNS_PER_HOUR || 2),
  defaultMaxRunsPerDay: Number(process.env.AGENT_MAX_RUNS_PER_DAY || 12),
};

export type OrchestratorConfig = typeof config;

const CLAUDE_ACCOUNTS: readonly ClaudeAccount[] = ['claude-dbc', 'claude-om'];

// Resolve the wrapper binary for a delegated run's chosen Claude account. The
// machine runs two Claude Code accounts via the ~/bin/claude-dbc and
// ~/bin/claude-om wrappers (each execs ~/.local/bin/claude with the right
// CLAUDE_CONFIG_DIR). The default is an ABSOLUTE path — launchd and Next give
// the worker no useful PATH, and ~/bin is not guaranteed to be on it — but
// CLAUDE_BIN_DBC / CLAUDE_BIN_OM override it. Throws for a missing or unknown
// account so the runner fails the task with an actionable error rather than
// silently falling back to a default binary.
export function resolveClaudeBin(account: ClaudeAccount | undefined | null): string {
  if (!account || !CLAUDE_ACCOUNTS.includes(account)) {
    throw new Error(
      `No Claude account set for this task (claudeAccount=${account ?? 'unset'}). ` +
      'Re-delegate and choose an account (DBC or OpenMined) before it can run.',
    );
  }
  const override = account === 'claude-dbc'
    ? process.env.CLAUDE_BIN_DBC
    : process.env.CLAUDE_BIN_OM;
  return override || path.join(homedir(), 'bin', account);
}
