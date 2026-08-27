import {
  addDaysStr,
  weekDates,
  formatDuration,
  shortDayLabel,
  boardWhenLabel,
  weekRangeLabel,
  dayFilterChips,
  rolledBadgeLabel,
  rolledDetailLabel,
} from '@/lib/board-format';

describe('board-format', () => {
  describe('addDaysStr / weekDates', () => {
    it('adds days without timezone drift', () => {
      expect(addDaysStr('2026-08-17', 6)).toBe('2026-08-23');
      expect(addDaysStr('2026-08-31', 1)).toBe('2026-09-01');
    });

    it('returns Mon..Sun for a week', () => {
      expect(weekDates('2026-08-17')).toEqual([
        '2026-08-17',
        '2026-08-18',
        '2026-08-19',
        '2026-08-20',
        '2026-08-21',
        '2026-08-22',
        '2026-08-23',
      ]);
    });
  });

  describe('formatDuration', () => {
    it('formats minutes, hours and mixed', () => {
      expect(formatDuration(45)).toBe('45m');
      expect(formatDuration(60)).toBe('1h');
      expect(formatDuration(90)).toBe('1h 30m');
    });
  });

  describe('shortDayLabel', () => {
    it('labels a date with and without month', () => {
      expect(shortDayLabel('2026-08-19')).toBe('Wed 19');
      expect(shortDayLabel('2026-08-19', true)).toBe('Wed 19 Aug');
    });
  });

  describe('boardWhenLabel', () => {
    it('shows date, time and duration when present', () => {
      expect(
        boardWhenLabel({ date: '2026-08-18', start: '09:00', durationMinutes: 45 })
      ).toBe('Tue 18 · 09:00 · 45m');
    });

    it('shows date alone when there is no time', () => {
      expect(boardWhenLabel({ date: '2026-08-18' })).toBe('Tue 18');
    });

    it('returns null when there is no date', () => {
      expect(boardWhenLabel({})).toBeNull();
    });
  });

  describe('weekRangeLabel', () => {
    it('collapses the month within one month', () => {
      expect(weekRangeLabel('2026-08-17')).toBe('Mon 17 – Sun 23 Aug');
    });

    it('shows both months when the week spans a boundary', () => {
      expect(weekRangeLabel('2026-07-27')).toBe('Mon 27 Jul – Sun 2 Aug');
    });
  });

  describe('rolledBadgeLabel', () => {
    it('names the original weekday', () => {
      // Originally Mon 24 Aug, now on Wed 26 Aug.
      expect(rolledBadgeLabel({ date: '2026-08-26', originallyPlannedFor: '2026-08-24' })).toBe('from Mon');
    });

    it('appends the roll count from the second roll on', () => {
      expect(
        rolledBadgeLabel({ date: '2026-08-26', originallyPlannedFor: '2026-08-24', rolls: 3 })
      ).toBe('from Mon · ×3');
    });

    it('returns null when the card was not rolled', () => {
      expect(rolledBadgeLabel({ date: '2026-08-26' })).toBeNull();
      expect(rolledBadgeLabel({ date: '2026-08-26', originallyPlannedFor: '2026-08-26' })).toBeNull();
    });
  });

  describe('rolledDetailLabel', () => {
    it('spells out the original date and the roll count', () => {
      expect(
        rolledDetailLabel({ date: '2026-08-26', originallyPlannedFor: '2026-08-24', rolls: 2 })
      ).toBe('Originally planned for Mon 24 Aug · rolled 2 times');
    });

    it('uses "once" for a single roll and null when not rolled', () => {
      expect(rolledDetailLabel({ date: '2026-08-26', originallyPlannedFor: '2026-08-24' })).toBe(
        'Originally planned for Mon 24 Aug · rolled once'
      );
      expect(rolledDetailLabel({ date: '2026-08-26' })).toBeNull();
    });
  });

  describe('dayFilterChips', () => {
    it('labels each day of the week', () => {
      const chips = dayFilterChips('2026-08-17');
      expect(chips.map(c => c.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
      expect(chips.map(c => c.dayOfMonth)).toEqual([17, 18, 19, 20, 21, 22, 23]);
      expect(chips[0].date).toBe('2026-08-17');
    });
  });
});
