'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { CalendarEvent, CalendarEventResponse, ScheduledAsanaTask, AsanaProject, AsanaFilterState, AsanaDateFilter } from '@/types';
import { api, parseCalendarEvents, ApiRequestError } from '@/lib/api';
import { isToday, isPast, isThisWeek, parseISO, compareAsc } from 'date-fns';
import { readAsanaTasksCache, writeAsanaTasksCache } from '@/lib/cache';
import { LOCAL_TYPE_FIELD_GID } from '@/lib/local-task-types-shared';

interface CreateAsanaTaskOptions {
  notes?: string;
  dueOn?: string;
  projectGid?: string;
  customFields?: Record<string, string>; // fieldGid -> enumOptionGid
  localType?: string; // Type label for a local-only workspace (e.g. DBC), set server-side
}

interface UpdateAsanaTaskOptions {
  dueOn?: string | null;
  startOn?: string | null;
  customFields?: Record<string, string | null>;
  addProjects?: string[];
  removeProjects?: string[];
  addTags?: string[];
  removeTags?: string[];
}

interface TypeFieldInfo {
  fieldGid: string;
  enumOptions: Map<string, string>; // displayValue -> enumOptionGid
}

interface UseAsanaTasksReturn {
  allAsanaTasks: CalendarEvent[];
  rawAsanaTasks: CalendarEvent[];
  filteredAsanaTasks: CalendarEvent[];
  scheduledAsanaTasks: ScheduledAsanaTask[];
  isLoading: boolean;
  error: string | null;
  // Filter state
  projects: AsanaProject[];
  typeValues: string[]; // Unique type values from tasks
  typeFieldInfoByIntegration: Map<string, TypeFieldInfo>; // Info for setting Type field on new tasks, per integration
  integrations: { id: string; name: string }[]; // Unique integrations from tasks
  filters: AsanaFilterState; // Default filters (for shared sidebar without locked integration)
  filtersMap: Record<string, AsanaFilterState>; // Per-integration filters
  setFilters: (filters: AsanaFilterState, integrationId?: string) => void;
  getFiltersForIntegration: (integrationId: string) => AsanaFilterState;
  clearFilters: (integrationId?: string) => void;
  // Actions
  fetchAllAsanaTasks: () => Promise<void>;
  scheduleAsana: (
    asanaTaskId: string,
    integrationId: string | undefined,
    scheduledDate: string,
    scheduledTime: string,
    duration: number,
    googleEventId?: string,
    googleIntegrationId?: string,
    taskName?: string
  ) => Promise<ScheduledAsanaTask | null>;
  updateScheduledAsana: (
    scheduleId: string,
    updates: Partial<ScheduledAsanaTask>
  ) => Promise<ScheduledAsanaTask | null>;
  updateScheduledAsanaByGoogleEvent: (
    googleEventId: string,
    updates: Partial<ScheduledAsanaTask>
  ) => Promise<ScheduledAsanaTask | null>;
  unscheduleAsana: (scheduleId: string) => Promise<boolean>;
  unscheduleAllAsanaInstances: (asanaTaskId: string) => Promise<boolean>;
  getScheduledAsanaEventsForDate: (date: string) => CalendarEvent[];
  completeAsanaTask: (taskId: string, integrationId: string, completed: boolean) => Promise<void>;
  addAsanaComment: (taskId: string, integrationId: string, comment: string, htmlText?: string) => Promise<void>;
  createAsanaTask: (integrationId: string, name: string, options?: CreateAsanaTaskOptions) => Promise<CalendarEvent | null>;
  updateAsanaTask: (taskId: string, integrationId: string, updates: UpdateAsanaTaskOptions) => Promise<CalendarEvent | null>;
  deleteAsanaTask: (taskId: string, integrationId: string) => Promise<boolean>;
}

