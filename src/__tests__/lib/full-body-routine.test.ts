/**
 * @jest-environment node
 *
 * The "Full body (3-day)" routine data and the extended rehab block. The
 * behaviours worth pinning: each full-body day title parses so the programmer
 * activates push, pull AND legs (a plain "Full body" would activate nothing),
 * the run/parkrun days classify as runs, the seeded week has the right day per
 * weekday, and the rehab list keeps the original ids while adding the McGill
 * movements.
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

describe('full-body day titles activate push, pull and legs', () => {
  for (const title of [
    'Full body A (push + pull + legs)',
    'Full body B (push + pull + legs)',
    'Full body C (push + pull + legs)',
  ]) {
    it(`${title} → push, pull, legs`, () => {
      const groups = groupsFor(title);
      expect(groups).toEqual(expect.arrayContaining(['push', 'pull', 'legs']));
    });
  }

  it('the run days classify as runs', () => {
    expect(parsePlannedTitle('🏋️ Treadmill run')?.type).toBe('run');
    expect(parsePlannedTitle('🏋️ Parkrun')?.type).toBe('run');
  });
});

describe('the seeded full-body routine', () => {
  const byDay = (n: number) => FULL_BODY_3DAY_ROUTINE.find(d => d.dayOfWeek === n)!;

  it('is named and covers all seven weekdays exactly once', () => {
    expect(FULL_BODY_3DAY_NAME).toBe('Full body (3-day)');
    expect(FULL_BODY_3DAY_ROUTINE).toHaveLength(7);
    expect(new Set(FULL_BODY_3DAY_ROUTINE.map(d => d.dayOfWeek)).size).toBe(7);
  });

  it('lifts on Mon/Wed/Fri, runs Tue/Thu, parkrun Sat, rest Sun', () => {
    expect(byDay(1).title).toBe('Full body A (push + pull + legs)');
    expect(byDay(2).title).toBe('Treadmill run');
    expect(byDay(3).title).toBe('Full body B (push + pull + legs)');
    expect(byDay(4).title).toBe('Treadmill run');
    expect(byDay(5).title).toBe('Full body C (push + pull + legs)');
    expect(byDay(6).title).toBe('Parkrun');
    expect(byDay(0).rest).toBe(true);
  });

  it('carries the §3 anchors and a core staple on each lift day', () => {
    expect(byDay(1).anchors).toEqual([
      'Leg press',
      'Seated leg curl',
      'Incline dumbbell press',
      'Chest-supported dumbbell row',
      'Seated dumbbell shoulder press',
    ]);
    expect(byDay(1).staples).toEqual(['Pallof press', '5-a-side football']);
    expect(byDay(3).anchors).toContain('Dumbbell Romanian deadlift');
    expect(byDay(3).staples).toEqual(['Dead bug']);
    expect(byDay(5).anchors).toContain('Single-leg glute bridge');
    expect(byDay(5).staples).toEqual(['Side plank']);
    // The run days carry no anchors.
    expect(byDay(2).anchors).toEqual([]);
    expect(byDay(6).anchors).toEqual([]);
  });
});

describe('the extended rehab block', () => {
  it('adds the McGill movements while keeping the original six ids', () => {
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
