/**
 * @jest-environment node
 *
 * Parsing a planned session's prescription out of its calendar description:
 * sections, per-exercise schemes (rep and hold ranges, "each side"),
 * parenthetical notes, anchor detection, and the leading session note. Junk and
 * scheme-less lines must be kept, never dropped.
 */
import {
  hasPrescribedExercises,
  parsePrescription,
} from '@/lib/exercise-prescription';

// The real example from Dave's "🏋️ Pull (back & arms) + core" event, verbatim
// (en dashes and all).
const PULL_DESCRIPTION = `Pull B — back width & arms.

Anchors (drive these up, log & beat last week):
- Seated cable row: 3 x 8–12
- Neutral-grip lat pulldown: 3 x 8–12

This week's accessories:
- Reverse pec deck (rear delts): 3 x 15
- Hammer curls: 3 x 10–12
- Incline dumbbell curls: 2 x 10–12
- Cable shrugs: 2 x 15

Core (proper session, ~15–20 min):
- Hanging knee raise: 3 x 10
- Pallof press: 3 x 10 each side
- Side plank: 3 x 30–45 sec each side
- Dead bug: 3 x 8 each side
- Bird dog: 2 x 10 each side`;

describe('parsePrescription — the full Pull example', () => {
  const parsed = parsePrescription(PULL_DESCRIPTION);

  it('reads the leading line as the session note', () => {
    expect(parsed.sessionNote).toBe('Pull B — back width & arms.');
  });

  it('splits into the three named sections in order', () => {
    expect(parsed.sections.map(s => s.title)).toEqual([
      'Anchors',
      "This week's accessories",
      'Core',
    ]);
  });

  it('marks the Anchors section and its exercises as anchors, and carries its note', () => {
    const anchors = parsed.sections[0];
    expect(anchors.isAnchor).toBe(true);
    expect(anchors.note).toBe('drive these up, log & beat last week');
    expect(anchors.exercises.every(e => e.isAnchor)).toBe(true);
    // A non-anchor section leaves the flag off.
    expect(parsed.sections[1].isAnchor).toBeUndefined();
    expect(parsed.sections[1].exercises.every(e => e.isAnchor === undefined)).toBe(true);
  });

  it('parses a rep range with an en dash', () => {
    const row = parsed.sections[0].exercises[0];
    expect(row).toMatchObject({ name: 'Seated cable row', sets: 3, repsMin: 8, repsMax: 12 });
  });

  it('parses a single rep count as a min===max range', () => {
    const pecDeck = parsed.sections[1].exercises[0];
    expect(pecDeck).toMatchObject({ name: 'Reverse pec deck', sets: 3, repsMin: 15, repsMax: 15 });
  });

  it('peels a parenthetical note off the exercise name', () => {
    expect(parsed.sections[1].exercises[0].note).toBe('rear delts');
  });

  it('reads a hold range in seconds and flags per-side', () => {
    const sidePlank = parsed.sections[2].exercises.find(e => e.name === 'Side plank')!;
    expect(sidePlank).toMatchObject({
      sets: 3,
      holdSecondsMin: 30,
      holdSecondsMax: 45,
      perSide: true,
    });
    expect(sidePlank.repsMin).toBeUndefined();
  });

  it('flags "each side" on a rep exercise without making it a hold', () => {
    const pallof = parsed.sections[2].exercises.find(e => e.name === 'Pallof press')!;
    expect(pallof).toMatchObject({ sets: 3, repsMin: 10, repsMax: 10, perSide: true });
    expect(pallof.holdSecondsMin).toBeUndefined();
  });

  it('carries the Core section aside', () => {
    expect(parsed.sections[2].note).toBe('proper session, ~15–20 min');
  });
});

describe('parsePrescription — edge cases', () => {
  it('parses a hyphen range as well as an en dash', () => {
    const parsed = parsePrescription('Work:\n- Bench press: 3 x 8-12');
    expect(parsed.sections[0].exercises[0]).toMatchObject({ repsMin: 8, repsMax: 12 });
  });

  it('reads a "30s" hold written without the word sec', () => {
    const parsed = parsePrescription('Core:\n- Plank: 3 x 45s');
    expect(parsed.sections[0].exercises[0]).toMatchObject({
      sets: 3,
      holdSecondsMin: 45,
      holdSecondsMax: 45,
    });
  });

  it('keeps a scheme-less junk line as a name-only item', () => {
    const parsed = parsePrescription('Warm-up:\n- Just move around and get loose');
    expect(parsed.sections[0].exercises[0]).toEqual({ name: 'Just move around and get loose' });
  });

  it('accepts • and * bullet markers', () => {
    const parsed = parsePrescription('Work:\n• Row: 3 x 8\n* Curl: 3 x 10');
    expect(parsed.sections[0].exercises.map(e => e.name)).toEqual(['Row', 'Curl']);
  });

  it('returns empty sections and no note for a blank description', () => {
    const parsed = parsePrescription(undefined);
    expect(parsed.sections).toEqual([]);
    expect(parsed.sessionNote).toBeUndefined();
    expect(hasPrescribedExercises(parsed.sections)).toBe(false);
  });

  it('lands bullets before any header in a default section', () => {
    const parsed = parsePrescription('- Row: 3 x 8');
    expect(parsed.sections[0].title).toBe('Exercises');
    expect(parsed.sections[0].exercises[0]).toMatchObject({ name: 'Row', sets: 3, repsMin: 8 });
  });

  it('reports whether anything was prescribed', () => {
    expect(hasPrescribedExercises(parsePrescription(PULL_DESCRIPTION).sections)).toBe(true);
  });
});
