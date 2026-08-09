/**
 * @jest-environment node
 *
 * The two importers' parsers. Every case here is taken verbatim from the real
 * sources — the training-log spreadsheet and the planned-session events on the
 * personal calendar — because both are hand-written and the awkward rows are
 * the whole point.
 */
import {
  isHoldName,
  isUnilateralName,
  parseLoad,
  parsePlannedTitle,
  parseSheetDate,
  parseSheetMarkdown,
  parseVolume,
} from '@/lib/exercise-parse';
import { exerciseKey } from '@/lib/exercise-progression';

describe('parseVolume', () => {
  it('reads sets and reps', () => {
    expect(parseVolume('3*8')).toEqual({ sets: 3, reps: 8 });
    expect(parseVolume('2*12')).toEqual({ sets: 2, reps: 12 });
    expect(parseVolume('3* 30 secs each side')).toEqual({
      sets: 3,
      holdSeconds: 30,
      perSide: true,
    });
  });

  it('treats a timed set as a hold, not as reps', () => {
    expect(parseVolume('3*20 secs')).toEqual({ sets: 3, holdSeconds: 20 });
    expect(parseVolume('1*60 secs')).toEqual({ sets: 1, holdSeconds: 60 });
    // Contrast: no unit word means the second number really is reps.
    expect(parseVolume('3*22')).toEqual({ sets: 3, reps: 22 });
  });

  it('flags per-side work without doubling the numbers', () => {
    expect(parseVolume('3*8 each side')).toEqual({ sets: 3, reps: 8, perSide: true });
    expect(parseVolume('3*10 each side')).toEqual({ sets: 3, reps: 10, perSide: true });
  });

  it('reads distances and durations from cardio rows', () => {
    expect(parseVolume('2km')).toEqual({ distanceKm: 2 });
    expect(parseVolume('10 mins, ')).toEqual({ durationMinutes: 10 });
    expect(parseVolume('15 mins')).toEqual({ durationMinutes: 15 });
  });

  it('takes the duration but not the speed from a treadmill row', () => {
    // "9.5" is the treadmill speed. Reading it as a distance would be wrong.
    expect(parseVolume('9.5 for 10 mins on treadmill')).toEqual({ durationMinutes: 10 });
  });

  it('returns nothing for an empty cell', () => {
    expect(parseVolume('')).toEqual({});
    expect(parseVolume(undefined)).toEqual({});
  });
});

describe('parseLoad', () => {
  it('reads a weight in kg', () => {
    expect(parseLoad('27kg')).toEqual({ weightKg: 27 });
    expect(parseLoad('34.3kg')).toEqual({ weightKg: 34.3 });
    expect(parseLoad('2.5kg')).toEqual({ weightKg: 2.5 });
  });

  it('takes the total from a per-side note', () => {
    expect(parseLoad('30kg (15 each side)')).toEqual({ weightKg: 30 });
  });

  it('recognises bodyweight', () => {
    expect(parseLoad('Bodyweight')).toEqual({ bodyweight: true });
  });

  it('reads nothing from an unusable cell', () => {
    expect(parseLoad('NA')).toEqual({});
    expect(parseLoad('')).toEqual({});
    // A bare number is ambiguous — it was a treadmill speed at least once —
    // so it must not become a weight.
    expect(parseLoad('9.2')).toEqual({});
  });
});

describe('parseSheetDate', () => {
  it('reads day-first dates, with or without a year', () => {
    expect(parseSheetDate('11/07', 2026)).toEqual({ date: '2026-07-11' });
    expect(parseSheetDate('2/8/26', 2026)).toEqual({ date: '2026-08-02' });
    expect(parseSheetDate('29/07/26', 2026)).toEqual({ date: '2026-07-29' });
    expect(parseSheetDate('28/07/2026', 2026)).toEqual({ date: '2026-07-28' });
  });

  it('separates a trailing session label from the date', () => {
    expect(parseSheetDate('28/07/2026 Home workout', 2026)).toEqual({
      date: '2026-07-28',
      label: 'Home workout',
    });
  });

  it('rejects a cell that is not a date', () => {
    expect(parseSheetDate('Converging chest press machine', 2026)).toBeNull();
    expect(parseSheetDate('', 2026)).toBeNull();
    expect(parseSheetDate('45/13', 2026)).toBeNull();
  });
});

