import { NextRequest, NextResponse } from 'next/server';

import { resolveTaskOwner, describeIntegrations } from '@/lib/asana-orchestrator';
import { getEnabledAsanaIntegrations } from '@/lib/integration-storage';

// Orchestrator-scoped Asana route for the headless delegation runner (via the
// local calendar-asana MCP server). Unlike /api/asana-tasks/[taskId], this does
// NOT take an integrationId — the owning integration is resolved by probing each
// enabled Asana integration, so the runner can READ tasks in EITHER the DBC or
// OM workspace through the app's own stored tokens.
//
// There is deliberately NO write path here: a delegated run must never post to
// Asana. Comments a run wants to leave go through the draft-comment route
// (./draft-comment), which stores them locally for Dave to review and post.

async function notFound(gid: string) {
  const integrations = await getEnabledAsanaIntegrations();
  return NextResponse.json(
    {
      error:
        `No enabled Asana integration can access task ${gid}. ` +
        `Tried: ${describeIntegrations(integrations)}. ` +
        `Check the gid is correct and that the owning workspace is connected in Settings.`,
    },
    { status: 404 }
  );
}

// GET - Fetch a single task by gid, resolving which workspace owns it.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ gid: string }> }
) {
  try {
    const { gid } = await params;
    const resolved = await resolveTaskOwner(gid);
    if (!resolved) {
      return notFound(gid);
    }

    const { integration, task } = resolved;
    const workspace = task.workspace as { gid?: string; name?: string } | undefined;

    return NextResponse.json({
      task,
      integration: {
        id: integration.id,
        name: integration.name,
        workspaceId: integration.workspaceId,
        workspaceName: workspace?.name ?? null,
      },
    });
  } catch (error) {
    console.error('[orchestrator/asana] Error fetching task:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch task' },
      { status: 500 }
    );
  }
}
