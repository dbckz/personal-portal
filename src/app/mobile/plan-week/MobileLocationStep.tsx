'use client';

import { format, parseISO } from 'date-fns';
import { Home, Building2, Plane } from 'lucide-react';

import type { WizardDayLocation } from '@/lib/api';

interface MobileLocationStepProps {
  workingDays: string[];
  dayLocations: Record<string, WizardDayLocation>;
  setDayLocation: (dateStr: string, next: WizardDayLocation | null) => void;
}

type LocType = 'home' | 'office' | 'travel';

const OPTIONS: Array<{ type: LocType; label: string; icon: typeof Home }> = [
  { type: 'home', label: 'Home', icon: Home },
  { type: 'office', label: 'Office', icon: Building2 },
  { type: 'travel', label: 'Travel', icon: Plane },
];

// Touch build of the Location step: one card per working day, three big chips,
// and (for travel) stacked destination / depart / duration inputs. Text commits
// on blur, per the mobile write convention.
export function MobileLocationStep({ workingDays, dayLocations, setDayLocation }: MobileLocationStepProps) {
  if (workingDays.length === 0) {
    return (
      <p className="py-8 text-center text-sm italic text-gray-400">
        No working days to set a location for this week.
      </p>
    );
  }

  const currentType = (dateStr: string): LocType => dayLocations[dateStr]?.type ?? 'home';

  const pick = (dateStr: string, type: LocType) => {
    if (type === 'home') return setDayLocation(dateStr, null);
    if (type === 'office') return setDayLocation(dateStr, { type: 'office' });
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
        travel days get a travel block.
      </p>
      {workingDays.map(dateStr => {
        const active = currentType(dateStr);
        const loc = dayLocations[dateStr];
        return (
          <div key={dateStr} className="rounded-xl border border-gray-200 p-3">
            <span className="text-sm font-medium text-gray-700">
              {format(parseISO(dateStr), 'EEEE d MMM')}
            </span>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {OPTIONS.map(({ type, label, icon: Icon }) => {
                const on = active === type;
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => pick(dateStr, type)}
                    aria-pressed={on}
                    className={`inline-flex items-center justify-center gap-1 rounded-lg border py-2 text-xs font-medium transition-colors ${
                      on
                        ? 'border-orange-300 bg-orange-100 text-orange-700'
                        : 'border-gray-200 text-gray-500 active:bg-gray-100'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                );
              })}
            </div>

            {active === 'travel' && (
              <div className="mt-3 space-y-2">
                <label className="flex flex-col gap-1 text-[11px] text-gray-500">
                  Destination
                  <input
                    type="text"
                    defaultValue={loc?.destination ?? ''}
                    onBlur={e => updateTravel(dateStr, { destination: e.target.value })}
                    placeholder="e.g. Paris"
                    className="rounded-lg border border-gray-300 px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </label>
                <div className="flex gap-2">
                  <label className="flex flex-1 flex-col gap-1 text-[11px] text-gray-500">
                    Depart
                    <input
                      type="time"
                      value={loc?.departTime ?? '09:00'}
                      onChange={e => updateTravel(dateStr, { departTime: e.target.value })}
                      className="rounded-lg border border-gray-300 px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </label>
                  <label className="flex flex-1 flex-col gap-1 text-[11px] text-gray-500">
                    Duration (min)
                    <input
                      type="number"
                      min={15}
                      max={720}
                      step={15}
                      value={loc?.travelMinutes ?? 120}
                      onChange={e => updateTravel(dateStr, { travelMinutes: Number(e.target.value) })}
                      className="rounded-lg border border-gray-300 px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </label>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