const DEFAULT_FILTERS: AsanaFilterState = {
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


// Helper to get "Type" custom field value from a task
function getTaskTypeValue(task: CalendarEvent): string | null {
  const typeField = task.customFields?.find(
    cf => cf.name.toLowerCase() === 'type'
  );
  return typeField?.displayValue || null;
}

// Helper to compare optional date strings for sorting
// Returns comparison result (-1, 0, 1) with nulls sorted to end when direction is positive
function compareDateStrings(
  dateA: string | undefined,
  dateB: string | undefined,
  direction: number
): number {
  if (!dateA && !dateB) return 0;
  if (!dateA) return direction; // No date goes to end for asc
  if (!dateB) return -direction;
  return direction * compareAsc(parseISO(dateA), parseISO(dateB));
}

// Helper to check if date matches filter
function matchesDateFilter(dateStr: string | undefined, filter: AsanaDateFilter): boolean {
  if (filter === 'all') return true;

  const date = dateStr ? parseISO(dateStr) : null;

  switch (filter) {
    case 'no_date':
      return date === null;
    case 'overdue':
      return date !== null && isPast(date) && !isToday(date);
    case 'today':
      return date !== null && isToday(date);
    case 'this_week':
      return date !== null && isThisWeek(date);
    default:
      return true;
  }
}

const FILTER_SAVE_DEBOUNCE_MS = 500;

export function useAsanaTasks(): UseAsanaTasksReturn {
  const [allAsanaTasks, setAllAsanaTasks] = useState<CalendarEvent[]>([]);
  const [rawAsanaTasks, setRawAsanaTasks] = useState<CalendarEvent[]>([]); // Includes "NOT A TASK" for metadata extraction
  const [scheduledAsanaTasks, setScheduledAsanaTasks] = useState<ScheduledAsanaTask[]>([]);
  const [filtersMap, setFiltersMapState] = useState<Record<string, AsanaFilterState>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ref for debouncing filter saves (keyed by integration ID)
  const filterSaveTimeoutsRef = useRef<Record<string, NodeJS.Timeout>>({});

  // Ref for tracking mounted state to prevent memory leaks
  const isMountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Load all filter preferences from server on mount
  useEffect(() => {
    api.getAllAsanaFilterPreferences()
      .then(({ filtersMap: loadedMap }) => {
        if (isMountedRef.current) {
          setFiltersMapState(loadedMap || {});
        }
      })
      .catch(error => console.error('Failed to load filter preferences:', error));
  }, []);

  // Cleanup debounce timeouts on unmount
  useEffect(() => {
    const timeoutsRef = filterSaveTimeoutsRef;
    return () => {
      Object.values(timeoutsRef.current).forEach(timeout => clearTimeout(timeout));
    };
  }, []);

  // Get filters for a specific integration (or default)
  const getFiltersForIntegration = useCallback((integrationId: string): AsanaFilterState => {
    const filters = filtersMap[integrationId];
    return filters ? { ...DEFAULT_FILTERS, ...filters } : DEFAULT_FILTERS;
  }, [filtersMap]);

  // Default filters (for compatibility with existing code)
  const filters = useMemo(() => {
    return getFiltersForIntegration('default');
  }, [getFiltersForIntegration]);

  // Wrapper to save filters to server when they change (debounced)
  const setFilters = useCallback((newFilters: AsanaFilterState, integrationId?: string) => {
    const key = integrationId || 'default';

    setFiltersMapState(prev => ({
      ...prev,
      [key]: newFilters,
    }));

    // Clear any pending save for this integration
    if (filterSaveTimeoutsRef.current[key]) {
      clearTimeout(filterSaveTimeoutsRef.current[key]);
    }

    // Debounce the API save
    filterSaveTimeoutsRef.current[key] = setTimeout(() => {
      api.saveAsanaFilterPreferences(newFilters, integrationId)
        .catch(error => console.error('Failed to save filter preferences:', error));
    }, FILTER_SAVE_DEBOUNCE_MS);
  }, []);

  // Load scheduled Asana tasks from server
  useEffect(() => {
    api.getScheduledAsanaTasks()
      .then(({ tasks }) => setScheduledAsanaTasks(tasks))
      .catch(error => console.error('Failed to load scheduled asana tasks:', error));
  }, []);

  const fetchAllAsanaTasks = useCallback(async () => {
    // ALWAYS restore from cache first if it exists
    const cached = readAsanaTasksCache();
    if (cached) {
      // Show cached data immediately (no loading state)
      // Cached data is already parsed, so use it directly
      setRawAsanaTasks(cached.allTasks);
      const filteredTasks = cached.allTasks.filter(task => {
        const typeValue = getTaskTypeValue(task);
        return typeValue !== 'NOT A TASK';
      });
      setAllAsanaTasks(filteredTasks);
      setScheduledAsanaTasks(cached.scheduledTasks);
    } else {
      // No cache - show loading state
      setIsLoading(true);
    }

    setError(null);

    try {
      // ALWAYS fetch fresh data (regardless of cache)
      const tasks = await api.getAllAsanaTasks();
      if (!isMountedRef.current) return;

      const parsedTasks = parseCalendarEvents(tasks);
      // Store raw tasks for metadata extraction (includes "NOT A TASK" for type dropdown)
      setRawAsanaTasks(parsedTasks);
      // Filter out tasks with Type = "NOT A TASK" for display
      const filteredTasks = parsedTasks.filter(task => {
        const typeValue = getTaskTypeValue(task);
        return typeValue !== 'NOT A TASK';
      });
      setAllAsanaTasks(filteredTasks);

      // Fetch scheduled tasks
      const { tasks: scheduled } = await api.getScheduledAsanaTasks();
      setScheduledAsanaTasks(scheduled);

      // Write to cache on success
      writeAsanaTasksCache(tasks, scheduled);
    } catch (err) {
      if (!isMountedRef.current) return;

      if (err instanceof ApiRequestError && err.status === 401) {
        setRawAsanaTasks([]);
        setAllAsanaTasks([]);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to fetch Asana tasks');
      setRawAsanaTasks([]);
      setAllAsanaTasks([]);
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Extract unique projects from all tasks
  const projects = useMemo(() => {
    const projectMap = new Map<string, AsanaProject>();
    allAsanaTasks.forEach(task => {
      if (task.projects) {
        task.projects.forEach(project => {
          if (!projectMap.has(project.gid)) {
            projectMap.set(project.gid, {
              gid: project.gid,
              name: project.name,
              integrationId: task.integrationId || '',
              integrationName: task.integrationName || '',
            });
          }
        });
      }
    });
    return Array.from(projectMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [allAsanaTasks]);

  // Extract unique type values from all tasks (including "NOT A TASK" for the dropdown)
  const typeValues = useMemo(() => {
    const types = new Set<string>();
    rawAsanaTasks.forEach(task => {
      const typeValue = getTaskTypeValue(task);
      if (typeValue) types.add(typeValue);
    });
    return Array.from(types).sort();
  }, [rawAsanaTasks]);

  // Extract Type custom field info per integration (fieldGid and label -> enumOptionGid mapping)
  // Custom fields are workspace-specific, so we track them per integration.
  // Populates from each field's full enum_options list so that ALL options are
  // available — including options no current task uses (e.g. "Engagement / Outreach",
  // "TO REVIEW"). Falls back to the task's own selected value if enumOptions is absent.
  const typeFieldInfoByIntegration = useMemo(() => {
    const infoMap = new Map<string, { fieldGid: string; enumOptions: Map<string, string> }>();

    for (const task of rawAsanaTasks) {
      if (!task.integrationId) continue;

      const typeField = task.customFields?.find(cf => cf.name.toLowerCase() === 'type');
      // A synthesized local-type field (gid 'local-type') carries a Type label but
      // does NOT make the integration Asana-writable — skip it here so a DBC task
      // never makes DBC look like it has a writable Type field.
      if (typeField && typeField.gid !== LOCAL_TYPE_FIELD_GID) {
        if (!infoMap.has(task.integrationId)) {
          infoMap.set(task.integrationId, {
            fieldGid: typeField.gid,
            enumOptions: new Map<string, string>(),
          });
        }

        const info = infoMap.get(task.integrationId)!;
        if (typeField.enumOptions && typeField.enumOptions.length > 0) {
          for (const opt of typeField.enumOptions) {
            info.enumOptions.set(opt.name, opt.gid);
          }
        } else if (typeField.displayValue && typeField.enumValueGid) {
          info.enumOptions.set(typeField.displayValue, typeField.enumValueGid);
        }
      }
    }

    return infoMap;
  }, [rawAsanaTasks]);

  // Extract unique integrations from all tasks
  const integrations = useMemo(() => {
    const integrationMap = new Map<string, string>();
    allAsanaTasks.forEach(task => {
      if (task.integrationId && task.integrationName && !integrationMap.has(task.integrationId)) {
        integrationMap.set(task.integrationId, task.integrationName);
      }
    });
    return Array.from(integrationMap.entries()).map(([id, name]) => ({ id, name }));
  }, [allAsanaTasks]);

  // Filter and sort tasks based on current filters
  const filteredAsanaTasks = useMemo(() => {
    // Filter tasks
    const filtered = allAsanaTasks.filter(task => {
      // Always exclude completed tasks
      if (task.completed) return false;

      const conditions: boolean[] = [];

      // Filter by integration
      if (filters.integrationIds.length > 0) {
        conditions.push(
          task.integrationId !== undefined && filters.integrationIds.includes(task.integrationId)
        );
      }

      // Filter by project
      if (filters.projectIds.length > 0) {
        const taskProjectIds = task.projects?.map(p => p.gid) || [];
        conditions.push(
          filters.projectIds.some(pid => taskProjectIds.includes(pid))
        );
      }

      // Filter by Type custom field
      if (filters.typeValues.length > 0) {
        const taskType = getTaskTypeValue(task);
        conditions.push(
          taskType !== null && filters.typeValues.includes(taskType)
        );
      }

      // Filter by due date
      if (filters.dueDateRange !== 'all') {
        conditions.push(matchesDateFilter(task.dueOn, filters.dueDateRange));
      }

      // Filter by start date
      if (filters.startDateRange !== 'all') {
        conditions.push(matchesDateFilter(task.startOn, filters.startDateRange));
      }

      // If no conditions, include the task
      if (conditions.length === 0) return true;

      // Apply AND/OR logic
      if (filters.filterLogic === 'and') {
        return conditions.every(c => c);
      } else {
        return conditions.some(c => c);
      }
    });

    // Sort tasks
    return filtered.sort((a, b) => {
      const direction = filters.sortDirection === 'asc' ? 1 : -1;

      switch (filters.sortField) {
        case 'title':
          return direction * a.title.localeCompare(b.title);
        case 'dueOn':
          return compareDateStrings(a.dueOn, b.dueOn, direction);
        case 'startOn':
          return compareDateStrings(a.startOn, b.startOn, direction);
        case 'createdAt':
          return compareDateStrings(a.createdAt, b.createdAt, direction);
        case 'type': {
          const typeA = getTaskTypeValue(a) || '';
          const typeB = getTaskTypeValue(b) || '';
          return direction * typeA.localeCompare(typeB);
        }
        default:
          return 0;
      }
    });
  }, [allAsanaTasks, filters]);

  const clearFilters = useCallback((integrationId?: string) => {
    const key = integrationId || 'default';

    setFiltersMapState(prev => ({
      ...prev,
      [key]: DEFAULT_FILTERS,
    }));

    // Clear any pending save and save immediately for clear action
    if (filterSaveTimeoutsRef.current[key]) {
      clearTimeout(filterSaveTimeoutsRef.current[key]);
    }
    api.saveAsanaFilterPreferences(DEFAULT_FILTERS, integrationId)
      .catch(error => console.error('Failed to save filter preferences:', error));
  }, []);

  const scheduleAsana = useCallback(async (
    asanaTaskId: string,
    integrationId: string | undefined,
    scheduledDate: string,
    scheduledTime: string,
    duration: number,
    googleEventId?: string,
    googleIntegrationId?: string,
    taskName?: string
  ): Promise<ScheduledAsanaTask | null> => {
    // Create optimistic scheduled task with temp ID
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const optimisticScheduled: ScheduledAsanaTask = {
      id: tempId,
      asanaTaskId,
      integrationId,
      scheduledDate,
      scheduledTime,
      duration,
      googleEventId,
      googleIntegrationId,
      ...(taskName ? { taskName } : {}),
    };

    // Add optimistically to state immediately
    setScheduledAsanaTasks(prev => {
      const updated = [...prev, optimisticScheduled];
      const cached = readAsanaTasksCache();
      if (cached) {
        writeAsanaTasksCache(cached.allTasks, updated);
      }
      return updated;
    });

    try {
      const { scheduled } = await api.scheduleAsanaTask(
        asanaTaskId,
        integrationId,
        scheduledDate,
        scheduledTime,
        duration,
        googleEventId,
        googleIntegrationId,
        taskName
      );
      // Replace temp entry with real entry from server
      setScheduledAsanaTasks(prev => {
        const updated = prev.map(s => s.id === tempId ? scheduled : s);
        const cached = readAsanaTasksCache();
        if (cached) {
          writeAsanaTasksCache(cached.allTasks, updated);
        }
        return updated;
      });
      return scheduled;
    } catch (error) {
      // Rollback: remove optimistic entry
      setScheduledAsanaTasks(prev => {
        const updated = prev.filter(s => s.id !== tempId);
        const cached = readAsanaTasksCache();
        if (cached) {
          writeAsanaTasksCache(cached.allTasks, updated);
        }
        return updated;
      });
      console.error('Failed to schedule asana task:', error);
      return null;
    }
  }, []);

  const updateScheduledAsana = useCallback(async (
    scheduleId: string,
    updates: Partial<ScheduledAsanaTask>
  ): Promise<ScheduledAsanaTask | null> => {
    // Capture previous state for rollback
    let previousSchedule: ScheduledAsanaTask | undefined;

    // Apply optimistic update immediately
    setScheduledAsanaTasks(prev => {
      const schedule = prev.find(s => s.id === scheduleId);
      previousSchedule = schedule;
      if (!schedule) return prev;

      const optimisticSchedule = { ...schedule, ...updates };
      const updatedList = prev.map(s => s.id === scheduleId ? optimisticSchedule : s);
      const cached = readAsanaTasksCache();
      if (cached) {
        writeAsanaTasksCache(cached.allTasks, updatedList);
      }
      return updatedList;
    });

    try {
      const { schedule: updated } = await api.updateScheduledAsanaTask(scheduleId, updates);
      // Reconcile with server response
      setScheduledAsanaTasks(prev => {
        const updatedList = prev.map(s => s.id === scheduleId ? updated : s);
        const cached = readAsanaTasksCache();
        if (cached) {
          writeAsanaTasksCache(cached.allTasks, updatedList);
        }
        return updatedList;
      });
      return updated;
    } catch (error) {
      // Rollback to previous state
      if (previousSchedule) {
        setScheduledAsanaTasks(prev => {
          const updatedList = prev.map(s => s.id === scheduleId ? previousSchedule! : s);
          const cached = readAsanaTasksCache();
          if (cached) {
            writeAsanaTasksCache(cached.allTasks, updatedList);
          }
          return updatedList;
        });
      }
      console.error('Failed to update scheduled asana task:', error);
      return null;
    }
  }, []);

  const updateScheduledAsanaByGoogleEvent = useCallback(async (
    googleEventId: string,
    updates: Partial<ScheduledAsanaTask>
  ): Promise<ScheduledAsanaTask | null> => {
    try {
      const { schedule: updated } = await api.updateScheduledAsanaTaskByGoogleEvent(googleEventId, updates);
      setScheduledAsanaTasks(prev => prev.map(s => s.googleEventId === googleEventId ? updated : s));
      return updated;
    } catch (error) {
      console.error('Failed to update scheduled asana task by google event:', error);
      return null;
    }
  }, []);

  const unscheduleAsana = useCallback(async (scheduleId: string): Promise<boolean> => {
    try {
      await api.unscheduleAsanaTask(scheduleId);
      setScheduledAsanaTasks(prev => {
        const updated = prev.filter(s => s.id !== scheduleId);
        const cached = readAsanaTasksCache();
        if (cached) {
          writeAsanaTasksCache(cached.allTasks, updated);
        }
        return updated;
      });
      return true;
    } catch (error) {
      console.error('Failed to unschedule asana task:', error);
      return false;
    }
  }, []);

  const unscheduleAllAsanaInstances = useCallback(async (asanaTaskId: string): Promise<boolean> => {
    try {
      await api.unscheduleAllAsanaTaskInstances(asanaTaskId);
      setScheduledAsanaTasks(prev => {
        const updated = prev.filter(s => s.asanaTaskId !== asanaTaskId);
        const cached = readAsanaTasksCache();
        if (cached) {
          writeAsanaTasksCache(cached.allTasks, updated);
        }
        return updated;
      });
      return true;
    } catch (error) {
      console.error('Failed to unschedule all asana task instances:', error);
      return false;
    }
  }, []);

  const getScheduledAsanaEventsForDate = useCallback((date: string): CalendarEvent[] => {
    const scheduled = scheduledAsanaTasks.filter(s => s.scheduledDate === date);
    const events: CalendarEvent[] = [];

    for (const s of scheduled) {
      const asanaTask = allAsanaTasks.find(t => t.id === s.asanaTaskId);
      if (!asanaTask) continue;

      const [hours, minutes] = s.scheduledTime.split(':').map(Number);
      const startTime = new Date(s.scheduledDate);
      startTime.setHours(hours, minutes, 0, 0);
      const endTime = new Date(startTime.getTime() + s.duration * 60 * 1000);

      events.push({
        ...asanaTask,
        id: s.id, // Use schedule ID as event ID (allows multiple instances)
        linkedAsanaTaskId: s.asanaTaskId, // Keep reference to original Asana task
        startTime,
        endTime,
      });
    }

    return events;
  }, [scheduledAsanaTasks, allAsanaTasks]);

  const completeAsanaTask = useCallback(async (
    taskId: string,
    integrationId: string,
    completed: boolean
  ) => {
    // Capture previous state for rollback
    let previousCompleted: boolean | undefined;

    // Optimistically update state immediately
    setAllAsanaTasks(prev => {
      const task = prev.find(t => t.id === taskId);
      previousCompleted = task?.completed;
      const updated = prev.map(t =>
        t.id === taskId ? { ...t, completed } : t
      );
      const cached = readAsanaTasksCache();
      if (cached) {
        const updatedCachedTasks = cached.allTasks.map(t =>
          t.id === taskId ? { ...t, completed } : t
        );
        writeAsanaTasksCache(updatedCachedTasks, cached.scheduledTasks);
      }
      return updated;
    });

    // Make API call in background - rollback on failure
    try {
      await api.completeAsanaTask(taskId, integrationId, completed);
    } catch (error) {
      // Rollback to previous state
      if (previousCompleted !== undefined) {
        setAllAsanaTasks(prev => {
          const reverted = prev.map(t =>
            t.id === taskId ? { ...t, completed: previousCompleted } : t
          );
          const cached = readAsanaTasksCache();
          if (cached) {
            const revertedCachedTasks = cached.allTasks.map(t =>
              t.id === taskId ? { ...t, completed: previousCompleted } : t
            );
            writeAsanaTasksCache(revertedCachedTasks, cached.scheduledTasks);
          }
          return reverted;
        });
      }
      throw error;
    }
  }, []);

  const addAsanaComment = useCallback(async (
    taskId: string,
    integrationId: string,
    comment: string,
    htmlText?: string
  ) => {
    await api.addAsanaComment(taskId, integrationId, comment, htmlText);
  }, []);

  const createAsanaTask = useCallback(async (
    integrationId: string,
    name: string,
    options?: CreateAsanaTaskOptions
  ): Promise<CalendarEvent | null> => {
    try {
      const result = await api.createAsanaTask(integrationId, name, options);
      if (!result.success || !result.task) {
        return null;
      }
      const newTask: CalendarEvent = {
        ...result.task,
        startTime: new Date(result.task.startTime),
        endTime: new Date(result.task.endTime),
      };
      setAllAsanaTasks(prev => {
        const updated = [...prev, newTask];
        const cached = readAsanaTasksCache();
        if (cached) {
          writeAsanaTasksCache([...cached.allTasks, result.task], cached.scheduledTasks);
        }
        return updated;
      });
      return newTask;
    } catch (error) {
      console.error('Failed to create Asana task:', error);
      throw error;
    }
  }, []);

  const updateAsanaTask = useCallback(async (
    taskId: string,
    integrationId: string,
    updates: UpdateAsanaTaskOptions
  ): Promise<CalendarEvent | null> => {
    // Capture previous task for rollback
    let previousTask: CalendarEvent | undefined;

    // Apply optimistic updates immediately based on what we know
    setAllAsanaTasks(prev => {
      previousTask = prev.find(t => t.id === taskId);
      if (!previousTask) return prev;

      const optimisticTask: CalendarEvent = { ...previousTask };
      if (updates.dueOn !== undefined) {
        optimisticTask.dueOn = updates.dueOn || undefined;
      }
      if (updates.startOn !== undefined) {
        optimisticTask.startOn = updates.startOn || undefined;
      }
      // Optimistically update customFields (e.g., Type field)
      if (updates.customFields && optimisticTask.customFields) {
        optimisticTask.customFields = optimisticTask.customFields.map(cf => {
          const newValue = updates.customFields?.[cf.gid];
          if (newValue !== undefined) {
            return {
              ...cf,
              enumValueGid: newValue || undefined,
              // Display value will be reconciled when server responds
              displayValue: newValue === null ? null : cf.displayValue,
            };
          }
          return cf;
        });
      }
      // Optimistically update projects
      if (updates.addProjects || updates.removeProjects) {
        let newProjects = [...(optimisticTask.projects || [])];
        // Remove projects
        if (updates.removeProjects) {
          newProjects = newProjects.filter(p => !updates.removeProjects!.includes(p.gid));
        }
        // Add projects (we only have GIDs, so use placeholder names until server responds)
        if (updates.addProjects) {
          updates.addProjects.forEach(gid => {
            if (!newProjects.find(p => p.gid === gid)) {
              newProjects.push({ gid, name: 'Loading...' });
            }
          });
        }
        optimisticTask.projects = newProjects;
      }
      // Optimistically update tags. We only know the gids being added, so for
      // additions we drop in a placeholder tag; the server response reconciles
      // the real name/color shortly after.
      if (updates.addTags || updates.removeTags) {
        let newTags = [...(optimisticTask.tags || [])];
        if (updates.removeTags) {
          newTags = newTags.filter(t => !updates.removeTags!.includes(t.gid));
        }
        if (updates.addTags) {
          updates.addTags.forEach(gid => {
            if (!newTags.find(t => t.gid === gid)) {
              newTags.push({ gid, name: '…' });
            }
          });
        }
        optimisticTask.tags = newTags;
      }

      const updated = prev.map(t => t.id === taskId ? optimisticTask : t);
      return updated;
    });

    try {
      const result = await api.updateAsanaTask(taskId, integrationId, updates);
      if (!result.success || !result.task) {
        // Rollback on failure
        if (previousTask) {
          setAllAsanaTasks(prev => prev.map(t => t.id === taskId ? previousTask! : t));
        }
        return null;
      }
      const updatedTask: CalendarEvent = {
        ...result.task,
        startTime: new Date(result.task.startTime),
        endTime: new Date(result.task.endTime),
      };
      // Reconcile with server response (replace optimistic update with actual data)
      setAllAsanaTasks(prev => {
        const updated = prev.map(t => t.id === taskId ? updatedTask : t);
        const cached = readAsanaTasksCache();
        if (cached) {
          const updatedCachedTasks = cached.allTasks.map(t =>
            t.id === taskId ? result.task : t
          );
          writeAsanaTasksCache(updatedCachedTasks, cached.scheduledTasks);
        }
        return updated;
      });
      return updatedTask;
    } catch (error) {
      // Rollback to previous state
      if (previousTask) {
        setAllAsanaTasks(prev => prev.map(t => t.id === taskId ? previousTask! : t));
      }
      console.error('Failed to update Asana task:', error);
      throw error;
    }
  }, []);

  const deleteAsanaTask = useCallback(async (
    taskId: string,
    integrationId: string
  ): Promise<boolean> => {
    // Capture the task and its index for rollback
    let deletedTask: CalendarEvent | undefined;
    let deletedIndex: number = -1;

    // Optimistically remove the task immediately
    setAllAsanaTasks(prev => {
      deletedIndex = prev.findIndex(t => t.id === taskId);
      if (deletedIndex >= 0) {
        deletedTask = prev[deletedIndex];
      }
      const updated = prev.filter(t => t.id !== taskId);
      const cached = readAsanaTasksCache();
      if (cached) {
        const updatedCachedTasks = cached.allTasks.filter(t => t.id !== taskId);
        writeAsanaTasksCache(updatedCachedTasks, cached.scheduledTasks);
      }
      return updated;
    });

    try {
      await api.deleteAsanaTask(taskId, integrationId);
      return true;
    } catch (error) {
      // Rollback: restore the deleted task
      if (deletedTask) {
        setAllAsanaTasks(prev => {
          // Insert back at original position (or end if position is invalid)
          const newList = [...prev];
          const insertIndex = Math.min(deletedIndex, newList.length);
          newList.splice(insertIndex, 0, deletedTask!);
          const cached = readAsanaTasksCache();
          if (cached) {
            const restoredCachedTasks = [...cached.allTasks];
            restoredCachedTasks.splice(insertIndex, 0, {
              ...deletedTask!,
              startTime: deletedTask!.startTime.toISOString(),
              endTime: deletedTask!.endTime.toISOString(),
            } as unknown as CalendarEventResponse);
            writeAsanaTasksCache(restoredCachedTasks, cached.scheduledTasks);
          }
          return newList;
        });
      }
      console.error('Failed to delete Asana task:', error);
      throw error;
    }
  }, []);

  return {
    allAsanaTasks,
    rawAsanaTasks,
    filteredAsanaTasks,
    scheduledAsanaTasks,
    isLoading,
    error,
    // Filter state
    projects,
    typeValues,
    typeFieldInfoByIntegration,
    integrations,
    filters,
    filtersMap,
    setFilters,
    getFiltersForIntegration,
    clearFilters,
    // Actions
    fetchAllAsanaTasks,
    scheduleAsana,
    updateScheduledAsana,
    updateScheduledAsanaByGoogleEvent,
    unscheduleAsana,
    unscheduleAllAsanaInstances,
    getScheduledAsanaEventsForDate,
    completeAsanaTask,
    addAsanaComment,
    createAsanaTask,
    updateAsanaTask,
    deleteAsanaTask,
  };
}
