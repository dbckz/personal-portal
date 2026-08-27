// Core types for the daily planner app

// Weekly task board types (BoardStatus, BOARD_COLUMNS, BoardTaskState, BoardCard).
export * from './board';

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  source: 'google' | 'asana' | 'adhoc';
  color?: string;
  location?: string;
  allDay?: boolean;
  completed?: boolean;
  assignee?: string;
  dueOn?: string;
  startOn?: string;
  createdAt?: string;
  integrationId?: string;
  integrationName?: string;
  calendarId?: string;       // Google sub-calendar ID (for mutations)
  calendarName?: string;     // Display name of the sub-calendar
  recurringEventId?: string; // Set when this event is an instance of a recurring series
  attendeeCount?: number;    // Number of attendees on the event (separates meetings from solo blocks)
  // Google's own classification: 'default' | 'focusTime' | 'outOfOffice' |
  // 'workingLocation' | 'birthday' | 'fromGmail'. Used by time attribution to
  // keep calendar furniture and Gmail-derived reminders out of worked time.
  eventType?: string;
  // The current user's own RSVP response for this event ('accepted', 'declined',
  // 'tentative', 'needsAction'), taken from the attendee whose self flag is true.
  // Undefined when the user isn't in the attendee list (e.g. an event they own
  // with no other attendees) — treated as attending. A 'declined' event is shown
  // in the UI but ignored by scheduling (it doesn't block free time).
  selfResponseStatus?: string;
  // Google's "show me as" free/busy flag. 'transparent' = shown as FREE (does not
  // block the user's time); 'opaque' (or absent) = shown as BUSY. Scheduling
  // treats a 'transparent' external event as free time — EXCEPT app-created blocks,
  // which the planner deliberately writes transparent yet must still count as busy.
  transparency?: 'opaque' | 'transparent';
  // Asana-specific fields
  projects?: Array<{ gid: string; name: string }>;
  customFields?: AsanaCustomField[];
  tags?: AsanaTag[];
  parentTask?: { gid: string; name: string };
  // Link to Asana task (when Google event represents a scheduled Asana task)
  linkedAsanaTaskId?: string;
  linkedAsanaIntegrationId?: string;
}

export interface AsanaCustomField {
  gid: string;
  name: string;
  displayValue: string | null;
  type: string;
  enumValueGid?: string; // GID of the selected enum option (for enum fields)
  enumOptions?: Array<{ gid: string; name: string }>;
}

export interface AsanaTag {
  gid: string;
  name: string;
  color?: string | null;
}

// A tag carrying the workspace it came from, for pickers that aggregate tags
// across every enabled Asana integration (mirrors AsanaProject).
export interface AsanaTagWithIntegration extends AsanaTag {
  integrationId: string;
  integrationName: string;
}

export interface AsanaTask {
  id: string;
  gid: string;
  name: string;
  notes?: string;
  dueOn?: string;
  dueAt?: string;
  startOn?: string;
  createdAt?: string;
  completed: boolean;
  assignee?: {
    gid: string;
    name: string;
  };
  projects?: Array<{
    gid: string;
    name: string;
  }>;
  customFields?: AsanaCustomField[];
  tags?: AsanaTag[];
  parent?: {
    gid: string;
    name: string;
  };
}

export interface AsanaProject {
  gid: string;
  name: string;
  integrationId: string;
  integrationName: string;
  // ISO timestamp of the project's last modification (bumped by task activity).
  // Used to build the activity-filtered reminder-triage classifier catalogue.
  modifiedAt?: string;
}

export interface AsanaStory {
  gid: string;
  type: string;
  text: string;
  createdAt: string;
  createdBy?: {
    gid: string;
    name: string;
  };
  resourceSubtype: string;
}

export type AsanaDateFilter = 'all' | 'overdue' | 'today' | 'this_week' | 'no_date';

export type AsanaSortField = 'dueOn' | 'startOn' | 'createdAt' | 'title' | 'type';
export type AsanaSortDirection = 'asc' | 'desc';

export type AsanaFilterLogic = 'and' | 'or';

