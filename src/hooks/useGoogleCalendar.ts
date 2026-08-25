'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { CalendarEvent } from '@/types';
import { api, parseCalendarEvents, ApiRequestError } from '@/lib/api';
import { readGoogleCalendarCache, writeGoogleCalendarCache } from '@/lib/cache';

interface UseGoogleCalendarReturn {
  googleEvents: CalendarEvent[];
  isLoading: boolean;
  error: string | null;
  fetchGoogleEventsForDate: (date: Date) => Promise<CalendarEvent[]>;
  fetchGoogleEventsForDates: (dates: Date[], options?: { incremental?: boolean }) => Promise<void>;
  resetFetchedDates: () => void;
  updateGoogleEvent: (
    eventId: string,
    integrationId: string,
    startTime: Date,
    endTime: Date,
    title?: string,
    description?: string,
    calendarId?: string
  ) => Promise<{ success: boolean; error?: string }>;
  createGoogleEvent: (
    integrationId: string,
    title: string,
    startTime: Date,
    endTime: Date,
    description?: string,
    eventType?: 'default' | 'focusTime',
    calendarId?: string,
    options?: {
      allDay?: boolean;
      recurrence?: string[];
      transparency?: 'opaque' | 'transparent';
    }
  ) => Promise<{ event: CalendarEvent | null; error?: string }>;
  deleteGoogleEvent: (
    eventId: string,
    integrationId: string,
    calendarId?: string
  ) => Promise<{ success: boolean; error?: string }>;
  setGoogleEvents: React.Dispatch<React.SetStateAction<CalendarEvent[]>>;
}

// Include calendarId in the key so the same event in different calendars is kept.
function eventKey(event: CalendarEvent): string {
  return event.calendarId ? `${event.calendarId}:${event.id}` : event.id;
}

