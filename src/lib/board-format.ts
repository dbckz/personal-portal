// Pure, I/O-free formatting helpers shared by the desktop and mobile weekly
// task boards. Kept out of the components so the label logic (planned-date
// labels, day-letter chips, the week-range label) is unit-tested in isolation
// and the two views cannot drift apart. Everything works on
// yyyy-MM-dd strings built from local parts, so a bare date never drifts across
// a timezone boundary.

import type { BoardCardBlock } from '@/types';

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;
// Mon..Sun single-letter labels, in board (week-start-Monday) order.
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// A Date at local midnight for a yyyy-MM-dd string (built from parts so it never
// shifts across a timezone boundary).
function dateFromStr(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toStr(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Today's yyyy-MM-dd, from local parts (never drifts across a timezone).
export function todayStr(): string {
  return toStr(new Date());
}

// The yyyy-MM-dd `days` after another. Used to walk a week Mon..Sun.
export function addDaysStr(dateStr: string, days: number): string {
  const base = dateFromStr(dateStr);
  return toStr(new Date(base.getFullYear(), base.getMonth(), base.getDate() + days));
}

// The seven days of a week (Mon..Sun) as yyyy-MM-dd strings.
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysStr(weekStart, i));
}

// "45m", "1h", "1h 30m".
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

// "Tue 19" (short) or "Tue 19 Aug" (with month).
export function shortDayLabel(dateStr: string, withMonth = false): string {
  const d = dateFromStr(dateStr);
  const base = `${WEEKDAY_ABBR[d.getDay()]} ${d.getDate()}`;
  return withMonth ? `${base} ${MONTH_ABBR[d.getMonth()]}` : base;
}

// A single block's planned-date chip: "Tue 19", "Tue 19 · 09:00", or
// "Tue 19 · 09:00 · 45m".
export function plannedBlockLabel(block: BoardCardBlock): string {
  const parts = [shortDayLabel(block.date)];
  if (block.start) parts.push(block.start);
  if (block.durationMinutes) parts.push(formatDuration(block.durationMinutes));
  return parts.join(' · ');
}

// The header's week-range label, e.g. "Mon 17 – Sun 23 Aug" (same month) or
// "Mon 28 Jul – Sun 3 Aug" (spanning two months).
export function weekRangeLabel(weekStart: string): string {
  const end = addDaysStr(weekStart, 6);
  const startD = dateFromStr(weekStart);
  const endD = dateFromStr(end);
  const sameMonth = startD.getMonth() === endD.getMonth() && startD.getFullYear() === endD.getFullYear();
  return `${shortDayLabel(weekStart, !sameMonth)} – ${shortDayLabel(end, true)}`;
}

export interface DayLetterChip {
  date: string; // yyyy-MM-dd
  letter: string; // M T W T F S S
  filled: boolean; // a planned date falls on this day
}

// Mon..Sun day-letter chips for a recurring card, each marked filled when the
// card is planned on that day.
export function dayLetterChips(weekStart: string, plannedDates: string[]): DayLetterChip[] {
  const planned = new Set(plannedDates);
  return weekDates(weekStart).map((date, i) => ({
    date,
    letter: DAY_LETTERS[i],
    filled: planned.has(date),
  }));
}

export interface DayFilterChip {
  date: string; // yyyy-MM-dd
  label: string; // "Mon"
  letter: string; // "M"
  dayOfMonth: number; // 17
}

// The seven per-day filter chips (Mon..Sun) shown in the board header.
export function dayFilterChips(weekStart: string): DayFilterChip[] {
  return weekDates(weekStart).map((date, i) => {
    const d = dateFromStr(date);
    return {
      date,
      label: WEEKDAY_ABBR[d.getDay()],
      letter: DAY_LETTERS[i],
      dayOfMonth: d.getDate(),
    };
  });
}
