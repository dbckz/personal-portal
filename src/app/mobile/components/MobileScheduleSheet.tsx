'use client';

import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Clock, Loader2 } from 'lucide-react';
import { formatTimeRange } from '@/lib/event-display';
import { CalendarEvent } from '@/types';
import { MobileSheet } from './MobileSheet';

// Schedule a not-yet-scheduled task, or reschedule an existing block, onto a
// chosen day and time. A drag grid has no touch analogue, so this uses plain
// date + time inputs and shows the chosen day's existing events for context.
export function MobileScheduleSheet({
  title,
  initialDate,
  initialTime,
  submitLabel,
  eventsForDate,
  onSubmit,
  onClose,
}: {
  title: string;
  initialDate: string; // yyyy-MM-dd
  initialTime: string; // HH:mm
  submitLabel: string;
  // Timed events already on the chosen day, for context (never a drag grid).
  eventsForDate: (dateStr: string) => CalendarEvent[];
  onSubmit: (dateStr: string, timeStr: string) => Promise<void>;
  onClose: () => void;
}) {
  const [dateStr, setDateStr] = useState(initialDate);
  const [timeStr, setTimeStr] = useState(initialTime);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dayEvents = useMemo(
    () =>
      eventsForDate(dateStr)
        .filter(event => !event.allDay)
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime()),
    [eventsForDate, dateStr]
  );

  const handleSave = async () => {
    if (!dateStr || !timeStr) {
      setError('Pick a date and time');
      return;
    }
    setError(null);
    setIsSaving(true);
    try {
      await onSubmit(dateStr, timeStr);
    } catch {
      setError('Could not save — check your connection.');
      setIsSaving(false);
    }
  };

  const fieldClass =
    'w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40';
  const labelClass = 'block text-xs font-semibold uppercase tracking-wide text-gray-500';

  return (
    <MobileSheet onClose={onClose}>
      <div className="border-b border-gray-200 px-4 pb-3">
        <h2 className="text-lg font-semibold text-gray-950">Schedule</h2>
        <p className="mt-0.5 truncate text-sm text-gray-500">{title}</p>
      </div>

      <div className="space-y-4 overflow-y-auto overscroll-contain p-4">
        <div className="flex gap-3">
          <div className="flex-1 space-y-1.5">
            <label className={labelClass} htmlFor="schedule-date">Day</label>
            <input
              id="schedule-date"
              type="date"
              value={dateStr}
              onChange={e => setDateStr(e.target.value)}
              className={fieldClass}
            />
          </div>
          <div className="flex-1 space-y-1.5">
            <label className={labelClass} htmlFor="schedule-time">Time</label>
            <input
              id="schedule-time"
              type="time"
              value={timeStr}
              onChange={e => setTimeStr(e.target.value)}
              className={fieldClass}
            />
          </div>
        </div>

        <div>
          <h3 className={labelClass}>On {format(new Date(`${dateStr}T00:00`), 'EEE, MMM d')}</h3>
          {dayEvents.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {dayEvents.map(event => (
                <li
                  key={`${event.integrationId || event.source}-${event.id}`}
                  className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"
                >
                  <Clock className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
                  <span className="w-28 flex-shrink-0 tabular-nums text-gray-500">
                    {formatTimeRange(event)}
                  </span>
                  <span className="truncate">{event.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-gray-400">Nothing else scheduled.</p>
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <div className="flex gap-2 border-t border-gray-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={onClose}
          disabled={isSaving}
          className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors active:bg-gray-100 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors active:bg-orange-700 disabled:opacity-50"
        >
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </MobileSheet>
  );
}
