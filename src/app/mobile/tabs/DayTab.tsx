'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef } from 'react';
import { format, isSameDay, startOfDay } from 'date-fns';
import { CalendarClock, CalendarDays, Loader2, Plus } from 'lucide-react';
import { SOURCE_STYLES } from '@/lib/event-display';
import { CalendarEvent } from '@/types';
import { MobileEventCard } from '../components/MobileEventCard';
import { NowIndicator } from '../components/NowIndicator';

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-10 text-center">
      <CalendarDays className="mx-auto h-8 w-8 text-gray-400" />
      <p className="mt-3 text-sm font-medium text-gray-700">No timed events</p>
    </div>
  );
}

export function DayTab({
  selectedDate,
  now,
  events,
  dueTodayTasks,
  isLoading,
  onSelectEvent,
  onSelectTask,
  onCreateEvent,
  onScheduleTask,
  onMoveEvent,
  onUnscheduleEvent,
}: {
  selectedDate: Date;
  now: Date;
  // Merged events for the selected date (Google + adhoc + scheduled Asana).
  events: CalendarEvent[];
  // Unscheduled Asana tasks due/starting on the selected date.
  dueTodayTasks: CalendarEvent[];
  isLoading: boolean;
  onSelectEvent: (event: CalendarEvent) => void;
  // Opens the task detail sheet for an Asana-backed row/event.
  onSelectTask?: (task: CalendarEvent) => void;
  // Add a new calendar event on the selected day.
  onCreateEvent?: () => void;
  // Schedule an unscheduled Asana task into a time slot.
  onScheduleTask?: (task: CalendarEvent) => void;
  // Reschedule / unschedule a scheduled Asana event.
  onMoveEvent?: (event: CalendarEvent) => void;
  onUnscheduleEvent?: (event: CalendarEvent) => void;
}) {
  const nowIndicatorRef = useRef<HTMLDivElement | null>(null);
  const hasAutoScrolledRef = useRef(false);

  const dateKey = useMemo(() => format(selectedDate, 'yyyy-MM-dd'), [selectedDate]);

  const allDayEvents = useMemo(
    () => events.filter(event => event.allDay),
    [events]
  );

  const timedEvents = useMemo(
    () => events
      .filter(event => !event.allDay)
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime()),
    [events]
  );

  const isToday = useMemo(() => isSameDay(selectedDate, now), [selectedDate, now]);
  const isPastDay = useMemo(
    () => startOfDay(selectedDate).getTime() < startOfDay(now).getTime(),
    [selectedDate, now]
  );

  const isEventPast = useCallback((event: CalendarEvent) => {
    if (isPastDay) return true;
    if (!isToday) return false;
    return event.endTime.getTime() < now.getTime();
  }, [isPastDay, isToday, now]);

  const isEventCurrent = useCallback((event: CalendarEvent) => {
    if (!isToday) return false;
    const nowMs = now.getTime();
    return event.startTime.getTime() <= nowMs && event.endTime.getTime() >= nowMs;
  }, [isToday, now]);

  const nowIndicatorIndex = useMemo(() => {
    if (!isToday) return -1;
    const idx = timedEvents.findIndex(event => event.endTime.getTime() >= now.getTime());
    return idx === -1 ? timedEvents.length : idx;
  }, [isToday, timedEvents, now]);

  useEffect(() => {
    hasAutoScrolledRef.current = false;
  }, [dateKey]);

  useEffect(() => {
    if (hasAutoScrolledRef.current) return;
    if (!isToday) return;
    if (isLoading) return;

    const node = nowIndicatorRef.current;
    if (!node) return;

    const frameId = window.requestAnimationFrame(() => {
      node.scrollIntoView({ block: 'center', behavior: 'auto' });
      hasAutoScrolledRef.current = true;
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [isToday, isLoading, nowIndicatorIndex]);

  return (
    <div className="space-y-4">
      {isLoading && (
        <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
          <Loader2 className="h-4 w-4 animate-spin" />
          Syncing planner data
        </div>
      )}

      {allDayEvents.length > 0 && (
        <section className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-800">
            <CalendarDays className="h-4 w-4 text-gray-500" />
            All-day
          </div>
          <div className="flex flex-wrap gap-2">
            {allDayEvents.map(event => (
              <button
                type="button"
                key={`${event.integrationId || event.source}-${event.id}`}
                onClick={() => onSelectEvent(event)}
                className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-transform active:scale-95 ${SOURCE_STYLES[event.source].className}`}
              >
                {event.title}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Agenda</h2>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">{timedEvents.length}</span>
            {onCreateEvent && (
              <button
                type="button"
                onClick={onCreateEvent}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-blue-600 px-3 text-xs font-semibold text-white transition-colors active:bg-blue-700"
              >
                <Plus className="h-4 w-4" />
                Add
              </button>
            )}
          </div>
        </div>
        {timedEvents.length > 0 ? (
          <>
            {timedEvents.map((event, index) => (
              <Fragment key={`${event.integrationId || event.source}-${event.id}`}>
                {index === nowIndicatorIndex && <NowIndicator ref={nowIndicatorRef} now={now} />}
                <MobileEventCard
                  event={event}
                  onSelect={onSelectEvent}
                  isPast={isEventPast(event)}
                  isCurrent={isEventCurrent(event)}
                  onMove={onMoveEvent}
                  onUnschedule={onUnscheduleEvent}
                />
              </Fragment>
            ))}
            {nowIndicatorIndex === timedEvents.length && <NowIndicator ref={nowIndicatorRef} now={now} />}
          </>
        ) : (
          <>
            {isToday && <NowIndicator ref={nowIndicatorRef} now={now} />}
            <EmptyState />
          </>
        )}
      </section>

      {dueTodayTasks.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Asana Today</h2>
            <span className="text-sm text-gray-500">{dueTodayTasks.length}</span>
          </div>
          {dueTodayTasks.slice(0, 12).map(task => {
            const meta = [
              task.integrationName,
              task.dueOn ? `Due ${task.dueOn}` : null,
              task.startOn ? `Starts ${task.startOn}` : null,
            ]
              .filter(Boolean)
              .join(' | ');
            const body = (
              <div className="flex items-start gap-3">
                <span className={`mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full ${SOURCE_STYLES.asana.dot}`} />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold leading-6 text-gray-950">{task.title}</h3>
                  <p className="mt-1 text-xs text-gray-500">{meta}</p>
                </div>
              </div>
            );
            const key = `${task.integrationId || 'asana'}-${task.id}`;
            if (!onSelectTask && !onScheduleTask) {
              return (
                <article key={key} className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                  {body}
                </article>
              );
            }
            return (
              <div key={key} className="rounded-lg border border-gray-200 bg-white shadow-sm">
                {onSelectTask ? (
                  <button
                    type="button"
                    onClick={() => onSelectTask(task)}
                    className="w-full rounded-lg p-3 text-left transition-colors active:bg-gray-50"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="p-3">{body}</div>
                )}
                {onScheduleTask && (
                  <div className="flex border-t border-gray-100 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => onScheduleTask(task)}
                      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors active:bg-gray-100"
                    >
                      <CalendarClock className="h-4 w-4 text-gray-400" />
                      Schedule
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
