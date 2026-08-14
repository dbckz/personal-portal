// The daily habits tracked in the Wellbeing section.
//
// Held in code rather than storage so the daily-review questions and the
// analysis can never drift apart: the review asks exactly these, and the
// analysis reports exactly these. Adding a habit is an entry here — history for
// it simply starts on the day it appears.
//
// Deliberately free of React imports so API routes, storage and the UI can all
// share it.

import { addDays, format } from 'date-fns';

import type { HabitDefinition } from '@/types/wellbeing';

// How far back the daily review will catch up habits — a week. A day missed
// longer ago than this ages out and stops being asked.
const CATCHUP_WINDOW_DAYS = 7;

// Parse a yyyy-MM-dd string as a local calendar date at midday, so a DST shift
// can never tip it into an adjacent day.
function parseDay(day: string): Date {
  return new Date(`${day}T12:00:00`);
}

// The days the daily review should ask the habit questions for: today, plus any
// day in the trailing 7-day window [today−6, today] that has no habit answers
// on record yet. Returned ascending, with today always last and always present.
//
// Deliberately independent of when the review last ran: a day whose habits were
// never answered keeps resurfacing until it ages out of the window. That is
// what makes it catch up missed days, and it is self-healing — a catch-up day
// left untouched is never saved, so it simply stops being asked once it falls
// outside the 7 days.
export function habitCatchupDates(
  today: string,
  storedDays: Array<{ date: string; habits: { habitId: string }[] }>
): string[] {
  const answered = new Set(storedDays.filter(d => d.habits.length > 0).map(d => d.date));
  const start = parseDay(today);
  const dates: string[] = [];
  for (let i = CATCHUP_WINDOW_DAYS - 1; i >= 0; i--) {
    const date = format(addDays(start, -i), 'yyyy-MM-dd');
    if (date === today || !answered.has(date)) dates.push(date);
  }
  return dates;
}

// A day's header in the catch-up list: 'Today', 'Yesterday', else 'EEE d MMM'.
export function habitDayHeader(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === format(addDays(parseDay(today), -1), 'yyyy-MM-dd')) return 'Yesterday';
  return format(parseDay(date), 'EEE d MMM');
}

export const HABITS: HabitDefinition[] = [
  { id: 'meditate', label: 'Meditate', question: 'Did you meditate today?' },
  { id: 'morning-pages', label: 'Morning pages', question: 'Did you do your morning pages today?' },
];

export function getHabit(id: string): HabitDefinition | undefined {
  return HABITS.find(h => h.id === id);
}

export function isValidHabitId(id: string): boolean {
  return HABITS.some(h => h.id === id);
}

export function habitLabel(id: string): string {
  return getHabit(id)?.label ?? id;
}
