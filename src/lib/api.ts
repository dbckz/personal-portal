// API utilities with retry logic and proper typing

import { EventAttributionRule } from '@/types';
import { AdHocTask, ApiError, AsanaFilterState, AsanaProject, AsanaStory, AsanaTag, AsanaTagWithIntegration, BoardStatus, BoardTaskState, CalendarEvent, CalendarEventResponse, CalendarEventsResponse, ClaudeAccount, CustomTaskType, DelegationDraftComment, DelegationQueueEntry, GoogleSubCalendar, OrchestratorStatus, Reminder, ScheduledAsanaTask, SettingsResponse, TaskMetadata, TaskTemplate, WeeklyTaskOutcomeKind } from '@/types';
import type { PrepBlock, RitualBlock } from '@/lib/storage/core';
import type { WeeklyProgressRow, UnscheduledTask } from '@/lib/weekly-stats';
import type { ProposedBlock } from '@/lib/scheduling/types';
import type { ReplanKept, ReplanMove, ReplanUnplaceable, ReplanStale, ReplanDeletion, ReplanRemoval, ReplanConversion, ReplanReviewBlock, ReplanCarryBlock, ReplanFreeSlot } from '@/lib/scheduling/replan';
import type {
  ReviewAdoptInput,
  ReviewReplacementInput,
  ReviewStartedInput,
} from '@/lib/scheduling/daily-review';
import type { AiClaim } from '@/lib/ai-verdicts';
import type { WorkflowConfig } from '@/lib/workflow-config-storage';
import type {
  ExerciseAnalysis,
  ExerciseEntry,
  ExerciseSession,
  WeeklyRoutineDay,
  Goal,
  GoalCheckIn,
  GoalCheckInStatus,
  GoalPeriodKind,
  GoalStatus,
  GoalWithProgress,
  Scorecard,
} from '@/types/life';
import type {
  Experiment,
  ExperimentStatus,
  ExperimentVerdict,
  HabitLog,
  WellbeingAnalysis,
  WellbeingDay,
} from '@/types/wellbeing';
import type { GoalNudge } from '@/lib/goal-progress';
import type { InferredEvidence, InferredGoal } from '@/lib/goal-inference';
import type { ExerciseProgression } from '@/lib/exercise-progression';
import type { FreeformDraft } from '@/lib/exercise-freeform';
import type { ExerciseTarget } from '@/lib/exercise-targets';
import type { DelegationStats } from '@/lib/delegation-stats';
import type { ProjectScan } from '@/lib/projects/scan';
import type { ProjectSummary } from '@/lib/projects/summarise';
import type { CalendarReminderCandidate } from '@/lib/scheduling/calendar-reminders';

export interface ProjectWithSummary extends ProjectScan {
  summary: ProjectSummary | null;
}

export interface QuotaSummaryRow {
  category: string;
  weeklyCount: number;
  existing: number;
  proposed: number;
  unmet: number;
}

// Usable free work time left in the remaining week after a plan is proposed.
export interface SpareCapacityRow {
  date: string; // yyyy-MM-dd
  freeMinutes: number;
}

export interface SpareCapacity {
  totalMinutes: number;
  gapCount: number;
  largestGapMinutes: number;
  byDate: SpareCapacityRow[];
}

// A real task the engine could place nowhere this week (not even evening
// overflow) — i.e. no free gap long enough remains in working hours. The review
// step lists these so an unscheduled must-do comes with an explanation.
export interface UnplaceableTaskRow {
  id: string; // gid or adhocId
  title: string;
  category: string;
}

export interface ProposeWeekResponse {
  weekStart: string;
  weekEnd: string;
  proposals: ProposedBlock[];
  quotaSummary: QuotaSummaryRow[];
  // Absent on older responses; the review step shows a spare-capacity line and
  // an "Add more tasks" affordance when present.
  spareCapacity?: SpareCapacity;
  // Working days (yyyy-MM-dd) with no exercise placement in the final proposals
  // or an existing calendar exercise event. The review step warns per day.
  exerciseMissingDays?: string[];
  // Real tasks that couldn't be scheduled anywhere. Absent on older responses —
  // treat as []. The review step uses it to explain WHY an unplaced (e.g.
  // must-do) task couldn't be placed.
  unplaceable?: UnplaceableTaskRow[];
  // Remaining working days of the plan window (yyyy-MM-dd, out-of-office days
  // already excluded). The review step's evening-overflow rows use these as the
  // per-row day-picker options. Absent on older responses.
  workingDays?: string[];
}

export interface ConfirmWeekResult {
  id: string;
  success: boolean;
  googleEventId?: string;
  error?: string;
}

// --- "Plan my week" wizard: priorities, prep and task-candidate shapes ---

export interface ProposeWeekRequest {
  weekStart?: string;
  selections?: Record<string, string[]>; // category -> selected candidate ids
  priorityGids?: string[];
  // Task ids (gid or adhocId) flagged "must do this week". Marked isPriority on
  // the engine's candidates so they sort first within their category and are
  // never dropped by a selection cap.
  mustDoIds?: string[];
  categoryOverrides?: Record<string, string>; // candidate id -> category
  prepBlocks?: ProposedBlock[];
  durationOverrides?: Record<string, number>; // grouped category -> per-week block length (mins)
  taskDurationOverrides?: Record<string, number>; // task id (gid/adhocId) -> block length (mins)
  // Days (yyyy-MM-dd) the user opted a 🚶 walk into, from the wizard's Walks row.
  // Absent/empty → no walks are scheduled (walks are opt-in per day).
  walkDays?: string[];
  // Per-day work location (yyyy-MM-dd → where Dave is that day), from the wizard's
  // Location step. Office days get a get-ready + commute pair (and cap deep work);
  // travel days get a fixed travel block. A missing entry (or 'home') = home.
  dayLocations?: Record<string, WizardDayLocation>;
}

// Where Dave is on a working day, chosen in the wizard's Location step. Mirrors
// DayLocation in scheduling/rituals.ts.
export interface WizardDayLocation {
  type: 'home' | 'office' | 'travel';
  destination?: string;
  departTime?: string; // "HH:mm"
  travelMinutes?: number;
}

export interface PriorityMatchRow {
  text: string;
  match: { gid: string; title: string; integrationId: string; category: string | null } | null;
}

export interface MatchPrioritiesResponse {
  results: PriorityMatchRow[];
  asanaIntegrations: Array<{ id: string; name: string }>;
  categories: string[];
  aiUnavailable?: boolean;
}

export interface CreatePriorityTasksResponse {
  created: Array<{ text: string; gid: string; title: string; integrationId: string }>;
  errors: Array<{ text: string; error: string }>;
}

export interface PrepMeetingRow {
  key: string;
  eventId: string;
  title: string;
  date: string;
  start: string;
  needsPrep: boolean;
  decidedBy: 'user' | 'ai';
  reason: string;
  // True when the meeting is on an early day of NEXT week (its prep block is
  // scheduled into this week). The UI labels these "next Mon"/"next Tue". Absent
  // on older responses — treat as false.
  nextWeek?: boolean;
  block?: ProposedBlock;
}

export interface PrepCandidatesResponse {
  meetings: PrepMeetingRow[];
  // Each unplaced meeting carries a short human reason (e.g. "meeting is today —
  // no free slot left before it starts"), rendered after the title.
  unplaced: Array<{ key: string; title: string; reason: string }>;
  // Working days (yyyy-MM-dd) of the remaining week, for the per-meeting prep-day
  // dropdown. Absent on older responses.
  workingDays?: string[];
}

export interface WeekCandidate {
  id: string;
  gid?: string;
  // Asana integration id (present for Asana-backed tasks). Needed to mark the
  // task done in Asana from the wizard.
  integrationId?: string;
  // Display name of the Asana integration/workspace this task comes from (e.g.
  // "DBC" / "OM"). Present for Asana-backed tasks; absent for ad-hoc tasks.
  integrationName?: string;
  title: string;
  dueDate?: string;
  deadlineType?: string;
  isPriority: boolean;
  // Set when the user carried this task out of an EARLIER week at that week's
  // end-of-week review. The wizard badges it and floats it up its category.
  carriedOver?: boolean;
  carriedFromWeek?: string; // yyyy-MM-dd Monday of the week it was carried out of
  // Consecutive end-of-week carries (1 = carried once).
  carryStreak?: number;
  // Flagged "must do next week" in the end-of-week review: the wizard pre-ticks
  // it and a selection cap can never drop it.
  mustDo?: boolean;
}

export interface WeekCandidateCategory {
  category: string;
  // No-quota catch-all categories (e.g. "General Todos") have no weekly cap:
  // noQuota is true and remainingQuota is null — pick any number of candidates.
  noQuota: boolean;
  // Grouped categories (e.g. Engagement / Outreach) also lift the selection cap
  // (remainingQuota is null); their picked tasks are spread across fixed blocks.
  grouped?: boolean;
  // True when the category has an explicit maxSelection cap. Unlike a plain
  // grouped/no-quota category, this cap is enforced even in "Add more tasks"
  // mode (the cap is never lifted), and remainingQuota carries the cap value.
  hasMaxSelection?: boolean;
  remainingQuota: number | null;
  // Count of this category's tasks currently deferred to a later week (shown as
  // a muted "N deferred to next week" note on the wizard's tasks step).
  deferredCount?: number;
  autoSelect: boolean;
  // Category's configured target block length in minutes (parsed from the
  // workflow config's targetLength). Used as the default for the per-week
  // block-length override on the tasks step.
  targetLengthMinutes: number;
  // Evidence-based calibration from recent weeks (see calibrateQuotas). Present
  // only when there is any history for the category; the wizard shows the quota
  // line only when weeksOfData ≥ 3 and the block hint only when blockSamples ≥ 5.
  // Purely informational — nothing here is auto-applied.
  calibration?: {
    weeksOfData: number;
    avgCompletionRate: number; // 0..1
    currentQuota: number;
    suggestedQuota?: number;
    reason?: string;
    blockSamples: number;
    suggestedBlockMinutes?: number;
    blockReason?: string;
  };
  candidates: WeekCandidate[];
}

