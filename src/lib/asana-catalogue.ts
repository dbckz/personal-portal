// The Asana project catalogue the goal inference chooses an asana-project ref
// from: every enabled, credentialled workspace, tokens refreshed as needed,
// failures per workspace swallowed so one bad integration doesn't sink the
// proposal. Mirrors /api/asana-projects.
//
// Server-only: reaches the Asana API and the integration store.

import { getProjects, refreshAsanaToken } from './asana';
import { getIntegrations, updateIntegration } from './integration-storage';
import type { AsanaIntegration, AsanaProject } from '@/types';

export async function loadAsanaProjects(): Promise<AsanaProject[]> {
  const { asanaIntegrations } = await getIntegrations();
  const usable = asanaIntegrations.filter(
    (i): i is AsanaIntegration & {
      credentials: NonNullable<AsanaIntegration['credentials']>;
      workspaceId: string;
    } => i.enabled && !!i.credentials && !!i.workspaceId
  );

  const all: AsanaProject[] = [];
  for (const integration of usable) {
    try {
      let credentials = integration.credentials;
      if (credentials.expiresAt && Date.now() >= credentials.expiresAt - 60000) {
        credentials = await refreshAsanaToken(
          credentials.refreshToken!,
          integration.clientId,
          integration.clientSecret
        );
        await updateIntegration(integration.id, { credentials });
      }
      const projects = await getProjects(credentials.accessToken, integration.workspaceId);
      for (const project of projects) {
        all.push({
          gid: project.gid,
          name: project.name,
          integrationId: integration.id,
          integrationName: integration.name,
          modifiedAt: project.modifiedAt,
        });
      }
    } catch (err) {
      console.error(`Error fetching projects for ${integration.name}:`, err);
    }
  }
  return all;
}
