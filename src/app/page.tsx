'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { format } from 'date-fns';
import { Header } from '@/components/Header';
import { SectionBar } from '@/components/SectionBar';
import { resolveIcon } from '@/components/section-icons';
import { ExerciseSection } from '@/components/sections/ExerciseSection';
import { GoalsSection } from '@/components/sections/GoalsSection';
import { MusicSection } from '@/components/sections/MusicSection';
import { RelationshipsSection } from '@/components/sections/RelationshipsSection';
import { WellbeingSection } from '@/components/sections/WellbeingSection';
import { ProjectsTab } from '@/components/sections/work/ProjectsTab';
import {
  DEFAULT_SECTION_ID,
  defaultSubTab,
  getSection,
  hasSubTab,
  isValidSectionId,
} from '@/lib/life-sections';
import { useGoalNudges } from '@/hooks/useGoalNudges';
import { TaskDetailDialog } from '@/components/AsanaSidebar';
import { DelegateModal } from '@/components/DelegateModal';
import { AddTaskModal } from '@/components/AddTaskModal';
import { RitualsContent } from '@/components/RitualsContent';
import { Reminders } from '@/components/Reminders';
import {
  attributeMinutes,
  buildMeetingWorkspaceByTitle,
  buildWorkspaceCalendarMap,
} from '@/lib/time-attribution';
import { AnalysisView } from '@/components/analysis/AnalysisView';
import { DashboardContent } from '@/components/dashboard/DashboardContent';
import { CalendarTab } from '@/components/home/CalendarTab';
import { CalendarSelectionModal } from '@/components/home/CalendarSelectionModal';
import { DeleteConfirmModal } from '@/components/home/DeleteConfirmModal';
import { GoogleEventModal } from '@/components/home/GoogleEventModal';
import { BatchBlockDialog } from '@/components/home/BatchBlockDialog';
import { resolveBlockMembers, isGroupedBlock, type BlockMember } from '@/lib/scheduling/block-members';
import { useTasks } from '@/hooks/useTasks';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useTaskMetadata } from '@/hooks/useTaskMetadata';
import { useDelegationQueue } from '@/hooks/useDelegationQueue';
import { useDashboard } from '@/hooks/useDashboard';
import { useToast } from '@/hooks/useToast';
import { useGoogleEventModal } from '@/hooks/useGoogleEventModal';
import { CalendarEvent, DelegationQueueEntry, DragItem, TaskType, SettingsResponse, AsanaFilterState, EventAttributionRule } from '@/types';
import { api } from '@/lib/api';
import { asanaTaskUrl, asanaTaskGidsFromText } from '@/lib/asana-url';
import { stripLeadingEmoji } from '@/lib/scheduling/calendar-review';
import { DEFAULT_ROLLOVER_HOUR, logicalToday, logicalTodayDate, formatLocalDate } from '@/lib/date-utils';

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

const COLOR_SCHEMES = [
  {
    name: 'Slate',
    headerBg: 'bg-gradient-to-r from-slate-600 to-slate-700',
    headerText: 'text-white',
    sidebarHeaderBg: 'bg-slate-100',
    sidebarHeaderText: 'text-slate-700',
    mainBg: 'bg-slate-50',
  },
  {
    name: 'Ocean',
    headerBg: 'bg-gradient-to-r from-blue-500 to-blue-600',
    headerText: 'text-white',
    sidebarHeaderBg: 'bg-blue-50',
    sidebarHeaderText: 'text-blue-700',
    mainBg: 'bg-blue-50/50',
  },
  {
    name: 'Forest',
    headerBg: 'bg-gradient-to-r from-emerald-500 to-emerald-600',
    headerText: 'text-white',
    sidebarHeaderBg: 'bg-emerald-50',
    sidebarHeaderText: 'text-emerald-700',
    mainBg: 'bg-emerald-50/50',
  },
  {
    name: 'Lavender',
    headerBg: 'bg-gradient-to-r from-violet-500 to-violet-600',
    headerText: 'text-white',
    sidebarHeaderBg: 'bg-violet-50',
    sidebarHeaderText: 'text-violet-700',
    mainBg: 'bg-violet-50/50',
  },
  {
    name: 'Rose',
    headerBg: 'bg-gradient-to-r from-rose-500 to-rose-600',
    headerText: 'text-white',
    sidebarHeaderBg: 'bg-rose-50',
    sidebarHeaderText: 'text-rose-700',
    mainBg: 'bg-rose-50/50',
  },
  {
    name: 'Amber',
    headerBg: 'bg-gradient-to-r from-amber-500 to-amber-600',
    headerText: 'text-white',
    sidebarHeaderBg: 'bg-amber-50',
    sidebarHeaderText: 'text-amber-700',
    mainBg: 'bg-amber-50/50',
  },
];

type WorkTab = 'dashboard' | 'calendar' | 'rituals' | 'reminders' | 'projects' | 'analysis';

const WORK_TABS: WorkTab[] = [
  'dashboard',
  'calendar',
  'rituals',
  'reminders',
  'projects',
  'analysis',
];

