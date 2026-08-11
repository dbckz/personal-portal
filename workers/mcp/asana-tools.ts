// Pure tool handlers for the calendar-asana MCP server (see
// asana-mcp-server.ts). Kept free of the MCP SDK so they can be unit-tested and
// so the transport wiring stays thin. Each handler calls the app's
// orchestrator-scoped Asana routes at the planner base URL — it never touches
// app code or Asana tokens directly.

import { readFileSync } from 'node:fs';
import path from 'node:path';

// Mirror workers/orchestrator/config.ts resolvePlannerBaseUrl: the worker does
// NOT import app code, so the base-URL resolution is duplicated here on purpose.
const repoRoot = process.env.CALENDAR_APP_DIR || process.cwd();

export function resolvePlannerBaseUrl(): string {
  if (process.env.PLANNER_BASE_URL) {
    return process.env.PLANNER_BASE_URL;
  }
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

// Injected in tests; defaults to the app's routes over the global fetch.
export interface ToolDeps {
  baseUrl: string;
  fetchFn?: typeof fetch;
}

function deps(overrides?: Partial<ToolDeps>): Required<ToolDeps> {
  return {
    baseUrl: overrides?.baseUrl ?? resolvePlannerBaseUrl(),
    fetchFn: overrides?.fetchFn ?? fetch,
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') return body.error;
    return JSON.stringify(body);
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

// get_task: fetch a task by gid, resolving whichever workspace owns it.
export async function getTask(gid: string, overrides?: Partial<ToolDeps>): Promise<string> {
  const { baseUrl, fetchFn } = deps(overrides);
  const trimmed = gid.trim();
  if (!trimmed) throw new Error('gid is required');

  const response = await fetchFn(
    `${baseUrl}/api/orchestrator/asana/tasks/${encodeURIComponent(trimmed)}`
  );

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const data = (await response.json()) as {
    task: Record<string, unknown>;
    integration: { name?: string; workspaceName?: string | null };
  };

  const t = data.task;
  const lines = [
    `Task: ${t.name ?? '(untitled)'}`,
    `Gid: ${trimmed}`,
    `Workspace: ${data.integration.workspaceName ?? data.integration.name ?? 'unknown'}`,
    `Completed: ${t.completed ? 'yes' : 'no'}`,
    t.due_on ? `Due on: ${t.due_on}` : null,
    (t.assignee as { name?: string } | undefined)?.name
      ? `Assignee: ${(t.assignee as { name?: string }).name}`
      : null,
    t.permalink_url ? `URL: ${t.permalink_url}` : null,
    '',
    `Notes:\n${(t.notes as string) || '(none)'}`,
  ].filter(Boolean);

  return lines.join('\n');
}

// draft_comment: save a comment on a task by gid as a LOCAL DRAFT for Dave to
// review — it is NOT posted to Asana. Delegated runs have no path that writes to
// Asana; this stores the comment on the task's delegation entry instead.
export async function draftComment(
  gid: string,
  text: string,
  overrides?: Partial<ToolDeps>
): Promise<string> {
  const { baseUrl, fetchFn } = deps(overrides);
  const trimmedGid = gid.trim();
  const trimmedText = (text ?? '').trim();
  if (!trimmedGid) throw new Error('gid is required');
  if (!trimmedText) throw new Error('text is required');

  const response = await fetchFn(
    `${baseUrl}/api/orchestrator/asana/tasks/${encodeURIComponent(trimmedGid)}/draft-comment`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmedText }),
    }
  );

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (
    `Saved as a LOCAL DRAFT on task ${trimmedGid} for Dave to review. ` +
    `It was NOT posted to Asana — Dave will edit and post it (or discard it) himself.`
  );
}
