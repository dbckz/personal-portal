'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

import { weekRangeLabel } from '@/lib/board-format';

interface WeekNavProps {
  weekStart: string;
  isThisWeek: boolean;
  onPrev: () => void;
  onNext: () => void;
  onThisWeek: () => void;
}

export function WeekNav({ weekStart, isThisWeek, onPrev, onNext, onThisWeek }: WeekNavProps) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center rounded-lg border border-gray-200 bg-white">
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous week"
          className="rounded-l-lg px-2 py-1.5 text-gray-500 hover:bg-gray-50"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-[9.5rem] px-2 text-center text-sm font-medium text-gray-800">
          {weekRangeLabel(weekStart)}
        </span>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next week"
          className="rounded-r-lg px-2 py-1.5 text-gray-500 hover:bg-gray-50"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      {!isThisWeek && (
        <button
          type="button"
          onClick={onThisWeek}
          className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          This week
        </button>
      )}
    </div>
  );
}
