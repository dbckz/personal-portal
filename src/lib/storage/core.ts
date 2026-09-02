// Core user-data assembly: the whole-object read/write that every per-domain
// module builds on. Backed by SQLite (see ./db) rather than a JSON file, but the
// external contract — a UserData object with all fields defaulted — is unchanged.

import { AsanaFilterState } from '@/types';
import type { WeeklyRoutineDay, RoutineOverride } from '@/types/life';
import { readAllDomains, writeAllDomains } from './db';
import type {
  AdHocTask,
  ScheduledAsanaTask,
  TaskTemplate,
  CustomTaskType,
  TemplateGroup,
  TaskMetadata,
  DelegationQueueEntry,
  AiClassificationEntry,
  AiUserVerdict,
  StaleClassificationEntry,
  MeetingPrepDecision,
  WeeklyStatsRecord,
  EventAttributionRule,
  BoardTaskState,
} from '@/types';

export const DEFAULT_ASANA_FILTERS: AsanaFilterState = {
  integrationIds: [],
  projectIds: [],
  typeValues: [],
  dueDateRange: 'all',
  startDateRange: 'all',
  filterLogic: 'and',
  sortField: 'dueOn',
  sortDirection: 'asc',
  groupBy: 'none',
  groupOrder: [],
  expandedGroups: [],
};

// Attribution for Google events to count toward time tracking
export interface GoogleEventAttribution {
  googleEventId: string;
  googleIntegrationId: string;
  asanaIntegrationId: string; // Which Asana workspace this counts toward (OM or DBC)
  createdAt: string;
}

// A meeting-prep block the "Plan my week" flow created on the calendar. Tracked
// here (not just as a "Prep:" Google event) so the planner can dedupe against
// it, reconcile it when the user deletes the event, and reason about it during
// replan (missed / mark-done / stale-when-meeting-past).
export interface PrepBlock {
  id: string;
  googleEventId: string;
  googleIntegrationId: string;
  meetingEventId: string; // the meeting this block prepares for
  meetingTitle: string;
  meetingStart: string; // ISO
  date: string; // yyyy-MM-dd (the prep block's own date)
  start: string; // HH:mm
  durationMinutes: number;
  done: boolean;
  createdAt: string;
  // Rollover bookkeeping (set when the daily rollover moves an unfinished prep
  // block forward, so the card can be badged "from Tue"). Mirrors the task
  // records — see src/lib/board-rollover.ts. Absent on a never-rolled block.
  originallyPlannedFor?: string; // yyyy-MM-dd the block was first planned for
  rolls?: number; // times it has been rolled
}

// A daily-ritual block (lunch / exercise / emails) the "Plan my week" flow
// created on the calendar. Tracked here (like PrepBlock) so the planner can
// dedupe against it, reconcile it when the user deletes the event, reset it, and
// re-slot it in replan. No `done` concept — a ritual is never marked done.
export interface RitualBlock {
  id: string;
  googleEventId: string;
  googleIntegrationId: string;
  title: string; // exact event title ("🍽️ Lunch" / "🏋️ Exercise" / "📧 Emails")
  date: string; // yyyy-MM-dd
  start: string; // HH:mm
  durationMinutes: number;
  createdAt: string;
}

// A task the user explicitly carried over from one week's end-of-week review
// into the next week's plan. `fromWeek` is the yyyy-MM-dd Monday of the week the
// task was planned in, so the plan-week wizard can badge it ("↩ last week") only
// when the week being planned is a LATER week.
// Lifecycle of a carry-over marker, and why it is NOT cleared on scheduling:
//
//   end-of-week review carries a task  → entry created, carries = 1
//   plan-week schedules it next week   → scheduledWeek stamped; the entry SURVIVES
//   that week ends and it is carried again → carries = 2, fromWeek moves on
//   the task is completed (or the marker goes stale) → entry removed
//
// Clearing on scheduling (the original behaviour) destroyed the streak on every
// schedule → not-done → carry cycle, which is exactly the cycle worth counting:
// a task carried three weeks running is a signal, not noise. `scheduledWeek`
// records that it did get a slot, so the badge only ever shows when the task is
// genuinely carrying into a LATER week than it was carried out of.
export interface CarryOverEntry {
  fromWeek: string; // yyyy-MM-dd (Monday of the week it was carried out of)
  at: number; // ms timestamp the carry-over was last recorded
  // Consecutive end-of-week carries. Absent on entries written before streaks
  // existed — treat as 1.
  carries?: number;
  // The last week this task was actually scheduled into, if any.
  scheduledWeek?: string;
  // Set from the end-of-week review's "Must do next week" option; the plan-week
  // wizard pre-flags the task so it can't be dropped by a selection cap.
  mustDo?: boolean;
}

