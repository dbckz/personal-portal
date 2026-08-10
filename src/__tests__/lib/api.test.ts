import { api, ApiRequestError, parseCalendarEvent, parseCalendarEvents } from '@/lib/api';
import { CalendarEventResponse } from '@/types';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('ApiRequestError', () => {
  it('creates error with status and message', () => {
    const error = new ApiRequestError('Test error', 404, { error: 'Not found' });

    expect(error.message).toBe('Test error');
    expect(error.status).toBe(404);
    expect(error.data).toEqual({ error: 'Not found' });
    expect(error.name).toBe('ApiRequestError');
  });

  it('can be used with instanceof', () => {
    const error = new ApiRequestError('Test', 500);
    expect(error instanceof Error).toBe(true);
    expect(error instanceof ApiRequestError).toBe(true);
  });
});

describe('parseCalendarEvent', () => {
  it('converts date strings to Date objects', () => {
    const response: CalendarEventResponse = {
      id: 'event-1',
      title: 'Test Event',
      startTime: new Date('2024-01-15T09:00:00Z'),
      endTime: new Date('2024-01-15T10:00:00Z'),
      source: 'google',
      integrationId: 'int-1',
      integrationName: 'My Calendar',
    };

    // Simulate API response where dates are strings
    const apiResponse = {
      ...response,
      startTime: '2024-01-15T09:00:00Z',
      endTime: '2024-01-15T10:00:00Z',
    };

    const parsed = parseCalendarEvent(apiResponse as unknown as CalendarEventResponse);

    expect(parsed.startTime).toBeInstanceOf(Date);
    expect(parsed.endTime).toBeInstanceOf(Date);
    expect(parsed.startTime.toISOString()).toBe('2024-01-15T09:00:00.000Z');
    expect(parsed.endTime.toISOString()).toBe('2024-01-15T10:00:00.000Z');
  });

  it('preserves all other event properties', () => {
    const response = {
      id: 'event-1',
      title: 'Test Event',
      description: 'A description',
      startTime: '2024-01-15T09:00:00Z',
      endTime: '2024-01-15T10:00:00Z',
      source: 'google',
      color: '#4285f4',
      location: 'Office',
      integrationId: 'int-1',
      integrationName: 'My Calendar',
    };

    const parsed = parseCalendarEvent(response as unknown as CalendarEventResponse);

    expect(parsed.id).toBe('event-1');
    expect(parsed.title).toBe('Test Event');
    expect(parsed.description).toBe('A description');
    expect(parsed.source).toBe('google');
    expect(parsed.color).toBe('#4285f4');
    expect(parsed.location).toBe('Office');
    expect(parsed.integrationId).toBe('int-1');
    expect(parsed.integrationName).toBe('My Calendar');
  });
});

describe('parseCalendarEvents', () => {
  it('parses array of events', () => {
    const responses = [
      {
        id: 'event-1',
        title: 'Event 1',
        startTime: '2024-01-15T09:00:00Z',
        endTime: '2024-01-15T10:00:00Z',
        source: 'google',
        integrationId: 'int-1',
        integrationName: 'Calendar',
      },
      {
        id: 'event-2',
        title: 'Event 2',
        startTime: '2024-01-15T11:00:00Z',
        endTime: '2024-01-15T12:00:00Z',
        source: 'google',
        integrationId: 'int-1',
        integrationName: 'Calendar',
      },
    ];

    const parsed = parseCalendarEvents(responses as unknown as CalendarEventResponse[]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].startTime).toBeInstanceOf(Date);
    expect(parsed[1].startTime).toBeInstanceOf(Date);
  });

  it('returns empty array for empty input', () => {
    const parsed = parseCalendarEvents([]);
    expect(parsed).toEqual([]);
  });
});

