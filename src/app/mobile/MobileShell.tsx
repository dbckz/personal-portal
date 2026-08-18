'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { addDays, format, subDays } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { api, type WeekStateResponse } from '@/lib/api';
import { formatDuration, getDayLabel } from '@/lib/event-display';
import { mergeEventsForDate } from '@/lib/event-merge';
import { logicalToday } from '@/lib/date-utils';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useDashboard } from '@/hooks/useDashboard';
import { useDelegationQueue } from '@/hooks/useDelegationQueue';
import { useReminders } from '@/hooks/useReminders';
import { useTaskMetadata } from '@/hooks/useTaskMetadata';
import { useTasks } from '@/hooks/useTasks';
import { useTimeAttribution } from '@/hooks/useTimeAttribution';
import { useToast } from '@/hooks/useToast';
import { DelegateModal } from '@/components/DelegateModal';
import { CalendarEvent, DelegationQueueEntry, SettingsResponse } from '@/types';
import { MOBILE_COLOR_SCHEMES, MobileHeader } from './components/MobileHeader';
import { MOBILE_TABS, MobileTab, MobileTabBar } from './components/MobileTabBar';
import { EventDetailSheet } from './components/EventDetailSheet';
import { MobileEventFormSheet, EventFormValues } from './components/MobileEventFormSheet';
import { MobileScheduleSheet } from './components/MobileScheduleSheet';
import { MobileTaskDetailSheet } from './components/MobileTaskDetailSheet';
import { MobileCreateTaskSheet } from './components/MobileCreateTaskSheet';
import { resolveBlockMembers, isGroupedBlock, type BlockMember } from '@/lib/scheduling/block-members';
import { MobileDailyReviewFlow, type MobileReviewEntry } from './components/MobileDailyReviewFlow';
import { CommandCenterTab } from './tabs/CommandCenterTab';
import { MobilePlanWeekWizard } from './plan-week/MobilePlanWeekWizard';
import { DayTab } from './tabs/DayTab';
import { RemindersTab } from './tabs/RemindersTab';
import { ExerciseTab } from './tabs/ExerciseTab';
import { GoalsTab } from './tabs/GoalsTab';
import { WellbeingTab } from './tabs/WellbeingTab';
import { useGoalNudges } from '@/hooks/useGoalNudges';
import {
  useExerciseOverview,
  useGoalsOverview,
  useWellbeingOverview,
} from '@/hooks/useLifeAreas';

const TAB_STORAGE_KEY = 'mobile-active-tab';

const TAB_SUBTITLES: Record<MobileTab, string> = {
  home: 'Command Center',
  day: 'Daily Planner',
  reminders: 'Reminders',
  goals: 'Goals',
  exercise: 'Exercise',
  wellbeing: 'Wellbeing',
};

