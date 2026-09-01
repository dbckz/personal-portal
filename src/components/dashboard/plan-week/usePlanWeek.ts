'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addDays, format, parseISO, startOfWeek } from 'date-fns';

import {
  api,
  type ProposeWeekResponse,
  type ProposeWeekRequest,
  type QuotaSummaryRow,
  type ConfirmWeekResult,
  type PrepCandidatesResponse,
  type WeekCandidateCategory,
  type WeekCandidate,
  type SpareCapacity,
  type UnplaceableTaskRow,
  type PendingInvite,
} from '@/lib/api';
import type { ProposedBlock } from '@/lib/scheduling/types';
import type { AsanaProject, CalendarEvent, Reminder } from '@/types';
import type { CalendarReminderCandidate } from '@/lib/scheduling/calendar-reminders';
import type { AsanaTypeFieldInfo } from '@/components/CreateAsanaTaskModal';
import {
  isProjectInTriageCatalogue,
  DEFAULT_TRIAGE_PROJECT_FILTER,
} from '@/lib/triage-project-filter';
import { typeChoicesFor } from '@/lib/type-choices';

import {
  type Step,
  STEP_LABELS,
  PRIORITIES_MATCH_LABEL,
  type UntypedTask,
  type TypeRow,
  type EditableProposal,
  type MatchRow,
  type MatchMeta,
  type ReminderTriageRow,
} from './types';
import type { WizardDayLocation } from '@/lib/api';

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// The remaining working-day dates (yyyy-MM-dd) of the target week, derived from
// the configured working-day names. Kept light (config is a local read) so the
// Location step can list one row per day without a full week-context gather. Past
// days are dropped; out-of-office days aren't known here (the propose route
// re-filters day locations to real working dates anyway).
function computeWorkingDayDates(weekStart: string | undefined, workingDayNames: string[]): string[] {
  const names = new Set(
    (workingDayNames ?? []).map(d => d.charAt(0).toUpperCase() + d.slice(1).toLowerCase())
  );
  const monday = weekStart
    ? startOfWeek(new Date(`${weekStart}T00:00:00`), { weekStartsOn: 1 })
    : startOfWeek(new Date(), { weekStartsOn: 1 });
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(monday, i);
    const dateStr = format(day, 'yyyy-MM-dd');
    if (dateStr < todayStr) continue;
    if (!names.has(WEEKDAY_NAMES[day.getDay()])) continue;
    out.push(dateStr);
  }
  return out;
}

// One classifier suggestion for a reminder, as returned by the triage endpoint.
type ReminderSuggestion = Awaited<
  ReturnType<typeof api.suggestReminderTriage>
>['suggestions'][number];

export interface UsePlanWeekOptions {
  isOpen: boolean;
  onApplied?: () => void; // called after a successful confirm so the caller can refresh
  // Incomplete Asana tasks + per-integration Type field info, used by the "type
  // unclassified tasks" pre-step to find untyped tasks and write labels back.
  asanaTasks?: CalendarEvent[];
  typeFieldInfoByIntegration?: Map<string, AsanaTypeFieldInfo>;
  // Asana integrations/workspaces (id + name), used by the reminders-triage step
  // to offer conversion destinations. Absent → the reminders step is skipped.
  asanaIntegrations?: Array<{ id: string; name: string }>;
  // The week to plan (yyyy-MM-dd Monday). Absent → the current week, as before.
  weekStart?: string;
}