export interface WeekCandidatesResponse {
  categories: WeekCandidateCategory[];
}

// What the dashboard's single adaptive planning button should do next.
export type { AiClaim } from '@/lib/ai-verdicts';

export interface WeekStateResponse {
  action: 'plan-this-week' | 'replan' | 'wrap-up' | 'plan-next-week' | 'replan-next-week';
  weekStart: string; // yyyy-MM-dd Monday of the current week
  nextWeekStart: string; // yyyy-MM-dd Monday of next week
  currentWeekPlanned: boolean;
  nextWeekPlanned: boolean;
  endOfWeek: boolean;
  endOfWeekReviewDone: boolean;
  hasReviewableBlocks: boolean;
  // The configured working days (default Mon–Fri), so the client can gate the
  // wrap-up nudge to working days only.
  workingDays?: string[];
}

export interface ConfirmWeekResponse {
  results: ConfirmWeekResult[];
}

// --- Mid-week replan ---

// A displaceable app block scheduled tomorrow, offered as a bump target for the
// "prioritise tomorrow" option on an unplaceable block.
export interface ReplanTomorrowBlock {
  googleEventId: string;
  googleIntegrationId?: string;
  category: string;
  titles: string[];
  date: string;
  start: string;
  durationMinutes: number;
  taskIds: string[];
}

// A displaceable app block anywhere in the remaining week, offered as a bump
// target for the "Make room" option on a couldn't-fit / stale-prep card. Extends
// the tomorrow block with `startMs`, so the client can apply the "before HH:mm"
// and "ends before the meeting" constraints.
export interface ReplanMoveCandidate extends ReplanTomorrowBlock {
  startMs: number;
}

// One unscheduled General-Todos candidate the user can tick to fill a free slot.
export interface ReplanTodoCandidate {
  gid?: string;
  adhocId?: string;
  title: string;
  integrationId?: string;
  category: string;
}

// One portal-done ("waiting on others") task, for the dashboard widget.
export interface WaitingTask {
  gid: string;
  integrationId: string;
  title: string;
  portalDoneAt?: string; // ISO — when it was flagged
}

// The local stores the weekly task board needs for a week (see GET /api/board).
// Live Asana tasks + task metadata are fetched separately and combined with
// this via buildBoardCards.
export interface BoardResponse {
  weekStart: string; // yyyy-MM-dd Monday (the requested date normalised)
  states: Record<string, BoardTaskState>;
  ritualBlocks: RitualBlock[]; // this week's ritual blocks (lib excludes furniture)
  prepBlocks: PrepBlock[]; // this week's meeting-prep blocks
  scheduledAsanaTasks: ScheduledAsanaTask[]; // this week's scheduled Asana blocks
  adHocTasks: AdHocTask[]; // all ad-hoc tasks (lib decides inclusion per week)
  portalDoneGids: string[]; // gids flagged portal-done → Waiting
  // This week's weekly-stats outcomes, keyed by taskId (gid or adhoc id), with
  // the durable title/category snapshot for cards dropped from the live fetch.
  weeklyOutcomes: Record<string, { outcome: WeeklyTaskOutcomeKind; category?: string; title?: string }>;
  blockDoneGoogleEventIds: string[]; // event ids marked done-for-planning → Done
}

// One portal-done ("waiting on others") task surfaced in the end-of-week review.
export interface ReplanWaitingTask {
  gid: string;
  integrationId: string;
  title: string;
  portalDoneAt?: string; // ISO — when it was flagged
}

export interface ReplanAnalyzeResponse {
  weekStart: string;
  weekEnd: string;
  kept: ReplanKept[];
  moves: ReplanMove[];
  unplaceable: ReplanUnplaceable[];
  stale: ReplanStale[];
  // Missing rituals to add on remaining working days (exercise is priority one).
  additions: ProposedBlock[];
  // Additional task blocks proposed into the remaining week's free time (the slots
  // freed by removed rituals included) to fill each category's unmet weekly quota.
  // Absent on older responses — treat as [].
  backfill?: ProposedBlock[];
  // Free working-hours slots left after everything else is placed, for the user to
  // fill by ticking General Todos himself. Absent on older responses — treat as [].
  freeSlots?: ReplanFreeSlot[];
  // The unscheduled General-Todos pool the user picks from to fill `freeSlots`. The
  // planner never auto-picks these. Absent on older responses — treat as [].
  todoCandidates?: ReplanTodoCandidate[];
  // Conflicted break blocks to delete (a break has no fixed home to move to).
  deletions: ReplanDeletion[];
  // Future ritual blocks to remove: retired rituals (Side projects / Learning /
  // Consulting) and mis-placed 🎰 New bookies blocks. Absent on older responses.
  removals?: ReplanRemoval[];
  // Legacy single-task deep-work blocks to convert in place to generic "Deep work"
  // containers. Absent on older responses — treat as [].
  conversions?: ReplanConversion[];
  // Whether an evening-overflow window exists this week. When true but an
  // unplaceable block has no overflowOption, the window filled up. Absent on
  // older responses — treat as false.
  overflowConfigured?: boolean;
  // App blocks scheduled tomorrow that can be displaced to make room for a
  // prioritised block. Absent on older responses — treat as [].
  tomorrowBlocks?: ReplanTomorrowBlock[];
  // App blocks across the remaining week that can be displaced to make room for a
  // couldn't-fit / stale-prep block ("Make room"). Absent on older responses —
  // treat as []. Superset of tomorrowBlocks (which is its tomorrow-only subset).
  moveCandidates?: ReplanMoveCandidate[];
  // Past app blocks (task/prep) for the daily-review step. Absent on older
  // responses — treat as [].
  reviewBlocks?: ReplanReviewBlock[];
  // True on the last working day of the week (or the weekend after it): there is
  // no week left to reschedule into, so the review offers carry-over decisions
  // instead. Absent on older responses — treat as false.
  endOfWeek?: boolean;
  // Unfinished, task-backed blocks to carry over / drop / mark done. Present only
  // in end-of-week mode; never contains ritual or meeting-prep blocks.
  carryBlocks?: ReplanCarryBlock[];
  // Portal-done tasks ("waiting on others") to review at end of week: complete in
  // Asana too, leave waiting, or reopen. Present only in end-of-week mode.
  waiting?: ReplanWaitingTask[];
  // Catch-up context for the review's subtitle. Absent on older responses.
  review?: {
    // Effective review-window start (ISO). Null when this is a first-ever review
    // (no prior completed review to look back from).
    sinceIso: string | null;
    // Configured working days missed since the last review (weekends and
    // out-of-office days excluded) — 0 when nothing was missed.
    missedWorkingDays: number;
    // True when the 7-day lookback cap bit (last review older than a week), so
    // the copy reads as a fresh start over the recent window rather than a
    // backlog.
    clamped: boolean;
  };
}

export interface ReplanConfirmResult {
  googleEventId: string;
  success: boolean;
  error?: string;
}

// One Asana-completion result from the daily-review apply (keyed by task gid).
export interface ReplanAsanaResult {
  gid: string;
  success: boolean;
  error?: string;
}

// One defer / leave-unscheduled result for an unplaceable block.
export interface ReplanDeferResult {
  taskIds: string[];
  googleEventId?: string;
  success: boolean;
  error?: string;
}

// One end-of-week carry-over result, keyed by the block's Google event id.
export interface ReplanCarryResult {
  blockId?: string;
  taskIds: string[];
  success: boolean;
  error?: string;
}

// One displaced-victim result from a "prioritise tomorrow" apply: the victim's
// calendar event was removed and its tasks deferred / left unscheduled.
export interface ReplanDisplaceResult {
  googleEventId: string;
  success: boolean;
  error?: string;
}

// A created ritual addition, reported back by its proposal id.
export interface ReplanAdditionResult {
  id: string;
  success: boolean;
  googleEventId?: string;
  error?: string;
}

// A created task-backfill block, reported back by its proposal id.
export interface ReplanBackfillResult {
  id: string;
  success: boolean;
  googleEventId?: string;
  error?: string;
}

export interface ResetWeekResponse {
  eventsDeleted: number;
  recordsCleared: number;
}

export interface ClientTimeRow {
  integrationId: string;
  integrationName: string;
  totalMinutes: number;
}

export interface DashboardCapacityResponse {
  weekStart: string;
  weekEnd: string;
  // Task-level progress for the planned week: X done of Y tasks scheduled into
  // the week (Y is a high-water mark — see WeeklyStatsRecord).
  weekProgress: WeeklyProgressRow[];
  // False before the week has been planned (nothing recorded against it yet).
  weekPlanned: boolean;
  clientTime: ClientTimeRow[];
  // Minutes worked this week per Asana integration, for the header line.
  weekWorkedByIntegration?: ClientTimeRow[];
}

// The dashboard's "Left unscheduled" widget: tasks planned into this week that
// then slid out of the schedule (deferred / carried).
export interface UnscheduledTasksResponse {
  weekStart: string;
  tasks: UnscheduledTask[];
}