describe('parseSheetMarkdown', () => {
  // A faithful slice of the real sheet, including the header and alignment rows.
  const SHEET = `|  |  |  |  |  |
| :-: | :-: | :-: | :-: | :-: |
| 11/07 | Converging shoulder press machine | 3\\*8 | 27kg | Could have done 1-2 more per set at most |
|  | Run | 9.5 for 10 mins on treadmill |  | Felt fine |
|  | Overhead db tricep extension | 3\\*10 | 10kg | Back hurt, but felt light |
| 28/07/2026 Home workout | Neutral grip pullups | 3\\*5 |  | The right amount, had 1 or 2 left |
|  | Side plank | 3\\*30 secs each side |  |  |`;

  it('groups rows into sessions, carrying the date down blank cells', () => {
    const sessions = parseSheetMarkdown(SHEET, 2026);

    expect(sessions).toHaveLength(2);
    expect(sessions[0].date).toBe('2026-07-11');
    expect(sessions[0].exercises).toHaveLength(3);
    expect(sessions[1].date).toBe('2026-07-28');
    expect(sessions[1].label).toBe('Home workout');
    expect(sessions[1].exercises).toHaveLength(2);
  });

  it('keeps the raw text beside the parsed figures', () => {
    const [first] = parseSheetMarkdown(SHEET, 2026);
    const press = first.exercises[0];

    expect(press.name).toBe('Converging shoulder press machine');
    expect(press.volumeText).toBe('3*8');
    expect(press.loadText).toBe('27kg');
    expect(press.sets).toBe(3);
    expect(press.reps).toBe(8);
    expect(press.weightKg).toBe(27);
    expect(press.notes).toMatch(/1-2 more per set/);
  });

  it('handles a cardio row with no load', () => {
    const run = parseSheetMarkdown(SHEET, 2026)[0].exercises[1];
    expect(run.name).toBe('Run');
    expect(run.durationMinutes).toBe(10);
    expect(run.weightKg).toBeUndefined();
    expect(run.volumeText).toBe('9.5 for 10 mins on treadmill');
  });

  it('ignores the header and alignment rows', () => {
    const sessions = parseSheetMarkdown(SHEET, 2026);
    const names = sessions.flatMap(s => s.exercises.map(e => e.name));
    expect(names).not.toContain('');
    expect(names).toHaveLength(5);
  });
});

describe('parsePlannedTitle', () => {
  it('reads a mixed session as strength + cardio, not as a run', () => {
    // The word "Run" appears, but this is a push session with a run bolted on.
    expect(parsePlannedTitle('🏋️ Push (shoulders) + Run (2 km)')).toEqual({
      title: 'Push (shoulders) + Run (2 km)',
      components: ['Push (shoulders)', 'Run (2 km)'],
      targetDistanceKm: 2,
      type: 'strength + cardio',
    });
  });

  it('reads a plain strength session', () => {
    expect(parsePlannedTitle('🏋️ Pull (back & arms) + core')).toEqual({
      title: 'Pull (back & arms) + core',
      components: ['Pull (back & arms)', 'core'],
      type: 'strength',
    });
  });

  it('reads a run session, and counts a core finisher as strength too', () => {
    const parsed = parsePlannedTitle('🏃 Run (3.5 km) + core');
    expect(parsed?.type).toBe('strength + cardio');
    expect(parsed?.targetDistanceKm).toBe(3.5);
    expect(parsed?.components).toEqual(['Run (3.5 km)', 'core']);
  });

  it('reads a pure run as a run', () => {
    expect(parsePlannedTitle('🏃 Run')?.type).toBe('run');
    expect(parsePlannedTitle('🏃 Parkrun')?.type).toBe('run');
  });

  it('rejects an errand wearing the same emoji', () => {
    // The real trap: this sits on the calendar alongside the training plan.
    expect(parsePlannedTitle('🏋️ Change gym membership')).toBeNull();
  });

  it('rejects titles with no exercise emoji', () => {
    expect(parsePlannedTitle('Water Plants')).toBeNull();
    expect(parsePlannedTitle('🌿 Water Plants')).toBeNull();
    expect(parsePlannedTitle('💰 Transfer salary')).toBeNull();
  });
});