// All state, API orchestration, derived values and navigation for the plan-my-week
// wizard, shared by the desktop modal (PlanWeekModal) and the mobile wizard
// (MobilePlanWeekWizard). The presentation layers render whatever this returns;
// they own only their own chrome (overlay, Escape/close, step layout).
export function usePlanWeek({
  isOpen,
  weekStart,
  onApplied,
  asanaTasks,
  typeFieldInfoByIntegration,
  asanaIntegrations,
}: UsePlanWeekOptions) {
  const [step, setStep] = useState<Step>('calendar');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 0 — calendar review. This week's meetings still awaiting the user's RSVP,
  // fetched on entering the step. null = not loaded yet; a fetch failure sets
  // invitesError and the step degrades to a static instruction (never blocks).
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[] | null>(null);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesError, setInvitesError] = useState<string | null>(null);

  // Location step — per-day work location (Home / Office / Travelling). Missing
  // entry = home. The step lists the target week's working days; a light config
  // read (below) resolves those dates without a full week-context gather.
  const [dayLocations, setDayLocations] = useState<Record<string, WizardDayLocation>>({});
  const [locationWorkingDays, setLocationWorkingDays] = useState<string[]>([]);

  // Step 0 — type unclassified tasks. Incomplete tasks whose Asana "Type" custom
  // field is empty, but whose integration has writable Type labels. These are
  // invisible to the allocation categories until typed.
  const untypedTasks = useMemo<UntypedTask[]>(() => {
    if (!asanaTasks || !typeFieldInfoByIntegration) return [];
    const out: UntypedTask[] = [];
    for (const t of asanaTasks) {
      if (t.completed || !t.integrationId) continue;
      const typeValue = t.customFields?.find(cf => cf.name.toLowerCase() === 'type')?.displayValue;
      if (typeValue) continue; // already typed (Asana Type, or an overlaid local Type)
      // One rule for the labels we can write and where (Asana field vs local
      // store). No labels available anywhere → the task can't be typed, so skip it.
      const { labels, writeTarget } = typeChoicesFor(t.integrationId, typeFieldInfoByIntegration);
      if (labels.length === 0) continue;
      out.push({
        gid: t.id,
        integrationId: t.integrationId,
        title: t.title,
        description: t.description,
        integrationName: t.integrationName,
        allowedTypes: labels,
        writeTarget,
      });
    }
    return out;
  }, [asanaTasks, typeFieldInfoByIntegration]);

  const hasTypeStep = untypedTasks.length > 0;

  // Uncompleted Google Tasks reminders, fetched once on open. null = not yet
  // loaded / Google Tasks not connected. The reminders-triage step is included
  // only when there's at least one reminder AND an Asana workspace to file into.
  const [reminderList, setReminderList] = useState<Reminder[] | null>(null);
  // Standing reminders parked on the calendar as daily recurring events. They
  // are triaged in the same step as the Google Tasks reminders, because the
  // decision is identical: is this a real task, and where does it belong?
  const [calendarReminders, setCalendarReminders] = useState<CalendarReminderCandidate[]>([]);
  const hasRemindersStep =
    ((reminderList?.length ?? 0) > 0 || calendarReminders.length > 0) &&
    (asanaIntegrations?.length ?? 0) > 0;

  // One entry per SCREEN the user actually pages through, for the header step
  // dots. This differs from the step list because the 'priorities' step is two
  // screens (input then match-review). The type screen is prepended only when
  // there are untyped tasks to classify; the reminders screen is inserted after
  // priorities only when there are reminders.
  const screenOrder = useMemo<Array<{ key: string; title: string }>>(
    () => [
      { key: 'calendar', title: STEP_LABELS.calendar },
      ...(hasTypeStep ? [{ key: 'type', title: STEP_LABELS.type }] : []),
      { key: 'location', title: STEP_LABELS.location },
      { key: 'priorities-input', title: STEP_LABELS.priorities },
      { key: 'priorities-review', title: PRIORITIES_MATCH_LABEL },
      ...(hasRemindersStep ? [{ key: 'reminders', title: STEP_LABELS.reminders }] : []),
      { key: 'prep', title: STEP_LABELS.prep },
      { key: 'tasks', title: STEP_LABELS.tasks },
      { key: 'review', title: STEP_LABELS.review },
    ],
    [hasTypeStep, hasRemindersStep]
  );

  // The step that follows priorities — reminders when present, else prep.
  const afterPriorities: Step = hasRemindersStep ? 'reminders' : 'prep';

  // Step 0 — type review
  const [typeRows, setTypeRows] = useState<TypeRow[] | null>(null); // null = not yet classified
  const [typeLoading, setTypeLoading] = useState(false);
  const [typeError, setTypeError] = useState<string | null>(null);
  const [isApplyingTypes, setIsApplyingTypes] = useState(false);

  // Step 1 — priorities
  const [priorityText, setPriorityText] = useState('');
  const [matchRows, setMatchRows] = useState<MatchRow[] | null>(null); // null = input phase
  const [matchMeta, setMatchMeta] = useState<MatchMeta>({
    asanaIntegrations: [],
    categories: [],
    projects: [],
    aiUnavailable: false,
  });
  const [createdTasks, setCreatedTasks] = useState<
    Array<{ text: string; gid: string; title: string; integrationId: string }>
  >([]);
  const [priorityIds, setPriorityIds] = useState<string[]>([]);
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, string>>({});

  // Step 1b — reminders triage. rows = per-reminder keep/convert decisions
  // (null until AI suggestions have been fetched). Projects are fetched once and
  // shared by every row's destination dropdown.
  const [reminderRows, setReminderRows] = useState<ReminderTriageRow[] | null>(null);
  const [remindersLoading, setRemindersLoading] = useState(false);
  const [remindersError, setRemindersError] = useState<string | null>(null);
  const [remindersProgress, setRemindersProgress] = useState<{ done: number; total: number } | null>(null);
  const [reminderProjects, setReminderProjects] = useState<AsanaProject[]>([]);
  // Bumped every time the modal opens/resets. A reminder-classification run
  // captures the value at its start and drops any state writes once it changes,
  // so a prefetch still in flight can't clobber a fresh open's reset.
  const remindersRunRef = useRef(0);
  const [isConvertingReminders, setIsConvertingReminders] = useState(false);

  // Step 2 — prep
  const [prepData, setPrepData] = useState<PrepCandidatesResponse | null>(null);
  const [showOtherMeetings, setShowOtherMeetings] = useState(false);
  const [prepEngaged, setPrepEngaged] = useState(false);
  // Per-meeting prep-length overrides, keyed by eventId. Only explicit picks are
  // stored; a meeting without an entry defaults to 15 mins.
  const [prepDurations, setPrepDurations] = useState<Record<string, number>>({});
  // Per-meeting prep-DAY overrides (yyyy-MM-dd), keyed by eventId. Only explicit
  // picks are stored; a meeting without an entry uses the default day-before →
  // day-of placement.
  const [prepDays, setPrepDays] = useState<Record<string, string>>({});

  // Step 3 — tasks
  const [taskCats, setTaskCats] = useState<WeekCandidateCategory[] | null>(null);
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [tasksEngaged, setTasksEngaged] = useState(false);
  // Per-week block-length overrides (mins), keyed by category. Now used only for
  // GROUPED categories (shared containers); single-task categories override per
  // task via taskDurationOverrides below. Only holds explicit user picks.
  const [taskDurations, setTaskDurations] = useState<Record<string, number>>({});
  // Per-task block-length overrides (mins), keyed by candidate id (gid/adhocId),
  // for single-task (non-grouped) categories. Only holds explicit picks; a task
  // not present here uses its category's default block length.
  const [taskDurationOverrides, setTaskDurationOverrides] = useState<Record<string, number>>({});
  // Step 3 — "🚶 Walks": days (yyyy-MM-dd) the user opted a walk into. Walks are
  // opt-in per day, so this starts empty (no walks) and the chosen days are sent
  // to the propose route. Reset on open.
  const [walkDays, setWalkDays] = useState<Set<string>>(new Set());

  // Step 3 — "Must do this week": task ids (gid/adhocId) the user flagged as
  // must-do. Flagging auto-selects the task and bypasses the selection cap; the
  // ids are sent to the propose route to mark them isPriority (sorted first,
  // never dropped). Reset on open.
  const [mustDoIds, setMustDoIds] = useState<Set<string>>(new Set());
  // Ids of Asana tasks currently being marked done from the wizard (spinner).
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  // Ids of candidate tasks currently being deleted (spinner).
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  // Candidate whose read-only detail modal is open (double-click to view).
  const [peekCandidate, setPeekCandidate] = useState<WeekCandidate | null>(null);

  // Step 3 — "Add more tasks": set when the user returns to the tasks step from
  // review to spend spare capacity. Lifts the per-category selection cap so
  // explicit over-quota picks are allowed, and shows a banner on the tasks step.
  const [addMoreMode, setAddMoreMode] = useState(false);

  // Step 4 — review / done
  const [proposals, setProposals] = useState<EditableProposal[]>([]);
  const [quotaSummary, setQuotaSummary] = useState<QuotaSummaryRow[]>([]);
  const [spareCapacity, setSpareCapacity] = useState<SpareCapacity | null>(null);
  const [unplaceable, setUnplaceable] = useState<UnplaceableTaskRow[]>([]);
  // Remaining working days (OOO excluded) — the evening-overflow rows' day picker.
  const [overflowDayOptions, setOverflowDayOptions] = useState<string[]>([]);
  // Working days (yyyy-MM-dd) with no exercise placement — the review step warns
  // per day since exercise is the number-one priority ritual.
  const [exerciseMissingDays, setExerciseMissingDays] = useState<string[]>([]);
  const [weekLabel, setWeekLabel] = useState('');
  const [isConfirming, setIsConfirming] = useState(false);
  const [results, setResults] = useState<Record<string, ConfirmWeekResult>>({});

  // Reset everything whenever the modal opens fresh.
  useEffect(() => {
    if (!isOpen) return;
    // Invalidate any reminder-classification run started for a previous open.
    remindersRunRef.current += 1;
    setStep('calendar');
    setPendingInvites(null);
    setInvitesLoading(false);
    setInvitesError(null);
    setDayLocations({});
    // Resolve the week's working-day dates for the Location step from a light
    // config read (no Google/Asana round trip). A failure just leaves the step
    // with no rows.
    setLocationWorkingDays([]);
    api
      .getWorkflowConfig()
      .then(c => setLocationWorkingDays(computeWorkingDayDates(weekStart, c.scheduling?.workingDays ?? [])))
      .catch(() => setLocationWorkingDays([]));
    setTypeRows(null);
    setTypeLoading(false);
    setTypeError(null);
    setIsApplyingTypes(false);
    setIsLoading(false);
    setError(null);
    setPriorityText('');
    setMatchRows(null);
    setMatchMeta({ asanaIntegrations: [], categories: [], projects: [], aiUnavailable: false });
    setCreatedTasks([]);
    setPriorityIds([]);
    setCategoryOverrides({});
    setReminderList(null);
    setReminderRows(null);
    setRemindersLoading(false);
    setRemindersError(null);
    setRemindersProgress(null);
    setReminderProjects([]);
    setIsConvertingReminders(false);
    // Fetch reminders once to decide whether to show the triage step. A failure
    // (e.g. Google Tasks not connected) silently omits the step.
    setCalendarReminders([]);
    if (asanaIntegrations && asanaIntegrations.length > 0) {
      api
        .getReminders()
        .then(({ reminders }) => setReminderList(reminders.filter(r => !r.completed)))
        .catch(() => setReminderList([]));
      // Advisory: a failure here just means no calendar-derived rows.
      api
        .getCalendarReminders(weekStart)
        .then(({ candidates }) => setCalendarReminders(candidates))
        .catch(() => setCalendarReminders([]));
    } else {
      setReminderList([]);
    }
    setPrepData(null);
    setShowOtherMeetings(false);
    setPrepEngaged(false);
    setPrepDurations({});
    setPrepDays({});
    setTaskCats(null);
    setSelections({});
    setTasksEngaged(false);
    setTaskDurations({});
    setTaskDurationOverrides({});
    setWalkDays(new Set());
    setMustDoIds(new Set());
    setCompletingIds(new Set());
    setDeletingIds(new Set());
    setPeekCandidate(null);
    setAddMoreMode(false);
    setProposals([]);
    setQuotaSummary([]);
    setSpareCapacity(null);
    setUnplaceable([]);
    setOverflowDayOptions([]);
    setExerciseMissingDays([]);
    setWeekLabel('');
    setIsConfirming(false);
    setResults({});
    // Only re-run on open/close; hasTypeStep is read fresh to pick the first step
    // but must not reset an in-progress wizard when the untyped set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // --- Step 0 actions (type unclassified tasks) ---

  // Classify the untyped tasks. Grouped by integration (allowed labels differ per
  // workspace), one headless call each, run concurrently server-side. Each row is
  // pre-filled with Claude's suggestion (blank if the model omitted/invalidated
  // it, so the user picks). A classifier failure still lets the user type by hand.
  const runTypeClassifier = useCallback(async () => {
    setTypeLoading(true);
    setTypeError(null);
    try {
      const groups = new Map<string, { integrationId: string; allowedTypes: string[]; tasks: Array<{ gid: string; title: string; description?: string; integrationName?: string }> }>();
      for (const t of untypedTasks) {
        let g = groups.get(t.integrationId);
        if (!g) {
          g = { integrationId: t.integrationId, allowedTypes: t.allowedTypes, tasks: [] };
          groups.set(t.integrationId, g);
        }
        g.tasks.push({ gid: t.gid, title: t.title, description: t.description, integrationName: t.integrationName });
      }
      const { suggestions } = await api.classifyTaskTypes([...groups.values()]);
      const byGid = new Map(suggestions.map(s => [s.gid, s.type]));
      setTypeRows(
        untypedTasks.map(t => {
          const suggested = byGid.get(t.gid);
          const valid = suggested && t.allowedTypes.includes(suggested) ? suggested : '';
          return { ...t, chosen: valid, suggested: valid || undefined };
        })
      );
    } catch (err) {
      // Degrade gracefully: no suggestions, but the user can still classify manually.
      setTypeRows(untypedTasks.map(t => ({ ...t, chosen: '' })));
      setTypeError(err instanceof Error ? err.message : 'Failed to suggest types');
    } finally {
      setTypeLoading(false);
    }
  }, [untypedTasks]);

  // Write each kept (non-blank) label to its Asana task's Type field, then advance
  // to the priorities step. On partial failure we surface a count and stay put so
  // the user can retry or Skip; on success we refresh so newly-typed tasks appear
  // in the allocation categories.
  const applyTypes = useCallback(async () => {
    if (!typeRows || !typeFieldInfoByIntegration) return;
    const toWrite = typeRows.filter(r => r.chosen);
    if (toWrite.length === 0) {
      setStep('location');
      return;
    }
    setIsApplyingTypes(true);
    setError(null);
    try {
      // Asana-target rows write to the task's Asana Type field; local-target rows
      // (integrations with no writable Asana Type, e.g. DBC) save to the app-local
      // Type store in one batch. Both paths share the partial-failure handling.
      const asanaRows = toWrite.filter(r => r.writeTarget !== 'local');
      const localRows = toWrite.filter(r => r.writeTarget === 'local');

      const asanaOutcomes = await Promise.allSettled(
        asanaRows.map(r => {
          const info = typeFieldInfoByIntegration.get(r.integrationId);
          const optionGid = info?.enumOptions.get(r.chosen);
          if (!info || !optionGid) {
            return Promise.reject(new Error(`No Type option for "${r.chosen}"`));
          }
          return api.updateAsanaTask(r.gid, r.integrationId, {
            customFields: { [info.fieldGid]: optionGid },
          });
        })
      );

      let localFailed = 0;
      if (localRows.length > 0) {
        try {
          await api.setLocalTaskTypes(Object.fromEntries(localRows.map(r => [r.gid, r.chosen])));
        } catch {
          localFailed = localRows.length; // the batch write is all-or-nothing
        }
      }

      // Learn from what he actually decided: record each written label against its
      // task title so the Type classifier follows his precedent next time. An
      // override (chosen ≠ suggested) is the stronger signal. Best-effort — never
      // let a verdict write block or fail the type application.
      api.recordTypeVerdicts(
        toWrite.map(r => ({ title: r.title, type: r.chosen, override: r.chosen !== r.suggested }))
      ).catch(() => {});

      const failed = asanaOutcomes.filter(o => o.status === 'rejected').length + localFailed;
      onApplied?.(); // refresh so applied types show up in the allocation categories
      if (failed > 0) {
        setError(`${failed} of ${toWrite.length} type update${toWrite.length === 1 ? '' : 's'} failed — retry, or Skip to continue.`);
        return; // stay on the type step
      }
      setStep('location');
    } finally {
      setIsApplyingTypes(false);
    }
  }, [typeRows, typeFieldInfoByIntegration, onApplied]);

  // --- Step 1b actions (reminders triage) ---

  // Turn calendar candidates into triage rows. They start as 'keep' — the
  // default must never be to silently create tasks from calendar events — and
  // carry the occurrence count so the nagging pattern is visible in the step.
  const calendarRows = useCallback(
    (candidates: CalendarReminderCandidate[], defaultIntegrationId: string): ReminderTriageRow[] =>
      candidates.map(c => ({
        id: `cal:${c.title}`,
        name: c.title,
        notes: '',
        action: 'keep' as const,
        integrationId: defaultIntegrationId,
        projectGid: '',
        taskType: '',
        dueOn: '',
        source: 'calendar' as const,
        occurrences: c.occurrences,
      })),
    []
  );

  const runReminderSuggest = useCallback(async () => {
    if (!reminderList || !asanaIntegrations || asanaIntegrations.length === 0) return;
    // Capture the current open-instance so writes from a run whose modal has
    // since been reset/reopened are dropped rather than clobbering fresh state.
    const runId = remindersRunRef.current;
    const isStale = () => remindersRunRef.current !== runId;
    setRemindersLoading(true);
    setRemindersError(null);
    setRemindersProgress(null);
    const defaultIntegrationId = asanaIntegrations[0].id;
    try {
      const [{ projects }, triageFilter] = await Promise.all([
        api.getAsanaProjects().catch(() => ({ projects: [] as AsanaProject[] })),
        // The classifier catalogue is trimmed to recently-active projects (plus
        // manual overrides). A missing config just falls back to the defaults.
        api
          .getWorkflowConfig()
          .then(c => c.triageProjectFilter ?? DEFAULT_TRIAGE_PROJECT_FILTER)
          .catch(() => DEFAULT_TRIAGE_PROJECT_FILTER),
      ]);
      if (isStale()) return;
      // Dropdowns keep the FULL project list; only the catalogue below is filtered.
      setReminderProjects(projects);

      const workspaces = asanaIntegrations.map(intg => ({
        integrationId: intg.id,
        name: intg.name,
        projects: projects
          .filter(p => p.integrationId === intg.id && isProjectInTriageCatalogue(p, triageFilter))
          .map(p => ({ gid: p.gid, name: p.name })),
        types: typeChoicesFor(intg.id, typeFieldInfoByIntegration).labels,
      }));

      // Classify in chunks so a long list (~37 reminders) shows real progress
      // instead of one silent 3-minute call. Run a small concurrency pool; a
      // failed chunk leaves its reminders with no suggestion (they fall through
      // to the defaults below), and only an all-chunks failure surfaces an error.
      const CHUNK_SIZE = 8;
      const MAX_IN_FLIGHT = 3;
      const chunks: Array<Array<{ id: string; title: string; notes?: string }>> = [];
      for (let i = 0; i < reminderList.length; i += CHUNK_SIZE) {
        chunks.push(
          reminderList.slice(i, i + CHUNK_SIZE).map(r => ({ id: r.id, title: r.text, notes: r.notes }))
        );
      }
      setRemindersProgress({ done: 0, total: chunks.length });

      const byId = new Map<string, ReminderSuggestion>();
      let failedChunks = 0;
      let nextChunk = 0;
      const runWorker = async () => {
        while (nextChunk < chunks.length) {
          const chunk = chunks[nextChunk++];
          try {
            const { suggestions } = await api.suggestReminderTriage(chunk, workspaces);
            for (const s of suggestions) byId.set(s.id, s);
          } catch {
            failedChunks++;
          } finally {
            if (!isStale()) {
              setRemindersProgress(prev => (prev ? { ...prev, done: prev.done + 1 } : prev));
            }
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MAX_IN_FLIGHT, chunks.length) }, runWorker)
      );
      if (chunks.length > 0 && failedChunks === chunks.length) {
        throw new Error('Failed to suggest destinations');
      }
      if (isStale()) return;

      setReminderRows(
        (reminderList.map(r => {
          const s = byId.get(r.id);
          const validWorkspace = !!s && asanaIntegrations.some(i => i.id === s.integrationId);
          const integrationId = validWorkspace ? s!.integrationId : defaultIntegrationId;
          const validProject =
            !!s && projects.some(p => p.gid === s.projectGid && p.integrationId === integrationId);
          const validType =
            !!s &&
            !!s.taskType &&
            typeChoicesFor(integrationId, typeFieldInfoByIntegration).labels.includes(s.taskType);
          // Default to the AI's action, but only trust "convert" when it resolved
          // to a real workspace; otherwise keep it as a reminder.
          const action = validWorkspace && s!.action === 'convert' ? ('convert' as const) : ('keep' as const);
          return {
            id: r.id,
            name: r.text,
            notes: r.notes ?? '',
            action,
            integrationId,
            projectGid: validProject ? s!.projectGid : '',
            taskType: validType ? s!.taskType : '',
            dueOn: r.due ?? '',
            source: 'google-tasks' as const,
          };
        }) as ReminderTriageRow[]).concat(calendarRows(calendarReminders, defaultIntegrationId))
      );
    } catch (err) {
      if (isStale()) return;
      // Degrade gracefully: no suggestions, but every reminder is still editable.
      setReminderRows(
        (reminderList.map(r => ({
          id: r.id,
          name: r.text,
          notes: r.notes ?? '',
          action: 'keep' as const,
          integrationId: defaultIntegrationId,
          projectGid: '',
          taskType: '',
          dueOn: r.due ?? '',
          source: 'google-tasks' as const,
        })) as ReminderTriageRow[]).concat(calendarRows(calendarReminders, defaultIntegrationId))
      );
      setRemindersError(err instanceof Error ? err.message : 'Failed to suggest destinations');
    } finally {
      if (!isStale()) {
        setRemindersLoading(false);
        setRemindersProgress(null);
      }
    }
  }, [
    reminderList,
    calendarReminders,
    calendarRows,
    asanaIntegrations,
    typeFieldInfoByIntegration,
  ]);

  // --- Data fetching per step ---

  // Calendar review: this week's meetings still awaiting an RSVP. Degrades to a
  // static instruction on failure (invitesError) — planning is never blocked.
  const fetchPendingInvites = useCallback(async () => {
    setInvitesLoading(true);
    setInvitesError(null);
    try {
      const { invites } = await api.getPendingInvites(weekStart);
      setPendingInvites(invites);
    } catch (err) {
      setPendingInvites([]);
      setInvitesError(err instanceof Error ? err.message : 'Failed to load invites');
    } finally {
      setInvitesLoading(false);
    }
  }, [weekStart]);

  const fetchPrep = useCallback(async (durations = prepDurations, days = prepDays) => {
    setIsLoading(true);
    setError(null);
    try {
      // Thread the Location step's picks so prep is proposed against the same busy
      // timeline (office get-ready/commute + daily rituals) the final plan uses.
      const data = await api.getPrepCandidates(weekStart, durations, days, dayLocations);
      setPrepData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load meeting prep');
    } finally {
      setIsLoading(false);
    }
  }, [prepDurations, prepDays, dayLocations, weekStart]);

  // Changing a prep row's length/day updates LOCAL state only — no refetch on
  // every change (that felt like a page reload). The proposed slots are
  // re-computed once, from both maps, when the user clicks Next off the prep step
  // (see advancePrep). The per-row proposed-slot text may be briefly stale after
  // a change; a note tells the user slots finalize on Next.
  const changePrepDuration = useCallback((eventId: string, durationMinutes: number) => {
    setPrepDurations(prev => ({ ...prev, [eventId]: durationMinutes }));
  }, []);

  const changePrepDay = useCallback((eventId: string, date: string) => {
    setPrepDays(prev => ({ ...prev, [eventId]: date }));
  }, []);

  // Next off the prep step: re-propose prep slots once with the full duration/day
  // maps (showing the button's busy state while it runs) so acceptedPrepBlocks
  // are fresh before advancing to the tasks step.
  const advancePrep = useCallback(async () => {
    await fetchPrep(prepDurations, prepDays);
    setPrepEngaged(true);
    setStep('tasks');
  }, [fetchPrep, prepDurations, prepDays]);

  const fetchTasks = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.getWeekCandidates({
        weekStart,
        priorityGids: priorityIds.length ? priorityIds : undefined,
        categoryOverrides: Object.keys(categoryOverrides).length ? categoryOverrides : undefined,
      });
      setTaskCats(data.categories);
      // A task the end-of-week review flagged "must do next week" arrives
      // pre-flagged, so a selection cap can never quietly drop it again.
      const mustDoFromReview = data.categories.flatMap(c =>
        c.candidates.filter(cand => cand.mustDo).map(cand => cand.id)
      );
      if (mustDoFromReview.length > 0) {
        setMustDoIds(prev => new Set([...prev, ...mustDoFromReview]));
      }
      // Pre-check priorities (capped at each category's remaining quota).
      const sel: Record<string, Set<string>> = {};
      for (const c of data.categories) {
        if (c.autoSelect) continue;
        const picked = new Set<string>();
        let count = 0;
        for (const cand of c.candidates) {
          // No-quota categories have no cap (remainingQuota === null).
          if (cand.isPriority && (c.remainingQuota === null || count < c.remainingQuota)) {
            picked.add(cand.id);
            count++;
          }
        }
        sel[c.category] = picked;
      }
      setSelections(sel);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load task candidates');
    } finally {
      setIsLoading(false);
    }
  }, [priorityIds, categoryOverrides, weekStart]);

  const acceptedPrepBlocks = useMemo(
    () => (prepData?.meetings ?? []).filter(m => m.needsPrep && m.block).map(m => m.block!),
    [prepData]
  );

  const fetchReview = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setResults({});
    try {
      const body: ProposeWeekRequest = weekStart ? { weekStart } : {};
      if (priorityIds.length) body.priorityGids = priorityIds;
      if (mustDoIds.size) body.mustDoIds = Array.from(mustDoIds);
      if (Object.keys(categoryOverrides).length) body.categoryOverrides = categoryOverrides;
      if (prepEngaged) body.prepBlocks = acceptedPrepBlocks;
      if (tasksEngaged && taskCats) {
        const selObj: Record<string, string[]> = {};
        for (const c of taskCats) {
          if (c.autoSelect) continue;
          selObj[c.category] = Array.from(selections[c.category] ?? []);
        }
        body.selections = selObj;
      }
      if (Object.keys(taskDurations).length) body.durationOverrides = taskDurations;
      if (Object.keys(taskDurationOverrides).length) body.taskDurationOverrides = taskDurationOverrides;
      if (walkDays.size) body.walkDays = Array.from(walkDays);
      if (Object.keys(dayLocations).length) body.dayLocations = dayLocations;
      const data: ProposeWeekResponse = await api.proposeWeeklyPlan(body);
      // Overflow blocks are OPTIONAL — default them to rejected so the user opts in.
      setProposals(data.proposals.map(p => ({ ...p, accepted: !p.overflow })));
      setQuotaSummary(data.quotaSummary);
      setSpareCapacity(data.spareCapacity ?? null);
      setUnplaceable(data.unplaceable ?? []);
      setOverflowDayOptions(data.workingDays ?? []);
      setExerciseMissingDays(data.exerciseMissingDays ?? []);
      setWeekLabel(
        `${format(parseISO(data.weekStart), 'MMM d')} – ${format(parseISO(data.weekEnd), 'MMM d')}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build your plan');
    } finally {
      setIsLoading(false);
    }
  }, [priorityIds, mustDoIds, categoryOverrides, prepEngaged, acceptedPrepBlocks, tasksEngaged, taskCats, selections, taskDurations, taskDurationOverrides, walkDays, dayLocations, weekStart]);

  // Lazy-fetch on entering a step. Prep/tasks fetch once (cached); review
  // re-proposes each entry since it depends on prior steps' choices.
  useEffect(() => {
    if (!isOpen) return;
    if (step === 'calendar' && pendingInvites === null && !invitesLoading) fetchPendingInvites();
    else if (step === 'type' && typeRows === null && !typeLoading) runTypeClassifier();
    else if (step === 'reminders' && reminderRows === null && !remindersLoading) runReminderSuggest();
    else if (step === 'prep' && prepData === null) fetchPrep();
    else if (step === 'tasks' && taskCats === null) fetchTasks();
    else if (step === 'review') fetchReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isOpen]);

  // Prefetch reminder classification as soon as its inputs are ready, so the
  // (slow) headless calls run in the background while the user is on the earlier
  // type/priorities steps. The on-step-entry trigger above still covers the case
  // where the user reaches the step before this finishes; both guard on
  // `reminderRows === null && !remindersLoading`, so they never double-run.
  useEffect(() => {
    if (!isOpen || !hasRemindersStep) return;
    if (reminderRows === null && !remindersLoading) runReminderSuggest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, hasRemindersStep, reminderRows, remindersLoading]);

  // --- Step 1 actions ---

  const runMatch = useCallback(async () => {
    const items = priorityText
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    if (items.length === 0) {
      setStep(afterPriorities);
      return;
    }
    setIsLoading(true);
    setError(null);
    setCreatedTasks([]);
    try {
      // Projects are needed so a newly-created task can be filed under a
      // required Asana project. Fetch alongside the match; a projects failure
      // shouldn't block matching.
      const [res, projectsRes] = await Promise.all([
        api.matchPriorities(items, weekStart),
        api.getAsanaProjects().catch(() => ({ projects: [] as AsanaProject[] })),
      ]);
      const defaultIntegrationId = res.asanaIntegrations[0]?.id ?? '';
      const rows: MatchRow[] = res.results.map(r => ({
        text: r.text,
        match: r.match,
        createIntegrationId: defaultIntegrationId,
        createProjectGid: '',
        category: r.match?.category ?? res.categories[0] ?? '',
        include: true,
      }));
      setMatchRows(rows);
      setMatchMeta({
        asanaIntegrations: res.asanaIntegrations,
        categories: res.categories,
        projects: projectsRes.projects,
        aiUnavailable: !!res.aiUnavailable,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to match priorities');
    } finally {
      setIsLoading(false);
    }
  }, [priorityText, afterPriorities, weekStart]);

  const confirmPriorities = useCallback(async () => {
    if (!matchRows) return;
    setIsLoading(true);
    setError(null);
    try {
      const unmatchedIncluded = matchRows.filter(r => !r.match && r.include);
      // A project is required for each new task whenever the chosen integration
      // has projects to file under. Guard here as a backstop to the disabled Next.
      const missingProject = unmatchedIncluded.some(
        r =>
          matchMeta.projects.some(p => p.integrationId === r.createIntegrationId) &&
          !r.createProjectGid
      );
      if (missingProject) {
        setError('Choose a project for each new task before continuing.');
        setIsLoading(false);
        return;
      }
      let created = createdTasks;
      if (unmatchedIncluded.length > 0 && createdTasks.length === 0) {
        const res = await api.createPriorityTasks(
          unmatchedIncluded.map(r => ({
            text: r.text,
            integrationId: r.createIntegrationId,
            ...(r.createProjectGid ? { projectGid: r.createProjectGid } : {}),
          }))
        );
        created = res.created;
        setCreatedTasks(created);
      }

      const ids: string[] = [];
      const overrides: Record<string, string> = {};
      for (const r of matchRows) {
        if (r.match) {
          ids.push(r.match.gid);
          // Task's Asana Type doesn't map to a quota category → carry the pick.
          if (!r.match.category) overrides[r.match.gid] = r.category;
        }
      }
      for (const c of created) {
        const row = matchRows.find(r => r.text === c.text);
        ids.push(c.gid);
        if (row) overrides[c.gid] = row.category;
      }

      setPriorityIds(ids);
      setCategoryOverrides(overrides);
      setTaskCats(null); // priorities changed → re-fetch candidates
      setStep(afterPriorities);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create Asana tasks');
    } finally {
      setIsLoading(false);
    }
  }, [matchRows, createdTasks, matchMeta.projects, afterPriorities]);

  // --- Step 2 actions ---

  // Toggle a meeting's prep decision optimistically: flip needsPrep LOCALLY so the
  // tick is instant, and persist the verdict in the background. No candidates
  // refetch here — the authoritative slot is recomputed once, for every needs-prep
  // meeting, when the user clicks Next off the step (see advancePrep). A meeting
  // toggled ON has no proposed `block` until then; PrepStep renders it as a pending
  // slot. Persisted by normalized title key server-side, so every row sharing the
  // title flips together to match. On failure, roll the flip back and surface it.
  const setPrepDecision = useCallback((title: string, needsPrep: boolean) => {
    setError(null);
    const flip = (want: boolean) =>
      setPrepData(prev =>
        prev
          ? { ...prev, meetings: prev.meetings.map(m => (m.title === title ? { ...m, needsPrep: want } : m)) }
          : prev
      );
    flip(needsPrep);
    api.setPrepDecision(title, needsPrep).catch(err => {
      flip(!needsPrep);
      setError(err instanceof Error ? err.message : 'Failed to update prep decision');
    });
  }, []);

  // --- Step 3 actions ---

  // remainingQuota === null means no cap (no-quota catch-all category). A must-do
  // task is always admissible even when the cap is hit.
  const toggleSelection = useCallback((category: string, id: string, remainingQuota: number | null) => {
    setSelections(prev => {
      const set = new Set(prev[category] ?? []);
      if (set.has(id)) set.delete(id);
      else if (remainingQuota === null || set.size < remainingQuota || mustDoIds.has(id)) set.add(id);
      return { ...prev, [category]: set };
    });
  }, [mustDoIds]);

  // Flag / unflag a task as "must do this week". Flagging auto-selects it,
  // bypassing the category's selection cap; unflagging leaves the selection as-is.
  const toggleMustDo = useCallback((category: string, id: string) => {
    const wasFlagged = mustDoIds.has(id);
    setMustDoIds(prev => {
      const next = new Set(prev);
      if (wasFlagged) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!wasFlagged) {
      setSelections(prev => {
        const set = new Set(prev[category] ?? []);
        set.add(id);
        return { ...prev, [category]: set };
      });
    }
  }, [mustDoIds]);

  // Set (or clear) a day's work location. Passing 'home' clears the entry (home
  // is the default = no extra blocks). Selecting 'travel' seeds sensible defaults
  // the user can then edit inline.
  const setDayLocation = useCallback((dateStr: string, next: WizardDayLocation | null) => {
    setDayLocations(prev => {
      if (!next || next.type === 'home') {
        if (!(dateStr in prev)) return prev;
        const rest = { ...prev };
        delete rest[dateStr];
        return rest;
      }
      return { ...prev, [dateStr]: next };
    });
  }, []);

  // Toggle a 🚶 walk on/off for a given working day (yyyy-MM-dd).
  const toggleWalkDay = useCallback((dateStr: string) => {
    setWalkDays(prev => {
      const next = new Set(prev);
      if (next.has(dateStr)) next.delete(dateStr);
      else next.add(dateStr);
      return next;
    });
  }, []);

  // Mark an Asana-backed candidate complete in Asana, then drop it from the wizard
  // (candidates, selections, must-do, per-task overrides).
  const completeAsana = useCallback(async (id: string, gid: string, integrationId: string) => {
    setCompletingIds(prev => new Set(prev).add(id));
    setError(null);
    try {
      await api.completeAsanaTaskInWizard(gid, integrationId);
      setTaskCats(prev =>
        prev
          ? prev.map(c => ({ ...c, candidates: c.candidates.filter(cd => cd.id !== id) }))
          : prev
      );
      setSelections(prev => {
        const next: Record<string, Set<string>> = {};
        for (const [cat, set] of Object.entries(prev)) {
          const s = new Set(set);
          s.delete(id);
          next[cat] = s;
        }
        return next;
      });
      setMustDoIds(prev => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
      setTaskDurationOverrides(prev => {
        if (!(id in prev)) return prev;
        const rest = { ...prev };
        delete rest[id];
        return rest;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark task done in Asana');
    } finally {
      setCompletingIds(prev => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    }
  }, []);

  // Delete a candidate task. Asana-backed tasks are deleted in Asana; ad-hoc
  // tasks are removed from their local store. On success the row is pulled from
  // the candidate list and from any selection/must-do sets it belonged to
  // (mirrors completeAsana's cleanup).
  const deleteTask = useCallback(async (category: string, candidate: WeekCandidate) => {
    const { id, gid, integrationId } = candidate;
    setDeletingIds(prev => new Set(prev).add(id));
    setError(null);
    try {
      if (gid && integrationId) {
        await api.deleteAsanaTask(gid, integrationId);
      } else {
        await api.deleteAdHocTask(id);
      }
      setTaskCats(prev =>
        prev
          ? prev.map(c =>
              c.category === category
                ? { ...c, candidates: c.candidates.filter(cd => cd.id !== id) }
                : c
            )
          : prev
      );
      setSelections(prev => {
        const next: Record<string, Set<string>> = {};
        for (const [cat, set] of Object.entries(prev)) {
          const s = new Set(set);
          s.delete(id);
          next[cat] = s;
        }
        return next;
      });
      setMustDoIds(prev => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
      setTaskDurationOverrides(prev => {
        if (!(id in prev)) return prev;
        const rest = { ...prev };
        delete rest[id];
        return rest;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task');
    } finally {
      setDeletingIds(prev => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    }
  }, []);

  // Return to the tasks step from review to spend spare capacity. Selections are
  // preserved (kept in state); addMoreMode lifts the per-category selection cap so
  // the user can pick beyond a quota, and those extra picks get scheduled.
  const addMoreTasks = useCallback(() => {
    setAddMoreMode(true);
    setStep('tasks');
  }, []);

  // --- Step 4 actions ---

  // Normal (working-hours) proposals, grouped by date. Overflow proposals are
  // rendered in their own opt-in section, so they're excluded here.
  const grouped = useMemo(() => {
    const map = new Map<string, EditableProposal[]>();
    for (const p of proposals) {
      if (p.overflow) continue;
      const list = map.get(p.date) ?? [];
      list.push(p);
      map.set(p.date, list);
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, items]) => ({
        date,
        items: items.sort((a, b) => (a.start < b.start ? -1 : 1)),
      }));
  }, [proposals]);

  // Optional evening-overflow proposals, sorted by date then start.
  const overflowProposals = useMemo(
    () =>
      proposals
        .filter(p => p.overflow)
        .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.start < b.start ? -1 : 1)),
    [proposals]
  );

  const acceptedCount = proposals.filter(p => p.accepted).length;
  const hasResults = Object.keys(results).length > 0;

  const toggleAccept = useCallback((id: string) =>
    setProposals(prev => prev.map(p => (p.id === id ? { ...p, accepted: !p.accepted } : p))), []);

  const editStart = useCallback((id: string, start: string) =>
    setProposals(prev => prev.map(p => (p.id === id ? { ...p, start } : p))), []);

  // Move a block to a different day (used by the evening-overflow day picker). The
  // confirm path reads p.date, so this is all that's needed to reschedule the day.
  const editDate = useCallback((id: string, date: string) => {
    if (!date) return;
    setProposals(prev => prev.map(p => (p.id === id ? { ...p, date } : p)));
  }, []);

  // Apply the reminders-triage decisions: each "convert" row creates an Asana
  // task (with notes/due/project/type) then deletes the source Google Tasks
  // reminder (mirrors the Reminders tab's convert-then-delete); "done" marks the
  // reminder completed; "delete" removes it. Returns the number of actions that
  // failed so the caller can surface a partial-failure note.
  const applyReminderActions = useCallback(async (): Promise<{ succeeded: number; failed: number }> => {
    const rows = reminderRows ?? [];
    const conversions = rows.filter(r => r.action === 'convert' && r.name.trim());
    // done/delete act on a Google Task, so they can only ever apply to rows
    // that have one.
    const dones = rows.filter(r => r.action === 'done' && r.source !== 'calendar');
    const deletes = rows.filter(r => r.action === 'delete' && r.source !== 'calendar');

    // Learn from his triage: record the keep/convert decisions (the classifier's
    // two classes) per reminder title so it follows his precedent next time. Done
    // BEFORE the no-actions early-return so an all-"keep" session still teaches the
    // negative class. Best-effort — never blocks applying the plan.
    const learnable = rows.filter(r => r.action === 'keep' || r.action === 'convert');
    if (learnable.length > 0) {
      api.recordReminderVerdicts(
        learnable.map(r => ({
          title: r.name,
          action: r.action as 'keep' | 'convert',
          integrationId: r.integrationId,
          projectGid: r.projectGid,
          taskType: r.taskType,
        }))
      ).catch(() => {});
    }

    const total = conversions.length + dones.length + deletes.length;
    if (total === 0) return { succeeded: 0, failed: 0 };
    setIsConvertingReminders(true);
    try {
      const outcomes = await Promise.allSettled([
        ...conversions.map(async row => {
          // Route the chosen Type to the right place: an Asana-writable workspace
          // gets a customFields write; a local-only one (e.g. DBC) has the label
          // set server-side against the new task's gid (see createAsanaTask).
          const typeOptions: { customFields?: Record<string, string>; localType?: string } = {};
          if (row.taskType) {
            const { writeTarget } = typeChoicesFor(row.integrationId, typeFieldInfoByIntegration);
            if (writeTarget === 'local') {
              typeOptions.localType = row.taskType;
            } else {
              const info = typeFieldInfoByIntegration?.get(row.integrationId);
              const optionGid = info?.enumOptions.get(row.taskType);
              if (info && optionGid) typeOptions.customFields = { [info.fieldGid]: optionGid };
            }
          }
          await api.createAsanaTask(row.integrationId, row.name.trim(), {
            ...(row.notes.trim() ? { notes: row.notes.trim() } : {}),
            ...(row.dueOn ? { dueOn: row.dueOn } : {}),
            ...(row.projectGid ? { projectGid: row.projectGid } : {}),
            ...typeOptions,
          });
          // Only remove the reminder once its task exists — and only when there
          // IS one. A calendar-derived row has no Google Task behind it; the
          // recurring event is left in place deliberately, so converting it
          // creates the task without touching the calendar.
          if (row.source !== 'calendar') await api.deleteReminder(row.id);
        }),
        ...dones.map(row => api.updateReminder(row.id, { completed: true })),
        ...deletes.map(row => api.deleteReminder(row.id)),
      ]);
      const failed = outcomes.filter(o => o.status === 'rejected').length;
      return { succeeded: total - failed, failed };
    } finally {
      setIsConvertingReminders(false);
    }
  }, [reminderRows, typeFieldInfoByIntegration]);

  const confirm = useCallback(async () => {
    const accepted = proposals.filter(p => p.accepted);
    if (accepted.length === 0) return;
    setIsConfirming(true);
    setError(null);
    try {
      const blocks: ProposedBlock[] = accepted.map(p => ({
        id: p.id,
        category: p.category,
        task: p.task,
        tasks: p.tasks,
        date: p.date,
        start: p.start,
        durationMinutes: p.durationMinutes,
        reason: p.reason,
        kind: p.kind,
        meeting: p.meeting,
        title: p.title,
      }));
      const { results: res } = await api.confirmWeeklyPlan(blocks, undefined, weekStart);
      const map: Record<string, ConfirmWeekResult> = {};
      for (const r of res) map[r.id] = r;
      setResults(map);
      // Apply reminder actions (convert / done / delete) alongside the plan. A
      // partial failure surfaces a note but doesn't block completing the plan.
      const { succeeded, failed } = await applyReminderActions();
      if (res.some(r => r.success) || succeeded > 0) onApplied?.();
      if (failed > 0) {
        setError(
          `${failed} reminder action${failed === 1 ? '' : 's'} failed — those reminders were left untouched.`
        );
      }
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm plan');
    } finally {
      setIsConfirming(false);
    }
  }, [proposals, onApplied, applyReminderActions, weekStart]);

  // --- Navigation ---

  const handleNext = useCallback(() => {
    switch (step) {
      case 'calendar':
        setStep(hasTypeStep ? 'type' : 'location');
        break;
      case 'type':
        applyTypes();
        break;
      case 'location':
        setStep('priorities');
        break;
      case 'priorities':
        if (matchRows === null) runMatch();
        else confirmPriorities();
        break;
      case 'reminders':
        setStep('prep');
        break;
      case 'prep':
        advancePrep();
        break;
      case 'tasks':
        setTasksEngaged(true);
        setStep('review');
        break;
      case 'review':
        confirm();
        break;
    }
  }, [step, hasTypeStep, matchRows, runMatch, confirmPriorities, confirm, applyTypes, advancePrep]);

  const handleSkip = useCallback(() => {
    switch (step) {
      case 'type':
        setStep('location');
        break;
      case 'location':
        // Skip = every day at home; clear any location picks.
        setDayLocations({});
        setStep('priorities');
        break;
      case 'priorities':
        setPriorityIds([]);
        setCategoryOverrides({});
        setTaskCats(null);
        setStep(afterPriorities);
        break;
      case 'reminders':
        // Skip = convert nothing; leave every reminder as-is.
        setReminderRows(prev => (prev ? prev.map(r => ({ ...r, action: 'keep' })) : prev));
        setStep('prep');
        break;
      case 'prep':
        setPrepEngaged(false);
        setStep('tasks');
        break;
      case 'tasks':
        setTasksEngaged(false);
        setStep('review');
        break;
    }
  }, [step, afterPriorities]);

  const handleBack = useCallback(() => {
    switch (step) {
      case 'type':
        setStep('calendar');
        break;
      case 'location':
        setStep(hasTypeStep ? 'type' : 'calendar');
        break;
      case 'priorities':
        if (matchRows !== null) setMatchRows(null); // matched → input phase
        break;
      case 'reminders':
        setStep('priorities');
        break;
      case 'prep':
        setStep(afterPriorities);
        break;
      case 'tasks':
        setStep('prep');
        break;
      case 'review':
        setStep('tasks');
        break;
    }
  }, [step, hasTypeStep, matchRows, afterPriorities]);

  // Map the current step (and, for priorities, its input/review phase) onto the
  // screen the active dot should mark. 'done' fills every dot (index = length).
  const activeScreenKey =
    step === 'priorities' ? (matchRows === null ? 'priorities-input' : 'priorities-review') : step;
  const activeIndex =
    step === 'done' ? screenOrder.length : screenOrder.findIndex(s => s.key === activeScreenKey);
  const canBack =
    step === 'type' ||
    step === 'location' ||
    (step === 'priorities' && matchRows !== null) ||
    step === 'reminders' ||
    step === 'prep' ||
    step === 'tasks' ||
    step === 'review';
  const canSkip =
    step === 'type' ||
    step === 'location' ||
    step === 'priorities' ||
    step === 'reminders' ||
    step === 'prep' ||
    step === 'tasks';

  const projectsForIntegration = useCallback(
    (integrationId: string) => matchMeta.projects.filter(p => p.integrationId === integrationId),
    [matchMeta.projects]
  );

  // Every included new task must have a project chosen (when its integration has
  // projects to choose from). Blocks Next on the priorities step until satisfied.
  const prioritiesReady =
    matchRows === null ||
    matchRows.every(
      r =>
        !!r.match ||
        !r.include ||
        projectsForIntegration(r.createIntegrationId).length === 0 ||
        r.createProjectGid !== ''
    );

  return {
    // core
    step,
    isLoading,
    error,
    weekLabel,
    // step visibility / progress
    hasTypeStep,
    hasRemindersStep,
    screenOrder,
    activeScreenKey,
    activeIndex,
    // calendar step
    pendingInvites,
    invitesLoading,
    invitesError,
    refreshPendingInvites: fetchPendingInvites,
    // location step
    dayLocations,
    setDayLocation,
    locationWorkingDays,
    // type step
    untypedTasks,
    typeRows,
    setTypeRows,
    typeLoading,
    typeError,
    isApplyingTypes,
    // priorities step
    priorityText,
    setPriorityText,
    matchRows,
    setMatchRows,
    matchMeta,
    createdTasks,
    prioritiesReady,
    projectsForIntegration,
    // reminders step
    reminderRows,
    setReminderRows,
    remindersLoading,
    remindersError,
    remindersProgress,
    reminderProjects,
    isConvertingReminders,
    // prep step
    prepData,
    showOtherMeetings,
    setShowOtherMeetings,
    prepDurations,
    prepDays,
    setPrepDecision,
    changePrepDuration,
    changePrepDay,
    // tasks step
    taskCats,
    selections,
    taskDurations,
    setTaskDurations,
    taskDurationOverrides,
    setTaskDurationOverrides,
    mustDoIds,
    walkDays,
    toggleWalkDay,
    completingIds,
    addMoreMode,
    spareCapacity,
    toggleSelection,
    toggleMustDo,
    completeAsana,
    deletingIds,
    deleteTask,
    peekCandidate,
    setPeekCandidate,
    // review step
    proposals,
    quotaSummary,
    unplaceable,
    overflowDayOptions,
    exerciseMissingDays,
    grouped,
    overflowProposals,
    acceptedCount,
    hasResults,
    results,
    isConfirming,
    toggleAccept,
    editStart,
    editDate,
    addMoreTasks,
    // navigation
    handleNext,
    handleSkip,
    handleBack,
    canBack,
    canSkip,
  };
}

export type UsePlanWeekReturn = ReturnType<typeof usePlanWeek>;
