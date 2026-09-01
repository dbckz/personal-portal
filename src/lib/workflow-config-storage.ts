// Server-side storage for workflow configuration
// Stores task quotas and scheduling preferences used by the workflow planner

import { promises as fs } from 'fs';
import path from 'path';

import { DATA_DIR, WORKFLOW_CONFIG_FILE } from './data-paths';
import { normalizeRolloverHour, DEFAULT_ROLLOVER_HOUR } from './date-utils';
import {
  DEFAULT_TRIAGE_PROJECT_FILTER,
  type TriageProjectFilterConfig,
} from './triage-project-filter';

// Types for workflow config data
export interface TaskQuota {
  weeklyCount?: number;
  targetLength: string;
  preferredTimes: string[];
  // When true, "Plan my week" auto-picks tasks for this category instead of
  // prompting for manual selection. Defaults on for Batch.
  autoSelect?: boolean;
  // When true, this category is scheduled as "grouped blocks": weeklyCount
  // reserved blocks are placed, and the user's selected tasks (any number — the
  // selection cap is lifted) are distributed across those blocks round-robin and
  // listed inside each block's event as an agenda, rather than one task per block.
  grouped?: boolean;
  // Optional hard cap on how many tasks the "Plan my week" wizard lets the user
  // SELECT for this category. When set, it caps the selection even for grouped
  // categories (which otherwise lift the cap) and is not lifted by "Add more
  // tasks". Used e.g. to keep grouped Deep Work at "up to 3" agenda items.
  maxSelection?: number;
  // When true, this category is scheduled ONCE PER WORKING DAY in the plan window
  // rather than by a fixed weeklyCount: the engine sets the effective weekly count
  // to the number of working days (e.g. Writing/Deep Work, so deep work leads
  // every day). existingScheduledCounts still subtract. Overrides weeklyCount.
  daily?: boolean;
  // When set (grouped categories only), the number of blocks scales with how many
  // tasks were selected: blockCount = min(maxBlocks, ceil(selectedTasks /
  // tasksPerBlock)), and ZERO selected tasks means ZERO blocks. Overrides
  // weeklyCount. Used e.g. for Batch (7 tasks per block, up to 3 blocks).
  scaleToTasks?: { tasksPerBlock: number; maxBlocks: number };
}

// Continuous-work-run rule. The calendar should form busy runs of at most
// `maxMinutes` (meetings + placed blocks counted together), each followed by at
// least `bufferMinutes` of free time. Replaces the old flat `bufferBetweenTasks`.
export interface WorkRunConfig {
  maxMinutes: number;
  bufferMinutes: number;
}

export const DEFAULT_WORK_RUN: WorkRunConfig = { maxMinutes: 120, bufferMinutes: 15 };

// Optional evening-overflow window. When set, "Plan my week" offers optional
// blocks in this window (outside working hours) for real tasks that didn't fit
// inside working hours. Times are "HH:MM" local.
export interface OverflowConfig {
  start: string;
  end: string;
}

// Parse+validate an overflow config from untrusted JSON. Keep it only when both
// ends are valid "HH:MM" times and the window is non-empty (start < end).
function parseOverflow(raw: unknown): OverflowConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { start, end } = raw as { start?: unknown; end?: unknown };
  const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
  if (typeof start !== 'string' || typeof end !== 'string') return undefined;
  if (!hhmm.test(start.trim()) || !hhmm.test(end.trim())) return undefined;
  if (start.trim() >= end.trim()) return undefined;
  return { start: start.trim(), end: end.trim() };
}

// The per-kind ritual-calendar routing map: which Google integration each
// ritual kind's events are created on.
export interface RitualCalendars {
  lunch?: string;
  emails?: string;
  exercise?: string;
  kindleNotes?: string;
  grooming?: string;
  retro?: string;
  delegationReview?: string;
  walk?: string;
  consulting?: string;
  sideProjects?: string;
  newBookies?: string;
  reading?: string;
  learning?: string;
}