describe('isHoldName', () => {
  it('recognises the timed holds', () => {
    expect(isHoldName('Side plank')).toBe(true);
    expect(isHoldName('Front plank')).toBe(true);
    expect(isHoldName('Dead hang')).toBe(true);
    expect(isHoldName('Wall sit')).toBe(true);
    expect(isHoldName('L-sit')).toBe(true);
    expect(isHoldName('Chin-up hold')).toBe(true);
  });

  it('does not read rep-based work as a hold', () => {
    // The trap: slow bodyweight core work that is NOT isometric.
    expect(isHoldName('Dead bug')).toBe(false);
    expect(isHoldName('Bird dog')).toBe(false);
    expect(isHoldName('Bench press')).toBe(false);
    expect(isHoldName('Treadmill run')).toBe(false);
    expect(isHoldName(undefined)).toBe(false);
    // Rep-based movements FROM a hold position are reps, not holds.
    expect(isHoldName('High plank shoulder taps')).toBe(false);
    expect(isHoldName('Plank jacks')).toBe(false);
    expect(isHoldName('Mountain climbers')).toBe(false);
    // Dynamic raises match \bhang\b but are rep-based, not timed holds.
    expect(isHoldName('Hanging knee raise')).toBe(false);
    expect(isHoldName('Hanging leg raise')).toBe(false);
  });
});

describe('isUnilateralName', () => {
  it('recognises single-side movements', () => {
    expect(isUnilateralName('Side plank')).toBe(true);
    expect(isUnilateralName('Shoulder taps')).toBe(true);
    expect(isUnilateralName('Single-arm row')).toBe(true);
    expect(isUnilateralName('Single leg calf raise')).toBe(true);
    expect(isUnilateralName('Pallof press')).toBe(true);
    expect(isUnilateralName('Paloff press with cable')).toBe(true);
    expect(isUnilateralName('Bulgarian split squat')).toBe(true);
    expect(isUnilateralName('Walking lunge')).toBe(true);
    expect(isUnilateralName('Step-up')).toBe(true);
  });

  it('does not over-match two-sided lifts', () => {
    expect(isUnilateralName('Back squat')).toBe(false);
    expect(isUnilateralName('Bench press')).toBe(false);
    expect(isUnilateralName('Front plank')).toBe(false);
    expect(isUnilateralName('Deadlift')).toBe(false);
    expect(isUnilateralName('Treadmill run')).toBe(false);
    expect(isUnilateralName(undefined)).toBe(false);
  });
});

describe('exerciseKey', () => {
  it('merges spellings that differ only in case or punctuation', () => {
    expect(exerciseKey('Db lateral raise')).toBe(exerciseKey('DB lateral raise'));
  });

  it('merges only the equivalences that have been confirmed', () => {
    // Both Paloff spellings collapse onto the corrected "Pallof press".
    expect(exerciseKey('Paloff press with cable')).toBe(exerciseKey('Paloff press'));
    // "Treadmill" is shorthand for a treadmill run.
    expect(exerciseKey('Treadmill')).toBe(exerciseKey('Treadmill run'));
    // Both pulldown spellings are the lat pulldown.
    expect(exerciseKey('Pulldown')).toBe(exerciseKey('Cable lat pulldowns'));
    // Two names for the same machine — the rear delt movement is the reverse pec
    // deck run backwards.
    expect(exerciseKey('Rear delt machine')).toBe(exerciseKey('Reverse pec deck machine'));
  });

  it('keeps equipment variants apart, because equipment IS the distinction', () => {
    // Dumbbell and cable versions load the movement differently — 7kg of
    // dumbbell lateral raise is not 2.5kg on the cable.
    expect(exerciseKey('Db lateral raise')).not.toBe(exerciseKey('Cable lateral raise'));
    // A treadmill run is not an outdoor run — the outdoor effort is harder.
    expect(exerciseKey('Treadmill run')).not.toBe(exerciseKey('Run'));
  });
});
