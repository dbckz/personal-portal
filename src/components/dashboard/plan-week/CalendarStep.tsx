'use client';

import { format, parseISO } from 'date-fns';
import { CalendarCheck, RefreshCw, Loader2, AlertTriangle } from 'lucide-react';

import type { PendingInvite } from '@/lib/api';

interface CalendarStepProps {
  // Meetings this week awaiting the user's RSVP. null = not loaded yet.
  invites: PendingInvite[] | null;
  loading: boolean;
  // Set when the fetch failed — the step degrades to the static instruction so it
  // never blocks planning.
  error: string | null;
  onRefresh: () => void;
}

// Wizard step 0 — Review your calendar. An accurate calendar makes for an accurate
// plan, so before anything else the user is asked to accept/decline this week's
// outstanding meeting invites. The app can't RSVP on their behalf, so it lists the
// pending invites and points them at Google Calendar, with a refresh to re-check.
export function CalendarStep({ invites, loading, error, onRefresh }: CalendarStepProps) {
  const label = (status: string): string =>
    status === 'tentative' ? 'Maybe' : 'No response';

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <CalendarCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-orange-500" />
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Review your calendar</h3>
          <p className="mt-1 text-sm text-gray-500">
            Before planning, make your calendar accurate: go through this week and
            accept or decline every meeting invite. The plan schedules around what
            you&apos;re actually attending.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Awaiting your response
        </h4>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            Couldn&apos;t load your invites. Open Google Calendar, respond to this
            week&apos;s meetings, then continue.
          </span>
        </div>
      ) : loading && invites === null ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking for invites…
        </div>
      ) : invites && invites.length > 0 ? (
        <>
          <ul className="space-y-2">
            {invites.map(inv => (
              <li
                key={inv.eventId}
                className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-800">{inv.title}</p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {format(parseISO(inv.date), 'EEE d MMM')} · {inv.start}
                    {inv.calendar ? ` · ${inv.calendar}` : ''}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                  {label(inv.responseStatus)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-400">
            Respond to these in Google Calendar, then hit Refresh to re-check.
          </p>
        </>
      ) : (
        <p className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          All caught up — no invites awaiting a response.
        </p>
      )}
    </div>
  );
}
