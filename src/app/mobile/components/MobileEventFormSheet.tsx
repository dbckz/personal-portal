'use client';

import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { MobileSheet } from './MobileSheet';

export interface EventFormValues {
  integrationId: string;
  title: string;
  start: Date;
  end: Date;
}

// Combine a yyyy-MM-dd date input and an HH:mm time input into a local Date.
function combine(dateStr: string, timeStr: string): Date {
  return new Date(`${dateStr}T${timeStr}`);
}

// Create or edit a Google calendar event. In create mode a calendar picker is
// shown when more than one Google integration is connected; in edit mode the
// event stays on its own calendar so the integration is fixed.
export function MobileEventFormSheet({
  mode,
  initialTitle = '',
  initialStart,
  initialEnd,
  googleIntegrations,
  fixedIntegrationId,
  onSubmit,
  onClose,
}: {
  mode: 'create' | 'edit';
  initialTitle?: string;
  initialStart: Date;
  initialEnd: Date;
  googleIntegrations: { id: string; name: string }[];
  fixedIntegrationId?: string;
  onSubmit: (values: EventFormValues) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [dateStr, setDateStr] = useState(format(initialStart, 'yyyy-MM-dd'));
  const [startStr, setStartStr] = useState(format(initialStart, 'HH:mm'));
  const [endStr, setEndStr] = useState(format(initialEnd, 'HH:mm'));
  const [integrationId, setIntegrationId] = useState(
    fixedIntegrationId || googleIntegrations[0]?.id || ''
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showCalendarPicker = mode === 'create' && !fixedIntegrationId && googleIntegrations.length > 1;

  const validationError = useMemo(() => {
    if (!title.trim()) return 'Add a title';
    const start = combine(dateStr, startStr);
    const end = combine(dateStr, endStr);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 'Pick a valid date and time';
    if (end.getTime() <= start.getTime()) return 'End time must be after the start';
    if (mode === 'create' && !integrationId) return 'No calendar connected';
    return null;
  }, [title, dateStr, startStr, endStr, integrationId, mode]);

  const handleSave = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setIsSaving(true);
    try {
      await onSubmit({
        integrationId,
        title: title.trim(),
        start: combine(dateStr, startStr),
        end: combine(dateStr, endStr),
      });
    } catch {
      setError('Could not save the event — check your connection.');
      setIsSaving(false);
    }
  };

  const fieldClass =
    'w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40';
  const labelClass = 'block text-xs font-semibold uppercase tracking-wide text-gray-500';

  return (
    <MobileSheet onClose={onClose}>
      <div className="flex items-center justify-between border-b border-gray-200 px-4 pb-3">
        <h2 className="text-lg font-semibold text-gray-950">
          {mode === 'create' ? 'New event' : 'Edit event'}
        </h2>
      </div>

      <div className="space-y-4 overflow-y-auto overscroll-contain p-4">
        <div className="space-y-1.5">
          <label className={labelClass} htmlFor="event-title">Title</label>
          <input
            id="event-title"
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Event title"
            autoFocus={mode === 'create'}
            className={fieldClass}
          />
        </div>

        <div className="space-y-1.5">
          <label className={labelClass} htmlFor="event-date">Date</label>
          <input
            id="event-date"
            type="date"
            value={dateStr}
            onChange={e => setDateStr(e.target.value)}
            className={fieldClass}
          />
        </div>

        <div className="flex gap-3">
          <div className="flex-1 space-y-1.5">
            <label className={labelClass} htmlFor="event-start">Starts</label>
            <input
              id="event-start"
              type="time"
              value={startStr}
              onChange={e => setStartStr(e.target.value)}
              className={fieldClass}
            />
          </div>
          <div className="flex-1 space-y-1.5">
            <label className={labelClass} htmlFor="event-end">Ends</label>
            <input
              id="event-end"
              type="time"
              value={endStr}
              onChange={e => setEndStr(e.target.value)}
              className={fieldClass}
            />
          </div>
        </div>

        {showCalendarPicker && (
          <div className="space-y-1.5">
            <label className={labelClass} htmlFor="event-calendar">Calendar</label>
            <select
              id="event-calendar"
              value={integrationId}
              onChange={e => setIntegrationId(e.target.value)}
              className={fieldClass}
            >
              {googleIntegrations.map(integration => (
                <option key={integration.id} value={integration.id}>
                  {integration.name}
                </option>
              ))}
            </select>
          </div>
        )}

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
          disabled={isSaving || !!validationError}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors active:bg-blue-700 disabled:opacity-50"
        >
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          {mode === 'create' ? 'Add event' : 'Save'}
        </button>
      </div>
    </MobileSheet>
  );
}