export interface UserData {
  taskTemplates: TaskTemplate[];
  templateGroups: TemplateGroup[];
  customTaskTypes: CustomTaskType[];
  adHocTasks: AdHocTask[];
  scheduledAsanaTasks: ScheduledAsanaTask[];
  asanaFilterPreferences?: AsanaFilterState; // Legacy: kept for migration
  asanaFilterPreferencesMap?: Record<string, AsanaFilterState>; // Key is integration ID or "default"
  googleEventAttributions?: GoogleEventAttribution[];
  taskMetadata?: Record<string, TaskMetadata>; // Key is Asana task GID
  delegationQueue?: Record<string, DelegationQueueEntry>; // Key is Asana task GID
  aiClassification?: Record<string, AiClassificationEntry>; // Key is Asana task GID
  // Dave's own AI-runnable verdicts (key: Asana task GID). Written when he
  // rejects a claim in the assessment review; beats the cached AI verdict, so a
  // rejected task never re-enters the AI-runnable list on re-assessment.
  aiUserVerdicts?: Record<string, AiUserVerdict>;
  staleClassification?: Record<string, StaleClassificationEntry>; // Key is Asana task GID
  staleKeep?: Record<string, string>; // GID -> ISO timestamp: "keep active" until (snooze)
  meetingPrepDecisions?: Record<string, MeetingPrepDecision>; // Key is normalized meeting title
  // Type labels the user decided in the wizard's type step, keyed by normalized
  // task title. Fed back to the Type classifier as few-shot examples.
  typeVerdicts?: Record<string, TypeVerdict>;
  // Reminder-triage decisions the user confirmed, keyed by normalized reminder
  // title. Fed back to the reminder-triage classifier as few-shot examples.
  reminderVerdicts?: Record<string, ReminderVerdict>;
  prepBlocks?: PrepBlock[]; // meeting-prep blocks created on the calendar
  ritualBlocks?: RitualBlock[]; // daily lunch/emails blocks created on the calendar
  // Google event ids the user explicitly marked "done for planning" during a
  // replan. Used for Asana-backed blocks whose task must stay open in Asana.
  blockDoneOverrides?: Record<string, true>;
  // Task ids (Asana gid or ad-hoc id) the user deferred out of the current
  // week's planning during a replan, mapped to the yyyy-MM-dd date they should
  // resume as a candidate (next Monday). Deferrals whose resume date has arrived
  // are pruned lazily by gatherWeekContext.
  taskDeferrals?: Record<string, string>;
  // Task ids (Asana gid or ad-hoc id) the user carried over at the end of a week,
  // mapped to the week they were carried out of. Purely a marker for the
  // plan-week wizard (the parallel taskDeferral is what actually parks the task);
  // cleared once the task is scheduled or completed, and pruned when stale.
  carryOvers?: Record<string, CarryOverEntry>;
  // Durable per-week analysis records, keyed by yyyy-MM-dd Monday. Append-only
  // in spirit: a past week's record is final. See WeeklyStatsRecord.
  weeklyStats?: Record<string, WeeklyStatsRecord>;
  // Durable attribution overrides matched by recurring series / title. See
  // EventAttributionRule; the built-in defaults live in lib/attribution-rules.ts.
  eventAttributionRules?: EventAttributionRule[];
  // The date analysis starts from (yyyy-MM-dd). Weeks before it are hidden and
  // never reconciled — the app wasn't in use, so that data is noise.
  analysisStartDate?: string;
  // When the server last rebuilt past days' time records from the calendar.
  // Used to debounce the automatic reconcile the Analysis tab fires on load.
  timeSyncState?: { lastReconciledAt?: string };
  // When the exercise calendar was last synced (auto or manual). Used to
  // throttle the automatic sync the Exercise section fires on load.
  exerciseSyncState?: { lastSyncedAt?: string };
  // Daily-review state: when the review was last completed (so the next review
  // only covers what has finished SINCE then) and the bare calendar-event titles
  // the user has dismissed as "not a task" (so they never resurface in review).
  dailyReviewState?: DailyReviewState;
  // Dave's standing weekly training routine — the repeating shape of the week the
  // plan is built from. Seeded and read/written through lib/storage/weekly-routine.
  weeklyRoutine?: WeeklyRoutineDay[];
  // Per-date deviations from the standing weekly routine, keyed by yyyy-MM-dd.
  // A one-off week shape (a shifted plan) that outlives the calendar sync. See
  // lib/storage/routine-overrides.
  routineOverrides?: Record<string, RoutineOverride>;
  // Per-task status for the weekly task board, keyed by BoardTaskState.key (the
  // week-suffixed key for rituals, the plain card key for asana/adhoc). See
  // lib/storage/board and lib/board.
  boardTasks?: Record<string, BoardTaskState>;
  // Daily board-rollover bookkeeping: the logical day (yyyy-MM-dd) the unfinished-
  // task rollover last ran for, so it runs at most once per logical day. See
  // lib/storage/board-rollover and lib/board-rollover.
  boardRollover?: BoardRolloverState;
}