interface RetryOptions {
  maxRetries?: number;
  retryDelay?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  retryDelay: 1000,
  shouldRetry: (error, attempt) => {
    // Retry on network errors or 5xx server errors
    if (error instanceof TypeError) return true; // Network error
    if (error instanceof ApiRequestError) {
      return error.status >= 500 && attempt < 3;
    }
    return false;
  },
};

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: ApiError
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry<T>(
  url: string,
  options?: RequestInit,
  retryOptions?: RetryOptions
): Promise<T> {
  const { maxRetries, retryDelay, shouldRetry } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...retryOptions,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new ApiRequestError(
          data.error || `Request failed with status ${response.status}`,
          response.status,
          data
        );
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      // Don't retry on auth errors (401, 403)
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
        throw error;
      }

      if (attempt < maxRetries && shouldRetry(error, attempt)) {
        await delay(retryDelay * (attempt + 1)); // Exponential backoff
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

export const api = {
  async getCalendarEvents(date: Date): Promise<CalendarEventsResponse> {
    return fetchWithRetry<CalendarEventsResponse>(
      `/api/calendar?date=${date.toISOString()}`
    );
  },

  async createCalendarEvent(
    integrationId: string,
    title: string,
    startTime: Date,
    endTime: Date,
    description?: string,
    eventType?: 'default' | 'focusTime',
    calendarId?: string,
    options?: {
      allDay?: boolean;
      recurrence?: string[];
      transparency?: 'opaque' | 'transparent';
    }
  ): Promise<CalendarEventResponse> {
    return fetchWithRetry<CalendarEventResponse>('/api/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integrationId,
        title,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        description,
        eventType,
        calendarId,
        allDay: options?.allDay,
        recurrence: options?.recurrence,
        transparency: options?.transparency,
      }),
    });
  },

  async updateCalendarEvent(
    eventId: string,
    integrationId: string,
    startTime: Date,
    endTime: Date,
    title?: string,
    description?: string,
    calendarId?: string,
    colorId?: string
  ): Promise<CalendarEventResponse> {
    return fetchWithRetry<CalendarEventResponse>('/api/calendar', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        integrationId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        title,
        description,
        calendarId,
        colorId,
      }),
    });
  },

  async deleteCalendarEvent(
    eventId: string,
    integrationId: string,
    calendarId?: string
  ): Promise<{ success: true }> {
    return fetchWithRetry<{ success: true }>('/api/calendar', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, integrationId, calendarId }),
    });
  },

  async getAllAsanaTasks(): Promise<CalendarEventsResponse> {
    return fetchWithRetry<CalendarEventsResponse>('/api/asana-tasks/all');
  },

  async completeAsanaTask(
    taskId: string,
    integrationId: string,
    completed: boolean
  ): Promise<{ success: true; completed: boolean }> {
    return fetchWithRetry<{ success: true; completed: boolean }>(
      `/api/asana-tasks/${taskId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed, integrationId }),
      }
    );
  },

  async addAsanaComment(
    taskId: string,
    integrationId: string,
    comment: string,
    htmlText?: string
  ): Promise<{ success: true }> {
    return fetchWithRetry<{ success: true }>(
      `/api/asana-tasks/${taskId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment, htmlText, integrationId }),
      }
    );
  },

  async deleteAsanaTask(
    taskId: string,
    integrationId: string
  ): Promise<{ success: true }> {
    return fetchWithRetry<{ success: true }>(
      `/api/asana-tasks/${taskId}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId }),
      }
    );
  },

  async getTaskStories(
    taskId: string,
    integrationId: string
  ): Promise<{ stories: AsanaStory[] }> {
    return fetchWithRetry<{ stories: AsanaStory[] }>(
      `/api/asana-tasks/${taskId}?integrationId=${encodeURIComponent(integrationId)}`
    );
  },

  async createAsanaTask(
    integrationId: string,
    name: string,
    options?: {
      notes?: string;
      dueOn?: string;
      projectGid?: string;
      customFields?: Record<string, string>; // fieldGid -> enumOptionGid
      localType?: string; // Type label for a local-only workspace; set server-side against the new task's gid
    }
  ): Promise<{ success: true; task: CalendarEventResponse }> {
    return fetchWithRetry<{ success: true; task: CalendarEventResponse }>(
      '/api/asana-tasks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId,
          name,
          ...options,
        }),
      }
    );
  },

  async updateAsanaTask(
    taskId: string,
    integrationId: string,
    updates: {
      name?: string;
      notes?: string;
      dueOn?: string | null;
      startOn?: string | null;
      customFields?: Record<string, string | null>;
      addProjects?: string[];
      removeProjects?: string[];
      addTags?: string[];
      removeTags?: string[];
    }
  ): Promise<{ success: true; task: CalendarEventResponse }> {
    return fetchWithRetry<{ success: true; task: CalendarEventResponse }>(
      `/api/asana-tasks/${taskId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId,
          ...updates,
        }),
      }
    );
  },

  async getAsanaProjects(): Promise<{ projects: AsanaProject[] }> {
    return fetchWithRetry<{ projects: AsanaProject[] }>('/api/asana-projects');
  },

  // Local "Type" store for tasks whose Asana workspace has no writable Type
  // field (e.g. DBC). Read the full { taskGid: label } map.
  async getLocalTaskTypes(): Promise<{ types: Record<string, string> }> {
    return fetchWithRetry<{ types: Record<string, string> }>('/api/local-task-types');
  },

  // Merge local Type associations (null deletes a task's local type). Returns the
  // merged map. Never touches Asana.
  async setLocalTaskTypes(
    updates: Record<string, string | null>
  ): Promise<{ types: Record<string, string> }> {
    return fetchWithRetry<{ types: Record<string, string> }>('/api/local-task-types', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });
  },

  // Tags across every enabled Asana workspace, each tagged with its origin.
  async getAsanaTags(): Promise<{ tags: AsanaTagWithIntegration[] }> {
    return fetchWithRetry<{ tags: AsanaTagWithIntegration[] }>('/api/asana-tags');
  },

  // Calendar-category suggestions for the goal editor's datalist (autocomplete
  // only — free text still resolves).
  async getGoalCategories(): Promise<{ categories: string[] }> {
    return fetchWithRetry<{ categories: string[] }>('/api/goals/categories');
  },

  async createAsanaTag(integrationId: string, name: string, color?: string): Promise<AsanaTag> {
    return fetchWithRetry<AsanaTag>('/api/asana-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ integrationId, name, color }),
    });
  },

  async getOrchestratorStatus(): Promise<OrchestratorStatus> {
    return fetchWithRetry<OrchestratorStatus>('/api/orchestrator/status');
  },

  // Delegation queue (app-owned, keyed by Asana task GID)
  async getDelegationQueue(): Promise<{ entries: Record<string, DelegationQueueEntry> }> {
    return fetchWithRetry<{ entries: Record<string, DelegationQueueEntry> }>('/api/orchestrator/queue');
  },

  async upsertDelegationEntry(
    asanaTaskGid: string,
    integrationId: string,
    updates: Partial<Omit<DelegationQueueEntry, 'asanaTaskGid' | 'integrationId' | 'updatedAt'>>
  ): Promise<{ entry: DelegationQueueEntry }> {
    return fetchWithRetry<{ entry: DelegationQueueEntry }>('/api/orchestrator/queue', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asanaTaskGid, integrationId, ...updates }),
    });
  },

  // Mark a finished run as reviewed (persists reviewedAt), so it leaves the
  // "For review" inbox and stays out across reloads.
  async markDelegationReviewed(
    asanaTaskGid: string,
    integrationId: string
  ): Promise<{ entry: DelegationQueueEntry }> {
    return fetchWithRetry<{ entry: DelegationQueueEntry }>('/api/orchestrator/queue', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asanaTaskGid,
        integrationId,
        reviewedAt: new Date().toISOString(),
      }),
    });
  },

  // Explicitly return a delegated task to the AI-runnable queue. Stamps
  // returnedToAiAt (which lifts the AI-runnable exclusion) and settles
  // reviewedAt so the entry also leaves the "For review" inbox. Pass the
  // entry's existing reviewedAt to preserve it; otherwise it is stamped now.
  async returnDelegationToAiQueue(
    asanaTaskGid: string,
    integrationId: string,
    reviewedAt?: string
  ): Promise<{ entry: DelegationQueueEntry }> {
    const now = new Date().toISOString();
    return fetchWithRetry<{ entry: DelegationQueueEntry }>('/api/orchestrator/queue', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asanaTaskGid,
        integrationId,
        reviewedAt: reviewedAt ?? now,
        returnedToAiAt: now,
      }),
    });
  },

  // Draft comments a delegated run left for review (stored on the delegation
  // entry; never posted to Asana until the user posts them here).
  async updateDraftComment(
    asanaTaskGid: string,
    draftId: string,
    text: string
  ): Promise<{ draft: DelegationDraftComment }> {
    return fetchWithRetry<{ draft: DelegationDraftComment }>(
      `/api/delegation/${encodeURIComponent(asanaTaskGid)}/draft-comments/${encodeURIComponent(draftId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }
    );
  },

  async discardDraftComment(asanaTaskGid: string, draftId: string): Promise<{ success: boolean }> {
    return fetchWithRetry<{ success: boolean }>(
      `/api/delegation/${encodeURIComponent(asanaTaskGid)}/draft-comments/${encodeURIComponent(draftId)}`,
      { method: 'DELETE' }
    );
  },

  // Post a draft to Asana (optionally with the latest edited text) then remove it.
  async postDraftComment(
    asanaTaskGid: string,
    draftId: string,
    text?: string
  ): Promise<{ success: boolean; integration?: { id: string; name: string } }> {
    return fetchWithRetry(
      `/api/delegation/${encodeURIComponent(asanaTaskGid)}/draft-comments/${encodeURIComponent(draftId)}/post`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(text !== undefined ? { text } : {}),
      },
      { maxRetries: 0 }
    );
  },

  async deleteDelegationEntry(asanaTaskGid: string): Promise<{ success: boolean }> {
    return fetchWithRetry<{ success: boolean }>(
      `/api/orchestrator/queue?asanaTaskGid=${encodeURIComponent(asanaTaskGid)}`,
      { method: 'DELETE' }
    );
  },

  async runNowDelegation(
    asanaTaskGid: string,
    integrationId: string,
    brief: string,
    title: string,
    claudeAccount: ClaudeAccount
  ): Promise<{ started: boolean }> {
    return fetchWithRetry<{ started: boolean }>('/api/orchestrator/run-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asanaTaskGid, integrationId, brief, title, claudeAccount }),
    });
  },

  async getDelegationTrace(file: string): Promise<{ events: unknown[] }> {
    return fetchWithRetry<{ events: unknown[] }>(
      `/api/orchestrator/trace?file=${encodeURIComponent(file)}`
    );
  },

  // Re-assess which tasks are AI-runnable. Cached tasks are skipped server-side;
  // only changed/new ones hit the model. No retry — the call is expensive.
  async classifyAiTasks(
    tasks: Array<{
      gid: string;
      integrationId: string;
      title: string;
      description?: string;
      integrationName?: string;
      dueOn?: string;
    }>,
    // 'review' holds new AI-runnable claims back for confirmation and returns
    // them in `claims`; omit (or 'apply') for the original apply-immediately
    // behaviour used by any non-interactive caller.
    mode?: 'apply' | 'review'
  ): Promise<{
    total: number;
    assessed: number;
    cached: number;
    changed: number;
    claims?: AiClaim[];
    promptVersion: string;
  }> {
    return fetchWithRetry(
      '/api/tasks/classify-ai',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks, ...(mode ? { mode } : {}) }),
      },
      { maxRetries: 0 }
    );
  },

  // Apply the AI-runnable review: accepted claims join the list, rejected ones
  // get a standing "not AI-runnable" verdict that outranks future assessments.
  async applyAiVerdicts(
    accept: Array<{ gid: string; integrationId: string }>,
    reject: Array<{ gid: string; integrationId: string }>
  ): Promise<{ accepted: number; rejected: number }> {
    return fetchWithRetry(
      '/api/tasks/ai-verdicts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept, reject }),
      },
      { maxRetries: 0 }
    );
  },

  // Triage which tasks look stale (deletion candidates). Cached/snoozed tasks are
  // skipped server-side. No retry — the call is expensive.
  async triageStaleTasks(
    tasks: Array<{ gid: string; integrationId: string; title: string; description?: string; createdAt?: string; dueOn?: string; startOn?: string; integrationName?: string }>
  ): Promise<{ total: number; assessed: number; staleTasks: Array<{ gid: string; reason: string }> }> {
    return fetchWithRetry(
      '/api/tasks/triage-stale',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks }),
      },
      { maxRetries: 0 }
    );
  },

  // Suggest a "Type" label for each untyped task, grouped by integration (allowed
  // labels differ per workspace). Returns one suggestion per task, each an exact
  // allowed label. No retry — the call is expensive.
  async classifyTaskTypes(
    groups: Array<{
      integrationId: string;
      allowedTypes: string[];
      tasks: Array<{ gid: string; title: string; description?: string; integrationName?: string }>;
    }>
  ): Promise<{ suggestions: Array<{ gid: string; type: string }> }> {
    return fetchWithRetry(
      '/api/tasks/classify-types',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups }),
      },
      { maxRetries: 0 }
    );
  },

  // Record the Type labels the user decided in the wizard's type step (keyed by
  // task title server-side), so the Type classifier can learn his own decisions.
  // Best-effort — a failure must never block applying the types.
  async recordTypeVerdicts(
    verdicts: Array<{ title: string; type: string; override?: boolean }>
  ): Promise<{ recorded: number }> {
    return fetchWithRetry(
      '/api/tasks/type-verdicts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdicts }),
      },
      { maxRetries: 0 }
    );
  },

  // Wizard "Reminders triage" step: suggest a destination Asana workspace/project/
  // type for each reminder, in ONE headless call. Returns ids/gids the dropdowns
  // use (blank where nothing valid fit). No retry — the call is expensive.
  async suggestReminderTriage(
    reminders: Array<{ id: string; title: string; notes?: string }>,
    workspaces: Array<{
      integrationId: string;
      name: string;
      projects: Array<{ gid: string; name: string }>;
      types: string[];
    }>
  ): Promise<{ suggestions: Array<{ id: string; action: 'keep' | 'convert'; integrationId: string; projectGid: string; taskType: string }> }> {
    return fetchWithRetry(
      '/api/reminders/triage/suggest',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminders, workspaces }),
      },
      { maxRetries: 0 }
    );
  },

  // Record the keep/convert decisions the user confirmed in the reminders step
  // (keyed by reminder title server-side), so the triage classifier can learn his
  // own calls. Best-effort — must never block applying the reminders.
  async recordReminderVerdicts(
    verdicts: Array<{
      title: string;
      action: 'keep' | 'convert';
      integrationId?: string;
      projectGid?: string;
      taskType?: string;
    }>
  ): Promise<{ recorded: number }> {
    return fetchWithRetry(
      '/api/reminders/triage/verdicts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdicts }),
      },
      { maxRetries: 0 }
    );
  },

  // "Keep active": snooze a task out of the stale list for a period (default 90 days).
  async keepTaskActive(asanaTaskGid: string, days?: number): Promise<{ success: boolean; keptUntil: string }> {
    return fetchWithRetry('/api/tasks/stale-keep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asanaTaskGid, ...(days ? { days } : {}) }),
    });
  },

  async getSettings(): Promise<SettingsResponse> {
    return fetchWithRetry<SettingsResponse>('/api/settings');
  },

  async getWorkflowConfig(): Promise<WorkflowConfig> {
    const { config } = await fetchWithRetry<{ config: WorkflowConfig }>('/api/workflow-config');
    return config;
  },

  async getTaskTemplates(): Promise<{ templates: TaskTemplate[] }> {
    return fetchWithRetry<{ templates: TaskTemplate[] }>('/api/user-data/task-templates');
  },

  async addTaskTemplate(template: Omit<TaskTemplate, 'id' | 'createdAt'>): Promise<{ template: TaskTemplate }> {
    return fetchWithRetry<{ template: TaskTemplate }>('/api/user-data/task-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(template),
    });
  },

  async updateTaskTemplate(id: string, updates: Partial<TaskTemplate>): Promise<{ template: TaskTemplate }> {
    return fetchWithRetry<{ template: TaskTemplate }>('/api/user-data/task-templates', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...updates }),
    });
  },

  async deleteTaskTemplate(id: string): Promise<{ success: true }> {
    return fetchWithRetry<{ success: true }>('/api/user-data/task-templates', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  },

  async getCustomTaskTypes(): Promise<{ customTypes: CustomTaskType[] }> {
    return fetchWithRetry<{ customTypes: CustomTaskType[] }>('/api/user-data/custom-task-types');
  },

  async addCustomTaskType(customType: Omit<CustomTaskType, 'id' | 'createdAt'>): Promise<{ customType: CustomTaskType }> {
    return fetchWithRetry<{ customType: CustomTaskType }>('/api/user-data/custom-task-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(customType),
    });
  },

  async deleteCustomTaskType(id: string): Promise<{ success: true }> {
    return fetchWithRetry<{ success: true }>('/api/user-data/custom-task-types', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  },

  async getAdHocTasks(): Promise<{ tasks: AdHocTask[] }> {
    return fetchWithRetry<{ tasks: AdHocTask[] }>('/api/user-data/adhoc-tasks');
  },

  async addAdHocTask(task: Omit<AdHocTask, 'id' | 'createdAt' | 'updatedAt'>): Promise<{ task: AdHocTask }> {
    return fetchWithRetry<{ task: AdHocTask }>('/api/user-data/adhoc-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
    });
  },

  async updateAdHocTask(id: string, updates: Partial<AdHocTask>): Promise<{ task: AdHocTask }> {
    return fetchWithRetry<{ task: AdHocTask }>('/api/user-data/adhoc-tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...updates }),
    });
  },

  async deleteAdHocTask(id: string): Promise<{ success: true }> {
    return fetchWithRetry<{ success: true }>('/api/user-data/adhoc-tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  },

  async getScheduledAsanaTasks(date?: string): Promise<{ tasks: ScheduledAsanaTask[] }> {
    const url = date
      ? `/api/user-data/scheduled-asana-tasks?date=${encodeURIComponent(date)}`
      : '/api/user-data/scheduled-asana-tasks';
    return fetchWithRetry<{ tasks: ScheduledAsanaTask[] }>(url);
  },

  async getScheduleByGoogleEventId(googleEventId: string): Promise<{ schedule: ScheduledAsanaTask | null }> {
    return fetchWithRetry<{ schedule: ScheduledAsanaTask | null }>(
      `/api/user-data/scheduled-asana-tasks?googleEventId=${encodeURIComponent(googleEventId)}`
    );
  },

  async scheduleAsanaTask(
    asanaTaskId: string,
    integrationId: string | undefined,
    scheduledDate: string,
    scheduledTime: string,
    duration: number,
    googleEventId?: string,
    googleIntegrationId?: string,
    taskName?: string
  ): Promise<{ scheduled: ScheduledAsanaTask }> {
    return fetchWithRetry<{ scheduled: ScheduledAsanaTask }>('/api/user-data/scheduled-asana-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asanaTaskId,
        integrationId,
        scheduledDate,
        scheduledTime,
        duration,
        googleEventId,
        googleIntegrationId,
        taskName,
      }),
    });
  },

  async updateScheduledAsanaTask(id: string, updates: Partial<ScheduledAsanaTask>): Promise<{ schedule: ScheduledAsanaTask }> {
    return fetchWithRetry<{ schedule: ScheduledAsanaTask }>('/api/user-data/scheduled-asana-tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...updates }),
    });
  },

  async updateScheduledAsanaTaskByGoogleEvent(googleEventId: string, updates: Partial<ScheduledAsanaTask>): Promise<{ schedule: ScheduledAsanaTask }> {
    return fetchWithRetry<{ schedule: ScheduledAsanaTask }>('/api/user-data/scheduled-asana-tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ googleEventId, ...updates }),
    });
  },

  async unscheduleAsanaTask(id: string): Promise<{ success: true }> {
    return fetchWithRetry<{ success: true }>('/api/user-data/scheduled-asana-tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  },

  async unscheduleAllAsanaTaskInstances(asanaTaskId: string): Promise<{ success: true; removedCount: number }> {
    return fetchWithRetry<{ success: true; removedCount: number }>('/api/user-data/scheduled-asana-tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asanaTaskId, all: true }),
    });
  },

  // Settle a single member of a grouped/batch block from the desktop drill-down
  // dialog: 'done' completes the task and records a 'done' weekly outcome;
  // 'remove' takes it out of the block (task returns to the backlog unscheduled)
  // and records an 'unscheduled' outcome — the same recording paths a review uses.
  async updateBlockMember(
    action: 'done' | 'remove' | 'portalDone' | 'reopenPortalDone',
    member: {
      source: 'asana' | 'adhoc';
      taskId: string;
      gid?: string;
      integrationId?: string;
      scheduleId?: string;
      adhocId?: string;
      title?: string;
    }
  ): Promise<{ success: true }> {
    return fetchWithRetry<{ success: true }>(
      '/api/scheduling/block-member',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, member }),
      },
      { maxRetries: 0 }
    );
  },

  async getAsanaFilterPreferences(integrationId?: string): Promise<{ filters: AsanaFilterState }> {
    const url = integrationId
      ? `/api/user-data/asana-filters?integrationId=${encodeURIComponent(integrationId)}`
      : '/api/user-data/asana-filters?integrationId=default';
    return fetchWithRetry<{ filters: AsanaFilterState }>(url);
  },

  async getAllAsanaFilterPreferences(): Promise<{ filtersMap: Record<string, AsanaFilterState> }> {
    return fetchWithRetry<{ filtersMap: Record<string, AsanaFilterState> }>('/api/user-data/asana-filters');
  },

  async saveAsanaFilterPreferences(filters: AsanaFilterState, integrationId?: string): Promise<{ success: true; filters: AsanaFilterState; integrationId?: string }> {
    return fetchWithRetry<{ success: true; filters: AsanaFilterState; integrationId?: string }>('/api/user-data/asana-filters', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters, integrationId }),
    });
  },

  // Google Event Attributions (for time tracking)
  async getGoogleEventAttributions(): Promise<{ attributions: Array<{ googleEventId: string; googleIntegrationId: string; asanaIntegrationId: string; createdAt: string }> }> {
    return fetchWithRetry('/api/user-data/google-event-attributions');
  },

  async setGoogleEventAttribution(
    googleEventId: string,
    googleIntegrationId: string,
    asanaIntegrationId: string
  ): Promise<{ success: boolean; attribution: { googleEventId: string; googleIntegrationId: string; asanaIntegrationId: string; createdAt: string } }> {
    return fetchWithRetry('/api/user-data/google-event-attributions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ googleEventId, googleIntegrationId, asanaIntegrationId }),
    });
  },

  async removeGoogleEventAttribution(googleEventId: string): Promise<{ success: boolean; removed: boolean }> {
    return fetchWithRetry('/api/user-data/google-event-attributions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ googleEventId }),
    });
  },

  // Reminders
  async getReminders(): Promise<{ reminders: Reminder[] }> {
    return fetchWithRetry<{ reminders: Reminder[] }>('/api/user-data/reminders');
  },

  async addReminder(text: string): Promise<{ reminder: Reminder }> {
    return fetchWithRetry<{ reminder: Reminder }>('/api/user-data/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  },

  async updateReminder(id: string, updates: Partial<Reminder>): Promise<{ reminder: Reminder }> {
    return fetchWithRetry<{ reminder: Reminder }>('/api/user-data/reminders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...updates }),
    });
  },

  async deleteReminder(id: string): Promise<{ success: true }> {
    return fetchWithRetry<{ success: true }>('/api/user-data/reminders', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  },

  async archiveReminders(): Promise<{ success: true; archivedCount: number }> {
    return fetchWithRetry<{ success: true; archivedCount: number }>('/api/user-data/reminders/archive', {
      method: 'POST',
    });
  },

  // Google sub-calendar management
  async getGoogleCalendars(integrationId: string): Promise<{ calendars: GoogleSubCalendar[] }> {
    return fetchWithRetry<{ calendars: GoogleSubCalendar[] }>(
      `/api/google-calendars?integrationId=${encodeURIComponent(integrationId)}`
    );
  },

  async saveGoogleCalendars(integrationId: string, calendars: GoogleSubCalendar[]): Promise<{ success: true; calendars: GoogleSubCalendar[] }> {
    return fetchWithRetry<{ success: true; calendars: GoogleSubCalendar[] }>('/api/google-calendars', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ integrationId, calendars }),
    });
  },

  // Time tracking API
  async recordTimeTracking(
    date: string,
    integrationTotals: Record<string, { integrationId: string; integrationName: string; totalMinutes: number }>,
    events: Array<{
      eventId: string;
      title: string;
      integrationId: string;
      integrationName: string;
      startTime: string;
      endTime: string;
      durationMinutes: number;
      source: 'google' | 'asana';
      linkedAsanaTaskId?: string;
    }>,
    // Minutes actually worked so far today per integration (the elapsed part of
    // each attributed event). `integrationTotals` stays the FULL scheduled
    // minutes, so the long-running time-tracking file keeps its meaning; this
    // extra map is what the durable weekly record stores as "worked".
    workedMinutesByIntegration?: Record<string, number>,
    // Worked minutes split by work category, keyed by integration then category.
    // Feeds the Analysis page's category-stacked bars.
    workedByCategory?: Record<string, Record<string, number>>
  ): Promise<{ success: boolean }> {
    return fetchWithRetry<{ success: boolean }>('/api/time-tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date,
        integrationTotals,
        events,
        workedMinutesByIntegration,
        workedByCategory,
      }),
    });
  },

  // Rebuild past days' time records from the calendar (retro-edits). `auto` is
  // debounced server-side; a manual press should omit it.
  async reconcileTimeFromCalendar(options?: { days?: number; auto?: boolean }): Promise<{
    days: number;
    updated: number;
    skipped: string[];
    lastSyncedAt: string;
    debounced?: boolean;
  }> {
    return fetchWithRetry(
      '/api/time-tracking/reconcile',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options ?? {}),
      },
      { maxRetries: 0 }
    );
  },

  // Task metadata (enrichment layer, keyed by Asana task GID)
  async getTaskMetadata(): Promise<{ metadata: Record<string, TaskMetadata> }> {
    return fetchWithRetry<{ metadata: Record<string, TaskMetadata> }>('/api/user-data/task-metadata');
  },

  // The "Waiting on others" list: tasks flagged portal-done (finished, awaiting
  // someone else to close in Asana), newest first.
  async getWaitingTasks(): Promise<{ tasks: WaitingTask[] }> {
    return fetchWithRetry<{ tasks: WaitingTask[] }>('/api/dashboard/waiting');
  },

  async upsertTaskMetadata(
    asanaTaskGid: string,
    integrationId: string,
    updates: Partial<Omit<TaskMetadata, 'asanaTaskGid' | 'integrationId' | 'updatedAt'>>
  ): Promise<{ metadata: TaskMetadata }> {
    return fetchWithRetry<{ metadata: TaskMetadata }>('/api/user-data/task-metadata', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asanaTaskGid, integrationId, ...updates }),
    });
  },

  // Weekly task board: the local stores for a week (normalised to its Monday).
  async getBoard(weekStart?: string): Promise<BoardResponse> {
    const url = weekStart
      ? `/api/board?weekStart=${encodeURIComponent(weekStart)}`
      : '/api/board';
    return fetchWithRetry<BoardResponse>(url);
  },

  // Weekly task board: upsert one card's status. Dumb persistence only — status
  // side effects (complete in Asana, flag portal-done) are done via the other
  // api methods in useBoard.
  async setBoardStatus(args: {
    stateKey: string;
    key: string;
    status: BoardStatus;
    weekStart?: string;
    title?: string;
    typeLabel?: string;
    integrationId?: string;
  }): Promise<{ state: BoardTaskState }> {
    return fetchWithRetry<{ state: BoardTaskState }>('/api/board/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  },

  // Backlog grooming: one-off bootstrap that marks already-in-flight tasks groomed.
  async bootstrapGrooming(): Promise<{ total: number; groomed: number; backlog: number; marked: number }> {
    return fetchWithRetry('/api/grooming/bootstrap', { method: 'POST' }, { maxRetries: 0 });
  },

  // Dashboard capacity + client-time for the current ISO week
  async getDashboardCapacity(): Promise<DashboardCapacityResponse> {
    return fetchWithRetry<DashboardCapacityResponse>('/api/dashboard/capacity');
  },

  // Tasks planned into this week that then slid out of the schedule, for the
  // dashboard's "Left unscheduled" widget.
  async getUnscheduledTasks(): Promise<UnscheduledTasksResponse> {
    return fetchWithRetry<UnscheduledTasksResponse>('/api/dashboard/unscheduled');
  },

  // "Plan my week" auto-scheduling. Empty body reproduces the original
  // auto-pick-everything behavior; the wizard passes selections/prep/priorities.
  async proposeWeeklyPlan(body?: ProposeWeekRequest): Promise<ProposeWeekResponse> {
    return fetchWithRetry<ProposeWeekResponse>('/api/scheduling/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  },

  // Wizard step 1: match typed priorities against existing Asana tasks.
  async matchPriorities(items: string[], weekStart?: string): Promise<MatchPrioritiesResponse> {
    return fetchWithRetry<MatchPrioritiesResponse>(
      '/api/scheduling/priorities/match',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, ...(weekStart ? { weekStart } : {}) }),
      },
      { maxRetries: 0 }
    );
  },

  // Wizard step 1: create Asana tasks for unmatched priorities.
  async createPriorityTasks(
    items: Array<{ text: string; integrationId: string; projectGid?: string }>
  ): Promise<CreatePriorityTasksResponse> {
    return fetchWithRetry<CreatePriorityTasksResponse>('/api/scheduling/priorities/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
  },

  // Wizard step 3: mark an Asana task complete without leaving the planner.
  async completeAsanaTaskInWizard(gid: string, integrationId: string): Promise<{ success: true }> {
    return fetchWithRetry<{ success: true }>(
      '/api/asana/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gid, integrationId }),
      },
      { maxRetries: 0 }
    );
  },

  // Wizard step 2: which meetings need prep, with proposed slots.
  async getPrepCandidates(
    weekStart?: string,
    prepDurations?: Record<string, number>,
    prepDays?: Record<string, string>
  ): Promise<PrepCandidatesResponse> {
    return fetchWithRetry<PrepCandidatesResponse>(
      '/api/scheduling/prep/candidates',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(weekStart ? { weekStart } : {}),
          ...(prepDurations && Object.keys(prepDurations).length ? { prepDurations } : {}),
          ...(prepDays && Object.keys(prepDays).length ? { prepDays } : {}),
        }),
      },
      { maxRetries: 0 }
    );
  },

  // Wizard step 2: persist a user's prep decision for a meeting title.
  async setPrepDecision(title: string, needsPrep: boolean): Promise<{ ok: true }> {
    return fetchWithRetry<{ ok: true }>('/api/scheduling/prep/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, needsPrep }),
    });
  },

  // Wizard step 3: ranked task candidates per quota category.
  async getWeekCandidates(body?: {
    weekStart?: string;
    priorityGids?: string[];
    categoryOverrides?: Record<string, string>;
  }): Promise<WeekCandidatesResponse> {
    return fetchWithRetry<WeekCandidatesResponse>('/api/scheduling/candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  },

  async confirmWeeklyPlan(
    proposals: ProposedBlock[],
    googleIntegrationId?: string,
    // The week being planned (yyyy-MM-dd Monday). Sent so the server's
    // slot-conflict pre-flight checks the RIGHT week when the wizard is planning
    // next week rather than this one.
    weekStart?: string
  ): Promise<ConfirmWeekResponse> {
    return fetchWithRetry<ConfirmWeekResponse>('/api/scheduling/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposals, googleIntegrationId, ...(weekStart ? { weekStart } : {}) }),
    });
  },

  // Side-project repos with recent activity and a one-line summary each.
  async getProjects(options: { includeDormant?: boolean; refresh?: boolean } = {}): Promise<{
    projects: ProjectWithSummary[];
    dormantCount: number;
  }> {
    const params = new URLSearchParams();
    if (options.includeDormant) params.set('includeDormant', '1');
    if (options.refresh) params.set('refresh', '1');
    return fetchWithRetry(`/api/projects?${params.toString()}`);
  },

  // Delegation run stats, computed from the orchestrator's own run traces.
  async getDelegationStats(): Promise<{ stats: DelegationStats }> {
    return fetchWithRetry<{ stats: DelegationStats }>('/api/orchestrator/stats');
  },

  async getAttributionRules(): Promise<{ rules: EventAttributionRule[] }> {
    return fetchWithRetry<{ rules: EventAttributionRule[] }>('/api/attribution-rules');
  },

  // Standing reminders parked on the calendar for a week (daily recurring
  // events that nag rather than occupy time).
  async getCalendarReminders(weekStart?: string): Promise<{ candidates: CalendarReminderCandidate[] }> {
    const params = new URLSearchParams();
    if (weekStart) params.set('weekStart', weekStart);
    return fetchWithRetry<{ candidates: CalendarReminderCandidate[] }>(
      `/api/scheduling/calendar-reminders?${params.toString()}`
    );
  },

  async getWeekState(): Promise<WeekStateResponse> {
    return fetchWithRetry<WeekStateResponse>('/api/scheduling/week-state', { method: 'GET' });
  },

  // Mid-week replan: analyze which of this week's app blocks were missed or now
  // conflict, and propose new slots for them.
  async analyzeReplan(weekStart?: string): Promise<ReplanAnalyzeResponse> {
    return fetchWithRetry<ReplanAnalyzeResponse>(
      '/api/scheduling/replan/analyze',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(weekStart ? { weekStart } : {}),
      },
      { maxRetries: 0 }
    );
  },

  // Daily review: stamp the review as completed now, so the next review only
  // covers blocks that finished after this moment. `confirmedTitles` are the bare
  // calendar-event titles the user reviewed (not dismissed), recorded as implicit
  // "this IS a task" verdicts so the classifier learns his confirmations.
  async completeDailyReview(confirmedTitles: string[] = []): Promise<{ lastReviewedAt: string }> {
    return fetchWithRetry<{ lastReviewedAt: string }>(
      '/api/scheduling/daily-review/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmedTitles.length > 0 ? { confirmedTitles } : {}),
      },
      { maxRetries: 0 }
    );
  },

  // Daily review: dismiss a bare calendar-event title as "not a task" so it
  // never resurfaces in the review.
  async dismissReviewTitle(title: string): Promise<{ ok: boolean }> {
    return fetchWithRetry<{ ok: boolean }>(
      '/api/scheduling/daily-review/dismiss',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
      { maxRetries: 0 }
    );
  },

  // Mid-week replan: apply the accepted moves (patch each Google event's time +
  // update the stored schedule) and/or mark selected blocks "done".
  async confirmReplan(
    moves: Array<{
      googleEventId: string;
      googleIntegrationId?: string;
      date: string;
      start: string;
      durationMinutes: number;
    }>,
    done?: string[],
    dismiss?: string[],
    additions?: ProposedBlock[],
    deletions?: Array<{ googleEventId: string; googleIntegrationId?: string }>,
    // Daily-review extras: mark blocks not-done (clears done state so they
    // re-classify as missed) and complete selected Asana tasks in Asana.
    notDone?: string[],
    completeAsana?: Array<{ gid: string; integrationId: string }>,
    // Unplaceable-block choices: defer each block's tasks to next week (until is
    // computed server-side), or leave a block unscheduled (clear its override).
    defer?: Array<{ taskIds: string[]; googleEventId?: string }>,
    leaveUnscheduled?: string[],
    // Daily-review adoptions: not-done bare calendar events to turn into local
    // records so the replan step can re-slot them.
    adopt?: ReviewAdoptInput[],
    // "Prioritise tomorrow" victims: each block's calendar event is removed and
    // its tasks deferred to next week ('defer') or left unscheduled ('leave'),
    // freeing tomorrow's slot for the prioritised block (sent as a normal move).
    displace?: Array<{
      googleEventId: string;
      googleIntegrationId?: string;
      taskIds: string[];
      mode: 'defer' | 'leave';
      // The victim's slot length and the prioritised block it must accommodate,
      // so the server can reject a victim too short to hold the prioritised block.
      durationMinutes: number;
      priorityDurationMinutes: number;
    }>,
    // End-of-week carry-overs: each entry marks a block's chosen tasks as carried
    // into next week's plan (and defers them past the weekend), or — with
    // quiet:true — quietly returns them to the backlog with no badge.
    carry?: Array<{ blockId?: string; blockIds?: string[]; taskIds: string[]; quiet?: boolean }>,
    // Daily-review outcomes: blocks worked on but not finished, and the
    // "what were you doing instead" answers for blocks that didn't happen.
    started?: ReviewStartedInput[],
    replacements?: ReviewReplacementInput[],
    // End-of-week escalation: hand a carried, AI-runnable task to an agent
    // instead of carrying it. Writes no carry-over marker.
    delegate?: Array<{
      blockId?: string;
      gid: string;
      integrationId: string;
      title?: string;
      brief?: string;
    }>,
    // Unplaceable blocks the user chose to DELETE outright ("I'm not doing this at
    // all"): the server removes the calendar block, clears its local records,
    // deletes each backing Asana task, and records a 'dropped' weekly outcome.
    drop?: Array<{ googleEventId: string; googleIntegrationId?: string; taskIds: string[] }>,
    // Task-backfill blocks the user accepted: each is created as a task/reserved/
    // grouped calendar event + scheduling records, exactly like a weekly-plan block.
    backfill?: ProposedBlock[],
    // Legacy single-task deep-work blocks to convert in place to generic "Deep
    // work" containers: the event is retitled + re-described and the stored record
    // becomes container membership. The slot never changes.
    conversions?: Array<{
      googleEventId: string;
      googleIntegrationId?: string;
      category: string;
      date: string;
      start: string;
      durationMinutes: number;
      tasks: Array<{ gid?: string; adhocId?: string; title: string; integrationId?: string }>;
    }>,
    // "Done (waiting on others)" from the couldn't-fit section: flag each task
    // portal-done (Asana untouched) and settle its block so it stops nagging.
    portalDone?: Array<{ gid: string; integrationId: string; title?: string; googleEventId?: string }>,
    // End-of-week "waiting on others" decisions that clear the flag: 'complete'
    // (paired with a completeAsana entry) sends no outcome; 'reopen' sends
    // outcome 'scheduled' so the planner schedules the task again.
    clearPortalDone?: Array<{ gid: string; integrationId: string; outcome?: WeeklyTaskOutcomeKind }>
  ): Promise<{
    results: ReplanConfirmResult[];
    doneResults: ReplanConfirmResult[];
    notDoneResults?: ReplanConfirmResult[];
    asanaResults?: ReplanAsanaResult[];
    adoptResults?: ReplanConfirmResult[];
    deferResults?: ReplanDeferResult[];
    carryResults?: ReplanCarryResult[];
    displaceResults?: ReplanDisplaceResult[];
    dropResults?: ReplanConfirmResult[];
    portalDoneResults?: Array<{ gid: string; googleEventId?: string; success: boolean; error?: string }>;
    clearPortalDoneResults?: Array<{ gid: string; success: boolean; error?: string }>;
    additionResults: ReplanAdditionResult[];
    backfillResults?: ReplanBackfillResult[];
    conversionResults?: ReplanConfirmResult[];
  }> {
    return fetchWithRetry<{
      results: ReplanConfirmResult[];
      doneResults: ReplanConfirmResult[];
      notDoneResults?: ReplanConfirmResult[];
      asanaResults?: ReplanAsanaResult[];
      adoptResults?: ReplanConfirmResult[];
      deferResults?: ReplanDeferResult[];
      carryResults?: ReplanCarryResult[];
      displaceResults?: ReplanDisplaceResult[];
      dropResults?: ReplanConfirmResult[];
      portalDoneResults?: Array<{ gid: string; googleEventId?: string; success: boolean; error?: string }>;
      clearPortalDoneResults?: Array<{ gid: string; success: boolean; error?: string }>;
      additionResults: ReplanAdditionResult[];
      backfillResults?: ReplanBackfillResult[];
      conversionResults?: ReplanConfirmResult[];
    }>(
      '/api/scheduling/replan/confirm',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moves,
          ...(done && done.length ? { done } : {}),
          ...(notDone && notDone.length ? { notDone } : {}),
          ...(completeAsana && completeAsana.length ? { completeAsana } : {}),
          ...(adopt && adopt.length ? { adopt } : {}),
          ...(defer && defer.length ? { defer } : {}),
          ...(leaveUnscheduled && leaveUnscheduled.length ? { leaveUnscheduled } : {}),
          ...(displace && displace.length ? { displace } : {}),
          ...(carry && carry.length ? { carry } : {}),
          ...(started && started.length ? { started } : {}),
          ...(replacements && replacements.length ? { replacements } : {}),
          ...(delegate && delegate.length ? { delegate } : {}),
          ...(drop && drop.length ? { drop } : {}),
          ...(portalDone && portalDone.length ? { portalDone } : {}),
          ...(clearPortalDone && clearPortalDone.length ? { clearPortalDone } : {}),
          ...(dismiss && dismiss.length ? { dismiss } : {}),
          ...(additions && additions.length ? { additions } : {}),
          ...(backfill && backfill.length ? { backfill } : {}),
          ...(deletions && deletions.length ? { deletions } : {}),
          ...(conversions && conversions.length ? { conversions } : {}),
        }),
      }
    );
  },

  // Daily-review closing message: a short, warm reflection on how the day went.
  // Best-effort — the route always returns a message (model or canned fallback),
  // and the UI shows it without blocking the review apply. No retry.
  async getReviewMessage(outcome: {
    doneCount: number;
    totalCount: number;
    doneTitles: string[];
    notDoneTitles: string[];
  }): Promise<{ message: string }> {
    return fetchWithRetry<{ message: string }>(
      '/api/scheduling/replan/review-message',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(outcome),
      },
      { maxRetries: 0 }
    );
  },

  // "Start the week from scratch": delete this week's upcoming app-created blocks
  // from the calendar and clear the week's planning records.
  async resetWeek(weekStart?: string): Promise<ResetWeekResponse> {
    return fetchWithRetry<ResetWeekResponse>(
      '/api/scheduling/reset-week',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(weekStart ? { weekStart } : {}),
      },
      { maxRetries: 0 }
    );
  },

  // --- Goals (monthly / quarterly, across every life section) ---------------

  // `withProgress` resolves evidence sources and pacing; leave it off for
  // pickers that only need titles.
  async getGoals(query: {
    sectionId?: string;
    periodKind?: GoalPeriodKind;
    periodKey?: string;
    status?: GoalStatus;
    withProgress?: boolean;
  } = {}): Promise<{ goals: Goal[]; items?: GoalWithProgress[] }> {
    const params = new URLSearchParams();
    if (query.sectionId) params.set('sectionId', query.sectionId);
    if (query.periodKind) params.set('periodKind', query.periodKind);
    if (query.periodKey) params.set('periodKey', query.periodKey);
    if (query.status) params.set('status', query.status);
    if (query.withProgress) params.set('withProgress', '1');
    return fetchWithRetry<{ goals: Goal[]; items?: GoalWithProgress[] }>(
      `/api/goals?${params.toString()}`
    );
  },

  async createGoal(input: {
    sectionId: string;
    periodKind: GoalPeriodKind;
    periodKey: string;
    title: string;
    detail?: string;
    parentGoalId?: string;
    target?: { value: number; unit?: string };
    evidence?: Goal['evidence'];
    plan?: Goal['plan'];
    planSource?: Goal['planSource'];
  }): Promise<{ goal: Goal }> {
    return fetchWithRetry<{ goal: Goal }>(
      '/api/goals',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { maxRetries: 0 }
    );
  },

  // Free text → a structured goal + progression-plan proposal. `proposal` is null
  // when the model is unavailable or returns nothing usable; the editor then
  // stays on the manual form.
  async inferGoal(input: { text: string; sectionId?: string }): Promise<{ proposal: InferredGoal | null }> {
    return fetchWithRetry<{ proposal: InferredGoal | null }>(
      '/api/goals/infer',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { maxRetries: 0 }
    );
  },

  // Suggest an auto-tracking source for a manually-tracked goal. `proposal` is
  // null when the goal isn't manual, the model is unavailable, or nothing usable
  // comes back; the editor then leaves the goal self-reported.
  async suggestGoalEvidence(id: string): Promise<{ proposal: InferredEvidence | null }> {
    return fetchWithRetry<{ proposal: InferredEvidence | null }>(
      `/api/goals/${id}/suggest-evidence`,
      { method: 'POST' },
      { maxRetries: 0 }
    );
  },

  async updateGoal(id: string, patch: Partial<Goal>): Promise<{ goal: Goal }> {
    return fetchWithRetry<{ goal: Goal }>(
      `/api/goals/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
      { maxRetries: 0 }
    );
  },

  async deleteGoal(id: string): Promise<{ success: boolean }> {
    return fetchWithRetry<{ success: boolean }>(
      `/api/goals/${id}`,
      { method: 'DELETE' },
      { maxRetries: 0 }
    );
  },

  async checkInGoal(
    id: string,
    input: { status: GoalCheckInStatus; note?: string; value?: number; source?: GoalCheckIn['source'] }
  ): Promise<{ goal: Goal }> {
    return fetchWithRetry<{ goal: Goal }>(
      `/api/goals/${id}/check-in`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { maxRetries: 0 }
    );
  },

  async getScorecard(periodKind: GoalPeriodKind, periodKey?: string, sectionId?: string): Promise<{ scorecard: Scorecard }> {
    const params = new URLSearchParams({ periodKind });
    if (periodKey) params.set('periodKey', periodKey);
    if (sectionId) params.set('sectionId', sectionId);
    return fetchWithRetry<{ scorecard: Scorecard }>(`/api/goals/scorecard?${params.toString()}`);
  },

  async getGoalNudges(): Promise<{ nudges: GoalNudge[] }> {
    return fetchWithRetry<{ nudges: GoalNudge[] }>('/api/goals/nudges');
  },

  // --- Exercise ------------------------------------------------------------

  async getExerciseSessions(from?: string, to?: string): Promise<{ sessions: ExerciseSession[] }> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return fetchWithRetry<{ sessions: ExerciseSession[] }>(`/api/exercise?${params.toString()}`);
  },

  // Duration is optional: a logged strength session is described by its
  // exercises, not by a stopwatch. `exercises` arrive without ids — storage
  // assigns them.
  async createExerciseSession(
    input: Omit<Partial<ExerciseSession>, 'exercises'> & {
      date: string;
      type: string;
      exercises?: Array<Omit<ExerciseEntry, 'id'>>;
    }
  ): Promise<{ session: ExerciseSession }> {
    return fetchWithRetry<{ session: ExerciseSession }>(
      '/api/exercise',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { maxRetries: 0 }
    );
  },

  // Log a session from a blob of text describing what was actually done — for
  // the day that went off-plan. Called twice from the desktop (read it, then
  // save the corrected draft) and once from mobile (`save`, no draft).
  //
  // The parse spawns Claude, so it is slow by web standards and never retried:
  // a second call would just run the model again on the same text.
  async logExerciseFreeform(input: {
    text: string;
    date?: string;
    save?: boolean;
    draft?: FreeformDraft;
  }): Promise<{ draft?: FreeformDraft; session?: ExerciseSession; parsed: boolean }> {
    return fetchWithRetry<{ draft?: FreeformDraft; session?: ExerciseSession; parsed: boolean }>(
      '/api/exercise/freeform',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { maxRetries: 0 }
    );
  },

  async updateExerciseSession(
    id: string,
    patch: Partial<ExerciseSession>
  ): Promise<{ session: ExerciseSession }> {
    return fetchWithRetry<{ session: ExerciseSession }>(
      `/api/exercise/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
      { maxRetries: 0 }
    );
  },

  async deleteExerciseSession(id: string): Promise<{ success: boolean }> {
    return fetchWithRetry<{ success: boolean }>(
      `/api/exercise/${id}`,
      { method: 'DELETE' },
      { maxRetries: 0 }
    );
  },

  // The standing weekly routine — the repeating shape of the week, Mon→Sun.
  async getWeeklyRoutine(): Promise<{ routine: WeeklyRoutineDay[] }> {
    return fetchWithRetry<{ routine: WeeklyRoutineDay[] }>('/api/exercise/routine');
  },

  async saveWeeklyRoutine(routine: WeeklyRoutineDay[]): Promise<{ routine: WeeklyRoutineDay[] }> {
    return fetchWithRetry<{ routine: WeeklyRoutineDay[] }>(
      '/api/exercise/routine',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routine }),
      },
      { maxRetries: 0 }
    );
  },

  // The gym button: open today's session, pre-filled with what to aim for.
  // Safe to call again — it resumes rather than starting a second session.
  async startExerciseSession(date?: string): Promise<{
    session: ExerciseSession;
    resumed: boolean;
    plan?: string | null;
  }> {
    return fetchWithRetry(
      '/api/exercise/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(date ? { date } : {}),
      },
      { maxRetries: 0 }
    );
  },

  async updateExerciseEntry(
    sessionId: string,
    entryId: string,
    patch: Partial<
      Pick<ExerciseEntry, 'name' | 'done' | 'sets' | 'reps' | 'holdSeconds' | 'weightKg' | 'notes'>
    > & {
      rir?: number | null;
      // Nullable extras: a swap sets a new name + substitutedFor (and, for
      // cardio, distanceKm), and clears the old targetText; a restore clears
      // substitutedFor. null is an explicit clear, undefined leaves it alone.
      substitutedFor?: string | null;
      targetText?: string | null;
      distanceKm?: number | null;
      durationMinutes?: number | null;
    }
  ): Promise<{ session: ExerciseSession }> {
    return fetchWithRetry(
      `/api/exercise/${sessionId}/entries/${entryId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
      { maxRetries: 0 }
    );
  },

  async addExerciseEntry(
    sessionId: string,
    input: { name: string; volumeText?: string; loadText?: string; notes?: string }
  ): Promise<{ session: ExerciseSession; entry: ExerciseEntry }> {
    return fetchWithRetry(
      `/api/exercise/${sessionId}/entries`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { maxRetries: 0 }
    );
  },

  async removeExerciseEntry(sessionId: string, entryId: string): Promise<{ session: ExerciseSession }> {
    return fetchWithRetry(
      `/api/exercise/${sessionId}/entries/${entryId}`,
      { method: 'DELETE' },
      { maxRetries: 0 }
    );
  },

  // What to aim for in a session, from the last time each exercise was trained.
  async getExerciseTargets(date?: string): Promise<{
    date: string;
    plan?: { label?: string; components: string[]; venue?: 'home' };
    targets: ExerciseTarget[];
    // 'ai' once the Claude programme is cached, 'fallback' while it generates or
    // when Claude is unavailable. `generating` flags that a refetch will upgrade.
    source?: 'ai' | 'fallback';
    generating?: boolean;
  }> {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    return fetchWithRetry(`/api/exercise/targets?${params.toString()}`);
  },

  // Swap a day's planned session to a home workout (bands, pull-up bar,
  // bodyweight) or back to the gym. Sets `venue` on the plan and kicks off a
  // fresh home programme server-side; the caller reloads targets to pick it up.
  async setExerciseVenue(
    venue: 'home' | 'gym',
    date?: string
  ): Promise<{ session: ExerciseSession; venue: 'home' | 'gym' }> {
    return fetchWithRetry(
      '/api/exercise/venue',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venue, ...(date ? { date } : {}) }),
      },
      { maxRetries: 0 }
    );
  },

  async getExerciseProgressions(): Promise<{ progressions: ExerciseProgression[] }> {
    return fetchWithRetry<{ progressions: ExerciseProgression[] }>('/api/exercise/progression');
  },

  // Two-way calendar sync: pull planned sessions from the personal Google
  // calendar's all-day events, then materialise the days ahead from the weekly
  // routine and push them back. created/updated/removed sum both halves;
  // `materialise` breaks out the routine push.
  // With { auto: true } the server throttles: if a sync ran in the last 6 hours
  // it returns { skipped: true, lastSyncedAt } and does no work.
  async syncExerciseCalendar(options?: { auto?: boolean }): Promise<{
    scanned?: number;
    created?: number;
    updated?: number;
    removed?: number;
    materialise?: { created: number; updated: number; removed: number };
    skipped?: boolean;
    lastSyncedAt?: string;
  }> {
    return fetchWithRetry(
      '/api/exercise/sync-calendar',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options?.auto ? { auto: true } : {}),
      },
      { maxRetries: 0 }
    );
  },

  async getExerciseAnalysis(from?: string, to?: string): Promise<{ analysis: ExerciseAnalysis }> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return fetchWithRetry<{ analysis: ExerciseAnalysis }>(
      `/api/exercise/analysis?${params.toString()}`
    );
  },

  // --- Wellbeing (daily habits and experiments) -----------------------------

  async getWellbeingDays(from?: string, to?: string): Promise<{ days: WellbeingDay[] }> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return fetchWithRetry<{ days: WellbeingDay[] }>(`/api/wellbeing/days?${params.toString()}`);
  },

  // Upsert one day's habit answers. Habits merge by id server-side, so sending
  // only the ones just answered never wipes an earlier answer for that day.
  async saveWellbeingDay(input: {
    date: string;
    habits: HabitLog[];
    notes?: string;
  }): Promise<{ day: WellbeingDay }> {
    return fetchWithRetry<{ day: WellbeingDay }>(
      '/api/wellbeing/days',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { maxRetries: 0 }
    );
  },

  async getWellbeingAnalysis(from?: string, to?: string): Promise<{ analysis: WellbeingAnalysis }> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return fetchWithRetry<{ analysis: WellbeingAnalysis }>(
      `/api/wellbeing/analysis?${params.toString()}`
    );
  },

  async getExperiments(status?: ExperimentStatus): Promise<{ experiments: Experiment[] }> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    return fetchWithRetry<{ experiments: Experiment[] }>(
      `/api/wellbeing/experiments?${params.toString()}`
    );
  },

  async createExperiment(input: Partial<Experiment>): Promise<{ experiment: Experiment }> {
    return fetchWithRetry<{ experiment: Experiment }>(
      '/api/wellbeing/experiments',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { maxRetries: 0 }
    );
  },

  // An empty string clears a field (that is how reopening drops a verdict);
  // omitting the key leaves whatever is stored alone.
  async updateExperiment(
    id: string,
    patch: Partial<Omit<Experiment, 'verdict'>> & { verdict?: ExperimentVerdict | '' }
  ): Promise<{ experiment: Experiment }> {
    return fetchWithRetry<{ experiment: Experiment }>(
      `/api/wellbeing/experiments/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
      { maxRetries: 0 }
    );
  },

  async deleteExperiment(id: string): Promise<{ success: boolean }> {
    return fetchWithRetry<{ success: boolean }>(
      `/api/wellbeing/experiments/${id}`,
      { method: 'DELETE' },
      { maxRetries: 0 }
    );
  },

  async checkInExperiment(
    id: string,
    input: { rating?: number; note?: string }
  ): Promise<{ experiment: Experiment }> {
    return fetchWithRetry<{ experiment: Experiment }>(
      `/api/wellbeing/experiments/${id}/check-in`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { maxRetries: 0 }
    );
  },
};

export function parseCalendarEvent(event: CalendarEventResponse): CalendarEvent {
  return {
    ...event,
    startTime: new Date(event.startTime),
    endTime: new Date(event.endTime),
  };
}

export function parseCalendarEvents(events: CalendarEventsResponse): CalendarEvent[] {
  return events.map(parseCalendarEvent);
}
