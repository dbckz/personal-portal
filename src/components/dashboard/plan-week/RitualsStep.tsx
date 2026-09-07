'use client';

import { Dispatch, SetStateAction } from 'react';
import { Minus, Plus } from 'lucide-react';
import { format, parseISO } from 'date-fns';

import type { RitualWeekSettings } from '@/lib/scheduling/rituals';

interface RitualsStepProps {
  ritualSettings: RitualWeekSettings;
  setRitualSettings: Dispatch<SetStateAction<RitualWeekSettings>>;
  // 🚶 Walk (moved here from the Tasks step): opt-in per day. The target week's
  // working days to offer as chips, the days opted in, and the per-day toggle.
  walkDays: Set<string>;
  weekWorkingDays: string[];
  toggleWalkDay: (dateStr: string) => void;
}

// Every automatically-scheduled ritual, on by default each week. Daily rituals
// are on/off for the week; weekly rituals carry a per-week count. The 🚶 Walk is
// opt-in per day (chips). Skipping the step keeps every default.
const DAILY: Array<{ key: keyof RitualWeekSettings['daily']; label: string }> = [
  { key: 'lunch', label: '🍽️ Lunch' },
  { key: 'exercise', label: '🏋️ Exercise' },
  { key: 'emails', label: '📧 Emails' },
  { key: 'breaks', label: '☕ Breaks' },
];

// Weekly rituals with their max per-week count. Retrospective is capped at 1 (it
// always takes the last working day); the rest allow up to 5.
const WEEKLY: Array<{ key: keyof RitualWeekSettings['weekly']; label: string; max: number }> = [
  { key: 'kindleNotes', label: '📚 Kindle notes', max: 5 },
  { key: 'delegationReview', label: '🤖 Delegation review', max: 5 },
  { key: 'grooming', label: '🧹 Backlog grooming', max: 5 },
  { key: 'retro', label: '🔄 Retrospective', max: 1 },
  { key: 'newBookies', label: '🎰 New bookies', max: 5 },
  { key: 'reading', label: '📖 Reading', max: 5 },
];

export function RitualsStep({
  ritualSettings,
  setRitualSettings,
  walkDays,
  weekWorkingDays,
  toggleWalkDay,
}: RitualsStepProps) {
  const setDaily = (key: keyof RitualWeekSettings['daily'], on: boolean) =>
    setRitualSettings(prev => ({ ...prev, daily: { ...prev.daily, [key]: on } }));

  const setWeekly = (key: keyof RitualWeekSettings['weekly'], value: number, max: number) =>
    setRitualSettings(prev => ({
      ...prev,
      weekly: { ...prev.weekly, [key]: Math.min(max, Math.max(0, value)) },
    }));

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">
        These rituals are scheduled automatically each week. Switch any off, or set
        how many times to place the weekly ones. Skip to keep the defaults.
      </p>

      {/* Daily rituals */}
      <div className="rounded-lg border border-gray-200 p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Every day</h3>
        <div className="space-y-1.5">
          {DAILY.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2.5 py-1 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={ritualSettings.daily[key]}
                onChange={e => setDaily(key, e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-orange-500 focus:ring-orange-500"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* Weekly rituals */}
      <div className="rounded-lg border border-gray-200 p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Each week</h3>
        <div className="space-y-1.5">
          {WEEKLY.map(({ key, label, max }) => {
            const value = ritualSettings.weekly[key];
            return (
              <div key={key} className="flex items-center justify-between gap-2 py-1">
                <span className={`text-sm ${value > 0 ? 'text-gray-700' : 'text-gray-400'}`}>{label}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setWeekly(key, value - 1, max)}
                    disabled={value <= 0}
                    aria-label={`Fewer ${label}`}
                    className="flex h-6 w-6 items-center justify-center rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span className="w-5 text-center text-sm tabular-nums text-gray-700" aria-live="polite">
                    {value === 0 ? 'Off' : value}
                  </span>
                  <button
                    type="button"
                    onClick={() => setWeekly(key, value + 1, max)}
                    disabled={value >= max}
                    aria-label={`More ${label}`}
                    className="flex h-6 w-6 items-center justify-center rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Walk — opt-in per day */}
      {weekWorkingDays.length > 0 && (
        <div className="rounded-lg border border-gray-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-medium text-gray-700">🚶 Walks</span>
            {weekWorkingDays.map(dateStr => {
              const on = walkDays.has(dateStr);
              return (
                <button
                  key={dateStr}
                  type="button"
                  onClick={() => toggleWalkDay(dateStr)}
                  aria-pressed={on}
                  title={`${on ? 'Remove' : 'Add a'} walk on ${format(parseISO(dateStr), 'EEEE d MMM')}`}
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    on
                      ? 'border-emerald-300 bg-emerald-100 text-emerald-700'
                      : 'border-gray-200 text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  {format(parseISO(dateStr), 'EEE')}
                </button>
              );
            })}
            <span className="ml-1 text-[11px] text-gray-400">
              {walkDays.size === 0 ? 'None' : `${walkDays.size} selected`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