function deduplicateEvents(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  return events.filter(event => {
    const key = eventKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Merge a fresh incremental fetch onto the cached events, letting the FRESHLY
// fetched copy win. deduplicateEvents keeps the first occurrence, so any stale
// cached copy of a re-fetched event (e.g. one moved to another day within the
// session) is evicted first — otherwise its old placement would shadow the fresh
// one for the rest of the session.
function mergeFreshEvents(prev: CalendarEvent[], fresh: CalendarEvent[]): CalendarEvent[] {
  const freshKeys = new Set(fresh.map(eventKey));
  const retainedPrev = prev.filter(e => !freshKeys.has(eventKey(e)));
  return deduplicateEvents([...retainedPrev, ...fresh]);
}

export function useGoogleCalendar(): UseGoogleCalendarReturn {
  const [googleEvents, setGoogleEvents] = useState<CalendarEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const pendingRequestsRef = useRef<Set<string>>(new Set());
  const fetchedDatesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchGoogleEventsForDate = useCallback(async (date: Date): Promise<CalendarEvent[]> => {
    const dateKey = date.toISOString().split('T')[0];

    // Skip if already fetching this date
    if (pendingRequestsRef.current.has(dateKey)) {
      return [];
    }

    pendingRequestsRef.current.add(dateKey);

    try {
      const events = await api.getCalendarEvents(date);
      return parseCalendarEvents(events);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        return []; // Not authenticated, return empty
      }
      console.error('Error fetching Google events:', err);
      return [];
    } finally {
      pendingRequestsRef.current.delete(dateKey);
    }
  }, []);

  const fetchGoogleEventsForDates = useCallback(async (dates: Date[], { incremental = false }: { incremental?: boolean } = {}) => {
    // In incremental mode, skip dates we've already fetched
    const datesToFetch = incremental
      ? dates.filter(d => !fetchedDatesRef.current.has(d.toISOString().split('T')[0]))
      : dates;

    if (datesToFetch.length === 0) return;

    if (!incremental) {
      const cached = readGoogleCalendarCache();
      if (cached) {
        setGoogleEvents(cached.events);
      } else {
        setIsLoading(true);
      }
    } else {
      setIsLoading(true);
    }
    setError(null);

    try {
      const eventArrays = await Promise.all(datesToFetch.map(fetchGoogleEventsForDate));
      if (!isMountedRef.current) return;

      const newEvents = eventArrays.flat();

      if (incremental) {
        setGoogleEvents(prev => {
          const uniqueEvents = mergeFreshEvents(prev, newEvents);
          writeGoogleCalendarCache(uniqueEvents);
          return uniqueEvents;
        });
      } else {
        const uniqueEvents = deduplicateEvents(newEvents);
        setGoogleEvents(uniqueEvents);
        writeGoogleCalendarCache(uniqueEvents);
      }

      // Track fetched dates
      for (const d of datesToFetch) {
        fetchedDatesRef.current.add(d.toISOString().split('T')[0]);
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to fetch calendar events');
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [fetchGoogleEventsForDate]);

  // Reset fetched dates tracking (used on full refresh)
  const resetFetchedDates = useCallback(() => {
    fetchedDatesRef.current.clear();
  }, []);

  const updateGoogleEvent = useCallback(async (
    eventId: string,
    integrationId: string,
    startTime: Date,
    endTime: Date,
    title?: string,
    description?: string,
    calendarId?: string
  ): Promise<{ success: boolean; error?: string }> => {
    let previousEvent: CalendarEvent | undefined;
    setGoogleEvents(prev => prev.map(event => {
      if (event.id === eventId) {
        previousEvent = event;
        return {
          ...event,
          startTime,
          endTime,
          ...(title !== undefined && { title }),
          ...(description !== undefined && { description }),
        };
      }
      return event;
    }));

    try {
      const updatedEvent = await api.updateCalendarEvent(eventId, integrationId, startTime, endTime, title, description, calendarId);
      setGoogleEvents(prev => {
        const updated = prev.map(event =>
          event.id === eventId ? { ...updatedEvent, startTime: new Date(updatedEvent.startTime), endTime: new Date(updatedEvent.endTime) } : event
        );
        writeGoogleCalendarCache(updated);
        return updated;
      });

      return { success: true };
    } catch (err) {
      if (previousEvent) {
        setGoogleEvents(prev => prev.map(event =>
          event.id === eventId ? previousEvent! : event
        ));
      }

      const message = err instanceof ApiRequestError ? err.message : 'Failed to update event';
      return { success: false, error: message };
    }
  }, []);

  const createGoogleEvent = useCallback(async (
    integrationId: string,
    title: string,
    startTime: Date,
    endTime: Date,
    description?: string,
    eventType?: 'default' | 'focusTime',
    calendarId?: string,
    options?: {
      allDay?: boolean;
      recurrence?: string[];
      transparency?: 'opaque' | 'transparent';
    }
  ): Promise<{ event: CalendarEvent | null; error?: string }> => {
    // Create optimistic event with temp ID
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const optimisticEvent: CalendarEvent = {
      id: tempId,
      title,
      startTime,
      endTime,
      source: 'google',
      description,
      integrationId,
      color: '#4285f4', // Google blue
      allDay: options?.allDay,
    };

    // Add optimistic event immediately
    setGoogleEvents(prev => {
      const updated = [...prev, optimisticEvent];
      writeGoogleCalendarCache(updated);
      return updated;
    });

    try {
      const createdEvent = await api.createCalendarEvent(integrationId, title, startTime, endTime, description, eventType, calendarId, options);

      const parsedEvent: CalendarEvent = {
        ...createdEvent,
        startTime: new Date(createdEvent.startTime),
        endTime: new Date(createdEvent.endTime),
      };

      // Replace temp event with real event
      setGoogleEvents(prev => {
        const updated = prev.map(e => e.id === tempId ? parsedEvent : e);
        writeGoogleCalendarCache(updated);
        return updated;
      });

      return { event: parsedEvent };
    } catch (err) {
      // Rollback: remove optimistic event
      setGoogleEvents(prev => {
        const updated = prev.filter(e => e.id !== tempId);
        writeGoogleCalendarCache(updated);
        return updated;
      });
      const message = err instanceof ApiRequestError ? err.message : 'Failed to create event';
      return { event: null, error: message };
    }
  }, []);

  const deleteGoogleEvent = useCallback(async (
    eventId: string,
    integrationId: string,
    calendarId?: string
  ): Promise<{ success: boolean; error?: string }> => {
    let previousEvents: CalendarEvent[] = [];
    setGoogleEvents(prev => {
      previousEvents = prev;
      return prev.filter(e => e.id !== eventId);
    });

    try {
      await api.deleteCalendarEvent(eventId, integrationId, calendarId);
      setGoogleEvents(prev => {
        writeGoogleCalendarCache(prev);
        return prev;
      });
      return { success: true };
    } catch (err) {
      setGoogleEvents(previousEvents);
      const message = err instanceof ApiRequestError ? err.message : 'Failed to delete event';
      return { success: false, error: message };
    }
  }, []);

  return {
    googleEvents,
    isLoading,
    error,
    fetchGoogleEventsForDate,
    fetchGoogleEventsForDates,
    resetFetchedDates,
    updateGoogleEvent,
    createGoogleEvent,
    deleteGoogleEvent,
    setGoogleEvents,
  };
}
