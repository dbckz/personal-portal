/**
 * @jest-environment node
 *
 * The "Full body (3-day)" routine data (v2) and the retained rehab block. The
 * behaviours worth pinning: each gym day title parses so the programmer activates
 * push, pull AND legs (a plain "Full body" would activate nothing) and the home
 * title activates core; the week has the right day per weekday; every antagonist
 * pair references the day's own anchors/staples and every alternative names a real
 * exercise; and the rehab list still keeps the original ids at the McGill dose.
 */
import {
  FULL_BODY_3DAY_NAME,
  FULL_BODY_3DAY_ROUTINE,
  MCGILL_REHAB_EXERCISES,
} from '@/lib/full-body-routine';
import { parsePlannedTitle } from '@/lib/exercise-parse';
import { activeGroups } from '@/lib/exercise-targets';

// Parse a routine title the way the materialiser does (a benign emoji prefix,
// then classification from the body) and return the groups its components
// activate — the same signal the programmer uses.
function groupsFor(title: string): string[] {
  const parsed = parsePlannedTitle(`🏋️ ${title}`);
  if (!parsed) return [];
  return activeGroups([...parsed.components, title]);
}

describe('v2 titles activate the right groups', () => {
  for (const title of [
    'Full body A (push + pull + legs) + Treadmill run',
    'Full body B (push + pull + legs) + Treadmill run',
    'Parkrun + Full body C (push + pull + legs)',
  ]) {
    it(`${title} → push, pull, legs, run`, () => {
      expect(groupsFor(title)).toEqual(expect.arrayContaining(['push', 'pull', 'legs', 'run']));
    });
  }

  it('the gym titles parse as strength + cardio', () => {
    expect(parsePlannedTitle('🏋️ Full body A (push + pull + legs) + Treadmill run')?.type).toBe(
      'strength + cardio'
    );
    expect(parsePlannedTitle('🏋️ Parkrun + Full body C (push + pull + legs)')?.type).toBe(
      'strength + cardio'
    );
  });

  it('the home title activates core', () => {
    expect(groupsFor('Home core + mobility')).toContain('core');
  });
});

describe('the seeded full-body routine (v2)', () => {
  const byDay = (n: number) => FULL_BODY_3DAY_ROUTINE.find(d => d.dayOfWeek === n)!;

  it('is named and covers all seven weekdays exactly once, with no rest day', () => {
    expect(FULL_BODY_3DAY_NAME).toBe('Full body (3-day)');
    expect(FULL_BODY_3DAY_ROUTINE).toHaveLength(7);
    expect(new Set(FULL_BODY_3DAY_ROUTINE.map(d => d.dayOfWeek)).size).toBe(7);
    // v2 has no rest day — Sunday is a home recovery block.
    expect(FULL_BODY_3DAY_ROUTINE.some(d => d.rest)).toBe(false);
  });

  it('home Mon/Wed/Fri/Sun, gym A Tue, gym B Thu, parkrun+C Sat', () => {
    for (const n of [1, 3, 5, 0]) {
      const day = byDay(n);
      expect(day.title).toBe('Home core + mobility');
      expect(day.venue).toBe('home');
      expect(day.fixed).toBe(true);
    }
    expect(byDay(2).title).toBe('Full body A (push + pull + legs) + Treadmill run');
    expect(byDay(4).title).toBe('Full body B (push + pull + legs) + Treadmill run');
    expect(byDay(6).title).toBe('Parkrun + Full body C (push + pull + legs)');
  });

  it('runs after the lifts on Tue/Thu, parkrun first on Sat', () => {
    expect(byDay(2).cardioAfter).toBe(true);
    expect(byDay(4).cardioAfter).toBe(true);
    // Sat parkrun leads its day, so cardioAfter is not set.
    expect(byDay(6).cardioAfter).toBeUndefined();
  });

  it('the home days carry the 15-minute block with fixed doses', () => {
    const home = byDay(1);
    expect(home.staples).toEqual([
      'Cat-cow',
      'Couch stretch',
      '90/90 hip switch',
      'McGill curl-up',
      'Side plank',
      'Bird dog',
      'Glute bridge',
      'Standing pelvic tilt',
      '5-a-side football', // Monday's evening extra
    ]);
    expect(home.prescriptions?.['Couch stretch']).toBe('90 s per side');
    expect(home.prescriptions?.['McGill curl-up']).toMatch(/3-2-1/);
    // Wednesday is the same block without the football extra.
    expect(byDay(3).staples).toHaveLength(8);
    // Sunday's note flags it as recovery, not training.
    expect(byDay(0).note).toMatch(/walk|yoga|recovery/i);
  });

  it('the gym days are four antagonist pairs plus calves', () => {
    expect(byDay(2).pairs).toHaveLength(4);
    expect(byDay(2).staples).toEqual(['Calf press']);
    expect(byDay(4).pairs).toHaveLength(4);
    expect(byDay(4).staples).toEqual(['Seated calf raise']);
    expect(byDay(6).pairs).toHaveLength(4);
  });

  it('every pair references the day’s own anchors/staples', () => {
    for (const day of FULL_BODY_3DAY_ROUTINE) {
      if (!day.pairs?.length) continue;
      const known = new Set([...day.anchors, ...(day.staples ?? [])]);
      for (const [a, b] of day.pairs) {
        expect(known.has(a)).toBe(true);
        expect(known.has(b)).toBe(true);
      }
    }
  });

  it('every alternative key names one of the day’s exercises', () => {
    for (const day of FULL_BODY_3DAY_ROUTINE) {
      if (!day.alternatives) continue;
      const known = new Set([...day.anchors, ...(day.staples ?? [])]);
      for (const [name, options] of Object.entries(day.alternatives)) {
        expect(known.has(name)).toBe(true);
        expect(options.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('the retained rehab block', () => {
  it('keeps the original nine ids in order', () => {
    const ids = MCGILL_REHAB_EXERCISES.map(e => e.id);
    expect(ids).toEqual([
      'cat-cow',
      'couch-stretch',
      '90-90-hip-switch',
      'mcgill-curl-up',
      'side-plank',
      'bird-dog',
      'glute-bridge',
      'dead-bug',
      'standing-pelvic-tilt',
    ]);
  });

  it('doses side plank and bird dog to the McGill 5-3-1 standard', () => {
    const dose = (id: string) => MCGILL_REHAB_EXERCISES.find(e => e.id === id)!.prescription;
    expect(dose('side-plank')).toMatch(/5-3-1/);
    expect(dose('bird-dog')).toMatch(/5-3-1/);
    expect(dose('mcgill-curl-up')).toMatch(/5-3-1/);
  });
});