// Parse+validate per-kind ritual calendars from untrusted JSON. Keep only the
// entries whose value is a non-empty string; return undefined when nothing valid
// survives so the field stays absent.
function parseRitualCalendars(raw: unknown): RitualCalendars | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const out: RitualCalendars = {};
  for (const kind of [
    'lunch',
    'emails',
    'exercise',
    'kindleNotes',
    'grooming',
    'retro',
    'delegationReview',
    'walk',
    'consulting',
    'sideProjects',
    'newBookies',
    'reading',
    'learning',
  ] as const) {
    const v = src[kind];
    if (typeof v === 'string' && v.trim()) out[kind] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface SchedulingConfig {
  // Legacy flat buffer between tasks. No longer read (superseded by workRun);
  // tolerated on load so old config files still parse.
  bufferBetweenTasks?: string;
  // Continuous-work-run rule (defaults applied on load when absent).
  workRun?: WorkRunConfig;
  workingDays: string[];
  workingHours: {
    start: string;
    end: string;
  };
  // Legacy: single Google integration id that ALL daily ritual events were
  // created on. Superseded by `ritualCalendars` (per-kind routing) but still read
  // as the fallback for lunch/emails so existing config files keep working.
  ritualGoogleIntegrationId?: string;
  // Per-ritual-kind Google integration routing. Lets each ritual live on its own
  // calendar (e.g. lunch/emails on the OM work calendar, exercise on personal).
  // Any unset kind falls back: lunch/emails → `ritualGoogleIntegrationId`,
  // exercise → default Google integration; the WORK rituals (kindleNotes /
  // grooming / retro) → the emails calendar setting, then the legacy id. Break
  // events follow the exercise calendar.
  ritualCalendars?: RitualCalendars;
  // Optional Google SUB-CALENDAR → Asana integration mapping for time
  // attribution, for when one Google account holds calendars belonging to
  // different workspaces (e.g. a consulting calendar inside the personal
  // account). Keyed by Google calendar id. Integration-level routing
  // (`eventGoogleIntegrationId` on the Asana integration) covers the common
  // case; this is the finer-grained override and takes precedence.
  calendarWorkspaceMap?: Record<string, string>;
  // Optional evening-overflow window for tasks that don't fit inside working hours.
  overflow?: OverflowConfig;
  // The "day rollover hour" (0–23, local). Local times before this hour count as
  // the previous day, so the app's notion of "today" doesn't flip at midnight
  // while a late-night session is still in flight. Always populated on load
  // (defaults to 04:00 when absent). See src/lib/date-utils.ts.
  dayRolloverHour?: number;
}

// Budget policy for the delegation pacer (drains the queue at a sustainable
// rate so a big queue never torches usage limits). Rate is tiered by time of
// day: a modest cap during `activeHours` (when you're using Claude yourself)
// and a higher cap outside it (while you sleep), biasing work toward the night.
export interface AgentPacingConfig {
  // Hourly cap during activeHours (when you're likely using Claude yourself).
  maxRunsPerHour: number;
  // Hourly cap outside activeHours (overnight). Defaults to maxRunsPerHour when
  // omitted (i.e. no day/night difference).
  sleepMaxRunsPerHour?: number;
  // Overall daily backstop across both tiers.
  maxRunsPerDay: number;
  // Your active window, "HH:MM"-"HH:MM"; may wrap past midnight
  // (e.g. 07:00-01:00). Outside this window the sleep rate applies.
  activeHours?: { start: string; end: string };
}

export interface WorkflowConfig {
  taskQuotas: Record<string, TaskQuota>;
  scheduling: SchedulingConfig;
  // Always populated by get/saveWorkflowConfig; optional in the type so older
  // fixtures/config files without it still satisfy WorkflowConfig.
  agentPacing?: AgentPacingConfig;
  // Maps each quota category to the task types that count toward it.
  // Values are matched (case-insensitively) against an Asana task's "Type"
  // custom field value and against an ad-hoc task's taskType. A block also
  // matches a category when its type equals the category name directly.
  typeMapping: Record<string, string[]>;
  // Which Asana projects the reminders-triage classifier is shown. Always
  // populated on load (defaults to a 90-day activity window, no overrides).
  triageProjectFilter?: TriageProjectFilterConfig;
  lastUpdated: string;
}

// Parse+validate the triage project filter from untrusted JSON. Coerces gid
// lists to string arrays and activeDays to a positive integer, falling back to
// defaults for anything malformed so a bad config can't hide every project.
function parseTriageProjectFilter(raw: unknown): TriageProjectFilterConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TRIAGE_PROJECT_FILTER };
  const src = raw as Record<string, unknown>;
  const gids = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string' && !!g.trim()) : [];
  const days = Number(src.activeDays);
  return {
    includeGids: gids(src.includeGids),
    excludeGids: gids(src.excludeGids),
    activeDays:
      Number.isFinite(days) && days > 0
        ? Math.floor(days)
        : DEFAULT_TRIAGE_PROJECT_FILTER.activeDays,
  };
}