export type AsanaGroupBy = 'none' | 'type';

// Orchestrator worker status (written by workers/orchestrator, read via
// /api/orchestrator/status). Mirrors workers/orchestrator/status.ts.
export interface OrchestratorHistoryEntry {
  ranAt: string;
  taskGid: string | null;
  title: string | null;
  finalStatus: string;
  summary: string;
}

export interface OrchestratorStatus {
  lastRunAt: string | null;
  running: { pid: number; startedAt: string; heartbeatAt: string } | null;
  currentTask?: { gid: string; title: string };
  history: OrchestratorHistoryEntry[];
  // Usage-limit backoff: when the CLI reports it hit a limit, the pacer parses
  // the reset time and records it here so subsequent ticks skip until then.
  pausedUntil?: string | null;
}

// App-owned delegation queue (keyed by Asana task GID inside user-data.json).
// The app owns discovery (delegate = enqueue); the launchd pacer owns pacing
// (drain the queue at a sustainable rate). Asana agent_* tags are kept as
// decoration for visibility, but this queue is the protocol.
export type DelegationMode = 'now' | 'background';
export type DelegationState = 'queued' | 'running' | 'done' | 'failed';

// Which of the machine's two Claude Code accounts a delegated run executes on.
// The value is the wrapper binary name (see ~/bin/claude-dbc, ~/bin/claude-om);
// the runner resolves it to a path. There is no default — the user must pick
// one at delegation time, and the runner refuses to run an entry without it.
export type ClaudeAccount = 'claude-dbc' | 'claude-om';

