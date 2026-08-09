// Shared types for the orchestrator worker. These mirror the shapes returned by
// the calendar app's HTTP API (CalendarEvent + Asana tags/stories) but are kept
// local so the worker never imports app source.

export interface AsanaTag {
  gid: string;
  name: string;
  color?: string | null;
}

export interface AsanaCustomField {
  gid: string;
  name: string;
  displayValue: string | null;
  type?: string;
  enumOptions?: Array<{ gid: string; name: string }>;
}

export interface PlannerTask {
  id: string;
  title: string;
  description?: string;
  completed?: boolean;
  dueOn?: string;
  integrationId?: string;
  integrationName?: string;
  tags?: AsanaTag[];
  customFields?: AsanaCustomField[];
}

export interface EligibleTask extends PlannerTask {
  integrationId: string;
  containers: string[];
}

export interface AsanaStory {
  gid: string;
  text?: string;
  createdAt?: string;
  createdBy?: { name?: string };
}

export type ReportStatus = 'successful' | 'failed';

export interface ContainerReport {
  status: ReportStatus;
  summary: string;
  outputs: string[];
  next: string;
}

// Mirrors src/types DelegationQueueEntry (the worker never imports app code).
export type DelegationMode = 'now' | 'background';
export type DelegationState = 'queued' | 'running' | 'done' | 'failed';
// Wrapper binary name for the chosen Claude account (see config.resolveClaudeBin).
export type ClaudeAccount = 'claude-dbc' | 'claude-om';

export interface DelegationRunResult {
  status: ReportStatus;
  summary: string;
  outputs: string[];
  next: string;
  reportMarkdown: string;
  sessionId: string | null;
  traceFile: string | null;
  finishedAt: string;
}

export interface DelegationQueueEntry {
  asanaTaskGid: string;
  integrationId: string;
  title: string;
  brief: string;
  mode: DelegationMode;
  state: DelegationState;
  priority: number;
  claudeAccount?: ClaudeAccount; // account the run executes on; no default
  enqueuedAt: string;
  startedAt?: string;
  result?: DelegationRunResult;
  reviewedAt?: string; // set when the user has triaged this finished run
  updatedAt: string;
}

// Pacing budget read from the app's workflow-config (agentPacing section).
// Rate is tiered: maxRunsPerHour applies during activeHours, sleepMaxRunsPerHour
// (if set) applies outside it, with maxRunsPerDay as an overall backstop.
export interface AgentPacing {
  maxRunsPerHour: number;
  sleepMaxRunsPerHour?: number;
  maxRunsPerDay: number;
  activeHours?: { start: string; end: string };
}
