/**
 * @jest-environment node
 *
 * Warm-up / cool-down guidance woven into the checklist: a general warm-up at
 * the top, ramp-up sets above the first movement of each pair, a cool-down at
 * the end, football's own pair of cues, and nothing extra on a home fixed day.
 */
import { sessionCues, type CueRow } from '@/lib/exercise-cues';

const r = (over: Partial<CueRow> & { name: string }): CueRow => ({ key: over.name, ...over });

describe('sessionCues', () => {
  it('lays out a Tuesday: general warm-up, ramp-ups above each pair lead, cool-down after the run', () => {
    const cues = sessionCues(
      [
        r({ name: 'Leg press', weightKg: 87.5, pair: { index: 1, slot: 'a' } }),
        r({ name: 'Seated leg curl', weightKg: 47, pair: { index: 1, slot: 'b' } }),
        r({ name: 'Neutral-grip pull-up', pair: { index: 2, slot: 'a' } }),
        r({ name: "Captain's chair knee raise", pair: { index: 2, slot: 'b' } }),
        r({ name: 'Calf press' }),
        r({ name: 'Treadmill run', kind: 'cardio' }),
      ],
      {}
    );
    expect(cues.intro).toHaveLength(1);
    expect(cues.intro[0].text).toMatch(/bike or cross-trainer/);
    expect(Object.keys(cues.before).sort()).toEqual(['Leg press', 'Neutral-grip pull-up']);
    expect(cues.before['Leg press'][0].text).toBe('10 reps at ~45kg, then 5 at ~65kg, then into your working sets.');
    expect(cues.before['Neutral-grip pull-up'][0].text).toMatch(/scapular pulls/);
    expect(cues.outro).toEqual([expect.objectContaining({ kind: 'cooldown', text: expect.stringMatching(/^Walk 3–5 min/) })]);
  });

  it('puts the ramp-up on the a-half even when the b-half arrives first', () => {
    const cues = sessionCues([
      r({ name: 'Row', weightKg: 20, pair: { index: 1, slot: 'b' } }),
      r({ name: 'Press', weightKg: 20, pair: { index: 1, slot: 'a' } }),
    ]);
    expect(Object.keys(cues.before)).toEqual(['Press']);
  });

  it('warms up for a parkrun that opens the session instead of a general warm-up, and cools down after the lifts', () => {
    const cues = sessionCues([
      r({ name: 'Parkrun', kind: 'cardio' }),
      r({ name: 'DB Romanian deadlift', weightKg: 20, pair: { index: 1, slot: 'a' } }),
      r({ name: 'DB lateral raise', weightKg: 6, pair: { index: 1, slot: 'b' } }),
    ]);
    expect(cues.intro).toEqual([]);
    expect(cues.before['Parkrun'][0].text).toMatch(/^Before the start/);
    expect(cues.outro[0].text).toMatch(/^5 min easy walk/);
  });

  it('adds only football’s own cues on a fixed home day', () => {
    const cues = sessionCues(
      [r({ name: 'Cat-cow' }), r({ name: 'Side plank', kind: 'hold' }), r({ name: '5-a-side football', kind: 'cardio' })],
      { venue: 'home', fixed: true }
    );
    expect(cues.intro).toEqual([]);
    expect(cues.outro).toEqual([]);
    expect(cues.before['5-a-side football'][0].text).toMatch(/^Before kick-off/);
    expect(cues.after['5-a-side football'][0].kind).toBe('cooldown');
    expect(Object.keys(cues.before)).toEqual(['5-a-side football']);
  });

  it('gives a plain fixed home day nothing', () => {
    const cues = sessionCues([r({ name: 'Cat-cow' })], { venue: 'home', fixed: true });
    expect(cues).toEqual({ intro: [], before: {}, after: {}, outro: [] });
  });

  it('ramps up once before the first lift on a day without pairs, with one easy set for a light lift', () => {
    const cues = sessionCues([r({ name: 'Treadmill run', kind: 'cardio' }), r({ name: 'DB lateral raise', weightKg: 3 })]);
    expect(Object.keys(cues.before)).toEqual(['DB lateral raise']);
    expect(cues.before['DB lateral raise'][0].text).toMatch(/^1 easy set of 10/);
  });

  it('is empty with no rows', () => {
    expect(sessionCues([])).toEqual({ intro: [], before: {}, after: {}, outro: [] });
  });
});
