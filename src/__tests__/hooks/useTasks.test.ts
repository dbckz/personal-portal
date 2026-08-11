/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTasks } from '@/hooks/useTasks';
import { api } from '@/lib/api';
import { AdHocTask } from '@/types';

// Mock the API module
jest.mock('@/lib/api', () => ({
  api: {
    getAdHocTasks: jest.fn(),
    addAdHocTask: jest.fn(),
    updateAdHocTask: jest.fn(),
    deleteAdHocTask: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

describe('useTasks hook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.getAdHocTasks.mockResolvedValue({ tasks: [] });
  });

  describe('initialization', () => {
    it('returns empty tasks array initially', async () => {
      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      expect(result.current.tasks).toEqual([]);
    });

    it('loads tasks from API on mount', async () => {
      const existingTasks = [
        { id: '1', title: 'Task 1', completed: false, priority: 'medium' as const, taskType: 'focus' as const, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: '2', title: 'Task 2', completed: true, priority: 'high' as const, taskType: 'email' as const, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ];
      mockApi.getAdHocTasks.mockResolvedValue({ tasks: existingTasks });

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      expect(mockApi.getAdHocTasks).toHaveBeenCalled();
      expect(result.current.tasks).toEqual(existingTasks);
    });

    it('sets isLoaded to true after loading', async () => {
      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });
    });

    it('handles API error gracefully', async () => {
      mockApi.getAdHocTasks.mockRejectedValue(new Error('API error'));
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      expect(result.current.tasks).toEqual([]);
      consoleSpy.mockRestore();
    });
  });

  describe('addTask', () => {
    it('adds a new task and updates state', async () => {
      const newTask = {
        title: 'New Task',
        completed: false,
        priority: 'medium' as const,
        taskType: 'focus' as const,
      };
      const createdTask = {
        ...newTask,
        id: 'new-id',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      mockApi.addAdHocTask.mockResolvedValue({ task: createdTask });

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      let returned: AdHocTask | null = null;
      await act(async () => {
        returned = await result.current.addTask(newTask);
      });

      expect(returned).toEqual(createdTask);
      expect(mockApi.addAdHocTask).toHaveBeenCalledWith(newTask);
      expect(result.current.tasks).toContainEqual(createdTask);
    });

    it('returns null on API error', async () => {
      mockApi.addAdHocTask.mockRejectedValue(new Error('API error'));
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      let returned: unknown = undefined;
      await act(async () => {
        returned = await result.current.addTask({
          title: 'Test',
          completed: false,
          priority: 'medium' as const,
          taskType: 'focus' as const,
        });
      });

      expect(returned).toBeNull();
      consoleSpy.mockRestore();
    });
  });

  describe('updateTask', () => {
    it('updates an existing task', async () => {
      const existingTask = {
        id: '1',
        title: 'Task 1',
        completed: false,
        priority: 'medium' as const,
        taskType: 'focus' as const,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };
      const updatedTask = { ...existingTask, title: 'Updated Task' };

      mockApi.getAdHocTasks.mockResolvedValue({ tasks: [existingTask] });
      mockApi.updateAdHocTask.mockResolvedValue({ task: updatedTask });

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      let returned: AdHocTask | null = null;
      await act(async () => {
        returned = await result.current.updateTask('1', { title: 'Updated Task' });
      });

      expect(returned).toEqual(updatedTask);
      expect(result.current.tasks[0].title).toBe('Updated Task');
    });

    it('returns null on API error', async () => {
      mockApi.updateAdHocTask.mockRejectedValue(new Error('API error'));
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      let returned: unknown = undefined;
      await act(async () => {
        returned = await result.current.updateTask('non-existent', { title: 'Test' });
      });

      expect(returned).toBeNull();
      consoleSpy.mockRestore();
    });
  });

  describe('removeTask', () => {
    it('removes a task successfully', async () => {
      const existingTask = {
        id: '1',
        title: 'Task 1',
        completed: false,
        priority: 'medium' as const,
        taskType: 'focus' as const,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };

      mockApi.getAdHocTasks.mockResolvedValue({ tasks: [existingTask] });
      mockApi.deleteAdHocTask.mockResolvedValue({ success: true });

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      let success = false;
      await act(async () => {
        success = await result.current.removeTask('1');
      });

      expect(success).toBe(true);
      expect(result.current.tasks).toHaveLength(0);
    });

    it('returns false on API error', async () => {
      mockApi.deleteAdHocTask.mockRejectedValue(new Error('API error'));
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      let success = true;
      await act(async () => {
        success = await result.current.removeTask('non-existent');
      });

      expect(success).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('toggleComplete', () => {
    it('toggles task completion status', async () => {
      const existingTask = {
        id: '1',
        title: 'Task 1',
        completed: false,
        priority: 'medium' as const,
        taskType: 'focus' as const,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };
      const toggledTask = { ...existingTask, completed: true };

      mockApi.getAdHocTasks.mockResolvedValue({ tasks: [existingTask] });
      mockApi.updateAdHocTask.mockResolvedValue({ task: toggledTask });

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      let returned: AdHocTask | null = null;
      await act(async () => {
        returned = await result.current.toggleComplete('1');
      });

      expect(returned).toEqual(toggledTask);
      expect(mockApi.updateAdHocTask).toHaveBeenCalledWith('1', { completed: true });
    });

    it('returns null for non-existent task', async () => {
      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      let returned: unknown = undefined;
      await act(async () => {
        returned = await result.current.toggleComplete('non-existent');
      });

      expect(returned).toBeNull();
    });
  });

  describe('getTasksForDate', () => {
    it('filters tasks by date', async () => {
      const tasks = [
        { id: '1', title: 'Task 1', dueDate: '2024-01-15', completed: false, priority: 'medium' as const, taskType: 'focus' as const, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: '2', title: 'Task 2', dueDate: '2024-01-16', completed: false, priority: 'high' as const, taskType: 'email' as const, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: '3', title: 'Task 3', dueDate: '2024-01-15', completed: false, priority: 'low' as const, taskType: 'writing' as const, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ];

      mockApi.getAdHocTasks.mockResolvedValue({ tasks });

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      const tasksForDate = result.current.getTasksForDate('2024-01-15');
      expect(tasksForDate).toHaveLength(2);
      expect(tasksForDate.map(t => t.id)).toEqual(['1', '3']);
    });

    it('returns empty array when no tasks match date', async () => {
      const tasks = [
        { id: '1', title: 'Task 1', dueDate: '2024-01-15', completed: false, priority: 'medium' as const, taskType: 'focus' as const, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ];

      mockApi.getAdHocTasks.mockResolvedValue({ tasks });

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      const tasksForDate = result.current.getTasksForDate('2024-01-20');
      expect(tasksForDate).toHaveLength(0);
    });
  });
});