// Idempotence stamp for the daily board rollover (see lib/board-rollover).
export interface BoardRolloverState {
  lastRolloverDay?: string; // yyyy-MM-dd (logical day the rollover last ran for)
}

export interface DailyReviewState {
  lastReviewedAt?: string; // ISO timestamp of the last completed daily review
  dismissedTitles?: string[]; // exact event titles to skip in calendar review
  // "Is this event a task at all?" verdicts for bare calendar-event titles,
  // keyed by normalized title (see scheduling/not-a-task.ts). A user dismissal
  // writes a permanent 'user' verdict; the AI classifier caches its own, keyed
  // additionally by content hash + prompt version.
  titleVerdicts?: Record<string, ReviewTitleVerdict>;
}

export interface ReviewTitleVerdict {
  isTask: boolean;
  decidedBy: 'user' | 'ai';
  contentHash?: string; // ai entries only — cache key
  promptVersion?: string;
  reason?: string;
  updatedAt: string;
}

// A reminder-triage decision the user confirmed in the wizard's reminders step,
// keyed by NORMALISED REMINDER TITLE. Records whether he kept the reminder or
// converted it to Asana (and, for a conversion, where), so the reminder-triage
// classifier can learn his keep-vs-convert boundary from his own calls.
export interface ReminderVerdict {
  action: 'keep' | 'convert';
  integrationId?: string; // convert: the workspace he filed it under
  projectGid?: string;
  taskType?: string;
  updatedAt: string;
}

// A Type label the user decided for a task in the plan-week wizard's type step,
// keyed by NORMALISED TASK TITLE (not gid — a title pattern teaches the Type
// classifier about future tasks; a gid teaches nothing). `override` marks that he
// changed the AI's suggestion, which is the stronger learning signal.
export interface TypeVerdict {
  type: string;
  override?: boolean;
  updatedAt: string;
}

const DEFAULT_USER_DATA: UserData = {
  taskTemplates: [],
  templateGroups: [],
  customTaskTypes: [],
  adHocTasks: [],
  scheduledAsanaTasks: [],
  asanaFilterPreferencesMap: {},
  googleEventAttributions: [],
  taskMetadata: {},
  delegationQueue: {},
  aiClassification: {},
  aiUserVerdicts: {},
  staleClassification: {},
  staleKeep: {},
  meetingPrepDecisions: {},
  typeVerdicts: {},
  reminderVerdicts: {},
  prepBlocks: [],
  ritualBlocks: [],
  blockDoneOverrides: {},
  taskDeferrals: {},
  carryOvers: {},
  weeklyStats: {},
  eventAttributionRules: [],
  timeSyncState: {},
  exerciseSyncState: {},
  dailyReviewState: {},
  weeklyRoutine: [],
  routineOverrides: {},
  boardTasks: {},
  boardRollover: {},
};

