'use client';

import { useEffect, useState } from 'react';
import { CalendarRange, ChevronDown, ChevronRight, Pencil } from 'lucide-react';

import { api } from '@/lib/api';
import type { WeeklyRoutineDay } from '@/types/life';
import { MobileRoutineEditor } from './MobileRoutineEditor';

// The standing weekly routine on the phone, tucked below today's checklist in a
// collapsible card: a glance at what each day is meant to be, and — via the Edit
// affordance — the read/write surface for changing it, in a bottom sheet.

const DAY_LABELS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  0: 'Sun',
};

export function RoutineCard() {
  const [open, setOpen] = useState(false);
  const [routine, setRoutine] = useState<WeeklyRoutineDay[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    // Fetch lazily on first expand — the card is closed by default and most
    // sessions never open it.
    if (!open || loaded) return;
    let cancelled = false;
    api
      .getWeeklyRoutine()
      .then(res => !cancelled && setRoutine(res.routine))
      .catch(() => !cancelled && setRoutine([]))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  return (
    <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <CalendarRange className="h-4 w-4 text-gray-400" />
        <span className="flex-1 text-sm font-semibold text-gray-900">Weekly routine</span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-400" />
        )}
      </button>

      {open && (
        <div className="border-t border-gray-100 px-3 py-2">
          {!loaded && <p className="text-sm text-gray-400">Loading…</p>}
          {loaded && routine && routine.length === 0 && (
            <p className="text-sm text-gray-400">No routine set.</p>
          )}
          {loaded && routine && (
            <div className="mb-1 flex justify-end">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-gray-500 active:text-gray-900"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </button>
            </div>
          )}
          {loaded && routine && routine.length > 0 && (
            <ul className="divide-y divide-gray-100">
              {routine.map(day => (
                <li key={day.dayOfWeek} className="flex gap-3 py-2">
                  <span className="w-9 shrink-0 text-xs font-semibold uppercase tracking-wide text-gray-400">
                    {DAY_LABELS[day.dayOfWeek]}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={`text-sm font-medium ${
                        day.rest ? 'text-gray-400' : 'text-gray-900'
                      }`}
                    >
                      {day.title || (day.rest ? 'Rest' : '—')}
                    </p>
                    {!day.rest && day.anchors.length > 0 && (
                      <p className="text-xs text-gray-600">{day.anchors.join(', ')}</p>
                    )}
                    {!day.rest && day.staples && day.staples.length > 0 && (
                      <p className="text-xs text-gray-400">{day.staples.join(', ')}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {editing && routine && (
        <MobileRoutineEditor
          initial={routine}
          onClose={() => setEditing(false)}
          onSaved={saved => {
            setRoutine(saved);
            setEditing(false);
          }}
        />
      )}
    </section>
  );
}