describe('api methods', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('getCalendarEvents', () => {
    it('fetches events for a date', async () => {
      const mockEvents = [{ id: 'event-1', title: 'Test' }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockEvents),
      });

      const date = new Date('2024-01-15');
      const result = await api.getCalendarEvents(date);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/calendar?date='),
        undefined
      );
      expect(result).toEqual(mockEvents);
    });
  });

  describe('updateBlockMember', () => {
    it('posts a done action for an Asana member', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });

      await api.updateBlockMember('done', {
        source: 'asana',
        taskId: 'g1',
        gid: 'g1',
        integrationId: 'int-1',
        scheduleId: 's1',
      });

      expect(mockFetch).toHaveBeenCalledWith('/api/scheduling/block-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'done',
          member: { source: 'asana', taskId: 'g1', gid: 'g1', integrationId: 'int-1', scheduleId: 's1' },
        }),
      });
    });

    it('posts a remove action', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });

      await api.updateBlockMember('remove', { source: 'asana', taskId: 'g2', scheduleId: 's2' });

      expect(mockFetch).toHaveBeenCalledWith('/api/scheduling/block-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'remove',
          member: { source: 'asana', taskId: 'g2', scheduleId: 's2' },
        }),
      });
    });
  });

  describe('createCalendarEvent', () => {
    it('creates event with correct payload', async () => {
      const mockEvent = { id: 'new-event', title: 'Test' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockEvent),
      });

      const startTime = new Date('2024-01-15T09:00:00Z');
      const endTime = new Date('2024-01-15T10:00:00Z');

      await api.createCalendarEvent('int-1', 'Test Event', startTime, endTime, 'Description');

      expect(mockFetch).toHaveBeenCalledWith('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId: 'int-1',
          title: 'Test Event',
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          description: 'Description',
          allDay: undefined,
          recurrence: undefined,
        }),
      });
    });
  });

  it('creates recurring all-day event with correct payload', async () => {
      const mockEvent = { id: 'new-event', title: 'Recurring Test' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockEvent),
      });

      const startTime = new Date('2026-05-08T00:00:00');
      const endTime = new Date('2026-05-09T00:00:00');

      await api.createCalendarEvent(
        'int-1',
        'Recurring Test',
        startTime,
        endTime,
        'Description',
        'default',
        'calendar-1',
        {
          allDay: true,
          recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR'],
        }
      );

      expect(mockFetch).toHaveBeenCalledWith('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId: 'int-1',
          title: 'Recurring Test',
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          description: 'Description',
          eventType: 'default',
          calendarId: 'calendar-1',
          allDay: true,
          recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR'],
        }),
      });
    });

  describe('updateCalendarEvent', () => {
    it('updates event with correct payload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const startTime = new Date('2024-01-15T10:00:00Z');
      const endTime = new Date('2024-01-15T11:00:00Z');

      await api.updateCalendarEvent('event-1', 'int-1', startTime, endTime);

      expect(mockFetch).toHaveBeenCalledWith('/api/calendar', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          integrationId: 'int-1',
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          title: undefined,
          description: undefined,
          calendarId: undefined,
          colorId: undefined,
        }),
      });
    });

    it('passes colorId when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const startTime = new Date('2024-01-15T10:00:00Z');
      const endTime = new Date('2024-01-15T11:00:00Z');

      await api.updateCalendarEvent(
        'event-1',
        'int-1',
        startTime,
        endTime,
        'Updated title',
        'Updated description',
        'calendar-1',
        '11'
      );

      expect(mockFetch).toHaveBeenCalledWith('/api/calendar', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          integrationId: 'int-1',
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          title: 'Updated title',
          description: 'Updated description',
          calendarId: 'calendar-1',
          colorId: '11',
        }),
      });
    });
  });

  describe('deleteCalendarEvent', () => {
    it('deletes event with correct payload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      await api.deleteCalendarEvent('event-1', 'int-1');

      expect(mockFetch).toHaveBeenCalledWith('/api/calendar', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          integrationId: 'int-1',
        }),
      });
    });
  });

  describe('getAllAsanaTasks', () => {
    it('fetches all Asana tasks', async () => {
      const mockTasks = [{ id: 'asana-1', title: 'Task 1' }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockTasks),
      });

      const result = await api.getAllAsanaTasks();

      expect(mockFetch).toHaveBeenCalledWith('/api/asana-tasks/all', undefined);
      expect(result).toEqual(mockTasks);
    });
  });

  describe('completeAsanaTask', () => {
    it('marks task as complete', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, completed: true }),
      });

      await api.completeAsanaTask('task-1', 'int-1', true);

      expect(mockFetch).toHaveBeenCalledWith('/api/asana-tasks/task-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true, integrationId: 'int-1' }),
      });
    });
  });

  describe('addAsanaComment', () => {
    it('adds comment to task', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      await api.addAsanaComment('task-1', 'int-1', 'My comment');

      expect(mockFetch).toHaveBeenCalledWith('/api/asana-tasks/task-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: 'My comment', integrationId: 'int-1' }),
      });
    });

    it('passes htmlText when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      await api.addAsanaComment('task-1', 'int-1', 'Plain fallback', '<body><strong>Hello</strong></body>');

      expect(mockFetch).toHaveBeenCalledWith('/api/asana-tasks/task-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: 'Plain fallback',
          htmlText: '<body><strong>Hello</strong></body>',
          integrationId: 'int-1',
        }),
      });
    });
  });

  describe('getAsanaProjects', () => {
    it('fetches Asana projects', async () => {
      const mockProjects = { projects: [{ gid: 'proj-1', name: 'Project 1' }] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockProjects),
      });

      const result = await api.getAsanaProjects();

      expect(mockFetch).toHaveBeenCalledWith('/api/asana-projects', undefined);
      expect(result).toEqual(mockProjects);
    });
  });

  describe('getSettings', () => {
    it('fetches settings', async () => {
      const mockSettings = { googleIntegrations: [], asanaIntegrations: [] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSettings),
      });

      const result = await api.getSettings();

      expect(mockFetch).toHaveBeenCalledWith('/api/settings', undefined);
      expect(result).toEqual(mockSettings);
    });
  });

  describe('error handling', () => {
    it('throws ApiRequestError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Not found' }),
      });

      await expect(api.getSettings()).rejects.toThrow(ApiRequestError);
    });

    it('does not retry on 401 error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Unauthorized' }),
      });

      await expect(api.getSettings()).rejects.toThrow(ApiRequestError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry on 403 error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: 'Forbidden' }),
      });

      await expect(api.getSettings()).rejects.toThrow(ApiRequestError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