export async function getUserData(): Promise<UserData> {
  try {
    const parsed = readAllDomains() as Partial<UserData>;

    // Migrate from legacy asanaFilterPreferences to asanaFilterPreferencesMap
    let filterMap = parsed.asanaFilterPreferencesMap || {};
    if (parsed.asanaFilterPreferences && !parsed.asanaFilterPreferencesMap) {
      // Migrate legacy single filter state to "default" key
      filterMap = { default: { ...DEFAULT_ASANA_FILTERS, ...parsed.asanaFilterPreferences } };
    }

    // Ensure all fields exist (for backwards compatibility)
    return {
      taskTemplates: parsed.taskTemplates || [],
      templateGroups: parsed.templateGroups || [],
      customTaskTypes: parsed.customTaskTypes || [],
      adHocTasks: parsed.adHocTasks || [],
      scheduledAsanaTasks: parsed.scheduledAsanaTasks || [],
      asanaFilterPreferencesMap: filterMap,
      googleEventAttributions: parsed.googleEventAttributions || [],
      taskMetadata: parsed.taskMetadata || {},
      delegationQueue: parsed.delegationQueue || {},
      aiClassification: parsed.aiClassification || {},
      // Tolerant load: keep only well-formed { aiSuitable } entries.
      aiUserVerdicts: Object.fromEntries(
        Object.entries(parsed.aiUserVerdicts || {}).filter(
          ([k, v]) =>
            typeof k === 'string' &&
            !!v &&
            typeof v === 'object' &&
            typeof (v as AiUserVerdict).aiSuitable === 'boolean'
        )
      ),
      staleClassification: parsed.staleClassification || {},
      staleKeep: parsed.staleKeep || {},
      meetingPrepDecisions: parsed.meetingPrepDecisions || {},
      typeVerdicts: parsed.typeVerdicts || {},
      reminderVerdicts: parsed.reminderVerdicts || {},
      prepBlocks: parsed.prepBlocks || [],
      ritualBlocks: parsed.ritualBlocks || [],
      blockDoneOverrides: parsed.blockDoneOverrides || {},
      // Tolerant load: keep only string→string entries.
      taskDeferrals: Object.fromEntries(
        Object.entries(parsed.taskDeferrals || {}).filter(
          ([k, v]) => typeof k === 'string' && typeof v === 'string'
        )
      ),
      // Tolerant load: keep only well-formed { fromWeek, at } entries.
      carryOvers: Object.fromEntries(
        Object.entries(parsed.carryOvers || {}).filter(
          ([k, v]) =>
            typeof k === 'string' &&
            !!v &&
            typeof v === 'object' &&
            typeof (v as CarryOverEntry).fromWeek === 'string'
        )
      ),
      weeklyStats: parsed.weeklyStats || {},
      eventAttributionRules: Array.isArray(parsed.eventAttributionRules)
        ? parsed.eventAttributionRules.filter(
            r => !!r && typeof r === 'object' && typeof r.asanaIntegrationId === 'string'
          )
        : [],
      ...(typeof parsed.analysisStartDate === 'string'
        ? { analysisStartDate: parsed.analysisStartDate }
        : {}),
      timeSyncState: parsed.timeSyncState || {},
      exerciseSyncState: parsed.exerciseSyncState || {},
      dailyReviewState: parsed.dailyReviewState || {},
      weeklyRoutine: parsed.weeklyRoutine || [],
      routineOverrides: parsed.routineOverrides || {},
      // Tolerant load: keep only well-formed { status } entries keyed by string.
      boardTasks: Object.fromEntries(
        Object.entries(parsed.boardTasks || {}).filter(
          ([k, v]) =>
            typeof k === 'string' &&
            !!v &&
            typeof v === 'object' &&
            typeof (v as BoardTaskState).status === 'string'
        )
      ),
      // Tolerant load: keep only a string lastRolloverDay.
      boardRollover:
        parsed.boardRollover &&
        typeof parsed.boardRollover === 'object' &&
        typeof parsed.boardRollover.lastRolloverDay === 'string'
          ? { lastRolloverDay: parsed.boardRollover.lastRolloverDay }
          : {},
    };
  } catch {
    // Deep clone so callers that mutate nested collections (e.g. upserting into
    // delegationQueue/taskMetadata) never pollute the shared DEFAULT_USER_DATA.
    return JSON.parse(JSON.stringify(DEFAULT_USER_DATA)) as UserData;
  }
}

export async function saveUserData(data: UserData): Promise<void> {
  writeAllDomains(data as unknown as Record<string, unknown>);
}
