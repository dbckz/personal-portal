'use client';

import type { BoardCard } from '@/types';
import { dayFilterChips, todayStr } from '@/lib/board-format';

// The "Move to day" control shared by the desktop detail modal and (via a
// touch-sized variant) the mobile sheet: a chip per day of the viewed week
// (Mon..Sun), today ringed and the card's current day disabled, plus a native
// date input for any other date. Changing the day moves the card's backing
// record(s); the Google Calendar event is not touched, noted when the card has
// one. Rendered only for movable cards (see canChangeCardDate).
export function MoveToDayRow({
  card,
  weekStart,
  disabled,
  size = 'desktop',
  onChangeDate,
}: {
  card: BoardCard;
  weekStart: string;
  disabled: boolean;
  size?: 'desktop' | 'mobile';
  onChangeDate: (card: BoardCard, date: string) => void;
}) {
  const today = todayStr();
  const chips = dayFilterChips(weekStart);
  const mobile = size === 'mobile';

  return (
    <div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
        Move to day
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map(chip => {
          const isCurrent = card.date === chip.date;
          const isToday = chip.date === today;
          return (
            <button
              key={chip.date}
              type="button"
              onClick={() => onChangeDate(card, chip.date)}
              disabled={disabled || isCurrent}
              aria-pressed={isCurrent}
              aria-label={`Move to ${chip.label} ${chip.dayOfMonth}`}
              className={`flex flex-col items-center rounded-lg font-medium transition-colors disabled:cursor-default ${
                mobile ? 'h-12 w-11 justify-center text-xs' : 'px-2 py-1 text-[11px]'
              } ${
                isCurrent
                  ? 'bg-orange-500 text-white'
                  : `border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-60 ${
                      isToday ? 'ring-1 ring-orange-400' : ''
                    }`
              }`}
            >
              <span>{chip.label}</span>
              <span className={mobile ? 'text-[10px] opacity-70' : 'text-[10px] opacity-70'}>
                {chip.dayOfMonth}
              </span>
            </button>
          );
        })}
        <label
          className={`flex items-center rounded-lg border border-gray-300 px-2 text-gray-600 hover:bg-gray-50 ${
            mobile ? 'h-12 text-sm' : 'py-1 text-[11px]'
          } ${disabled ? 'opacity-60' : ''}`}
        >
          <span className="mr-1">Other</span>
          <input
            type="date"
            aria-label="Move to another date"
            disabled={disabled}
            value={card.date ?? ''}
            onChange={e => {
              if (e.target.value) onChangeDate(card, e.target.value);
            }}
            className="bg-transparent outline-none"
          />
        </label>
      </div>
      {card.googleEventId && (
        <p className="mt-1.5 text-[11px] text-gray-400">
          The calendar event stays where it is; only the board day changes.
        </p>
      )}
    </div>
  );
}
