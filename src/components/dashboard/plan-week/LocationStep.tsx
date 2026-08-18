'use client';

import { format, parseISO } from 'date-fns';
import { Home, Building2, Plane } from 'lucide-react';

import type { WizardDayLocation } from '@/lib/api';

interface LocationStepProps {
  // The target week's working-day dates (yyyy-MM-dd).
  workingDays: string[];
  // Current per-day location picks (missing entry = home).
  dayLocations: Record<string, WizardDayLocation>;
  // Set (or clear, with 'home'/null) a day's location.
  setDayLocation: (dateStr: string, next: WizardDayLocation | null) => void;
}

type LocType = 'home' | 'office' | 'travel';

const OPTIONS: Array<{ type: LocType; label: string; icon: typeof Home }> = [
  { type: 'home', label: 'Home', icon: Home },
  { type: 'office', label: 'Office', icon: Building2 },
  { type: 'travel', label: 'Travelling', icon: Plane },
];

// Per-day work location: where Dave will be each working day. Home is the default
// (no entry). Office days get a get-ready + commute pair and cap deep work;
// travelling reveals destination / depart time / duration inputs and inserts a
// fixed travel block.
export function LocationStep({ workingDays, dayLocations, setDayLocation }: LocationStepProps) {
  if (workingDays.length === 0) {
    return (
      <p className="text-sm text-gray-400 italic py-8 text-center">
        No working days to set a location for this week.
      </p>
    );
  }

  const currentType = (dateStr: string): LocType => dayLocations[dateStr]?.type ?? 'home';

  const pick = (dateStr: string, type: LocType) => {
    if (type === 'home') return setDayLocation(dateStr, null);
    if (type === 'office') return setDayLocation(dateStr, { type: 'office' });
    // Travelling: seed sensible defaults the user can edit.
    setDayLocation(dateStr, {
      type: 'travel',
      destination: dayLocations[dateStr]?.destination ?? '',
      departTime: dayLocations[dateStr]?.departTime ?? '09:00',
      travelMinutes: dayLocations[dateStr]?.travelMinutes ?? 120,
    });
  };

  const updateTravel = (dateStr: string, patch: Partial<WizardDayLocation>) => {
    const existing = dayLocations[dateStr];
    if (!existing || existing.type !== 'travel') return;
    setDayLocation(dateStr, { ...existing, ...patch });
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">
        Where will you be each day? Office days get a get-ready and commute block;
        travel days get a travel block. Deep work still leads the morning at home.
      </p>
      {workingDays.map(dateStr => {
        const active = currentType(dateStr);
        const loc = dayLocations[dateStr];
        return (
          <div key={dateStr} className="rounded-lg border border-gray-200 p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-sm font-medium text-gray-700 w-24 flex-shrink-0">
                {format(parseISO(dateStr), 'EEE d MMM')}
              </span>
              <div className="flex items-center gap-1.5">
                {OPTIONS.map(({ type, label, icon: Icon }) => {
                  const on = active === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => pick(dateStr, type)}
                      aria-pressed={on}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                        on
                          ? 'bg-orange-100 text-orange-700 border-orange-300'
                          : 'text-gray-500 border-gray-200 hover:bg-gray-100'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {active === 'travel' && (
              <div className="mt-3 flex flex-wrap items-end gap-3 pl-1">
                <label className="flex flex-col gap-1 text-[11px] text-gray-500">
                  Destination
                  <input
                    type="text"
                    defaultValue={loc?.destination ?? ''}
                    onBlur={e => updateTravel(dateStr, { destination: e.target.value })}
                    placeholder="e.g. Paris"
                    className="w-40 text-sm border border-gray-300 rounded px-2 py-1 outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-gray-500">
                  Depart
                  <input
                    type="time"
                    value={loc?.departTime ?? '09:00'}
                    onChange={e => updateTravel(dateStr, { departTime: e.target.value })}
                    className="text-sm border border-gray-300 rounded px-2 py-1 outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-gray-500">
                  Duration (min)
                  <input
                    type="number"
                    min={15}
                    max={720}
                    step={15}
                    value={loc?.travelMinutes ?? 120}
                    onChange={e => updateTravel(dateStr, { travelMinutes: Number(e.target.value) })}
                    className="w-24 text-sm border border-gray-300 rounded px-2 py-1 outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  />
                </label>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
