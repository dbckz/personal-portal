import { AdHocTask, ScheduledAsanaTask, CalendarEvent, TaskTemplate, CustomTaskType } from '@/types';

export const mockAdHocTask: AdHocTask = {
  id: 'task-1',
  title: 'Test Task',
  description: 'A test task description',
  completed: false,
  priority: 'medium',
  taskType: 'focus',
  dueDate: '2024-01-15',
  dueTime: '09:00',
  duration: 60,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

export const mockScheduledAsanaTask: ScheduledAsanaTask = {
  id: 'schedule-1',
  asanaTaskId: 'asana-task-1',
  integrationId: 'integration-1',
  scheduledDate: '2024-01-15',
  scheduledTime: '09:00',
  duration: 60,
};

export const mockScheduledAsanaTaskWithGoogle: ScheduledAsanaTask = {
  id: 'schedule-2',
  asanaTaskId: 'asana-task-2',
  integrationId: 'integration-1',
  scheduledDate: '2024-01-15',
  scheduledTime: '10:00',
  duration: 30,
  googleEventId: 'google-event-1',
  googleIntegrationId: 'google-integration-1',
};

export const mockCalendarEvent: CalendarEvent = {
  id: 'event-1',
  title: 'Test Event',
  description: 'A test event',
  startTime: new Date('2024-01-15T09:00:00'),
  endTime: new Date('2024-01-15T10:00:00'),
  source: 'google',
  color: '#4285f4',
};

export const mockAsanaCalendarEvent: CalendarEvent = {
  id: 'asana-event-1',
  title: 'Asana Task',
  description: 'An Asana task',
  startTime: new Date('2024-01-15T11:00:00'),
  endTime: new Date('2024-01-15T12:00:00'),
  source: 'asana',
  integrationId: 'integration-1',
  completed: false,
};

export const mockTaskTemplate: TaskTemplate = {
  id: 'template-1',
  title: 'Daily Standup',
  description: 'Team standup meeting',
  duration: 15,
  taskType: 'custom:meeting',
  priority: 'medium',
  createdAt: '2024-01-01T00:00:00.000Z',
};

export const mockCustomTaskType: CustomTaskType = {
  id: 'custom-type-1',
  label: 'Research',
  emoji: '🔬',
  createdAt: '2024-01-01T00:00:00.000Z',
};

// Factory functions for creating test data with overrides
export const createMockAdHocTask = (overrides: Partial<AdHocTask> = {}): AdHocTask => ({
  ...mockAdHocTask,
  ...overrides,
});

export const createMockScheduledAsanaTask = (
  overrides: Partial<ScheduledAsanaTask> = {}
): ScheduledAsanaTask => ({
  ...mockScheduledAsanaTask,
  ...overrides,
});

export const createMockCalendarEvent = (
  overrides: Partial<CalendarEvent> = {}
): CalendarEvent => ({
  ...mockCalendarEvent,
  ...overrides,
});

export const createMockTaskTemplate = (
  overrides: Partial<TaskTemplate> = {}
): TaskTemplate => ({
  ...mockTaskTemplate,
  ...overrides,
});

export const createMockCustomTaskType = (
  overrides: Partial<CustomTaskType> = {}
): CustomTaskType => ({
  ...mockCustomTaskType,
  ...overrides,
});