const DEFAULT_CONFIG: WorkflowConfig = {
  taskQuotas: {
    'Writing/Deep Work': {
      weeklyCount: 3,
      targetLength: '2h',
      preferredTimes: ['08:00-11:00'],
    },
    Blogs: {
      weeklyCount: 2,
      targetLength: '1.5h',
      preferredTimes: ['09:00-12:00'],
    },
    Batch: {
      weeklyCount: 2,
      targetLength: '1h',
      preferredTimes: [],
      autoSelect: true,
    },
    'Engagement/Outreach': {
      weeklyCount: 3,
      targetLength: '1h',
      grouped: true,
      preferredTimes: ['13:00-17:00'],
      autoSelect: false,
    },
    'General Todos': {
      // This fills remaining time - minimal configuration needed
      targetLength: '30min',
      preferredTimes: [],
    },
  },
  scheduling: {
    workRun: { ...DEFAULT_WORK_RUN },
    workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    workingHours: {
      start: '09:00',
      end: '17:00',
    },
    dayRolloverHour: DEFAULT_ROLLOVER_HOUR,
  },
  agentPacing: {
    maxRunsPerHour: 2,        // daytime (active hours) — light, you're using Claude
    sleepMaxRunsPerHour: 6,   // overnight — drain harder while you sleep
    maxRunsPerDay: 40,        // overall backstop across both tiers
    activeHours: { start: '07:00', end: '01:00' },
  },
  // By default, each category matches an Asana Type / ad-hoc taskType with the
  // same name (handled by the direct category-name match in capacity logic),
  // plus the one built-in task type whose id matches a category name.
  typeMapping: {
    'Writing/Deep Work': [],
    Blogs: [],
    Batch: ['batch'],
    'Engagement/Outreach': [],
    'General Todos': [],
  },
  triageProjectFilter: { ...DEFAULT_TRIAGE_PROJECT_FILTER },
  lastUpdated: new Date().toISOString(),
};

