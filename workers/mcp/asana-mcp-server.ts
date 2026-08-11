// calendar-asana MCP server.
//
// A thin stdio MCP shim the headless delegation runner spawns (see
// workers/orchestrator/config.ts mcpServers + claude-runner.ts). It exposes two
// tools: get_task READS any task in ANY of Dave's workspaces (DBC, OM, ...), and
// draft_comment saves a comment as a LOCAL DRAFT for Dave to review (it never
// posts to Asana). Both go through the calendar app's own stored integrations —
// use them instead of the claude.ai Asana connector when that connector lacks
// access to the workspace a task lives in.
//
// The actual Asana calls happen in the app's orchestrator-scoped routes; this
// server only forwards to them (see asana-tools.ts). Run it with:
//   npx tsx workers/mcp/asana-mcp-server.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getTask, draftComment } from './asana-tools';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'calendar-asana',
    version: '1.0.0',
  });

  server.registerTool(
    'get_task',
    {
      title: 'Get Asana task',
      description:
        "Fetch an Asana task by its gid from Dave's calendar app, resolving " +
        'whichever workspace (DBC or OM) owns it. Returns title, workspace, ' +
        'status, assignee, due date, URL and notes. Use this to read any task ' +
        'in either workspace when the Asana connector lacks access.',
      inputSchema: {
        gid: z.string().describe('The Asana task gid (numeric id).'),
      },
    },
    async ({ gid }) => {
      const text = await getTask(gid);
      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'draft_comment',
    {
      title: 'Draft Asana comment for review',
      description:
        'Draft a comment on an Asana task for Dave to review, edit, and post ' +
        'himself. This does NOT post to Asana — it saves the comment locally as ' +
        'a pending draft on the task, and Dave decides whether to post or ' +
        'discard it. Use this to leave a note, findings, or a proposed reply on ' +
        'a task; never try to post to Asana directly. The owning workspace is ' +
        'resolved automatically from the gid.',
      inputSchema: {
        gid: z.string().describe('The Asana task gid to draft a comment on.'),
        text: z.string().describe('The draft comment body (plain text).'),
      },
    },
    async ({ gid, text }) => {
      const result = await draftComment(gid, text);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the transport when run directly (not when imported by tests).
const invokedDirectly =
  typeof process.argv[1] === 'string' && process.argv[1].includes('asana-mcp-server');

if (invokedDirectly) {
  main().catch(error => {
    console.error('[calendar-asana MCP] fatal:', error);
    process.exit(1);
  });
}
