'use client';

import { dayFilterChips } from '@/lib/board-format';

export type DayFilter = string | 'all' | 'unplanned';

export interface DayFilterCounts {
  all: number;
  unplanned: number;
  byDate: Record<string, number>;
}

interface DayFilterChipsProps {
  weekStart: string;
  selected: DayFilter;
  today: string; // yyyy-MM-dd, highlighted when in this week
  counts: DayFilterCounts;
  onSelect: (day: DayFilter) => void;
}

function chipClass(active: boolean, isToday: boolean): string {
  if (active) return 'bg-orange-500 text-white border-orange-500';
  if (isToday) return 'border-orange-300 text-orange-700 bg-white';
  return 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50';
}

export function DayFilterChips({ weekStart, selected, today, counts, onSelect }: DayFilterChipsProps) {
  const days = dayFilterChips(weekStart);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onSelect('all')}
        className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${chipClass(
          selected === 'all',
          false
        )}`}
      >
        All <span className="opacity-70">{counts.all}</span>
      </button>

      {days.map(day => {
        const count = counts.byDate[day.date] ?? 0;
        const isToday = day.date === today;
        return (
          <button
            key={day.date}
            type="button"
            onClick={() => onSelect(day.date)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${chipClass(
              selected === day.date,
              isToday
            )}`}
            title={isToday ? 'Today' : undefined}
          >
            {day.label} <span className="opacity-70">{count}</span>
          </button>
        );
      })}

      <button
        type="button"
        onClick={() => onSelect('unplanned')}
        className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${chipClass(
          selected === 'unplanned',
          false
        )}`}
      >
        Unplanned <span className="opacity-70">{counts.unplanned}</span>
      </button>
    </div>
  );
}