async function ensureDataDir(): Promise<void> {
  try {
    await fs.access(DATA_DIR);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// One-time migration: the config previously lived at the repo root.
// If the data-dir copy doesn't exist yet but the legacy file does, copy it over.
async function migrateLegacyConfig(): Promise<void> {
  if (await fileExists(WORKFLOW_CONFIG_FILE)) {
    return;
  }

  const legacyPath = path.join(process.cwd(), 'workflow-config.json');
  if (!(await fileExists(legacyPath))) {
    return;
  }

  try {
    await fs.copyFile(legacyPath, WORKFLOW_CONFIG_FILE);
  } catch (error) {
    console.error('Error migrating workflow config to data dir:', error);
  }
}

export async function getWorkflowConfig(): Promise<WorkflowConfig> {
  try {
    await ensureDataDir();
    await migrateLegacyConfig();

    if (!(await fileExists(WORKFLOW_CONFIG_FILE))) {
      // Create default config if it doesn't exist
      await saveWorkflowConfig(DEFAULT_CONFIG);
      return { ...DEFAULT_CONFIG };
    }

    const data = await fs.readFile(WORKFLOW_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(data) as Partial<WorkflowConfig>;

    // Backward compat: older config files predate typeMapping. Default it to
    // an entry per existing quota category (empty array => category-name match).
    let typeMapping = parsed.typeMapping;
    if (!typeMapping) {
      typeMapping = {};
      for (const category of Object.keys(parsed.taskQuotas || {})) {
        typeMapping[category] = DEFAULT_CONFIG.typeMapping[category] || [];
      }
    }

    // Backward compat: older config files predate autoSelect. Default it to
    // true only for Batch (which historically auto-picked its tasks).
    const taskQuotas = parsed.taskQuotas || DEFAULT_CONFIG.taskQuotas;
    for (const [category, quota] of Object.entries(taskQuotas)) {
      if (quota.autoSelect === undefined) quota.autoSelect = category === 'Batch';
      // Tolerant load: keep maxSelection only when it's a positive integer,
      // otherwise drop it so a malformed value can't break the selection cap.
      if (quota.maxSelection !== undefined) {
        const n = Number(quota.maxSelection);
        if (Number.isFinite(n) && n > 0) quota.maxSelection = Math.floor(n);
        else delete quota.maxSelection;
      }
      // Tolerant load: `daily` only survives as a real boolean true.
      if (quota.daily !== undefined && quota.daily !== true) delete quota.daily;
      // Tolerant load: keep scaleToTasks only when both bounds are positive
      // integers, otherwise drop it so a malformed value can't zero out a category.
      if (quota.scaleToTasks !== undefined) {
        const raw = quota.scaleToTasks as { tasksPerBlock?: unknown; maxBlocks?: unknown };
        const per = Number(raw?.tasksPerBlock);
        const max = Number(raw?.maxBlocks);
        if (Number.isFinite(per) && per > 0 && Number.isFinite(max) && max > 0) {
          quota.scaleToTasks = { tasksPerBlock: Math.floor(per), maxBlocks: Math.floor(max) };
        } else {
          delete quota.scaleToTasks;
        }
      }
    }

    // Normalize scheduling: fill the work-run rule with defaults when a legacy
    // config predates it (old files carry only `bufferBetweenTasks`, now ignored).
    const scheduling: SchedulingConfig = parsed.scheduling
      ? {
          ...parsed.scheduling,
          workRun: {
            maxMinutes: parsed.scheduling.workRun?.maxMinutes ?? DEFAULT_WORK_RUN.maxMinutes,
            bufferMinutes: parsed.scheduling.workRun?.bufferMinutes ?? DEFAULT_WORK_RUN.bufferMinutes,
          },
          // Tolerant load: keep a ritual integration id only when it's a non-empty
          // string, otherwise drop it so rituals fall back to the default calendar.
          ritualGoogleIntegrationId:
            typeof parsed.scheduling.ritualGoogleIntegrationId === 'string' &&
            parsed.scheduling.ritualGoogleIntegrationId.trim()
              ? parsed.scheduling.ritualGoogleIntegrationId
              : undefined,
          // Tolerant load: keep per-kind ritual calendars, dropping any entry
          // that isn't a non-empty string. Omit the field entirely when nothing valid.
          ritualCalendars: parseRitualCalendars(parsed.scheduling.ritualCalendars),
          // Tolerant load: keep only string→string calendar/workspace pairs.
          calendarWorkspaceMap: Object.fromEntries(
            Object.entries(
              (parsed.scheduling.calendarWorkspaceMap as Record<string, unknown> | undefined) ?? {}
            ).filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && !!v)
          ) as Record<string, string>,
          // Tolerant load: keep the overflow window only when both ends parse.
          overflow: parseOverflow(parsed.scheduling.overflow),
          // Always populate: coerce to a valid 0–23 hour, default 04:00.
          dayRolloverHour: normalizeRolloverHour(parsed.scheduling.dayRolloverHour),
        }
      : DEFAULT_CONFIG.scheduling;

    return {
      taskQuotas,
      scheduling,
      agentPacing: parsed.agentPacing || DEFAULT_CONFIG.agentPacing,
      typeMapping,
      triageProjectFilter: parseTriageProjectFilter(parsed.triageProjectFilter),
      lastUpdated: parsed.lastUpdated || new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error reading workflow config:', error);
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveWorkflowConfig(
  config: Omit<WorkflowConfig, 'lastUpdated'> & { lastUpdated?: string }
): Promise<WorkflowConfig> {
  await ensureDataDir();

  const configToWrite: WorkflowConfig = {
    ...config,
    typeMapping: config.typeMapping ?? {},
    agentPacing: config.agentPacing ?? DEFAULT_CONFIG.agentPacing,
    triageProjectFilter: parseTriageProjectFilter(config.triageProjectFilter),
    lastUpdated: new Date().toISOString(),
  };

  await fs.writeFile(WORKFLOW_CONFIG_FILE, JSON.stringify(configToWrite, null, 2), 'utf-8');
  return configToWrite;
}
