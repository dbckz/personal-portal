import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceTags, createTag, refreshAsanaToken } from '@/lib/asana';
import { getIntegrationById, getIntegrations, updateIntegration } from '@/lib/integration-storage';
import { AsanaIntegration, AsanaTagWithIntegration } from '@/types';

async function getRefreshedCredentials(integration: AsanaIntegration) {
  let credentials = integration.credentials!;
  if (credentials.expiresAt && Date.now() >= credentials.expiresAt - 60000) {
    credentials = await refreshAsanaToken(
      credentials.refreshToken!,
      integration.clientId,
      integration.clientSecret
    );
    await updateIntegration(integration.id, { credentials });
  }
  return credentials;
}

async function resolveIntegration(integrationId: string | null) {
  if (!integrationId) {
    return { error: NextResponse.json({ error: 'integrationId is required' }, { status: 400 }) };
  }
  const integration = await getIntegrationById(integrationId) as AsanaIntegration | null;
  if (!integration || integration.type !== 'asana') {
    return { error: NextResponse.json({ error: 'Asana integration not found' }, { status: 404 }) };
  }
  if (!integration.credentials || !integration.workspaceId) {
    return { error: NextResponse.json({ error: 'Integration not properly configured' }, { status: 400 }) };
  }
  return { integration };
}

export async function GET(request: NextRequest) {
  try {
    const integrationId = request.nextUrl.searchParams.get('integrationId');

    // With an explicit integration, return that one workspace's bare tag array —
    // the original single-workspace contract the tag creator relies on.
    if (integrationId) {
      const resolved = await resolveIntegration(integrationId);
      if ('error' in resolved) return resolved.error;

      const credentials = await getRefreshedCredentials(resolved.integration);
      const tags = await getWorkspaceTags(credentials.accessToken, resolved.integration.workspaceId!);
      return NextResponse.json(tags);
    }

    // With no integration, aggregate tags across every enabled Asana workspace,
    // each tagged with its origin (mirrors /api/asana-projects).
    const { asanaIntegrations } = await getIntegrations();
    const enabled = asanaIntegrations.filter(i => i.enabled && !!i.credentials && !!i.workspaceId);

    const tags: AsanaTagWithIntegration[] = [];
    for (const integration of enabled) {
      try {
        const credentials = await getRefreshedCredentials(integration);
        const workspaceTags = await getWorkspaceTags(credentials.accessToken, integration.workspaceId!);
        for (const tag of workspaceTags) {
          tags.push({ ...tag, integrationId: integration.id, integrationName: integration.name });
        }
      } catch (err) {
        console.error(`Error fetching tags for ${integration.name}:`, err);
        // Continue with other integrations.
      }
    }

    return NextResponse.json({ tags });
  } catch (error) {
    console.error('Error fetching Asana tags:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch tags' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { integrationId, name, color } = await request.json();

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const resolved = await resolveIntegration(integrationId);
    if ('error' in resolved) return resolved.error;

    const credentials = await getRefreshedCredentials(resolved.integration);
    const tag = await createTag(
      credentials.accessToken,
      resolved.integration.workspaceId!,
      name.trim(),
      typeof color === 'string' ? color : undefined
    );
    return NextResponse.json(tag);
  } catch (error) {
    console.error('Error creating Asana tag:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create tag' },
      { status: 500 }
    );
  }
}
