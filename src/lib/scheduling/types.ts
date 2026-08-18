// Types for the "Plan my week" auto-scheduling engine.
// Kept separate from the pure engine logic so routes and UI can import them
// without pulling in the algorithm.

import type { BestTime, DeadlineType, EnergyLevel } from '@/types';
import type { WorkflowConfig } from '@/lib/workflow-config-storage';

// A merged busy interval on the user's timeline. Absolute times. `isBreak`
// marks a "break" interval (e.g. the daily lunch ritual): it is still busy (can't
// be double-booked) but does NOT count as work when forming continuous work runs,
// so a run interrupted by a break is two runs.
export interface BusyInterval {
  start: Date;
  end: Date;
  isBreak?: boolean;
}

// A candidate task the engine may place on the calendar. Either an Asana task
// (gid + Asana integrationId) or an ad-hoc task (adhocId). `typeSignals` are the
// same signals the capacity lib classifies on (Asana "Type" custom-field value,
// or ad-hoc taskType id + label) and drive which quota category the task counts
// toward.
export interface CandidateTask {
  gid?: string; // Asana task GID
  adhocId?: string; // ad-hoc task id
  title: string;
  integrationId?: string; // Asana integration id (for time-tracking attribution)
  dueDate?: string; // yyyy-MM-dd
  typeSignals: string[];
  deadlineType?: DeadlineType;
  bestTime?: BestTime;
  energyLevel?: EnergyLevel;
  effortMinutes?: number;
  // Marks a task the user pinned as a priority in the wizard. Sorts first
  // within its category, ahead of deadline/due-date ranking.
  isPriority?: boolean;
  // Set when the user carried this task out of an EARLIER week during that
  // week's end-of-week review. The wizard badges it ("↩ last week") and floats it
  // above the rest of its category (behind pinned priorities).
  carriedOver?: boolean;
  carriedFromWeek?: string; // yyyy-MM-dd Monday of the week it was carried out of
  // Consecutive end-of-week carries (1 = carried once). Drives the escalating
  // badge in the wizard.
  carryStreak?: number;
  // Flagged "must do next week" from the end-of-week review's escalation.
  mustDo?: boolean;
}

// A single proposed calendar block. `task` is omitted for a "reserved" block
// (quota remains but no matching candidate task was available).
export interface ProposedBlock {
  id: string;
  category: string;
  task?: {
    gid?: string;
    adhocId?: string;
    title: string;
    integrationId?: string;
  };
  // Present only on grouped blocks (a `grouped` category, e.g. Engagement /
  // Outreach): the tasks assigned to this block, listed inside the event as an
  // agenda. A grouped block has `tasks` (0+ items) and no single `task`.
  tasks?: Array<{
    gid?: string;
    adhocId?: string;
    title: string;
    integrationId?: string;
  }>;
  date: string; // yyyy-MM-dd
  start: string; // HH:mm (local)
  durationMinutes: number;
  reason: string;
  // Block classification. Absent on engine task/reserved blocks (derive from
  // `task` presence for back-compat); set to 'prep' by the prep placer,
  // 'ritual' by the ritual (lunch/exercise/emails) placer, and 'break' by the
  // post-placement break pass ("☕ Break" gaps after each work run).
  kind?: 'task' | 'reserved' | 'prep' | 'ritual' | 'break';
  // Present only on prep blocks: the meeting this block prepares for.
  meeting?: { eventId: string; title: string; meetingStart: string /* ISO */ };
  // Present only on ritual blocks (lunch/exercise/emails): the exact event title
  // to create ("🍽️ Lunch" / "🏋️ Exercise" / "📧 Emails"). `category` is 'Lunch',
  // 'Exercise' or 'Emails'.
  title?: string;
  // True for an OPTIONAL evening-overflow block: a real selected task that didn't
  // fit inside working hours, placed in the configured overflow window (e.g.
  // 21:00–23:00). The review UI shows these in their own opt-in section
  // (default-rejected) and spare-capacity ignores overflow-window time.
  overflow?: boolean;
  // Present only when the soft work-run rule TRIMMED this block to fit: the
  // block's ORIGINAL (pre-trim) length in minutes. `durationMinutes` is the
  // actual (shortened) length. The review UI badges it ("75 min · trimmed from
  // 90"). Absent when the block was placed at its full requested length.
  trimmedFromMinutes?: number;
}

export interface ProposeBlocksInput {
  config: WorkflowConfig;
  busyIntervals: BusyInterval[];
  candidateTasks: CandidateTask[];
  // Per-category count of blocks already scheduled this week (reduces remaining
  // weekly quota). Keyed by category name.
  existingScheduledCounts: Record<string, number>;
  // Per-date, per-category count of blocks already on the calendar this week.
  // Seeds the spread heuristic so mid-week re-runs don't re-pile a day. Keyed
  // by yyyy-MM-dd then category name.
  existingCategoryCountsByDate?: Record<string, Record<string, number>>;
  // Per-week block-length overrides (minutes), keyed by category name. When set
  // for a category, its blocks use this duration instead of the targetLength
  // parsed from workflow config. Grouped categories (shared containers) take
  // their length from here; single-task categories prefer a per-task override
  // (below) and fall back to this, then to the parsed targetLength. Does not
  // modify the saved config.
  durationOverridesByCategory?: Record<string, number>;
  // Per-task block-length overrides (minutes), keyed by task id (gid or adhocId).
  // Applies to that task's single-task block — both its duration and the slot
  // search for it. Ignored for grouped/reserved blocks (which are not tied to a
  // single task). Does not modify the saved config.
  durationOverridesByTask?: Record<string, number>;
  // Per-category count of tasks the user explicitly selected for a manual
  // (non-auto-select, non-grouped) category. When present, that category places
  // max(remaining weekly quota, selected count) blocks, so explicit over-quota
  // picks are attempted rather than clamped to the quota. Absent when no manual
  // selection was made (e.g. the tasks step was skipped), in which case the
  // quota cap applies as before. Keyed by category name.
  selectedCountsByCategory?: Record<string, number>;
  weekStart: Date; // local midnight of the week's Monday
  now: Date;
  // Dates (yyyy-MM-dd) the user is out of office. These days are dropped from the
  // working days entirely (no blocks, rituals or spread) and shrink weekly quotas
  // proportionally. Derived from the calendar in gather; absent → none.
  outOfOfficeDates?: Set<string>;
  // REPLAN ONLY: the exact deep-work tasks to list on every daily deep-work
  // morning (the generic container's shared agenda), overriding the tasks
  // bucketed from `candidateTasks`. Mid-week the week's deep-work tasks are
  // already chosen (they back the existing deep-work blocks), so the replan only
  // adds BLOCKS carrying this same list — it never draws a NEW deep-work task from
  // the general pool. An empty array means "no task selected" → the mornings get
  // reserved deep-work blocks. Absent in the wizard path, which lists its selected
  // deep-work candidates on every morning as before.
  deepWorkTasksOverride?: CandidateTask[];
}
