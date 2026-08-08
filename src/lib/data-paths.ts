// Shared data directory paths for persistent storage.
// Lives outside the project (~/.claude/data/portal/) so it survives builds and
// deployments.

import fs from 'fs';
import { homedir } from 'os';
import path from 'path';

// The directory was called `calendar` before the app was renamed to the portal.
// Prefer the new name, but fall back to the old one when only that exists —
// this repo runs on two machines, and one of them may not have been migrated
// yet. Starting against an empty directory would look exactly like data loss.
function resolveDataDir(): string {
  // Explicit override wins — the staging instance points this at a copied
  // data directory so its writes never touch production data.
  const override = process.env.PORTAL_DATA_DIR;
  if (override) return override;
  const current = path.join(homedir(), '.claude', 'data', 'portal');
  const legacy = path.join(homedir(), '.claude', 'data', 'calendar');
  // This runs at module load, and tests that mock `fs` leave existsSync
  // undefined — a throw here would stop the module importing at all. Treat an
  // unusable fs as "no legacy directory" and take the current path.
  const exists = (dir: string): boolean => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  };
  if (exists(current)) return current;
  if (exists(legacy)) return legacy;
  return current;
}

export const DATA_DIR = resolveDataDir();

// Individual data files
export const USER_DATA_FILE = path.join(DATA_DIR, 'user-data.json');
export const INTEGRATIONS_FILE = path.join(DATA_DIR, 'integrations.json');
export const TIME_TRACKING_FILE = path.join(DATA_DIR, 'time-tracking.json');
export const WORKFLOW_CONFIG_FILE = path.join(DATA_DIR, 'workflow-config.json');

// Local "Type" associations for tasks from integrations that have no writable
// Asana Type field (e.g. Dave's DBC workspace). Keyed by Asana task gid; the
// value is the chosen Type label. Never written back to Asana — it lives here
// so those tasks can still be typed and counted by the capacity categories.
export const LOCAL_TASK_TYPES_FILE = path.join(DATA_DIR, 'local-task-types.json');

// Orchestrator worker status file (workers/orchestrator writes this; the app
// reads it via /api/orchestrator/status). The worker duplicates this path
// locally in workers/orchestrator/config.ts to avoid importing app code.
export const ORCHESTRATOR_STATUS_FILE = path.join(DATA_DIR, 'orchestrator-status.json');

// Per-run agent trace files (`<taskGid>-<ts>.jsonl`) written by the runner from
// the `stream-json` event stream, plus detached "Run now" child logs. The app
// reads these via /api/orchestrator/trace. The worker duplicates this path
// locally in workers/orchestrator/config.ts to avoid importing app code.
export const AGENT_RUNS_DIR = path.join(DATA_DIR, 'agent-runs');