export function MobileShell() {
  const toast = useToast();

  // Default tab matches desktop (Command Center); the persisted choice is
  // applied after mount so SSR and the first client render agree.
  const [activeTab, setActiveTab] = useState<MobileTab>('home');
  useEffect(() => {
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY);
    // Validated against the live tab list, so a tab removed in a later version
    // can't leave the shell rendering nothing.
    if (stored && (MOBILE_TABS as string[]).includes(stored)) {
      setActiveTab(stored as MobileTab);
    }
  }, []);
  const changeTab = useCallback((tab: MobileTab) => {
    setActiveTab(tab);
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // Private-mode quota errors just lose the persistence, nothing else.
    }
  }, []);

  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [now, setNow] = useState(() => new Date());
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [delegateTask, setDelegateTask] = useState<CalendarEvent | null>(null);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [showPlanWeek, setShowPlanWeek] = useState(false);
  // Google calendar event create/edit form.
  const [eventForm, setEventForm] = useState<{ mode: 'create' | 'edit'; event?: CalendarEvent } | null>(null);
  // Scheduling sheet: 'new' schedules an unscheduled task; 'move' reschedules an
  // existing scheduled Asana event.
  const [scheduleTarget, setScheduleTarget] = useState<
    { kind: 'new'; task: CalendarEvent } | { kind: 'move'; event: CalendarEvent } | null
  >(null);
  // Time-tracking attributions keyed by Google event id.
  const [googleEventAttributions, setGoogleEventAttributions] = useState<
    Record<string, { asanaIntegrationId: string; googleIntegrationId: string }>
  >({});
  const [colorSchemeIndex, setColorSchemeIndex] = useState(0);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Week state drives the "review due" prompt on the Home card; cheap (local
  // stores), reloaded whenever a review / replan applies. null until first load.
  const [weekState, setWeekState] = useState<WeekStateResponse | null>(null);
  // Which planning flow is open over the shell, if any.
  const [reviewEntry, setReviewEntry] = useState<MobileReviewEntry | null>(null);

  const { getTasksForDate, addTask } = useTasks();
  const {
    googleEvents,
    allAsanaTasks,
    rawAsanaTasks,
    scheduledAsanaTasks,
    isLoading,
    fetchAllEvents,
    fetchEventsForDate,
    adhocToCalendarEvent,
    getScheduledAsanaEventsForDate,
    asanaIntegrations,
    asanaProjects,
    asanaTypeFieldInfoByIntegration,
    completeAsanaTask,
    addAsanaComment,
    createAsanaTask,
    updateAsanaTask,
    deleteAsanaTask,
    unscheduleAllAsanaInstances,
    createGoogleEvent,
    updateGoogleEvent,
    deleteGoogleEvent,
    scheduleAsana,
    updateScheduledAsana,
    updateScheduledAsanaByGoogleEvent,
    unscheduleAsana,
  } = useCalendarEvents();
  const remindersStore = useReminders();
  const { metadataByGid, saveMetadata, reload: reloadMetadata } = useTaskMetadata();
  const { delegationByGid, refresh: refreshDelegation } = useDelegationQueue();
  const { data: capacityData, isLoading: capacityLoading, refetch: refetchCapacity } = useDashboard();
  // Life-area feeds. Both are lazy: goal evidence can cost an Asana round trip
  // per goal, so nothing is fetched until the tab is opened.
  const { nudges: goalNudges } = useGoalNudges();
  const goalsOverview = useGoalsOverview(activeTab === 'goals');
  const exerciseOverview = useExerciseOverview(activeTab === 'exercise');
  const wellbeingOverview = useWellbeingOverview(activeTab === 'wellbeing');

  const loadSettings = useCallback(async () => {
    try {
      setSettingsError(null);
      const settingsData = await api.getSettings();
      setSettings(settingsData);
    } catch (error) {
      console.error('Failed to load mobile settings:', error);
      setSettingsError('Unable to load planner settings');
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const loadWeekState = useCallback(() => {
    api.getWeekState()
      .then(setWeekState)
      .catch(() => setWeekState(null));
  }, []);
  useEffect(() => {
    loadWeekState();
  }, [loadWeekState]);

  // Load time-tracking attributions once so the event sheet can show/set them.
  useEffect(() => {
    api.getGoogleEventAttributions()
      .then(({ attributions }) => {
        const map: Record<string, { asanaIntegrationId: string; googleIntegrationId: string }> = {};
        for (const a of attributions) {
          map[a.googleEventId] = { asanaIntegrationId: a.asanaIntegrationId, googleIntegrationId: a.googleIntegrationId };
        }
        setGoogleEventAttributions(map);
      })
      .catch(err => console.error('Failed to load event attributions:', err));
  }, []);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      setColorSchemeIndex(Math.floor(Math.random() * MOBILE_COLOR_SCHEMES.length));
    });

    return () => window.cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    fetchEventsForDate(selectedDate);
  }, [fetchEventsForDate, selectedDate]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Merge the day's sources (Google + adhoc + scheduled Asana) for any date.
  const buildEventsForDate = useCallback((dateStr: string): CalendarEvent[] => {
    const adhocEvents = getTasksForDate(dateStr)
      .filter(task => task.dueTime && !task.googleEventId)
      .map(adhocToCalendarEvent);

    return mergeEventsForDate(dateStr, {
      googleEvents,
      scheduledAsanaTasks,
      adhocEvents,
      scheduledAsanaEvents: getScheduledAsanaEventsForDate(dateStr),
      allAsanaTasks,
    });
  }, [
    adhocToCalendarEvent,
    allAsanaTasks,
    getScheduledAsanaEventsForDate,
    getTasksForDate,
    googleEvents,
    scheduledAsanaTasks,
  ]);

  const dateKey = useMemo(() => format(selectedDate, 'yyyy-MM-dd'), [selectedDate]);
  const dayEvents = useMemo(() => buildEventsForDate(dateKey), [buildEventsForDate, dateKey]);

  // Logical today's timed events for the Command Center, attributed to
  // workspaces by the same rules as desktop.
  const buildTodayTimedEvents = useCallback(
    (rolloverHour: number) =>
      buildEventsForDate(logicalToday(new Date(), rolloverHour)).filter(e => !e.allDay),
    [buildEventsForDate]
  );
  const {
    rolloverHour,
    todayTimedEvents,
    timeWorkedByIntegration,
    timeScheduledByIntegration,
  } = useTimeAttribution(settings, googleEvents, buildTodayTimedEvents);

  // Unscheduled Asana tasks due/starting on the selected date (Day tab list).
  const dueTodayTasks = useMemo(() => {
    const dayStart = new Date(selectedDate);
    dayStart.setHours(0, 0, 0, 0);
    const fallback = dayStart.getTime();

    return allAsanaTasks
      .filter(task => !task.completed)
      .filter(task => task.dueOn === dateKey || task.startOn === dateKey)
      .filter(task => !scheduledAsanaTasks.some(schedule => schedule.asanaTaskId === task.id && schedule.scheduledDate === dateKey))
      .sort((a, b) => {
        const aCreated = a.createdAt ? new Date(a.createdAt).getTime() : fallback;
        const bCreated = b.createdAt ? new Date(b.createdAt).getTime() : fallback;
        return aCreated - bCreated;
      });
  }, [allAsanaTasks, dateKey, scheduledAsanaTasks, selectedDate]);

  const incompleteAsanaTasks = useMemo(
    () => allAsanaTasks.filter(t => !t.completed),
    [allAsanaTasks]
  );

  // GIDs the store currently shows as completed — a task merely absent from the
  // store is NOT treated as completed (matches desktop).
  const completedTaskGids = useMemo(() => {
    const set = new Set<string>();
    for (const t of allAsanaTasks) {
      if (t.completed) set.add(t.id);
    }
    return set;
  }, [allAsanaTasks]);

  const openTask = useMemo(
    () => (openTaskId ? allAsanaTasks.find(t => t.id === openTaskId) ?? null : null),
    [openTaskId, allAsanaTasks]
  );

  const activeReminderCount = useMemo(
    () => remindersStore.reminders.filter(r => !r.completed).length,
    [remindersStore.reminders]
  );

  const connectedCount = useMemo(() => {
    if (!settings) return 0;
    const google = settings.googleIntegrations.filter(item => item.enabled && item.connected).length;
    const asana = settings.asanaIntegrations.filter(item => item.enabled && item.connected).length;
    return google + asana;
  }, [settings]);

  // Every configured workspace, whether or not any of its tasks loaded, so a
  // fetch failure can't silently drop a workspace row (matches desktop).
  const dashboardIntegrations = useMemo(() => {
    const fromSettings = (settings?.asanaIntegrations ?? [])
      .filter(i => i.enabled)
      .map(i => ({ id: i.id, name: i.name }));
    const seen = new Set(fromSettings.map(i => i.id));
    return [...fromSettings, ...asanaIntegrations.filter(i => !seen.has(i.id))];
  }, [settings, asanaIntegrations]);

  // Connected Google calendars, for the event create/edit calendar picker.
  const connectedGoogleIntegrations = useMemo(
    () =>
      (settings?.googleIntegrations ?? [])
        .filter(i => i.enabled && i.connected)
        .map(i => ({ id: i.id, name: i.name })),
    [settings]
  );

  // Member tasks when the open event is a grouped batch block (else empty).
  const selectedEventMembers = useMemo<BlockMember[]>(() => {
    if (!selectedEvent) return [];
    const adhocTasks = getTasksForDate(format(selectedEvent.startTime, 'yyyy-MM-dd'));
    if (!isGroupedBlock(selectedEvent, scheduledAsanaTasks, adhocTasks)) return [];
    return resolveBlockMembers(selectedEvent.id, scheduledAsanaTasks, adhocTasks, gid => {
      const t = rawAsanaTasks.find(task => task.id === gid);
      return t ? { title: t.title, completed: !!t.completed, integrationId: t.integrationId } : undefined;
    });
  }, [selectedEvent, scheduledAsanaTasks, allAsanaTasks, rawAsanaTasks, getTasksForDate]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([fetchAllEvents(), loadSettings(), remindersStore.refetch()]);
      refreshDelegation();
      refetchCapacity();
      loadWeekState();
      // Only the life-area feed being looked at — refreshing the other would
      // fetch data that isn't on screen, and goal evidence isn't free.
      if (activeTab === 'goals') goalsOverview.refresh();
      if (activeTab === 'exercise') exerciseOverview.refresh();
      if (activeTab === 'wellbeing') wellbeingOverview.refresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [
    fetchAllEvents,
    loadSettings,
    remindersStore,
    refreshDelegation,
    refetchCapacity,
    loadWeekState,
    activeTab,
    goalsOverview,
    exerciseOverview,
    wellbeingOverview,
  ]);

  // A Day-tab event opens the task sheet when it's backed by an Asana task in
  // the store; otherwise the editable event sheet.
  const handleSelectEvent = useCallback((event: CalendarEvent) => {
    const taskId = event.linkedAsanaTaskId || (event.source === 'asana' ? event.id : null);
    // A grouped batch block keeps its own sheet (member drill-down) even though
    // it carries a linked task id.
    const adhocTasks = getTasksForDate(format(event.startTime, 'yyyy-MM-dd'));
    if (taskId && allAsanaTasks.some(t => t.id === taskId) && !isGroupedBlock(event, scheduledAsanaTasks, adhocTasks)) {
      setOpenTaskId(taskId);
      return;
    }
    setSelectedEvent(event);
  }, [allAsanaTasks, scheduledAsanaTasks, getTasksForDate]);

  const handleCreateEvent = useCallback(() => {
    setEventForm({ mode: 'create' });
  }, []);

  const handleEditEvent = useCallback((event: CalendarEvent) => {
    setSelectedEvent(null);
    setEventForm({ mode: 'edit', event });
  }, []);

  const handleSubmitEventForm = useCallback(async (values: EventFormValues) => {
    if (eventForm?.mode === 'create') {
      const created = await createGoogleEvent(values.integrationId, values.title, values.start, values.end);
      if (!created) {
        toast.error('Failed to add event');
        throw new Error('create failed');
      }
      toast.success('Event added');
      setEventForm(null);
      return;
    }
    const event = eventForm?.event;
    if (!event?.integrationId) {
      toast.error('Cannot update event: missing calendar');
      return;
    }
    const result = await updateGoogleEvent(
      event.id,
      event.integrationId,
      values.start,
      values.end,
      values.title,
      undefined,
      event.calendarId
    );
    if (!result.success) {
      toast.error(result.error || 'Failed to update event');
      throw new Error('update failed');
    }
    // Keep a linked Asana schedule in sync with the new time.
    if (scheduledAsanaTasks.some(s => s.googleEventId === event.id)) {
      await updateScheduledAsanaByGoogleEvent(event.id, {
        scheduledDate: format(values.start, 'yyyy-MM-dd'),
        scheduledTime: format(values.start, 'HH:mm'),
        duration: Math.round((values.end.getTime() - values.start.getTime()) / 60000),
      });
    }
    toast.success('Event updated');
    setEventForm(null);
  }, [eventForm, createGoogleEvent, updateGoogleEvent, updateScheduledAsanaByGoogleEvent, scheduledAsanaTasks, toast]);

  const handleDeleteEvent = useCallback(async (event: CalendarEvent) => {
    if (event.source !== 'google' || !event.integrationId) return;
    // Delete the Google event; unschedule any Asana task linked to it first.
    const linked = scheduledAsanaTasks.find(s => s.googleEventId === event.id);
    if (linked) await unscheduleAsana(linked.id);
    const ok = await deleteGoogleEvent(event.id, event.integrationId, event.calendarId);
    if (!ok) {
      toast.error('Failed to delete event');
      throw new Error('delete failed');
    }
    toast.success('Event deleted');
    setSelectedEvent(null);
  }, [deleteGoogleEvent, unscheduleAsana, scheduledAsanaTasks, toast]);

  const handleSetAttribution = useCallback(async (event: CalendarEvent, asanaIntegrationId: string) => {
    if (!event.integrationId) {
      toast.error('Cannot attribute: missing calendar');
      return;
    }
    try {
      await api.setGoogleEventAttribution(event.id, event.integrationId, asanaIntegrationId);
      setGoogleEventAttributions(prev => ({
        ...prev,
        [event.id]: { asanaIntegrationId, googleIntegrationId: event.integrationId! },
      }));
      toast.success('Attribution set');
    } catch (err) {
      console.error('Failed to set attribution:', err);
      toast.error('Failed to set attribution');
    }
  }, [toast]);

  const handleRemoveAttribution = useCallback(async (event: CalendarEvent) => {
    try {
      await api.removeGoogleEventAttribution(event.id);
      setGoogleEventAttributions(prev => {
        const next = { ...prev };
        delete next[event.id];
        return next;
      });
      toast.success('Attribution removed');
    } catch (err) {
      console.error('Failed to remove attribution:', err);
      toast.error('Failed to remove attribution');
    }
  }, [toast]);

  const handleBlockMemberAction = useCallback(async (action: 'done' | 'remove', member: BlockMember) => {
    await api.updateBlockMember(action, {
      source: member.source,
      taskId: member.taskId,
      ...(member.gid ? { gid: member.gid } : {}),
      ...(member.integrationId ? { integrationId: member.integrationId } : {}),
      ...(member.scheduleId ? { scheduleId: member.scheduleId } : {}),
      ...(member.adhocId ? { adhocId: member.adhocId } : {}),
    });
  }, []);

  const handleMemberDone = useCallback(async (member: BlockMember) => {
    try {
      await handleBlockMemberAction('done', member);
    } catch (err) {
      toast.error('Could not mark the task done');
      throw err;
    }
  }, [handleBlockMemberAction, toast]);

  const handleMemberRemove = useCallback(async (member: BlockMember) => {
    try {
      await handleBlockMemberAction('remove', member);
    } catch (err) {
      toast.error('Could not remove the task from the block');
      throw err;
    }
  }, [handleBlockMemberAction, toast]);

  // Reconcile block-member changes with the server when the sheet closes.
  const handleCloseEventSheet = useCallback(() => {
    setSelectedEvent(null);
    if (selectedEventMembers.length > 0) fetchAllEvents();
  }, [selectedEventMembers, fetchAllEvents]);

  const handleMoveEvent = useCallback((event: CalendarEvent) => {
    setScheduleTarget({ kind: 'move', event });
  }, []);

  const handleScheduleTask = useCallback((task: CalendarEvent) => {
    setScheduleTarget({ kind: 'new', task });
  }, []);

  const handleUnscheduleEvent = useCallback(async (event: CalendarEvent) => {
    if (event.source === 'asana') {
      const ok = await unscheduleAsana(event.id);
      if (ok) toast.success('Unscheduled');
      else toast.error('Failed to unschedule');
      return;
    }
    if (event.source === 'google') {
      const linked = scheduledAsanaTasks.find(s => s.googleEventId === event.id);
      if (linked) await unscheduleAsana(linked.id);
      if (event.integrationId) await deleteGoogleEvent(event.id, event.integrationId, event.calendarId);
      toast.success('Unscheduled');
    }
  }, [unscheduleAsana, deleteGoogleEvent, scheduledAsanaTasks, toast]);

  const handleSubmitSchedule = useCallback(async (dateStr: string, timeStr: string) => {
    if (!scheduleTarget) return;
    if (scheduleTarget.kind === 'new') {
      const task = scheduleTarget.task;
      const scheduled = await scheduleAsana(task.id, task.integrationId, dateStr, timeStr, 30, undefined, undefined, task.title);
      if (!scheduled) {
        toast.error('Failed to schedule task');
        throw new Error('schedule failed');
      }
      toast.success('Task scheduled');
      setScheduleTarget(null);
      return;
    }
    const event = scheduleTarget.event;
    if (event.source === 'asana') {
      const updated = await updateScheduledAsana(event.id, { scheduledDate: dateStr, scheduledTime: timeStr });
      if (!updated) {
        toast.error('Failed to move task');
        throw new Error('move failed');
      }
    } else {
      // A Google-linked block: move the event, then sync the schedule record.
      if (!event.integrationId) {
        toast.error('Cannot move: missing calendar');
        return;
      }
      const duration = Math.round((event.endTime.getTime() - event.startTime.getTime()) / 60000);
      const newStart = new Date(`${dateStr}T${timeStr}`);
      const newEnd = new Date(newStart.getTime() + duration * 60000);
      const result = await updateGoogleEvent(event.id, event.integrationId, newStart, newEnd, event.title, undefined, event.calendarId);
      if (!result.success) {
        toast.error(result.error || 'Failed to move task');
        throw new Error('move failed');
      }
      await updateScheduledAsanaByGoogleEvent(event.id, { scheduledDate: dateStr, scheduledTime: timeStr, duration });
    }
    toast.success('Task moved');
    setScheduleTarget(null);
  }, [scheduleTarget, scheduleAsana, updateScheduledAsana, updateGoogleEvent, updateScheduledAsanaByGoogleEvent, toast]);

  const handleOpenTask = useCallback((taskOrGid: CalendarEvent | string) => {
    setOpenTaskId(typeof taskOrGid === 'string' ? taskOrGid : taskOrGid.id);
  }, []);

  const handleToggleComplete = useCallback((taskId: string, integrationId: string, completed: boolean) => {
    completeAsanaTask(taskId, integrationId, completed)
      .then(() => {
        refetchCapacity();
        toast.success(completed ? 'Task completed' : 'Task reopened');
      })
      .catch(err => {
        console.error('Failed to update task:', err);
        toast.error('Failed to update task');
      });
  }, [completeAsanaTask, refetchCapacity, toast]);

  // After a triage change (AI verdicts applied, or a stale task kept/deleted),
  // refresh the derived feeds that depend on it.
  const handleTriageDataChanged = useCallback(() => {
    refetchCapacity();
    refreshDelegation();
  }, [refetchCapacity, refreshDelegation]);

  const handleMoveToBacklog = useCallback((entry: DelegationQueueEntry) => {
    saveMetadata(entry.asanaTaskGid, entry.integrationId, { aiDelegable: false })
      .catch(err => console.error('Error clearing aiDelegable:', err));
    api.markDelegationReviewed(entry.asanaTaskGid, entry.integrationId)
      .then(() => refreshDelegation())
      .catch(err => {
        toast.error('Failed to clear from review');
        console.error('Error marking delegation reviewed:', err);
      });
    toast.success('Moved to backlog for a human');
  }, [saveMetadata, refreshDelegation, toast]);

  // "Return to AI queue": the next step is AI-runnable again. Mirrors the
  // desktop handler — stamp returnedToAiAt + settle reviewedAt (leaves
  // For-review, lifts the AI-runnable exclusion) and re-affirm aiDelegable + a
  // positive verdict so a later assessment can't drop it.
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

  // Edit an Asana task (due/start dates, Type, projects). Optimistic in the
  // hook; a failure rolls back and surfaces a toast.
  const handleUpdateTask = useCallback((
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
    updateAsanaTask(taskId, integrationId, updates)
      .then(() => refetchCapacity())
      .catch(err => {
        toast.error('Failed to update task in Asana');
        console.error('Error updating Asana task:', err);
      });
  }, [updateAsanaTask, refetchCapacity, toast]);

  const handleDeleteTask = useCallback((taskId: string, integrationId: string) => {
    unscheduleAllAsanaInstances(taskId);
    toast.success('Task deleted from Asana');
    deleteAsanaTask(taskId, integrationId)
      .then(() => refetchCapacity())
      .catch(err => {
        toast.error('Failed to delete task from Asana');
        console.error('Error deleting Asana task:', err);
      });
  }, [deleteAsanaTask, unscheduleAllAsanaInstances, refetchCapacity, toast]);

  const handleCreateAsanaTask = useCallback(async (
    integrationId: string,
    name: string,
    options?: { notes?: string; dueOn?: string; projectGid?: string; customFields?: Record<string, string>; localType?: string }
  ) => {
    try {
      const task = await createAsanaTask(integrationId, name, options);
      if (task) {
        toast.success('Task created in Asana');
        refetchCapacity();
      }
      return task;
    } catch (err) {
      toast.error('Failed to create task in Asana');
      console.error('Error creating Asana task:', err);
      throw err;
    }
  }, [createAsanaTask, refetchCapacity, toast]);

  const handleCreateAdhoc = useCallback(async (
    task: Parameters<typeof addTask>[0]
  ) => {
    const created = await addTask(task);
    if (created) {
      toast.success('Task created');
    } else {
      toast.error('Failed to create task');
    }
    return created;
  }, [addTask, toast]);

  const prevDay = subDays(selectedDate, 1);
  const nextDay = addDays(selectedDate, 1);
  const showLoading = isLoading || isRefreshing;
  const colorScheme = MOBILE_COLOR_SCHEMES[colorSchemeIndex];

  return (
    <div className="min-h-dvh touch-manipulation bg-slate-100 text-gray-950">
      <MobileHeader
        colorScheme={colorScheme}
        subtitle={TAB_SUBTITLES[activeTab]}
        googleEvents={googleEvents}
        onRefresh={handleRefresh}
        isRefreshing={showLoading}
      >
        {activeTab === 'day' && (
          <>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedDate(prevDay)}
                className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md bg-white/10 text-white transition-colors hover:bg-white/20"
                aria-label="Previous day"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => setSelectedDate(new Date())}
                className="min-w-0 flex-1 rounded-md bg-white px-3 py-2 text-center text-slate-950 shadow-sm"
              >
                <span className="block text-base font-semibold">{getDayLabel(selectedDate)}</span>
                <span className="block text-xs text-slate-500">{format(selectedDate, 'EEEE, MMMM d')}</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedDate(nextDay)}
                className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md bg-white/10 text-white transition-colors hover:bg-white/20"
                aria-label="Next day"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-200">
              <span className="rounded-full bg-white/10 px-2.5 py-1">
                {settingsError || `${connectedCount} connected`}
              </span>
              {asanaIntegrations.map(integration => {
                const minutes = timeWorkedByIntegration[integration.id] || 0;
                if (minutes === 0) return null;
                return (
                  <span key={integration.id} className="rounded-full bg-white/10 px-2.5 py-1">
                    {integration.name}: {formatDuration(minutes)}
                  </span>
                );
              })}
            </div>
          </>
        )}
      </MobileHeader>

      <main className="mx-auto max-w-xl px-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] pt-4">
        {activeTab === 'home' && (
          <CommandCenterTab
            todayEvents={todayTimedEvents}
            asanaTasks={incompleteAsanaTasks}
            metadataByGid={metadataByGid}
            delegationByGid={delegationByGid}
            capacityData={capacityData}
            capacityLoading={capacityLoading}
            timeWorkedByIntegration={timeWorkedByIntegration}
            timeScheduledByIntegration={timeScheduledByIntegration}
            rolloverHour={rolloverHour}
            asanaIntegrations={dashboardIntegrations}
            completedTaskGids={completedTaskGids}
            onExpandToDay={() => changeTab('day')}
            onOpenTask={handleOpenTask}
            onDelegateTask={setDelegateTask}
            onReloadMetadata={reloadMetadata}
            onDeleteTask={deleteAsanaTask}
            onDataChanged={handleTriageDataChanged}
            reviewDue={!!weekState?.hasReviewableBlocks}
            onStartReview={() => setReviewEntry('review')}
            onReplan={() => setReviewEntry('replan')}
            onResetWeek={() => setReviewEntry('reset')}
            onPlanWeek={() => setShowPlanWeek(true)}
          />
        )}

        {activeTab === 'day' && (
          <DayTab
            selectedDate={selectedDate}
            now={now}
            events={dayEvents}
            dueTodayTasks={dueTodayTasks}
            isLoading={showLoading}
            onSelectEvent={handleSelectEvent}
            onSelectTask={handleOpenTask}
            onCreateEvent={connectedGoogleIntegrations.length > 0 ? handleCreateEvent : undefined}
            onScheduleTask={handleScheduleTask}
            onMoveEvent={handleMoveEvent}
            onUnscheduleEvent={handleUnscheduleEvent}
          />
        )}

        {activeTab === 'goals' && (
          <GoalsTab
            monthItems={goalsOverview.monthItems}
            quarterItems={goalsOverview.quarterItems}
            nudges={goalNudges}
            isLoading={goalsOverview.isLoading}
            error={goalsOverview.error}
            onChanged={goalsOverview.refresh}
          />
        )}

        {activeTab === 'exercise' && (
          <ExerciseTab
            planned={exerciseOverview.planned}
            recent={exerciseOverview.recent}
            analysis={exerciseOverview.analysis}
            onSessionChanged={exerciseOverview.refresh}
            isLoading={exerciseOverview.isLoading}
            error={exerciseOverview.error}
          />
        )}

        {activeTab === 'wellbeing' && (
          <WellbeingTab
            analysis={wellbeingOverview.analysis}
            experiments={wellbeingOverview.experiments}
            isLoading={wellbeingOverview.isLoading}
            error={wellbeingOverview.error}
            onChanged={wellbeingOverview.refresh}
          />
        )}

        {activeTab === 'reminders' && (
          <RemindersTab
            reminders={remindersStore.reminders}
            updatingIds={remindersStore.updatingIds}
            hasUndo={remindersStore.undoState !== null}
            isArchiving={remindersStore.isArchiving}
            error={remindersStore.error}
            onComplete={reminder => void remindersStore.completeReminder(reminder)}
            onAdd={text => void remindersStore.addReminder(text)}
            onEdit={(id, text) => void remindersStore.updateReminderText(id, text)}
            onDelete={id => void remindersStore.deleteReminder(id)}
            onArchive={() => void remindersStore.archiveReminders()}
            onUndo={() => void remindersStore.undo()}
          />
        )}
      </main>

      <button
        type="button"
        onClick={() => setShowCreateTask(true)}
        className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-orange-600 text-white shadow-lg transition-colors active:bg-orange-700"
        aria-label="New task"
      >
        <Plus className="h-6 w-6" />
      </button>

      <MobileTabBar
        activeTab={activeTab}
        onTabChange={changeTab}
        reminderCount={activeReminderCount}
        goalNudgeCount={goalNudges.length}
      />

      {selectedEvent && (
        <EventDetailSheet
          event={selectedEvent}
          onClose={handleCloseEventSheet}
          onEdit={handleEditEvent}
          onDelete={handleDeleteEvent}
          attribution={googleEventAttributions[selectedEvent.id]}
          asanaIntegrations={dashboardIntegrations}
          onSetAttribution={id => handleSetAttribution(selectedEvent, id)}
          onRemoveAttribution={() => handleRemoveAttribution(selectedEvent)}
          members={selectedEventMembers}
          onMemberDone={handleMemberDone}
          onMemberRemove={handleMemberRemove}
        />
      )}

      {eventForm && (
        <MobileEventFormSheet
          mode={eventForm.mode}
          initialTitle={eventForm.event?.title ?? ''}
          initialStart={eventForm.event?.startTime ?? (() => {
            const start = new Date(selectedDate);
            start.setHours(9, 0, 0, 0);
            return start;
          })()}
          initialEnd={eventForm.event?.endTime ?? (() => {
            const end = new Date(selectedDate);
            end.setHours(9, 30, 0, 0);
            return end;
          })()}
          googleIntegrations={connectedGoogleIntegrations}
          fixedIntegrationId={eventForm.mode === 'edit' ? eventForm.event?.integrationId : undefined}
          onSubmit={handleSubmitEventForm}
          onClose={() => setEventForm(null)}
        />
      )}

      {scheduleTarget && (
        <MobileScheduleSheet
          title={scheduleTarget.kind === 'new' ? scheduleTarget.task.title : scheduleTarget.event.title}
          initialDate={
            scheduleTarget.kind === 'new'
              ? dateKey
              : format(scheduleTarget.event.startTime, 'yyyy-MM-dd')
          }
          initialTime={
            scheduleTarget.kind === 'new'
              ? '09:00'
              : format(scheduleTarget.event.startTime, 'HH:mm')
          }
          submitLabel={scheduleTarget.kind === 'new' ? 'Schedule' : 'Move'}
          eventsForDate={buildEventsForDate}
          onSubmit={handleSubmitSchedule}
          onClose={() => setScheduleTarget(null)}
        />
      )}

      {openTask && (
        <MobileTaskDetailSheet
          task={openTask}
          delegationEntry={delegationByGid[openTask.id]}
          onClose={() => setOpenTaskId(null)}
          onToggleComplete={handleToggleComplete}
          onAddComment={addAsanaComment}
          onUpdateTask={handleUpdateTask}
          onDeleteTask={handleDeleteTask}
          projects={asanaProjects}
          typeFieldInfoByIntegration={asanaTypeFieldInfoByIntegration}
          metadata={metadataByGid[openTask.id]}
          onSaveMetadata={saveMetadata}
          onDelegate={setDelegateTask}
          onDraftChange={refreshDelegation}
          onMoveToBacklog={handleMoveToBacklog}
          onReturnToAiQueue={handleReturnToAiQueue}
        />
      )}

      {showCreateTask && (
        <MobileCreateTaskSheet
          integrations={asanaIntegrations}
          projects={asanaProjects}
          typeFieldInfoByIntegration={asanaTypeFieldInfoByIntegration}
          onClose={() => setShowCreateTask(false)}
          onCreateAsanaTask={handleCreateAsanaTask}
          onCreateAdhoc={handleCreateAdhoc}
        />
      )}

      {delegateTask && delegateTask.integrationId && (
        <DelegateModal
          asanaTaskGid={delegateTask.id}
          integrationId={delegateTask.integrationId}
          taskTitle={delegateTask.title}
          initialBrief={delegateTask.description || ''}
          onClose={() => setDelegateTask(null)}
          onDelegated={() => {
            refreshDelegation();
            refetchCapacity();
          }}
        />
      )}

      <MobilePlanWeekWizard
        isOpen={showPlanWeek}
        onClose={() => setShowPlanWeek(false)}
        asanaTasks={incompleteAsanaTasks}
        typeFieldInfoByIntegration={asanaTypeFieldInfoByIntegration}
        asanaIntegrations={asanaIntegrations}
        onApplied={() => {
          fetchAllEvents();
          refetchCapacity();
          refreshDelegation();
          loadWeekState();
        }}
      />

      {reviewEntry && (
        <MobileDailyReviewFlow
          entry={reviewEntry}
          workspaceOptions={dashboardIntegrations}
          onClose={() => setReviewEntry(null)}
          onApplied={() => {
            fetchAllEvents();
            refetchCapacity();
            refreshDelegation();
            loadWeekState();
          }}
        />
      )}
    </div>
  );
}