// A comment a delegated agent wants to leave on the Asana task, held LOCALLY for
// Dave to review, edit, and either post or discard. Delegated runs never write
// to Asana directly — they only ever produce these drafts. A draft exists only
// while pending: posting or discarding removes it from the entry's array.
export interface DelegationDraftComment {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface DelegationRunResult {
  status: 'successful' | 'failed';
  summary: string;
  outputs: string[];
  next: string;
  reportMarkdown: string;   // full assistant result text
  sessionId: string | null; // for `claude --resume`
  traceFile: string | null; // basename of the per-run JSONL trace under AGENT_RUNS_DIR
  finishedAt: string;
}

export interface DelegationQueueEntry {
  asanaTaskGid: string;
  integrationId: string;
  title: string;
  brief: string;             // plain-English instruction (no magic syntax)
  mode: DelegationMode;
  state: DelegationState;
  priority: number;          // lower = sooner; default 0
  // Which Claude account the run executes on. Chosen at delegation time (no
  // default). Optional on the type only so legacy entries and skeleton bulk
  // enqueues remain representable — those are surfaced as "needs account" in
  // the UI and refused by the runner rather than guessed.
  claudeAccount?: ClaudeAccount;
  enqueuedAt: string;
  startedAt?: string;
  result?: DelegationRunResult;
  // Set when the user has triaged a finished run in the "For review" inbox
  // (Done / Needs human / Continue with AI). Persisted so a reviewed entry
  // stays out of the inbox across reloads. Cleared automatically when the
  // entry is re-queued so a fresh run re-enters the inbox.
  reviewedAt?: string;
  // Set only when the user EXPLICITLY returns a reviewed task to the AI-runnable
  // queue (its next step is AI-runnable again). Delegating a task otherwise
  // removes it from the AI-runnable queue permanently; this flag is the one way
  // back, and it is never set automatically. Cleared on any re-queue (a fresh
  // delegation run takes the task out of the queue again).
  returnedToAiAt?: string;
  // Pending comments a delegated run drafted for this task, awaiting Dave's
  // review. Absent/empty when there is nothing to review. Posting or discarding
  // a draft removes it from this array (see the delegation-queue storage
  // helpers). Runs never post to Asana directly — this is the only channel.
  draftComments?: DelegationDraftComment[];
  updatedAt: string;
}

export interface AsanaFilterState {
  integrationIds: string[];
  projectIds: string[];
  typeValues: string[]; // Custom field "Type" values
  dueDateRange: AsanaDateFilter;
  startDateRange: AsanaDateFilter;
  filterLogic: AsanaFilterLogic;
  sortField: AsanaSortField;
  sortDirection: AsanaSortDirection;
  groupBy: AsanaGroupBy;
  groupOrder: string[]; // Custom order of group names (when groupBy is active)
  expandedGroups: string[]; // Groups that are expanded (persisted across refresh)
}

// Built-in task types
export type BuiltInTaskType =
  | 'flight'
  | 'train'
  | 'car'
  | 'walk'
  | 'writing'
  | 'reading'
  | 'focus'
  | 'email'
  | 'batch';

// Custom task type created by user
export interface CustomTaskType {
  id: string;
  label: string;
  emoji: string;
  createdAt: string;
}

// TaskType can be either a built-in type or a custom type ID (prefixed with 'custom:')
export type TaskType = BuiltInTaskType | `custom:${string}`;

// Helper type for form state where task type might not be selected yet
export type TaskTypeSelection = TaskType | null;

export const BUILT_IN_TASK_TYPE_EMOJIS: Record<BuiltInTaskType, string> = {
  flight: '✈️',
  train: '🚂',
  car: '🚗',
  walk: '🚶',
  writing: '✍️',
  reading: '📖',
  focus: '🎯',
  email: '📧',
  batch: '📦',
};

export const BUILT_IN_TASK_TYPE_LABELS: Record<BuiltInTaskType, string> = {
  flight: 'Flight',
  train: 'Train',
  car: 'Car',
  walk: 'Walk',
  writing: 'Writing',
  reading: 'Reading',
  focus: 'Focus time',
  email: 'Email',
  batch: 'Batch',
};

// Helper functions to work with task types
export function isCustomTaskType(taskType: TaskType): taskType is `custom:${string}` {
  return taskType.startsWith('custom:');
}

export function getCustomTaskTypeId(taskType: `custom:${string}`): string {
  return taskType.slice(7); // Remove 'custom:' prefix
}

export interface AdHocTask {
  id: string;
  title: string;
  description?: string;
  dueDate?: string;
  dueTime?: string;
  duration?: number; // in minutes
  completed: boolean;
  priority: 'low' | 'medium' | 'high';
  taskType: TaskType;
  googleEventId?: string; // ID of the corresponding Google Calendar event
  googleIntegrationId?: string; // Which Google integration it was created in
  // The block's category captured at scheduling time (e.g. 'Writing/Deep Work'),
  // as chosen by the plan wizard / replan. Preferred over re-deriving from the
  // task's type signals. Optional for backward compatibility with tasks stored
  // before this field existed (those fall back to classification).
  category?: string;
  // Daily board rollover: when an unfinished dated task rolls to the next
  // working day, its ORIGINAL planned date is captured here on the first roll and
  // never overwritten, and `rolls` counts how many times it has rolled. Used to
  // badge the board card ("from Tue") without moving the Google Calendar event.
  originallyPlannedFor?: string; // yyyy-MM-dd
  rolls?: number;
  createdAt: string;
  updatedAt: string;
}

// Local schedule for Asana tasks (stored server-side in .data/user-data.json)
// Each entry represents one scheduled time block - same task can have multiple entries
export interface ScheduledAsanaTask {
  id: string; // Unique ID for this schedule entry
  asanaTaskId: string;
  integrationId?: string;
  scheduledDate: string; // yyyy-MM-dd
  scheduledTime: string; // HH:mm
  duration: number; // in minutes
  // Link to Google Calendar event (for unified display)
  googleEventId?: string;
  googleIntegrationId?: string;
  // The Asana task's name captured at scheduling time. Lets consumers (e.g. the
  // daily-review step) label a scheduled block even after the task has been
  // completed and dropped out of the live incomplete-tasks fetch. Optional for
  // backward compatibility with entries stored before this field existed.
  taskName?: string;
  // The block's category captured at scheduling time (e.g. 'Writing/Deep Work'),
  // as chosen by the plan wizard / replan. Consumers prefer this over
  // re-deriving the category from the Asana Type field, which can disagree with
  // what the user actually placed. Optional for backward compatibility with
  // entries stored before this field existed (those fall back to classification).
  category?: string;
  // Daily board rollover: when an unfinished scheduled task rolls to the next
  // working day, its ORIGINAL scheduled date is captured here on the first roll
  // and never overwritten, and `rolls` counts how many times it has rolled. Used
  // to badge the board card ("from Tue") without moving the Google Calendar event.
  originallyPlannedFor?: string; // yyyy-MM-dd
  rolls?: number;
}

export interface GoogleCalendarCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface AsanaCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

// Multi-integration types (v2)
export interface IntegrationBase {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
}

export interface GoogleSubCalendar {
  id: string;          // e.g., 'primary', 'family123@group.calendar.google.com'
  summary: string;     // Display name, e.g., "Joneses"
  backgroundColor: string;  // e.g., '#7986cb'
  selected: boolean;   // Whether user wants to fetch events from this calendar
}

export interface GoogleIntegration extends IntegrationBase {
  type: 'google';
  clientId: string;
  clientSecret: string;
  credentials?: GoogleCalendarCredentials;
  calendars?: GoogleSubCalendar[];  // undefined means legacy = fetch only 'primary'
}

export interface AsanaIntegration extends IntegrationBase {
  type: 'asana';
  clientId: string;
  clientSecret: string;
  credentials?: AsanaCredentials;
  workspaceId?: string;
  // Optional event-routing overrides for calendar events created from this
  // Asana integration's tasks. When `eventGoogleIntegrationId` is set, the
  // planner creates those tasks' events on that Google integration's primary
  // calendar (instead of the default first-enabled one); `eventTransparency`
  // controls the event's availability (default 'opaque' = busy).
  eventGoogleIntegrationId?: string;
  eventTransparency?: 'opaque' | 'transparent';
}

export type Integration = GoogleIntegration | AsanaIntegration;

export interface MultiIntegrationSettings {
  version: 2;
  googleIntegrations: GoogleIntegration[];
  asanaIntegrations: AsanaIntegration[];
}

// Drag and drop types
export interface DragItem {
  type: 'asana-task' | 'adhoc-task' | 'calendar-event' | 'task-template';
  id: string;
  source: 'asana' | 'adhoc' | 'google' | 'template';
  title: string;
  duration?: number; // in minutes, for calendar events
  taskType?: TaskType; // for templates
  priority?: 'low' | 'medium' | 'high'; // for templates
}

// API Response types for proper typing
export interface ApiError {
  error: string;
}

// Calendar API responses
export type CalendarEventResponse = CalendarEvent & {
  integrationId: string;
  integrationName: string;
};

export type CalendarEventsResponse = CalendarEventResponse[];

// Cache types
export interface CacheMetadata {
  version: number;
  lastUpdated: string;
}

export interface GoogleCalendarCache {
  events: CalendarEvent[];
  metadata: CacheMetadata;
}

export interface AsanaTasksCache {
  allTasks: CalendarEvent[];
  scheduledTasks: ScheduledAsanaTask[];
  metadata: CacheMetadata;
}

// Settings API response (sanitized, no secrets)
export interface SettingsResponse {
  googleIntegrations: Array<{
    id: string;
    name: string;
    enabled: boolean;
    connected: boolean;
    calendars?: GoogleSubCalendar[];
  }>;
  asanaIntegrations: Array<{
    id: string;
    name: string;
    enabled: boolean;
    connected: boolean;
    eventGoogleIntegrationId?: string;
    eventTransparency?: 'opaque' | 'transparent';
  }>;
}

// Toast notification types
export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

// Frequently used task templates - can be dragged multiple times as templates
export interface TaskTemplate {
  id: string;
  title: string;
  description?: string;
  duration: number; // default duration in minutes
  priority: 'low' | 'medium' | 'high';
  taskType: TaskType;
  group?: string; // group name for organization
  createdAt: string;
}

// Reminder checklist item
export interface Reminder {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
  // Optional free-text notes carried from the underlying Google Task.
  notes?: string;
  // Optional due date (yyyy-MM-dd) carried from the underlying Google Task.
  due?: string;
}

// Groups for organizing task templates
export interface TemplateGroup {
  id: string;
  name: string;
  order: number;
}

// Enrichment metadata attached to an Asana task (keyed by task GID).
// Used for ranking in the Command Center and, later, for auto-scheduling.
export type EnergyLevel = 'high' | 'medium' | 'low';
export type DeadlineType = 'hard' | 'soft' | 'aspirational';
export type BestTime = 'morning' | 'afternoon' | 'evening';

export interface TaskMetadata {
  asanaTaskGid: string;
  integrationId: string;
  energyLevel?: EnergyLevel;
  aiDelegable?: boolean;
  deadlineType?: DeadlineType;
  bestTime?: BestTime;
  effortMinutes?: number;
  dependsOn?: string[]; // GIDs of tasks this depends on
  // Backlog grooming: a groomed task has been reviewed (worth doing, concrete
  // next action, realistic due date, Type set). Ungroomed tasks form the backlog.
  // This state lives only here, never in Asana.
  groomed?: boolean;
  groomedAt?: string; // ISO timestamp of when it was last marked groomed
  // Portal-done ("waiting on others"): Dave's work on the task is finished, but
  // the task can't be completed in Asana yet (awaiting someone else — e.g. a
  // written piece awaiting publication). A portal-done task is dropped from the
  // planner's candidate pool and surfaced in the "Waiting on others" widget /
  // end-of-week review instead. Like `groomed`, this state lives ONLY here,
  // never in Asana. The title is snapshotted at flag time so the widget renders
  // without an Asana fetch.
  portalDone?: boolean;
  portalDoneAt?: string; // ISO timestamp of when it was last flagged portal-done
  portalDoneTitle?: string; // task title captured when it was flagged
  updatedAt: string;
}

// Cached AI-suitability verdict for a task (keyed by Asana GID). Lets the
// "Re-assess AI-runnable" action skip tasks whose content and the classifier
// prompt are both unchanged since the last run.
// Dave's own verdict on whether a task is AI-runnable, keyed by Asana GID.
// Recorded when he rejects a claim in the assessment review, and it BEATS the
// AI classifier from then on (same precedence idea as meetingPrepDecisions): a
// re-assessment can never re-claim a task he has already said no to.
// --- Weekly stats (durable analysis record) ---------------------------------
//
// One record per planned week, keyed by its Monday. This is the app's LONG-TERM
// memory: it is written at the moments that change it (plan confirm, replan
// confirm, daily-review apply, time-tracking updates) and is NEVER rebuilt from
// live Asana/Google state, so a completed week stays readable years later even
// after the week is reset, the tasks are purged, or the calendar is cleared.
//
// Design rules, so a future reader can trust the numbers:
//  * `tasks` is a HIGH-WATER MARK: an entry is added the first time a task is
//    scheduled into the week and is NEVER removed. Carrying or dropping a task
//    changes its `outcome`, not its presence — that is what makes end-of-week
//    over-scheduling visible ("you planned 14, finished 6").
//  * Only outcome 'done' counts as completed. 'started' (worked on but not
//    finished), 'carried', 'unscheduled' and 'dropped' are explicitly NOT
//    completed — a started task still has to be finished, so it stays in the
//    not-done pool for replan and carry-over. The progress display shows started
//    separately so partial progress on a long task is visible rather than
//    reading as a total miss.
//  * 'unscheduled' means: planned this week, then left without a slot — still
//    open, no longer on the calendar. Distinct from 'carried' (explicitly parked
//    for next week) and 'dropped' (deleted on purpose), but counted alongside
//    'carried' in the summaries since both mean planned-but-not-done-and-open.
//  * Per-category totals are DERIVED from `tasks` (see summariseWeek) rather
//    than stored, so the counters can never drift from the task list.
//  * Times are per integration per day, so a week's OM/DBC split can be
//    recovered without the (rolling) time-tracking file.
export type WeeklyTaskOutcomeKind =
  | 'scheduled'
  | 'started'
  | 'done'
  | 'carried'
  | 'unscheduled'
  | 'dropped'
  // Dave finished his part but the task waits on someone else to close in Asana
  // (see TaskMetadata.portalDone). Not done — it stays out of the completed
  // count — but no longer scheduled or carried.
  | 'portalDone';

export interface WeeklyTaskOutcome {
  taskId: string; // Asana gid or ad-hoc id
  title?: string;
  category: string;
  integrationId?: string;
  scheduledAt: string; // ISO — when it first entered this week's plan
  outcome: WeeklyTaskOutcomeKind;
  outcomeAt?: string; // ISO — when the outcome last changed
  // Minutes of calendar time this task's block reserved when it was scheduled
  // (a grouped block's time split evenly across its members). Estimate-vs-actual
  // evidence for block-size calibration. Absent on records written before this
  // was tracked — those contribute no sizing evidence, nothing more.
  scheduledMinutes?: number;
}

export interface WeeklyStatsIntegrationDay {
  date: string; // yyyy-MM-dd
  minutesScheduled: number;
  minutesWorked: number;
  // Worked minutes split by work category (Meetings / Writing/Deep Work /
  // Emails / …), overlap-deduped so the segments sum to minutesWorked. Absent on
  // records written before category tracking existed — treat as "unsplit".
  byCategory?: Record<string, number>;
}

export interface WeeklyStatsRecord {
  weekStart: string; // yyyy-MM-dd Monday — the record key
  createdAt: string;
  updatedAt: string;
  tasks: Record<string, WeeklyTaskOutcome>; // keyed by taskId
  integrations: Record<
    string, // Asana integration id
    { integrationName: string; days: Record<string, WeeklyStatsIntegrationDay> }
  >;
  // Working days in this week spent out of office (yyyy-MM-dd), read off the
  // calendar. Without it a holiday week reads as a collapse in output; with it
  // the low numbers are explained. Written by the reconcile, which also REMOVES
  // a date whose OOO event has since been deleted. Absent on records written
  // before this was tracked — which means "not known", not "was in the office".
  outOfOfficeDays?: string[];
}

// A DURABLE attribution override for calendar events, matched by recurring
// series or by exact title. Per-event googleEventAttributions can't help with a
// recurring meeting (every instance has its own id, and a new instance appears
// every week), so a rule attributes the whole series once and keeps working
// through reconcile and future instances.
export interface EventAttributionRule {
  id: string;
  // Match on the recurring series id where the fetch provides one (most precise),
  // and/or on the exact event title (case- and space-insensitive). A rule needs
  // at least one of the two.
  recurringEventId?: string;
  title?: string;
  // The Asana workspace this event's time belongs to, or 'none' to force it to
  // count toward NOTHING (personal time on a work calendar).
  asanaIntegrationId: string | 'none';
  note?: string;
  createdAt: string;
}

export interface AiUserVerdict {
  aiSuitable: boolean;
  decidedAt: string; // ISO timestamp
}

export interface AiClassificationEntry {
  contentHash: string;   // fingerprint of title+description at assessment time
  promptVersion: string; // version of the classifier prompt used
  aiSuitable: boolean;
  reason: string;
  assessedAt: string;
}

// Cached staleness verdict for a task (keyed by Asana GID) — feeds the
// "Triage stale" review. Cached by content hash + prompt version like above.
export interface StaleClassificationEntry {
  contentHash: string;
  promptVersion: string;
  stale: boolean;
  reason: string;
  assessedAt: string;
}

// Remembered "does this meeting need a prep block?" decision, keyed by a
// normalized meeting title. User decisions are permanent; AI decisions carry a
// content hash + prompt version so they can be re-used or re-assessed.
export interface MeetingPrepDecision {
  needsPrep: boolean;
  decidedBy: 'user' | 'ai';
  contentHash?: string;  // ai entries only — cache key
  promptVersion?: string;
  updatedAt: string;
}