// The hash now carries both levels of the hierarchy, '#exercise/history'. The
// old single-level form ('#rituals') still resolves — those are work sub-tabs,
// and existing bookmarks shouldn't break.
function parseHash(hash: string): { section: string; subTab: string } {
  const raw = hash.replace(/^#/, '');
  if (!raw) return { section: DEFAULT_SECTION_ID, subTab: 'dashboard' };

  const [first, second] = raw.split('/');
  if (WORK_TABS.includes(first as WorkTab) && !second) {
    return { section: 'work', subTab: first };
  }
  if (!isValidSectionId(first)) return { section: DEFAULT_SECTION_ID, subTab: 'dashboard' };
  const subTab = second && hasSubTab(first, second) ? second : defaultSubTab(first);
  return { section: first, subTab };
}

export default function Home() {
  const initialRoute = typeof window !== 'undefined'
    ? parseHash(window.location.hash)
    : { section: DEFAULT_SECTION_ID, subTab: 'dashboard' };

  const [activeSection, setActiveSection] = useState(initialRoute.section);
  const [activeTab, setActiveTab] = useState<WorkTab>(
    initialRoute.section === 'work' ? (initialRoute.subTab as WorkTab) : 'dashboard'
  );
  // Sub-tab per non-work section, so switching away and back returns to where
  // you were rather than resetting to the first tab.
  const [subTabBySection, setSubTabBySection] = useState<Record<string, string>>(() =>
    initialRoute.section === 'work' ? {} : { [initialRoute.section]: initialRoute.subTab }
  );

  const { nudges: goalNudges, refresh: refreshGoalNudges } = useGoalNudges();

  const writeHash = useCallback((section: string, subTab: string) => {
    // The Command Center is the app's home, so it stays on a bare URL.
    window.location.hash = section === 'work' && subTab === 'dashboard' ? '' : `${section}/${subTab}`;
  }, []);

  const activeSubTab =
    activeSection === 'work' ? activeTab : subTabBySection[activeSection] ?? defaultSubTab(activeSection);

  const handleTabChange = useCallback(
    (tab: string) => {
      if (activeSection === 'work') {
        setActiveTab(tab as WorkTab);
      } else {
        setSubTabBySection(prev => ({ ...prev, [activeSection]: tab }));
      }
      writeHash(activeSection, tab);
    },
    [activeSection, writeHash]
  );

  const handleSectionChange = useCallback(
    (sectionId: string) => {
      setActiveSection(sectionId);
      const subTab =
        sectionId === 'work' ? activeTab : subTabBySection[sectionId] ?? defaultSubTab(sectionId);
      writeHash(sectionId, subTab);
    },
    [activeTab, subTabBySection, writeHash]
  );

  // The nudge card's "Open goals" jumps straight to the cross-cutting view.
  const goToGoals = useCallback(() => {
    handleSectionChange('goals');
  }, [handleSectionChange]);

  // Follow the hash when it changes outside our own writes — pasting a
  // '#exercise/history' link into an already-open tab, or using the browser's
  // back button, should actually move.
  useEffect(() => {
    const onHashChange = () => {
      const route = parseHash(window.location.hash);
      setActiveSection(route.section);
      if (route.section === 'work') {
        setActiveTab(route.subTab as WorkTab);
      } else {
        setSubTabBySection(prev => ({ ...prev, [route.section]: route.subTab }));
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // The day-rollover hour (from workflow config); local times before it count as
  // the previous day. Defaults until the config loads. See lib/date-utils.ts.
  const [rolloverHour, setRolloverHour] = useState(DEFAULT_ROLLOVER_HOUR);
  const [selectedDate, setSelectedDate] = useState(() => logicalTodayDate(new Date(), DEFAULT_ROLLOVER_HOUR));
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [colorSchemeIndex, setColorSchemeIndex] = useState(0);

  // Random colour scheme, picked on the client only so SSR and the first client
  // render agree. Deferred to an animation frame rather than set in the effect
  // body — same pattern as MobileShell, and a synchronous setState here would
  // just cost an extra render pass.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setColorSchemeIndex(Math.floor(Math.random() * COLOR_SCHEMES.length));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const colorScheme = COLOR_SCHEMES[colorSchemeIndex];

  const toast = useToast();
  const { metadataByGid, saveMetadata, reload: reloadMetadata } = useTaskMetadata();
  const { delegationByGid, refresh: refreshDelegation } = useDelegationQueue();
  // Weekly-capacity store lifted here (from DashboardContent) so mutations that
  // affect counts — task complete/delete, delegation — can refetch it.
  const { data: capacityData, isLoading: capacityLoading, refetch: refetchCapacity } = useDashboard();
  const { addTask, updateTask, removeTask, getTasksForDate, tasks: allAdhocTasks } = useTasks();
  const {
    googleEvents,
    allAsanaTasks,
    rawAsanaTasks,
    filteredAsanaTasks,
    scheduledAsanaTasks,
    isLoading,
    fetchAllEvents,
    fetchEventsForDate,
    adhocToCalendarEvent,
    scheduleAsana,
    updateScheduledAsana,
    updateScheduledAsanaByGoogleEvent,
    unscheduleAsana,
    unscheduleAllAsanaInstances,
    updateGoogleEvent,
    createGoogleEvent,
    deleteGoogleEvent,
    getScheduledAsanaEventsForDate,
    completeAsanaTask,
    addAsanaComment,
    createAsanaTask,
    updateAsanaTask,
    deleteAsanaTask,
    asanaProjects,
    asanaTypeValues,
    asanaTypeFieldInfoByIntegration,
    asanaIntegrations,
    setAsanaFilters,
    getAsanaFiltersForIntegration,
    clearAsanaFilters,
  } = useCalendarEvents();

  const [calendarSelectionModal, setCalendarSelectionModal] = useState<{
    show: boolean;
    pendingDrop: { dragItem: DragItem; startTime: Date; endTime: Date } | null;
  }>({ show: false, pendingDrop: null });

  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{
    show: boolean;
    event: CalendarEvent | null;
  }>({ show: false, event: null });

  const [createTaskModal, setCreateTaskModal] = useState<{
    show: boolean;
    startTime: Date | null;
    endTime: Date | null;
  }>({ show: false, startTime: null, endTime: null });

  const [highlightedAsanaTaskId, setHighlightedAsanaTaskId] = useState<string | null>(null);
  const [openTaskDialogId, setOpenTaskDialogId] = useState<string | null>(null);
  // Ordered id list backing the task dialog's prev/next navigation. Set only
  // when the dialog is opened from a Command Center panel (Top Tasks /
  // AI-runnable); null for every other open path, so no nav chevrons appear.
  const [taskNavIds, setTaskNavIds] = useState<string[] | null>(null);
  const [staleModalOpen, setStaleModalOpen] = useState(false);
  // The grouped/batch calendar block being drilled into (double-clicked). Its
  // member tasks are resolved below and shown in the BatchBlockDialog.
  const [batchBlockEvent, setBatchBlockEvent] = useState<CalendarEvent | null>(null);
  // Set true when a member action mutates data, so the calendar refreshes once
  // when the dialog closes rather than on every tick.
  const batchDidMutate = useRef(false);
  const googleEventModal = useGoogleEventModal();
  const {
    selectedGoogleEvent,
    setSelectedGoogleEvent,
    isEditing: isEditingGoogleEvent,
    setIsEditing: setIsEditingGoogleEvent,
  } = googleEventModal;

  // Google event attributions for time tracking
  const [googleEventAttributions, setGoogleEventAttributions] = useState<
    Record<string, { asanaIntegrationId: string; googleIntegrationId: string }>
  >({});

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedGoogleEvent) {
          if (isEditingGoogleEvent) {
            setIsEditingGoogleEvent(false);
          } else {
            setSelectedGoogleEvent(null);
          }
        } else if (calendarSelectionModal.show) {
          setCalendarSelectionModal({ show: false, pendingDrop: null });
        } else if (deleteConfirmModal.show) {
          setDeleteConfirmModal({ show: false, event: null });
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    selectedGoogleEvent,
    isEditingGoogleEvent,
    setSelectedGoogleEvent,
    setIsEditingGoogleEvent,
    calendarSelectionModal.show,
    deleteConfirmModal.show,
  ]);

  useEffect(() => {
    api.getSettings()
      .then(data => setSettings(data))
      .catch(err => {
        console.error('Failed to load settings:', err);
        toast.error('Failed to load integration settings');
      });
  }, [toast]);

  const [calendarWorkspaceMap, setCalendarWorkspaceMap] = useState<Record<string, string>>({});
  // Stored series/title attribution overrides. The built-in rules apply without
  // this (they live in code), so a load failure degrades gracefully.
  const [attributionRules, setAttributionRules] = useState<EventAttributionRule[]>([]);
  useEffect(() => {
    api.getAttributionRules()
      .then(res => setAttributionRules(res.rules))
      .catch(err => console.error('Failed to load attribution rules:', err));
  }, []);

  // Opening the Analysis tab refreshes past days from the calendar first, so
  // retro-edits (a deleted meeting, a moved block) are already reflected in what
  // it renders. The server debounces this to at most one pass per ~10 minutes,
  // so flipping between tabs is cheap; the manual "Sync from calendar" button on
  // the page itself bypasses the debounce. The view is mounted after the pass
  // settles (and remounted via its key) so it never reads half-updated data.
  const [analysisSyncing, setAnalysisSyncing] = useState(false);
  const [analysisKey, setAnalysisKey] = useState(0);
  useEffect(() => {
    if (activeTab !== 'analysis') return;
    let cancelled = false;
    // Kicked off from a timer so the setState lands in a callback, not in the
    // effect body.
    const id = setTimeout(async () => {
      setAnalysisSyncing(true);
      try {
        await api.reconcileTimeFromCalendar({ auto: true });
      } catch (err) {
        // A sync failure must not block the page — it just shows what it has.
        console.error('Automatic calendar sync failed:', err);
      }
      if (cancelled) return;
      setAnalysisSyncing(false);
      setAnalysisKey(k => k + 1);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [activeTab]);

  // Load the configured day-rollover hour. If it differs from the default we
  // assumed at init and the user hasn't navigated away from the auto-selected
  // "today", re-sync the selected date to the configured logical today.
  useEffect(() => {
    api.getWorkflowConfig()
      .then(config => {
        const hour = config.scheduling.dayRolloverHour ?? DEFAULT_ROLLOVER_HOUR;
        setRolloverHour(hour);
        // Kept for time attribution's optional per-sub-calendar workspace map.
        setCalendarWorkspaceMap(config.scheduling.calendarWorkspaceMap ?? {});
        setSelectedDate(prev => {
          const stillOnDefaultToday =
            formatLocalDate(prev) === logicalToday(new Date(), DEFAULT_ROLLOVER_HOUR);
          return stillOnDefaultToday ? logicalTodayDate(new Date(), hour) : prev;
        });
      })
      .catch(err => {
        console.error('Failed to load workflow config:', err);
      });
  }, []);

  // Fetch Google event attributions for time tracking
  useEffect(() => {
    api.getGoogleEventAttributions()
      .then(data => {
        const map: Record<string, { asanaIntegrationId: string; googleIntegrationId: string }> = {};
        for (const attr of data.attributions) {
          map[attr.googleEventId] = {
            asanaIntegrationId: attr.asanaIntegrationId,
            googleIntegrationId: attr.googleIntegrationId,
          };
        }
        setGoogleEventAttributions(map);
      })
      .catch(err => {
        console.error('Failed to load Google event attributions:', err);
      });
  }, []);

  // Fetch events for newly navigated dates
  useEffect(() => {
    fetchEventsForDate(selectedDate);
  }, [selectedDate, fetchEventsForDate]);

  // Check if an event falls on a specific date
  const isEventOnDate = useCallback((event: CalendarEvent, targetDate: string): boolean => {
    const startDateStr = format(event.startTime, 'yyyy-MM-dd');
    const endDateStr = format(event.endTime, 'yyyy-MM-dd');

    // All-day events have exclusive end dates (Jan 15-16 = 1-day event on Jan 15)
    if (event.allDay) {
      return targetDate >= startDateStr && targetDate < endDateStr;
    }
    return startDateStr === targetDate;
  }, []);

  // Incomplete Asana task titles → gids, for linking planner blocks created
  // before descriptions carried task URLs. Those blocks are titled
  // "<category emoji> <task title>" (or just the task title when it already led
  // with its own emoji), so an exact title match identifies the task.
  const asanaGidsByTitle = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of allAsanaTasks) {
      if (t.completed) continue;
      const key = t.title.trim();
      map.set(key, [...(map.get(key) ?? []), t.id]);
    }
    return map;
  }, [allAsanaTasks]);

  // Combine calendar events for a given date, filtering out duplicates from synced Google events
  const buildEventsForDate = useCallback((dateStr: string): CalendarEvent[] => {
    const filteredGoogleEvents = googleEvents.filter(event => isEventOnDate(event, dateStr));

    const enrichedGoogleEvents = filteredGoogleEvents.map(event => {
      const linkedAsana = scheduledAsanaTasks.find(s => s.googleEventId === event.id);
      if (linkedAsana) {
        return {
          ...event,
          linkedAsanaTaskId: linkedAsana.asanaTaskId,
          linkedAsanaIntegrationId: linkedAsana.integrationId,
          // Use Asana color for linked events
          color: '#f06a6a',
        };
      }
      // No schedule-store link: fall back to a task URL in the description. Only
      // link when exactly one distinct task is referenced — grouped blocks with
      // several task URLs are ambiguous about which task to open, so stay
      // unlinked. Description-only links keep the event's own color and leave
      // linkedAsanaIntegrationId unset (unknown from the URL alone).
      const descGids = event.description ? asanaTaskGidsFromText(event.description) : [];
      if (descGids.length === 1) {
        return { ...event, linkedAsanaTaskId: descGids[0] };
      }
      // Last resort, for planner blocks that predate description links: match
      // the title against incomplete Asana tasks, tolerating the planner's
      // category-emoji prefix. Only an unambiguous (single-task) match links.
      const strippedTitle = stripLeadingEmoji(event.title);
      const titleGids =
        asanaGidsByTitle.get(strippedTitle) ?? asanaGidsByTitle.get(event.title.trim()) ?? [];
      if (titleGids.length === 1) {
        return { ...event, linkedAsanaTaskId: titleGids[0] };
      }
      return event;
    });

    // Exclude tasks that are already synced to Google to avoid duplicates
    const adhocTasks = getTasksForDate(dateStr).filter(t => t.dueTime && !t.googleEventId);
    const adhocEvents = adhocTasks.map(adhocToCalendarEvent);

    // Exclude Asana schedules linked to Google events (shown via enrichedGoogleEvents)
    const scheduledAsanaEvents = getScheduledAsanaEventsForDate(dateStr).filter(event => {
      const schedule = scheduledAsanaTasks.find(s => s.id === event.id);
      return !schedule?.googleEventId;
    });

    return [...enrichedGoogleEvents, ...adhocEvents, ...scheduledAsanaEvents];
  }, [googleEvents, getTasksForDate, adhocToCalendarEvent, getScheduledAsanaEventsForDate, scheduledAsanaTasks, isEventOnDate, asanaGidsByTitle]);

  const allEvents = useMemo(
    () => buildEventsForDate(format(selectedDate, 'yyyy-MM-dd')),
    [buildEventsForDate, selectedDate]
  );

  // Separate all-day events from timed events
  const allDayEvents = useMemo(() => allEvents.filter(e => e.allDay), [allEvents]);
  const timedEvents = useMemo(() => allEvents.filter(e => !e.allDay), [allEvents]);

  // Today's timed events for the Command Center dashboard (independent of selectedDate)
  const todayTimedEvents = useMemo(
    () => buildEventsForDate(logicalToday(new Date(), rolloverHour)).filter(e => !e.allDay),
    [buildEventsForDate, rolloverHour]
  );

  // Which Asana workspace each Google calendar belongs to. Built from the
  // routing Dave already maintains (an Asana integration's
  // eventGoogleIntegrationId), plus any per-sub-calendar overrides in config.
  const workspaceCalendarMap = useMemo(
    () =>
      buildWorkspaceCalendarMap(
        settings?.asanaIntegrations ?? [],
        calendarWorkspaceMap
      ),
    [settings, calendarWorkspaceMap]
  );

  // Every configured workspace, whether or not any of its tasks loaded — the
  // dashboard widgets must always show a row per workspace, so a fetch failure
  // or empty task list can't silently drop OM or DBC.
  const dashboardIntegrations = useMemo(() => {
    const fromSettings = (settings?.asanaIntegrations ?? [])
      .filter(i => i.enabled)
      .map(i => ({ id: i.id, name: i.name }));
    const seen = new Set(fromSettings.map(i => i.id));
    return [...fromSettings, ...asanaIntegrations.filter(i => !seen.has(i.id))];
  }, [settings, asanaIntegrations]);

  const attributionContext = useMemo(() => {
    const base = {
      map: workspaceCalendarMap,
      attributionByEventId: googleEventAttributions,
      attributionRules,
    };
    // Prep blocks count toward the workspace of the meeting they prep for. Build
    // the meeting-title → workspace map from the whole loaded calendar window (a
    // prep block's meeting may be on a different day than the prep itself).
    return {
      ...base,
      meetingWorkspaceByNormalizedTitle: buildMeetingWorkspaceByTitle(googleEvents, base),
    };
  }, [workspaceCalendarMap, googleEventAttributions, attributionRules, googleEvents]);

  // A minute-resolution clock for the "worked so far" split below. Held in state
  // (not read during render) so the figures stay pure and tick on their own.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    // Set from timers rather than the effect body so the first value arrives in
    // a callback (no synchronous setState during the effect, no impure render).
    const tick = () => setNowMs(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  // Minutes per workspace for the selected day: the full length of every
  // countable attributed block, and the part that has actually elapsed. Both
  // come from one filter, attribution and overlap resolution, so they can never
  // disagree — and overlapping blocks (a meeting over a task block) count once.
  const attributedTime = useMemo(
    () => attributeMinutes(timedEvents, attributionContext, nowMs),
    [timedEvents, attributionContext, nowMs]
  );
  const timeWorkedByIntegration = attributedTime.worked;
  const timeScheduledByIntegration = attributedTime.scheduled;

  // Record time tracking data for longitudinal analysis
  // Only records for today or past dates, debounced to avoid excessive writes
  useEffect(() => {
    const dateStr = formatLocalDate(selectedDate);
    const today = logicalToday(new Date(), rolloverHour);

    // Only record for dates that are today or in the past (logical day, so a
    // just-after-midnight session still records against the day it belongs to).
    if (dateStr > today) return;

    // Skip if no events or still loading
    if (isLoading || timedEvents.length === 0) return;

    // Debounce the recording
    const timeoutId = setTimeout(() => {
      // Build integration totals with names
      const integrationTotals: Record<string, { integrationId: string; integrationName: string; totalMinutes: number }> = {};
      for (const [integrationId, minutes] of Object.entries(timeScheduledByIntegration)) {
        const integration = asanaIntegrations.find(i => i.id === integrationId);
        integrationTotals[integrationId] = {
          integrationId,
          integrationName: integration?.name || 'Unknown',
          totalMinutes: minutes,
        };
      }

      // Build event records for detailed analysis, straight from the attributed
      // events so the log carries the same category and overlap-resolved
      // contribution the totals were built from.
      const eventById = new Map(timedEvents.map(e => [e.id, e]));
      const eventRecords = attributedTime.events.map(attributed => {
        const event = eventById.get(attributed.eventId);
        const integration = asanaIntegrations.find(i => i.id === attributed.workspaceId);
        return {
          eventId: attributed.eventId,
          title: attributed.title,
          integrationId: attributed.workspaceId,
          integrationName: integration?.name || 'Unknown',
          startTime: new Date(attributed.startMs).toISOString(),
          endTime: new Date(attributed.endMs).toISOString(),
          durationMinutes: Math.round(attributed.fullMinutes),
          source: (event?.source === 'asana' ? 'asana' : 'google') as 'google' | 'asana',
          ...(event?.linkedAsanaTaskId ? { linkedAsanaTaskId: event.linkedAsanaTaskId } : {}),
          category: attributed.category,
          countedMinutes: Math.round(attributed.countedMinutes),
        };
      });

      // Record the time data
      api.recordTimeTracking(
        dateStr,
        integrationTotals,
        eventRecords,
        timeWorkedByIntegration,
        attributedTime.workedByCategory
      ).catch(err => {
        console.error('Failed to record time tracking data:', err);
      });
    }, 2000); // 2 second debounce

    return () => clearTimeout(timeoutId);
  }, [selectedDate, timedEvents, attributedTime, timeWorkedByIntegration, timeScheduledByIntegration, asanaIntegrations, isLoading, rolloverHour]);

  const handleRefresh = useCallback(() => {
    // Rotate to a new random color scheme on refresh
    setColorSchemeIndex(prev => {
      let newIndex;
      do {
        newIndex = Math.floor(Math.random() * COLOR_SCHEMES.length);
      } while (newIndex === prev && COLOR_SCHEMES.length > 1);
      return newIndex;
    });
    fetchAllEvents();
  }, [fetchAllEvents]);

  const handleSidebarAsanaComplete = useCallback((taskId: string, integrationId: string, completed: boolean) => {
    toast.success(completed ? 'Task marked complete' : 'Task reopened');
    completeAsanaTask(taskId, integrationId, completed)
      .then(() => refetchCapacity()) // keep the capacity widget's counts current
      .catch(err => {
        toast.error('Failed to update task in Asana');
        console.error('Error completing Asana task:', err);
      });
  }, [completeAsanaTask, toast, refetchCapacity]);

  const handleSidebarAsanaComment = useCallback(async (taskId: string, integrationId: string, comment: string) => {
    try {
      await addAsanaComment(taskId, integrationId, comment);
      toast.success('Comment added to Asana');
    } catch (err) {
      toast.error('Failed to add comment to Asana');
      console.error('Error adding Asana comment:', err);
    }
  }, [addAsanaComment, toast]);

  const handleSidebarAsanaDelete = useCallback((taskId: string, integrationId: string) => {
    unscheduleAllAsanaInstances(taskId);
    toast.success('Task deleted from Asana');
    deleteAsanaTask(taskId, integrationId)
      .then(() => refetchCapacity()) // keep the capacity widget's counts current
      .catch(err => {
        toast.error('Failed to delete task from Asana');
        console.error('Error deleting Asana task:', err);
      });
  }, [deleteAsanaTask, unscheduleAllAsanaInstances, toast, refetchCapacity]);

  const handleSidebarAsanaUpdate = useCallback((
    taskId: string,
    integrationId: string,
    updates: {
      dueOn?: string | null;
      startOn?: string | null;
      customFields?: Record<string, string | null>;
      addProjects?: string[];
      removeProjects?: string[];
      addTags?: string[];
      removeTags?: string[];
    }
  ) => {
    updateAsanaTask(taskId, integrationId, updates).catch(err => {
      toast.error('Failed to update task in Asana');
      console.error('Error updating Asana task:', err);
    });
  }, [updateAsanaTask, toast]);

  const handleSidebarAsanaCreate = useCallback(async (
    integrationId: string,
    name: string,
    options?: { notes?: string; dueOn?: string; projectGid?: string; customFields?: Record<string, string>; localType?: string }
  ) => {
    try {
      const task = await createAsanaTask(integrationId, name, options);
      if (task) {
        toast.success('Task created in Asana');
      }
      return task;
    } catch (err) {
      toast.error('Failed to create task in Asana');
      console.error('Error creating Asana task:', err);
      throw err;
    }
  }, [createAsanaTask, toast]);

  const connectedGoogleIntegrations = useMemo(
    () => settings?.googleIntegrations.filter(i => i.connected && i.enabled) || [],
    [settings]
  );

  // Event routing for an Asana task: if its Asana integration declares an event
  // Google calendar (e.g. OM tasks → OM calendar, marked Free), scheduling that
  // task creates the event there with the configured availability, bypassing the
  // default/picker. Returns null when there's no override or the target calendar
  // isn't connected.
  const asanaEventRouting = useCallback(
    (asanaIntegrationId?: string): { googleIntegrationId: string; transparency: 'opaque' | 'transparent' } | null => {
      if (!asanaIntegrationId) return null;
      const asana = settings?.asanaIntegrations.find(i => i.id === asanaIntegrationId);
      if (!asana?.eventGoogleIntegrationId) return null;
      const target = connectedGoogleIntegrations.find(i => i.id === asana.eventGoogleIntegrationId);
      if (!target) return null;
      return { googleIntegrationId: asana.eventGoogleIntegrationId, transparency: asana.eventTransparency ?? 'opaque' };
    },
    [settings, connectedGoogleIntegrations]
  );

  const handleDropTask = useCallback((dragItem: DragItem, startTime: Date, endTime: Date) => {
    const dateStr = format(startTime, 'yyyy-MM-dd');
    const timeStr = format(startTime, 'HH:mm');
    const duration = Math.round((endTime.getTime() - startTime.getTime()) / (60 * 1000));

    // An Asana task with an event-routing override goes straight to its target
    // calendar (e.g. OM → OM calendar, Free), skipping the picker entirely.
    if (dragItem.type === 'asana-task') {
      const routedTask = allAsanaTasks.find(t => t.id === dragItem.id);
      const routed = asanaEventRouting(routedTask?.integrationId);
      if (routed && routedTask) {
        createGoogleEvent(
          routed.googleIntegrationId,
          routedTask.title,
          startTime,
          endTime,
          asanaTaskUrl(routedTask.id),
          undefined,
          undefined,
          { transparency: routed.transparency }
        ).then(googleEvent => {
          if (googleEvent) {
            scheduleAsana(dragItem.id, routedTask.integrationId, dateStr, timeStr, duration, googleEvent.id, routed.googleIntegrationId, routedTask.title);
            toast.success('Task scheduled and synced to Google Calendar');
          } else {
            scheduleAsana(dragItem.id, routedTask.integrationId, dateStr, timeStr, duration, undefined, undefined, routedTask.title);
            toast.error('Failed to sync with Google Calendar');
          }
        });
        return;
      }
    }

    if (connectedGoogleIntegrations.length > 1) {
      setCalendarSelectionModal({
        show: true,
        pendingDrop: { dragItem, startTime, endTime },
      });
      return;
    }

    const integrationId = connectedGoogleIntegrations.length === 1 ? connectedGoogleIntegrations[0].id : undefined;

    if (dragItem.type === 'adhoc-task') {
      updateTask(dragItem.id, { dueDate: dateStr, dueTime: timeStr, duration });

      if (integrationId) {
        createGoogleEvent(integrationId, dragItem.title, startTime, endTime).then(googleEvent => {
          if (googleEvent) {
            updateTask(dragItem.id, {
              googleEventId: googleEvent.id,
              googleIntegrationId: integrationId,
            });
            toast.success('Event added to Google Calendar');
          } else {
            toast.error('Failed to sync with Google Calendar');
          }
        });
      }
    } else if (dragItem.type === 'asana-task') {
      const asanaTask = allAsanaTasks.find(t => t.id === dragItem.id);

      if (integrationId && asanaTask) {
        createGoogleEvent(integrationId, asanaTask.title, startTime, endTime, asanaTaskUrl(asanaTask.id)).then(googleEvent => {
          if (googleEvent) {
            scheduleAsana(
              dragItem.id,
              asanaTask.integrationId,
              dateStr,
              timeStr,
              duration,
              googleEvent.id,
              integrationId,
              asanaTask.title
            );
            toast.success('Task scheduled and synced to Google Calendar');
          } else {
            scheduleAsana(
              dragItem.id,
              asanaTask.integrationId,
              dateStr,
              timeStr,
              duration,
              undefined,
              undefined,
              asanaTask.title
            );
            toast.error('Failed to sync with Google Calendar');
          }
        });
      } else {
        scheduleAsana(
          dragItem.id,
          asanaTask?.integrationId,
          dateStr,
          timeStr,
          duration,
          undefined,
          undefined,
          asanaTask?.title
        );
      }
    } else if (dragItem.type === 'task-template') {
      addTask({
        title: dragItem.title,
        dueDate: dateStr,
        dueTime: timeStr,
        priority: dragItem.priority || 'medium',
        taskType: dragItem.taskType!,
        completed: false,
      }).then(newTask => {
        if (!newTask) return;
        updateTask(newTask.id, { duration });

        if (integrationId) {
          createGoogleEvent(integrationId, dragItem.title, startTime, endTime).then(googleEvent => {
            if (googleEvent) {
              updateTask(newTask.id, {
                googleEventId: googleEvent.id,
                googleIntegrationId: integrationId,
              });
              toast.success('Event added to Google Calendar');
            } else {
              toast.error('Failed to sync with Google Calendar');
            }
          });
        }
      });
    }
  }, [updateTask, addTask, scheduleAsana, allAsanaTasks, connectedGoogleIntegrations, createGoogleEvent, toast, asanaEventRouting]);

  const handleCalendarSelection = useCallback((integrationId: string) => {
    const { pendingDrop } = calendarSelectionModal;
    if (!pendingDrop) return;

    const { dragItem, startTime, endTime } = pendingDrop;
    const dateStr = format(startTime, 'yyyy-MM-dd');
    const timeStr = format(startTime, 'HH:mm');
    const duration = Math.round((endTime.getTime() - startTime.getTime()) / (60 * 1000));

    if (dragItem.type === 'adhoc-task') {
      updateTask(dragItem.id, {
        dueDate: dateStr,
        dueTime: timeStr,
        duration,
      });

      createGoogleEvent(integrationId, dragItem.title, startTime, endTime).then(googleEvent => {
        if (googleEvent) {
          updateTask(dragItem.id, {
            googleEventId: googleEvent.id,
            googleIntegrationId: integrationId,
          });
          toast.success('Event added to Google Calendar');
        } else {
          toast.error('Failed to sync with Google Calendar');
        }
      });
    } else if (dragItem.type === 'asana-task') {
      const asanaTask = allAsanaTasks.find(t => t.id === dragItem.id);

      if (asanaTask) {
        // Create Google event first, then link to Asana schedule
        createGoogleEvent(integrationId, asanaTask.title, startTime, endTime, asanaTaskUrl(asanaTask.id)).then(googleEvent => {
          if (googleEvent) {
            scheduleAsana(
              dragItem.id,
              asanaTask.integrationId,
              dateStr,
              timeStr,
              duration,
              googleEvent.id,
              integrationId,
              asanaTask.title
            );
            toast.success('Task scheduled and synced to Google Calendar');
          } else {
            scheduleAsana(
              dragItem.id,
              asanaTask.integrationId,
              dateStr,
              timeStr,
              duration,
              undefined,
              undefined,
              asanaTask.title
            );
            toast.error('Failed to sync with Google Calendar');
          }
        });
      }
    } else if (dragItem.type === 'task-template') {
      addTask({
        title: dragItem.title,
        dueDate: dateStr,
        dueTime: timeStr,
        priority: dragItem.priority || 'medium',
        taskType: dragItem.taskType!,
        completed: false,
      }).then(newTask => {
        if (!newTask) return;
        updateTask(newTask.id, { duration });

        createGoogleEvent(integrationId, dragItem.title, startTime, endTime).then(googleEvent => {
          if (googleEvent) {
            updateTask(newTask.id, {
              googleEventId: googleEvent.id,
              googleIntegrationId: integrationId,
            });
            toast.success('Event added to Google Calendar');
          } else {
            toast.error('Failed to sync with Google Calendar');
          }
        });
      });
    }

    setCalendarSelectionModal({ show: false, pendingDrop: null });
  }, [calendarSelectionModal, updateTask, addTask, scheduleAsana, allAsanaTasks, createGoogleEvent, toast]);

  const handleEventMove = useCallback((
    eventId: string,
    source: 'adhoc' | 'asana' | 'google',
    startTime: Date,
    endTime: Date
  ) => {
    const dateStr = format(startTime, 'yyyy-MM-dd');
    const timeStr = format(startTime, 'HH:mm');
    const duration = Math.round((endTime.getTime() - startTime.getTime()) / (60 * 1000));

    if (source === 'adhoc') {
      updateTask(eventId, { dueDate: dateStr, dueTime: timeStr, duration });
    } else if (source === 'asana') {
      updateScheduledAsana(eventId, { scheduledDate: dateStr, scheduledTime: timeStr, duration });
    } else if (source === 'google') {
      const googleEvent = googleEvents.find(e => e.id === eventId);
      if (googleEvent?.integrationId) {
        updateGoogleEvent(eventId, googleEvent.integrationId, startTime, endTime, undefined, undefined, googleEvent.calendarId);
      }
      updateScheduledAsanaByGoogleEvent(eventId, { scheduledDate: dateStr, scheduledTime: timeStr, duration });
    }
  }, [updateTask, updateScheduledAsana, updateScheduledAsanaByGoogleEvent, updateGoogleEvent, googleEvents]);

  const handleAddTask = useCallback(async (task: {
    title: string;
    description?: string;
    dueDate?: string;
    dueTime?: string;
    duration?: number;
    priority: 'low' | 'medium' | 'high';
    taskType: TaskType;
    completed: boolean;
  }, integrationId?: string, timeAttributionId?: string) => {
    const newTask = await addTask(task);
    if (!newTask) return null;

    // If created with time and an integration was selected, sync it immediately
    if (task.dueDate && task.dueTime && task.duration && integrationId) {
      const [hours, minutes] = task.dueTime.split(':').map(Number);
      const startTime = new Date(task.dueDate);
      startTime.setHours(hours, minutes, 0, 0);
      const endTime = new Date(startTime.getTime() + task.duration * 60 * 1000);

      const eventType = task.taskType === 'focus' ? 'focusTime' : undefined;
      createGoogleEvent(integrationId, task.title, startTime, endTime, task.description, eventType).then(async googleEvent => {
        if (googleEvent) {
          updateTask(newTask.id, {
            googleEventId: googleEvent.id,
            googleIntegrationId: integrationId,
          });

          // Set time attribution if selected
          if (timeAttributionId) {
            await api.setGoogleEventAttribution(googleEvent.id, integrationId, timeAttributionId);
            setGoogleEventAttributions(prev => ({
              ...prev,
              [googleEvent.id]: { asanaIntegrationId: timeAttributionId, googleIntegrationId: integrationId },
            }));
          }

          toast.success('Event added to Google Calendar');
        }
      });
    }

    return newTask;
  }, [addTask, createGoogleEvent, updateTask, toast]);

  const handleTimelineCreateTask = useCallback((startTime: Date, endTime: Date) => {
    setCreateTaskModal({ show: true, startTime, endTime });
  }, []);

  const handleEventClick = useCallback((event: CalendarEvent) => {
    const asanaTaskId = event.linkedAsanaTaskId || (event.source === 'asana' ? event.id : null);
    if (asanaTaskId) {
      setHighlightedAsanaTaskId(asanaTaskId);
    }
  }, []);

  const handleClearHighlight = useCallback(() => {
    setHighlightedAsanaTaskId(null);
  }, []);

  const handleEventDoubleClick = useCallback((event: CalendarEvent) => {
    // A grouped/batch block (several tasks sharing one Google event) opens the
    // drill-down dialog; single-task and plain events keep their behaviour.
    if (isGroupedBlock(event, scheduledAsanaTasks, allAdhocTasks)) {
      setBatchBlockEvent(event);
      return;
    }
    const asanaTaskId = event.linkedAsanaTaskId || (event.source === 'asana' ? event.id : null);
    if (asanaTaskId) {
      setOpenTaskDialogId(asanaTaskId);
      setTaskNavIds(null);
    } else if (event.source === 'google') {
      setSelectedGoogleEvent(event);
    }
  }, [setSelectedGoogleEvent, scheduledAsanaTasks, allAdhocTasks]);

  // The member tasks of the block being drilled into, resolved from the same
  // scheduled-task / ad-hoc data the calendar renders. Live title + completion
  // come from the loaded Asana task list (id === gid).
  // Asana gids the user marked portal-done, so batch members render their
  // "waiting on others" state.
  const portalDoneGids = useMemo(
    () => new Set(Object.entries(metadataByGid).filter(([, m]) => m?.portalDone).map(([gid]) => gid)),
    [metadataByGid]
  );

  const batchBlockMembers = useMemo<BlockMember[]>(() => {
    if (!batchBlockEvent) return [];
    return resolveBlockMembers(
      batchBlockEvent.id,
      scheduledAsanaTasks,
      allAdhocTasks,
      gid => {
        const t = rawAsanaTasks.find(task => task.id === gid);
        return t ? { title: t.title, completed: !!t.completed, integrationId: t.integrationId } : undefined;
      },
      portalDoneGids
    );
  }, [batchBlockEvent, scheduledAsanaTasks, allAdhocTasks, rawAsanaTasks, portalDoneGids]);

  const closeBatchBlock = useCallback(() => {
    setBatchBlockEvent(null);
    if (batchDidMutate.current) {
      batchDidMutate.current = false;
      fetchAllEvents();
      // A portal-done flag change lands in task metadata, so refresh it too.
      reloadMetadata();
    }
  }, [fetchAllEvents, reloadMetadata]);

  const handleBatchMemberDone = useCallback(async (member: BlockMember) => {
    try {
      await api.updateBlockMember('done', {
        source: member.source,
        taskId: member.taskId,
        ...(member.gid ? { gid: member.gid } : {}),
        ...(member.integrationId ? { integrationId: member.integrationId } : {}),
        ...(member.scheduleId ? { scheduleId: member.scheduleId } : {}),
        ...(member.adhocId ? { adhocId: member.adhocId } : {}),
      });
      batchDidMutate.current = true;
    } catch (err) {
      toast.error('Could not mark the task done');
      throw err;
    }
  }, [toast]);

  const handleBatchMemberRemove = useCallback(async (member: BlockMember) => {
    try {
      await api.updateBlockMember('remove', {
        source: member.source,
        taskId: member.taskId,
        ...(member.gid ? { gid: member.gid } : {}),
        ...(member.integrationId ? { integrationId: member.integrationId } : {}),
        ...(member.scheduleId ? { scheduleId: member.scheduleId } : {}),
        ...(member.adhocId ? { adhocId: member.adhocId } : {}),
      });
      batchDidMutate.current = true;
    } catch (err) {
      toast.error('Could not remove the task from the block');
      throw err;
    }
  }, [toast]);

  const handleBatchMemberPortalDone = useCallback(async (member: BlockMember) => {
    try {
      await api.updateBlockMember('portalDone', {
        source: member.source,
        taskId: member.taskId,
        ...(member.gid ? { gid: member.gid } : {}),
        ...(member.integrationId ? { integrationId: member.integrationId } : {}),
        ...(member.scheduleId ? { scheduleId: member.scheduleId } : {}),
        ...(member.adhocId ? { adhocId: member.adhocId } : {}),
        title: member.title,
      });
      batchDidMutate.current = true;
    } catch (err) {
      toast.error('Could not mark the task done (waiting)');
      throw err;
    }
  }, [toast]);

  const handleBatchMemberOpen = useCallback((member: BlockMember) => {
    if (!member.gid) return;
    closeBatchBlock();
    setOpenTaskDialogId(member.gid);
    setTaskNavIds(null);
  }, [closeBatchBlock]);

  const handleClearOpenTaskDialog = useCallback(() => {
    setOpenTaskDialogId(null);
    setTaskNavIds(null);
  }, []);

  const handleDeleteEventRequest = useCallback((event: CalendarEvent) => {
    setDeleteConfirmModal({ show: true, event });
  }, []);

  const handleConfirmDelete = useCallback(() => {
    const { event } = deleteConfirmModal;
    if (!event) return;

    // Close modal immediately for better UX
    setDeleteConfirmModal({ show: false, event: null });

    if (event.source === 'google' && event.integrationId) {
      // Also unschedule linked Asana schedule if present (find by googleEventId)
      const linkedSchedule = scheduledAsanaTasks.find(s => s.googleEventId === event.id);
      if (linkedSchedule) {
        unscheduleAsana(linkedSchedule.id);
      }
      // deleteGoogleEvent is already optimistic - it removes from UI immediately
      deleteGoogleEvent(event.id, event.integrationId, event.calendarId).then(success => {
        if (success) {
          toast.success('Event deleted from Google Calendar');
        } else {
          toast.error('Failed to delete event from Google Calendar');
        }
      });
    } else if (event.source === 'adhoc') {
      removeTask(event.id);
      toast.success('Task deleted');
    } else if (event.source === 'asana') {
      // event.id is the schedule ID for Asana events
      unscheduleAsana(event.id);
      toast.success('Task unscheduled');
    }
  }, [deleteConfirmModal, deleteGoogleEvent, removeTask, unscheduleAsana, scheduledAsanaTasks, toast]);

  const handleUnscheduleAsana = useCallback((asanaTaskId: string) => {
    unscheduleAllAsanaInstances(asanaTaskId);
  }, [unscheduleAllAsanaInstances]);

  // Integration IDs for the two Asana workspaces (looked up by name)
  const OM_INTEGRATION_ID = useMemo(
    () => asanaIntegrations.find(i => i.name === 'OM')?.id ?? '',
    [asanaIntegrations]
  );
  const DBC_INTEGRATION_ID = useMemo(
    () => asanaIntegrations.find(i => i.name === 'DBC')?.id ?? '',
    [asanaIntegrations]
  );

  // Get filters for each locked integration
  const omFilters = useMemo(
    () => getAsanaFiltersForIntegration(OM_INTEGRATION_ID),
    [getAsanaFiltersForIntegration, OM_INTEGRATION_ID]
  );
  const dbcFilters = useMemo(
    () => getAsanaFiltersForIntegration(DBC_INTEGRATION_ID),
    [getAsanaFiltersForIntegration, DBC_INTEGRATION_ID]
  );

  // Callbacks for setting/clearing filters per integration
  const handleOmFiltersChange = useCallback(
    (filters: AsanaFilterState) => setAsanaFilters(filters, OM_INTEGRATION_ID),
    [setAsanaFilters, OM_INTEGRATION_ID]
  );
  const handleDbcFiltersChange = useCallback(
    (filters: AsanaFilterState) => setAsanaFilters(filters, DBC_INTEGRATION_ID),
    [setAsanaFilters, DBC_INTEGRATION_ID]
  );
  const handleOmClearFilters = useCallback(
    () => clearAsanaFilters(OM_INTEGRATION_ID),
    [clearAsanaFilters, OM_INTEGRATION_ID]
  );
  const handleDbcClearFilters = useCallback(
    () => clearAsanaFilters(DBC_INTEGRATION_ID),
    [clearAsanaFilters, DBC_INTEGRATION_ID]
  );

  // Sub-tabs come from the section registry, so a new life area needs no change
  // here — only an entry in lib/life-sections.ts.
  const tabs = useMemo(
    () =>
      (getSection(activeSection)?.subTabs ?? []).map(tab => ({
        id: tab.id,
        label: tab.label,
        icon: resolveIcon(tab.icon),
      })),
    [activeSection]
  );

  // Double-clicking the dashboard's Today heading blows the day up into the
  // calendar view — the same destination as the nav tab.
  const goToCalendarTab = useCallback(() => {
    setActiveTab('calendar');
    window.location.hash = 'calendar';
  }, []);

  // Open a task from the Command Center WITHOUT leaving it — a page-level dialog
  // renders over the dashboard rather than switching to the calendar tab.
  const handleOpenTaskInPlace = useCallback((taskId: string, navIds?: string[]) => {
    setOpenTaskDialogId(taskId);
    setTaskNavIds(navIds ?? null);
  }, []);

  const dashboardDialogTask = useMemo(
    () => (activeTab === 'dashboard' && openTaskDialogId
      ? allAsanaTasks.find(t => t.id === openTaskDialogId) ?? null
      : null),
    [activeTab, openTaskDialogId, allAsanaTasks],
  );

  // Resolve the previous/next navigable task ids from the panel's ordered list,
  // skipping any id that no longer resolves to a live task. Each is null at the
  // corresponding end of the list, which suppresses that chevron in the dialog.
  const { prevTaskId, nextTaskId } = useMemo(() => {
    if (!taskNavIds || !openTaskDialogId) return { prevTaskId: null, nextTaskId: null };
    const idx = taskNavIds.indexOf(openTaskDialogId);
    if (idx === -1) return { prevTaskId: null, nextTaskId: null };
    const liveIds = new Set(allAsanaTasks.map(t => t.id));
    const prevTaskId = taskNavIds.slice(0, idx).reverse().find(id => liveIds.has(id)) ?? null;
    const nextTaskId = taskNavIds.slice(idx + 1).find(id => liveIds.has(id)) ?? null;
    return { prevTaskId, nextTaskId };
  }, [taskNavIds, openTaskDialogId, allAsanaTasks]);

  // One-click delegate from the AI-runnable section (compose-brief modal).
  const [delegateTask, setDelegateTask] = useState<CalendarEvent | null>(null);

  // After a delegate action: refresh the queue store (so the DelegationWidget
  // updates at once) and the capacity widget's counts.
  const handleDelegated = useCallback(() => {
    refreshDelegation();
    refetchCapacity();
  }, [refreshDelegation, refetchCapacity]);

  // "For review" inbox triage happens in the task dialog. Triage settles the
  // delegation entry's reviewedAt server-side (so it leaves the inbox across
  // reloads), then refreshes the shared store so the UI updates instantly.
  const markReviewed = useCallback((entry: DelegationQueueEntry) => {
    api.markDelegationReviewed(entry.asanaTaskGid, entry.integrationId)
      .then(() => refreshDelegation())
      .catch(err => {
        toast.error('Failed to clear from review');
        console.error('Error marking delegation reviewed:', err);
      });
  }, [refreshDelegation, toast]);

  // "Move to backlog" (needs a human): drop the AI-delegable flag so the task
  // leaves the AI-runnable panel but stays in the normal backlog (NOT completed),
  // then mark the delegation entry reviewed so it leaves the For-review inbox.
  const handleMoveToBacklog = useCallback((entry: DelegationQueueEntry) => {
    saveMetadata(entry.asanaTaskGid, entry.integrationId, { aiDelegable: false })
      .catch(err => console.error('Error clearing aiDelegable:', err));
    markReviewed(entry);
    toast.success('Moved to backlog for a human');
  }, [saveMetadata, markReviewed, toast]);

  // "Return to AI queue": the next step is AI-runnable again. Stamp
  // returnedToAiAt (lifting the AI-runnable exclusion) and settle reviewedAt so
  // the entry leaves For-review, then re-affirm aiDelegable + a positive verdict
  // (the same mechanism as accepting a claim) so a later assessment can't drop
  // it. saveMetadata also updates the client store so the panel reappears at once.
  const handleReturnToAiQueue = useCallback((entry: DelegationQueueEntry) => {
    saveMetadata(entry.asanaTaskGid, entry.integrationId, { aiDelegable: true })
      .catch(err => console.error('Error setting aiDelegable:', err));
    Promise.all([
      api.returnDelegationToAiQueue(entry.asanaTaskGid, entry.integrationId, entry.reviewedAt),
      api.applyAiVerdicts([{ gid: entry.asanaTaskGid, integrationId: entry.integrationId }], []),
    ])
      .then(() => refreshDelegation())
      .catch(err => {
        toast.error('Failed to return to AI queue');
        console.error('Error returning delegation to AI queue:', err);
      });
    toast.success('Returned to AI queue');
  }, [saveMetadata, refreshDelegation, toast]);

  // GIDs of Asana tasks the store currently shows as completed. A task merely
  // absent from the store is NOT treated as completed — an integration fetch
  // may have failed or the task may belong to another workspace.
  const completedAsanaGids = useMemo(() => {
    const set = new Set<string>();
    for (const t of allAsanaTasks) {
      if (t.completed) set.add(t.id);
    }
    return set;
  }, [allAsanaTasks]);

  // A task completed directly in Asana (outside the app) shouldn't linger in the
  // For-review inbox. Auto-mark such finished, unreviewed entries reviewed so
  // they settle server-side too. Guarded by a ref so each gid is attempted at
  // most once per session (server-side reviewedAt then stops it after refresh).
  const autoReviewedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const entry of Object.values(delegationByGid)) {
      const finished = entry.state === 'done' || entry.state === 'failed';
      if (!finished || entry.reviewedAt) continue;
      if (!completedAsanaGids.has(entry.asanaTaskGid)) continue;
      if (autoReviewedRef.current.has(entry.asanaTaskGid)) continue;
      autoReviewedRef.current.add(entry.asanaTaskGid);
      markReviewed(entry);
    }
  }, [delegationByGid, completedAsanaGids, markReviewed]);

  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      <SectionBar
        activeSection={activeSection}
        onSectionChange={handleSectionChange}
        nudgeCount={goalNudges.length}
      />

      <Header
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        onRefresh={handleRefresh}
        isLoading={isLoading}
        colorScheme={colorScheme}
        activeTab={activeSubTab}
        tabs={tabs}
        onTabChange={handleTabChange}
        notificationEvents={googleEvents}
        showDateNav={activeSection === 'work' && activeTab === 'calendar'}
      />

      {activeSection === 'exercise' ? (
        <div className="flex-1 overflow-y-auto bg-gray-50">
          <ExerciseSection subTab={activeSubTab} />
        </div>
      ) : activeSection === 'music' ? (
        <div className="flex-1 overflow-y-auto bg-gray-50">
          <MusicSection />
        </div>
      ) : activeSection === 'relationships' ? (
        <div className="flex-1 overflow-y-auto bg-gray-50">
          <RelationshipsSection />
        </div>
      ) : activeSection === 'wellbeing' ? (
        <div className="flex-1 overflow-y-auto bg-gray-50">
          <WellbeingSection subTab={activeSubTab} />
        </div>
      ) : activeSection === 'goals' ? (
        <div className="flex-1 overflow-y-auto bg-gray-50">
          <GoalsSection subTab={activeSubTab} onGoalsChanged={refreshGoalNudges} />
        </div>
      ) : activeTab === 'dashboard' ? (
        <div className="flex-1 overflow-hidden min-h-0 bg-gray-50">
          <DashboardContent
            todayEvents={todayTimedEvents}
            rolloverHour={rolloverHour}
            asanaTasks={allAsanaTasks}
            metadataByGid={metadataByGid}
            delegationByGid={delegationByGid}
            capacityData={capacityData}
            capacityLoading={capacityLoading}
            onRefetchCapacity={refetchCapacity}
            timeWorkedByIntegration={timeWorkedByIntegration}
            timeScheduledByIntegration={timeScheduledByIntegration}
            asanaIntegrations={dashboardIntegrations}
            typeFieldInfoByIntegration={asanaTypeFieldInfoByIntegration}
            onOpenTask={handleOpenTaskInPlace}
            onDelegateTask={setDelegateTask}
            completedTaskGids={completedAsanaGids}
            onReloadMetadata={reloadMetadata}
            onDeleteTask={handleSidebarAsanaDelete}
            onPlanApplied={fetchAllEvents}
            staleModalOpen={staleModalOpen}
            onStaleModalOpenChange={setStaleModalOpen}
            onExpandToCalendar={goToCalendarTab}
            goalNudges={goalNudges}
            onOpenGoals={goToGoals}
            taskDialogOpen={Boolean(dashboardDialogTask)}
          />
          {delegateTask && delegateTask.integrationId && (
            <DelegateModal
              asanaTaskGid={delegateTask.id}
              integrationId={delegateTask.integrationId}
              taskTitle={delegateTask.title}
              initialBrief={delegationByGid[delegateTask.id]?.brief || ''}
              onClose={() => setDelegateTask(null)}
              onDelegated={handleDelegated}
            />
          )}
          {/* Open a task over the Command Center without switching to calendar */}
          {dashboardDialogTask && (
            <TaskDetailDialog
              key={dashboardDialogTask.id}
              task={dashboardDialogTask}
              formatDuration={formatMinutes}
              onClose={handleClearOpenTaskDialog}
              elevated={staleModalOpen}
              onBack={staleModalOpen ? handleClearOpenTaskDialog : undefined}
              onPrevTask={prevTaskId ? () => setOpenTaskDialogId(prevTaskId) : undefined}
              onNextTask={nextTaskId ? () => setOpenTaskDialogId(nextTaskId) : undefined}
              onToggleComplete={handleSidebarAsanaComplete}
              onAddComment={handleSidebarAsanaComment}
              onUpdateTask={handleSidebarAsanaUpdate}
              onDeleteTask={handleSidebarAsanaDelete}
              projects={asanaProjects}
              typeFieldInfoByIntegration={asanaTypeFieldInfoByIntegration}
              metadata={metadataByGid[dashboardDialogTask.id]}
              onSaveMetadata={saveMetadata}
              delegationEntry={delegationByGid[dashboardDialogTask.id]}
              onDelegated={handleDelegated}
              onMoveToBacklog={handleMoveToBacklog}
              onReturnToAiQueue={handleReturnToAiQueue}
            />
          )}
        </div>
      ) : activeTab === 'rituals' ? (
        <div className="flex-1 overflow-y-auto">
          <RitualsContent />
        </div>
      ) : activeTab === 'reminders' ? (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto p-6">
            <Reminders
              asanaIntegrations={asanaIntegrations}
              asanaProjects={asanaProjects}
              asanaTypeFieldInfoByIntegration={asanaTypeFieldInfoByIntegration}
              onCreateAsanaTask={handleSidebarAsanaCreate}
            />
          </div>
        </div>
      ) : activeTab === 'projects' ? (
        <div className="flex-1 overflow-y-auto bg-gray-50">
          <ProjectsTab />
        </div>
      ) : activeTab === 'analysis' ? (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto p-6">
            {analysisSyncing ? (
              <div className="flex items-center justify-center gap-3 py-16 text-sm text-gray-500">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-orange-500" />
                Syncing from your calendar…
              </div>
            ) : (
              <AnalysisView key={analysisKey} />
            )}
          </div>
        </div>
      ) : (
        <CalendarTab
          colorScheme={colorScheme}
          isLoading={isLoading}
          settings={settings}
          filteredAsanaTasks={filteredAsanaTasks}
          scheduledAsanaTasks={scheduledAsanaTasks}
          asanaProjects={asanaProjects}
          asanaTypeValues={asanaTypeValues}
          asanaTypeFieldInfoByIntegration={asanaTypeFieldInfoByIntegration}
          asanaIntegrations={asanaIntegrations}
          metadataByGid={metadataByGid}
          delegationByGid={delegationByGid}
          onUnschedule={handleUnscheduleAsana}
          onToggleComplete={handleSidebarAsanaComplete}
          onAddComment={handleSidebarAsanaComment}
          onCreateAsanaTask={handleSidebarAsanaCreate}
          onUpdateTask={handleSidebarAsanaUpdate}
          onDeleteTask={handleSidebarAsanaDelete}
          onSaveTaskMetadata={saveMetadata}
          onDelegated={handleDelegated}
          highlightedAsanaTaskId={highlightedAsanaTaskId}
          onClearHighlight={handleClearHighlight}
          openTaskDialogId={openTaskDialogId}
          onClearOpenTaskDialog={handleClearOpenTaskDialog}
          omIntegrationId={OM_INTEGRATION_ID}
          dbcIntegrationId={DBC_INTEGRATION_ID}
          omFilters={omFilters}
          dbcFilters={dbcFilters}
          onOmFiltersChange={handleOmFiltersChange}
          onDbcFiltersChange={handleDbcFiltersChange}
          onOmClearFilters={handleOmClearFilters}
          onDbcClearFilters={handleDbcClearFilters}
          allDayEvents={allDayEvents}
          timedEvents={timedEvents}
          selectedDate={selectedDate}
          onEventClick={handleEventClick}
          onEventDoubleClick={handleEventDoubleClick}
          onDropTask={handleDropTask}
          onEventMove={handleEventMove}
          onDeleteEvent={handleDeleteEventRequest}
          onCreateTask={handleTimelineCreateTask}
          googleEventAttributions={googleEventAttributions}
          setGoogleEventAttributions={setGoogleEventAttributions}
        />
      )}

      {calendarSelectionModal.show && (
        <CalendarSelectionModal
          integrations={connectedGoogleIntegrations}
          onSelect={handleCalendarSelection}
          onCancel={() => setCalendarSelectionModal({ show: false, pendingDrop: null })}
        />
      )}

      {deleteConfirmModal.show && deleteConfirmModal.event && (
        <DeleteConfirmModal
          event={deleteConfirmModal.event}
          onCancel={() => setDeleteConfirmModal({ show: false, event: null })}
          onConfirm={handleConfirmDelete}
        />
      )}

      <AddTaskModal
        isOpen={createTaskModal.show}
        onClose={() => setCreateTaskModal({ show: false, startTime: null, endTime: null })}
        onAdd={handleAddTask}
        defaultDate={selectedDate}
        defaultStartTime={createTaskModal.startTime || undefined}
        defaultEndTime={createTaskModal.endTime || undefined}
        googleIntegrations={connectedGoogleIntegrations.map(i => ({ id: i.id, name: i.name }))}
        asanaIntegrations={asanaIntegrations.map(i => ({ id: i.id, name: i.name }))}
      />

      {batchBlockEvent && (
        <BatchBlockDialog
          event={batchBlockEvent}
          members={batchBlockMembers}
          onMemberDone={handleBatchMemberDone}
          onMemberRemove={handleBatchMemberRemove}
          onMemberPortalDone={handleBatchMemberPortalDone}
          onOpenTask={handleBatchMemberOpen}
          onClose={closeBatchBlock}
        />
      )}

      {selectedGoogleEvent && (
        <GoogleEventModal
          event={selectedGoogleEvent}
          setSelectedGoogleEvent={setSelectedGoogleEvent}
          isEditing={googleEventModal.isEditing}
          setIsEditing={googleEventModal.setIsEditing}
          editingTitle={googleEventModal.editingTitle}
          setEditingTitle={googleEventModal.setEditingTitle}
          editingDescription={googleEventModal.editingDescription}
          setEditingDescription={googleEventModal.setEditingDescription}
          isSaving={googleEventModal.isSaving}
          setIsSaving={googleEventModal.setIsSaving}
          googleEventAttributions={googleEventAttributions}
          setGoogleEventAttributions={setGoogleEventAttributions}
          asanaIntegrations={asanaIntegrations}
          updateGoogleEvent={updateGoogleEvent}
          onRequestDelete={(ev) => {
            setDeleteConfirmModal({ show: true, event: ev });
            setSelectedGoogleEvent(null);
          }}
        />
      )}
    </div>
  );
}
