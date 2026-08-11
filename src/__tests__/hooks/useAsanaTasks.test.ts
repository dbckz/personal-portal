/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAsanaTasks } from '@/hooks/useAsanaTasks';
import * as api from '@/lib/api';
import { CalendarEvent, CalendarEventResponse, CalendarEventsResponse } from '@/types';

// Mock the api module
jest.mock('@/lib/api', () => ({
  api: {
    getAllAsanaTasks: jest.fn(),
    getScheduledAsanaTasks: jest.fn(),
    scheduleAsanaTask: jest.fn(),
    updateScheduledAsanaTask: jest.fn(),
    updateScheduledAsanaTaskByGoogleEvent: jest.fn(),
    unscheduleAsanaTask: jest.fn(),
    unscheduleAllAsanaTaskInstances: jest.fn(),
    completeAsanaTask: jest.fn(),
    addAsanaComment: jest.fn(),
    createAsanaTask: jest.fn(),
    deleteAsanaTask: jest.fn(),
    getAllAsanaFilterPreferences: jest.fn(),
    saveAsanaFilterPreferences: jest.fn(),
  },
  parseCalendarEvents: jest.fn((events) => events),
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const mockApi = api.api as jest.Mocked<typeof api.api>;

describe('useAsanaTasks hook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.getAllAsanaTasks.mockResolvedValue([]);
    mockApi.getScheduledAsanaTasks.mockResolvedValue({ tasks: [] });
    mockApi.getAllAsanaFilterPreferences.mockResolvedValue({ filtersMap: {} });
    mockApi.saveAsanaFilterPreferences.mockResolvedValue({
      success: true,
      filters: {
        integrationIds: [], projectIds: [], typeValues: [],
        dueDateRange: 'all', startDateRange: 'all', filterLogic: 'and',
        sortField: 'dueOn', sortDirection: 'asc', groupBy: 'none',
        groupOrder: [], expandedGroups: [],
      },
    });
  });

  describe('initialization', () => {
    it('returns empty tasks array initially', () => {
      const { result } = renderHook(() => useAsanaTasks());
      expect(result.current.allAsanaTasks).toEqual([]);
      expect(result.current.filteredAsanaTasks).toEqual([]);
    });

    it('loads scheduled tasks from API on mount', async () => {
      const scheduledTasks = [
        { id: 'sched-1', asanaTaskId: 'task-1', integrationId: 'int-1', scheduledDate: '2024-01-15', scheduledTime: '09:00', duration: 60 },
      ];
      mockApi.getScheduledAsanaTasks.mockResolvedValue({ tasks: scheduledTasks });

      const { result } = renderHook(() => useAsanaTasks());

      await waitFor(() => {
        expect(mockApi.getScheduledAsanaTasks).toHaveBeenCalled();
        expect(result.current.scheduledAsanaTasks).toEqual(scheduledTasks);
      });
    });

    it('loads filters from API on mount', async () => {
      const savedFilters = {
        integrationIds: ['int-1'],
        projectIds: ['proj-1'],
        typeValues: ['Bug'],
        dueDateRange: 'today' as const,
        startDateRange: 'all' as const,
        filterLogic: 'and' as const,
        sortField: 'title' as const,
        sortDirection: 'desc' as const,
        groupBy: 'none' as const,
        groupOrder: [],
        expandedGroups: [],
      };
      mockApi.getAllAsanaFilterPreferences.mockResolvedValue({ filtersMap: { 'int-1': savedFilters } });

      const { result } = renderHook(() => useAsanaTasks());

      await waitFor(() => {
        expect(result.current.filtersMap['int-1']?.integrationIds).toEqual(['int-1']);
        expect(result.current.filtersMap['int-1']?.sortField).toBe('title');
      });
    });

    it('uses default filters when API returns empty map', async () => {
      const { result } = renderHook(() => useAsanaTasks());

      await waitFor(() => {
        expect(result.current.filters.integrationIds).toEqual([]);
        expect(result.current.filters.dueDateRange).toBe('all');
        expect(result.current.filters.filterLogic).toBe('and');
      });
    });
  });

  describe('fetchAllAsanaTasks', () => {
    it('fetches tasks from API', async () => {
      const mockTasks = [
        { id: 'task-1', title: 'Task 1', source: 'asana', startTime: new Date(), endTime: new Date() },
      ];
      mockApi.getAllAsanaTasks.mockResolvedValue(mockTasks as unknown as CalendarEventsResponse);
      (api.parseCalendarEvents as jest.Mock).mockReturnValue(mockTasks);

      const { result } = renderHook(() => useAsanaTasks());

      await act(async () => {
        await result.current.fetchAllAsanaTasks();
      });

      expect(mockApi.getAllAsanaTasks).toHaveBeenCalled();
      expect(result.current.allAsanaTasks).toEqual(mockTasks);
    });

    it('sets loading state during fetch', async () => {
      mockApi.getAllAsanaTasks.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([]), 100)));

      const { result } = renderHook(() => useAsanaTasks());

      act(() => {
        result.current.fetchAllAsanaTasks();
      });

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('filters out tasks with Type = "NOT A TASK"', async () => {
      const mockTasks = [
        { id: 'task-1', title: 'Task 1', source: 'asana', startTime: new Date(), endTime: new Date(), customFields: [{ name: 'Type', displayValue: 'Bug' }] },
        { id: 'task-2', title: 'Task 2', source: 'asana', startTime: new Date(), endTime: new Date(), customFields: [{ name: 'Type', displayValue: 'NOT A TASK' }] },
      ];
      mockApi.getAllAsanaTasks.mockResolvedValue(mockTasks as unknown as CalendarEventsResponse);
      (api.parseCalendarEvents as jest.Mock).mockReturnValue(mockTasks);

      const { result } = renderHook(() => useAsanaTasks());

      await act(async () => {
        await result.current.fetchAllAsanaTasks();
      });

      expect(result.current.allAsanaTasks).toHaveLength(1);
      expect(result.current.allAsanaTasks[0].id).toBe('task-1');
    });

    it('handles API errors gracefully', async () => {
      mockApi.getAllAsanaTasks.mockRejectedValue(new Error('API Error'));

      const { result } = renderHook(() => useAsanaTasks());

      await act(async () => {
        await result.current.fetchAllAsanaTasks();
      });

      expect(result.current.error).toBe('API Error');
      expect(result.current.allAsanaTasks).toEqual([]);
    });

    it('clears tasks on 401 error without showing error', async () => {
      const error = new api.ApiRequestError('Unauthorized', 401);
      mockApi.getAllAsanaTasks.mockRejectedValue(error);

      const { result } = renderHook(() => useAsanaTasks());

      await act(async () => {
        await result.current.fetchAllAsanaTasks();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.allAsanaTasks).toEqual([]);
    });
  });

  describe('setFilters', () => {
    it('updates filters and saves to API', async () => {
      jest.useFakeTimers();
      const { result } = renderHook(() => useAsanaTasks());

      // Wait for initial async setup to complete
      await waitFor(() => {
        expect(mockApi.getAllAsanaFilterPreferences).toHaveBeenCalled();
      });

      act(() => {
        result.current.setFilters({
          ...result.current.filters,
          integrationIds: ['int-1'],
        });
      });

      await waitFor(() => {
        expect(result.current.filters.integrationIds).toEqual(['int-1']);
      });

      // Advance timers to trigger debounced save (500ms debounce)
      await act(async () => {
        jest.advanceTimersByTime(500);
      });

      expect(mockApi.saveAsanaFilterPreferences).toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('clearFilters', () => {
    it('resets filters to defaults', async () => {
      const { result } = renderHook(() => useAsanaTasks());

      // First set some filters
      await act(async () => {
        result.current.setFilters({
          ...result.current.filters,
          integrationIds: ['int-1'],
          projectIds: ['proj-1'],
        });
      });

      // Then clear them
      await act(async () => {
        result.current.clearFilters();
      });

      expect(result.current.filters.integrationIds).toEqual([]);
      expect(result.current.filters.projectIds).toEqual([]);
      expect(result.current.filters.dueDateRange).toBe('all');
    });
  });

  describe('filtering', () => {
    const setupTasksWithFilters = async (tasks: Record<string, unknown>[]) => {
      mockApi.getAllAsanaTasks.mockResolvedValue(tasks as unknown as CalendarEventsResponse);
      (api.parseCalendarEvents as jest.Mock).mockReturnValue(tasks);

      const { result } = renderHook(() => useAsanaTasks());

      await act(async () => {
        await result.current.fetchAllAsanaTasks();
      });

      return result;
    };

    it('filters by integration ID', async () => {
      const tasks = [
        { id: 'task-1', title: 'Task 1', source: 'asana', integrationId: 'int-1', startTime: new Date(), endTime: new Date() },
        { id: 'task-2', title: 'Task 2', source: 'asana', integrationId: 'int-2', startTime: new Date(), endTime: new Date() },
      ];
      const result = await setupTasksWithFilters(tasks);

      act(() => {
        result.current.setFilters({
          ...result.current.filters,
          integrationIds: ['int-1'],
        });
      });

      expect(result.current.filteredAsanaTasks).toHaveLength(1);
      expect(result.current.filteredAsanaTasks[0].id).toBe('task-1');
    });

    it('filters by project ID', async () => {
      const tasks = [
        { id: 'task-1', title: 'Task 1', source: 'asana', projects: [{ gid: 'proj-1', name: 'Project 1' }], startTime: new Date(), endTime: new Date() },
        { id: 'task-2', title: 'Task 2', source: 'asana', projects: [{ gid: 'proj-2', name: 'Project 2' }], startTime: new Date(), endTime: new Date() },
      ];
      const result = await setupTasksWithFilters(tasks);

      act(() => {
        result.current.setFilters({
          ...result.current.filters,
          projectIds: ['proj-1'],
        });
      });

      expect(result.current.filteredAsanaTasks).toHaveLength(1);
      expect(result.current.filteredAsanaTasks[0].id).toBe('task-1');
    });

    it('filters by Type custom field', async () => {
      const tasks = [
        { id: 'task-1', title: 'Task 1', source: 'asana', customFields: [{ name: 'Type', displayValue: 'Bug' }], startTime: new Date(), endTime: new Date() },
        { id: 'task-2', title: 'Task 2', source: 'asana', customFields: [{ name: 'Type', displayValue: 'Feature' }], startTime: new Date(), endTime: new Date() },
      ];
      const result = await setupTasksWithFilters(tasks);

      act(() => {
        result.current.setFilters({
          ...result.current.filters,
          typeValues: ['Bug'],
        });
      });

      expect(result.current.filteredAsanaTasks).toHaveLength(1);
      expect(result.current.filteredAsanaTasks[0].id).toBe('task-1');
    });
  });

  describe('extracted metadata', () => {
    it('extracts unique projects from tasks', async () => {
      const tasks = [
        { id: 'task-1', title: 'Task 1', source: 'asana', projects: [{ gid: 'proj-1', name: 'Project A' }], integrationId: 'int-1', startTime: new Date(), endTime: new Date() },
        { id: 'task-2', title: 'Task 2', source: 'asana', projects: [{ gid: 'proj-1', name: 'Project A' }, { gid: 'proj-2', name: 'Project B' }], integrationId: 'int-1', startTime: new Date(), endTime: new Date() },
      ];
      mockApi.getAllAsanaTasks.mockResolvedValue(tasks as unknown as CalendarEventsResponse);
      (api.parseCalendarEvents as jest.Mock).mockReturnValue(tasks);

      const { result } = renderHook(() => useAsanaTasks());

      await act(async () => {
        await result.current.fetchAllAsanaTasks();
      });

      expect(result.current.projects).toHaveLength(2);
      expect(result.current.projects.map(p => p.gid)).toContain('proj-1');
      expect(result.current.projects.map(p => p.gid)).toContain('proj-2');
    });

    it('extracts unique type values from tasks', async () => {
      const tasks = [
        { id: 'task-1', title: 'Task 1', source: 'asana', customFields: [{ name: 'Type', displayValue: 'Bug' }], startTime: new Date(), endTime: new Date() },
        { id: 'task-2', title: 'Task 2', source: 'asana', customFields: [{ name: 'Type', displayValue: 'Feature' }], startTime: new Date(), endTime: new Date() },
        { id: 'task-3', title: 'Task 3', source: 'asana', customFields: [{ name: 'Type', displayValue: 'Bug' }], startTime: new Date(), endTime: new Date() },
      ];
      mockApi.getAllAsanaTasks.mockResolvedValue(tasks as unknown as CalendarEventsResponse);
      (api.parseCalendarEvents as jest.Mock).mockReturnValue(tasks);

      const { result } = renderHook(() => useAsanaTasks());

      await act(async () => {
        await result.current.fetchAllAsanaTasks();
      });

      expect(result.current.typeValues).toHaveLength(2);
      expect(result.current.typeValues).toContain('Bug');
      expect(result.current.typeValues).toContain('Feature');
    });

    it('extracts unique integrations from tasks', async () => {
      const tasks = [
        { id: 'task-1', title: 'Task 1', source: 'asana', integrationId: 'int-1', integrationName: 'Work', startTime: new Date(), endTime: new Date() },
        { id: 'task-2', title: 'Task 2', source: 'asana', integrationId: 'int-2', integrationName: 'Personal', startTime: new Date(), endTime: new Date() },
        { id: 'task-3', title: 'Task 3', source: 'asana', integrationId: 'int-1', integrationName: 'Work', startTime: new Date(), endTime: new Date() },
      ];
      mockApi.getAllAsanaTasks.mockResolvedValue(tasks as unknown as CalendarEventsResponse);
      (api.parseCalendarEvents as jest.Mock).mockReturnValue(tasks);

      const { result } = renderHook(() => useAsanaTasks());

      await act(async () => {
        await result.current.fetchAllAsanaTasks();
      });

      expect(result.current.integrations).toHaveLength(2);
      expect(result.current.integrations.map(i => i.id)).toContain('int-1');
      expect(result.current.integrations.map(i => i.id)).toContain('int-2');
    });
  });

  describe('schedule management', () => {
    it('schedules an Asana task via API', async () => {
      const scheduledTask = {
        id: 'sched-1',
        asanaTaskId: 'task-1',
        integrationId: 'int-1',
        scheduledDate: '2024-01-15',
        scheduledTime: '09:00',
        duration: 60,
      };
      mockApi.scheduleAsanaTask.mockResolvedValue({ scheduled: scheduledTask });

      const { result } = renderHook(() => useAsanaTasks());

      let returned: unknown;
      await act(async () => {
        returned = await result.current.scheduleAsana('task-1', 'int-1', '2024-01-15', '09:00', 60);
      });

      expect(mockApi.scheduleAsanaTask).toHaveBeenCalledWith('task-1', 'int-1', '2024-01-15', '09:00', 60, undefined, undefined, undefined);
      expect(returned).toEqual(scheduledTask);
    });

    it('unschedules an Asana task via API', async () => {
      mockApi.unscheduleAsanaTask.mockResolvedValue({ success: true });

      const { result } = renderHook(() => useAsanaTasks());

      let success: boolean;
      await act(async () => {
        success = await result.current.unscheduleAsana('sched-1');
      });

      expect(mockApi.unscheduleAsanaTask).toHaveBeenCalledWith('sched-1');
      expect(success!).toBe(true);
    });

    it('updates a scheduled task via API', async () => {
      const updatedTask = {
        id: 'sched-1',
        asanaTaskId: 'task-1',
        integrationId: 'int-1',
        scheduledDate: '2024-01-16',
        scheduledTime: '10:00',
        duration: 90,
      };
      mockApi.updateScheduledAsanaTask.mockResolvedValue({ schedule: updatedTask });

      const { result } = renderHook(() => useAsanaTasks());

      let returned: unknown;
      await act(async () => {
        returned = await result.current.updateScheduledAsana('sched-1', { scheduledDate: '2024-01-16' });
      });

      expect(mockApi.updateScheduledAsanaTask).toHaveBeenCalledWith('sched-1', { scheduledDate: '2024-01-16' });
      expect(returned).toEqual(updatedTask);
    });
  });

  describe('task actions', () => {
    it('completes an Asana task', async () => {
      mockApi.completeAsanaTask.mockResolvedValue({ success: true, completed: true });

      const { result } = renderHook(() => useAsanaTasks());

      await act(async () => {
        await result.current.completeAsanaTask('task-1', 'int-1', true);
      });

      expect(mockApi.completeAsanaTask).toHaveBeenCalledWith('task-1', 'int-1', true);
    });

    it('adds a comment to an Asana task', async () => {
      mockApi.addAsanaComment.mockResolvedValue({ success: true });

      const { result } = renderHook(() => useAsanaTasks());

      await act(async () => {
        await result.current.addAsanaComment('task-1', 'int-1', 'Test comment');
      });

      expect(mockApi.addAsanaComment).toHaveBeenCalledWith('task-1', 'int-1', 'Test comment', undefined);
    });

    it('creates a new Asana task', async () => {
      const now = new Date();
      const newTask = { id: 'new-task', title: 'New Task', source: 'asana', startTime: now.toISOString(), endTime: now.toISOString() };
      mockApi.createAsanaTask.mockResolvedValue({ success: true, task: newTask as unknown as CalendarEventResponse });

      const { result } = renderHook(() => useAsanaTasks());

      let created: CalendarEvent | null = null;
      await act(async () => {
        created = await result.current.createAsanaTask('int-1', 'New Task', { notes: 'Test notes' });
      });

      expect(mockApi.createAsanaTask).toHaveBeenCalledWith('int-1', 'New Task', { notes: 'Test notes' });
      expect(created).not.toBeNull();
      expect(created!.id).toBe('new-task');
      expect(created!.title).toBe('New Task');
    });

    it('deletes an Asana task', async () => {
      mockApi.deleteAsanaTask.mockResolvedValue({ success: true });

      const tasks = [
        { id: 'task-1', title: 'Task 1', source: 'asana', startTime: new Date(), endTime: new Date() },
      ];
      mockApi.getAllAsanaTasks.mockResolvedValue(tasks as unknown as CalendarEventsResponse);
      (api.parseCalendarEvents as jest.Mock).mockReturnValue(tasks);

      const { result } = renderHook(() => useAsanaTasks());

      await act(async () => {
        await result.current.fetchAllAsanaTasks();
      });

      expect(result.current.allAsanaTasks).toHaveLength(1);

      let deleted: boolean;
      await act(async () => {
        deleted = await result.current.deleteAsanaTask('task-1', 'int-1');
      });

      expect(mockApi.deleteAsanaTask).toHaveBeenCalledWith('task-1', 'int-1');
      expect(deleted!).toBe(true);
      expect(result.current.allAsanaTasks).toHaveLength(0);
    });
  });
});
