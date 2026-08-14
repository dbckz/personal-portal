import { format } from 'date-fns';

import { habitCatchupDates, habitDayHeader } from '@/lib/wellbeing-habits';

const TODAY = '2026-08-14'; // a Friday
// The trailing week [today−6, today]: 08-08 … 08-14.
const WINDOW = [
  '2026-08-08',
  '2026-08-09',
  '2026-08-10',
  '2026-08-11',
  '2026-08-12',
  '2026-08-13',
  '2026-08-14',
];

function answered(date: string) {
  return { date, habits: [{ habitId: 'meditate' }] };
}
function noHabits(date: string) {
  return { date, habits: [] as { habitId: string }[] };
}

describe('habitCatchupDates', () => {
  it('asks only today when every earlier day in the window is answered', () => {
    const stored = WINDOW.slice(0, 6).map(answered);
    expect(habitCatchupDates(TODAY, stored)).toEqual([TODAY]);
  });

  it('asks the whole window when nothing is on record', () => {
    expect(habitCatchupDates(TODAY, [])).toEqual(WINDOW);
  });

  it('always includes today, even when today is already answered', () => {
    const stored = WINDOW.map(answered); // all seven, including today
    expect(habitCatchupDates(TODAY, stored)).toEqual([TODAY]);
  });

  it('treats an absent day and a stored day with no habits alike — both resurface', () => {
    // 08-10 stored but empty (reviewed, no habits answered); 08-12 absent.
    const stored = [
      answered('2026-08-08'),
      answered('2026-08-09'),
      noHabits('2026-08-10'),
      answered('2026-08-11'),
      // 08-12 missing entirely
      answered('2026-08-13'),
    ];
    expect(habitCatchupDates(TODAY, stored)).toEqual(['2026-08-10', '2026-08-12', TODAY]);
  });

  it('includes the far edge of the window but nothing older', () => {
    // 08-08 is exactly today−6 (in); 08-07 is today−7 (out) and never appears
    // even when it is the unanswered one.
    const stored = WINDOW.slice(1, 6).map(answered); // 08-09 … 08-13 answered
    expect(habitCatchupDates(TODAY, stored)).toEqual(['2026-08-08', TODAY]);

    const withOldGap = WINDOW.map(answered); // everything in-window answered
    expect(habitCatchupDates(TODAY, withOldGap)).toEqual([TODAY]);
  });

  it('returns the days ascending with today last', () => {
    const result = habitCatchupDates(TODAY, []);
    expect(result[result.length - 1]).toBe(TODAY);
    expect([...result].sort()).toEqual(result);
  });
});

describe('habitDayHeader', () => {
  it('labels today and yesterday by name', () => {
    expect(habitDayHeader(TODAY, TODAY)).toBe('Today');
    expect(habitDayHeader('2026-08-13', TODAY)).toBe('Yesterday');
  });

  it('labels an earlier day with weekday and date', () => {
    expect(habitDayHeader('2026-08-11', TODAY)).toBe(
      format(new Date('2026-08-11T12:00:00'), 'EEE d MMM')
    );
  });
});
