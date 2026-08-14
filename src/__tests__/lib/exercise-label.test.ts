/**
 * Deriving a completed session's title from what was actually done. The bias is
 * conservative: rename a cardio piece only on a recorded swap, drop only a block
 * that was genuinely skipped, and keep the planned wording whenever the mapping
 * is unclear.
 */
import { deriveCompletedLabel } from '@/lib/exercise-label';
import type { ExerciseEntry } from '@/types/life';

let nextId = 0;
function ex(name: string, extra: Partial<ExerciseEntry> = {}): ExerciseEntry {
  return { id: `e${nextId++}`, name, done: true, ...extra };
}

beforeEach(() => {
  nextId = 0;
});

describe('deriveCompletedLabel', () => {
  it('renames a substituted cardio component to what was actually done', () => {
    // The motivating case: a planned Parkrun swapped for a treadmill run, with
    // the core work done as planned.
    const result = deriveCompletedLabel(
      ['Parkrun', 'core'],
      'Parkrun + core',
      [
        ex('Treadmill run', { substitutedFor: 'Outdoor run', durationMinutes: 20 }),
        ex('Dead bug'),
        ex('Side plank'),
        ex('Plank'),
        ex('High plank shoulder taps'),
      ]
    );

    expect(result.components).toEqual(['Treadmill run', 'core']);
    expect(result.label).toBe('Treadmill run + core');
  });

  it('drops a component whose exercises were all skipped', () => {
    // The core block was ticked; the planned run was never done.
    const result = deriveCompletedLabel(
      ['Parkrun', 'core'],
      'Parkrun + core',
      [ex('Dead bug'), ex('Side plank')]
    );

    expect(result.components).toEqual(['core']);
    expect(result.label).toBe('core');
  });

  it('leaves the label unchanged when everything went to plan', () => {
    const result = deriveCompletedLabel(
      ['Parkrun', 'core'],
      'Parkrun + core',
      [ex('Parkrun'), ex('Dead bug'), ex('Plank')]
    );

    expect(result.components).toEqual(['Parkrun', 'core']);
    expect(result.label).toBe('Parkrun + core');
  });

  it('keeps a same-kind run (no swap) and its planned annotations', () => {
    // An outdoor run logged for a planned run carries no substitutedFor, so the
    // "(2 km)" target wording is preserved rather than overwritten.
    const result = deriveCompletedLabel(
      ['Run (2 km)', 'core'],
      'Run (2 km) + core',
      [ex('Outdoor run', { distanceKm: 2 }), ex('Plank')]
    );

    expect(result.components).toEqual(['Run (2 km)', 'core']);
    expect(result.label).toBe('Run (2 km) + core');
  });

  it('keeps a strength block name even when a lift inside it was swapped', () => {
    // A bench press swapped for an incline press is still the Push block.
    const result = deriveCompletedLabel(
      ['Push (shoulders)', 'core'],
      'Push (shoulders) + core',
      [
        ex('Incline press', { substitutedFor: 'Bench press' }),
        ex('Lateral raise'),
        ex('Plank'),
      ]
    );

    expect(result.components).toEqual(['Push (shoulders)', 'core']);
    expect(result.label).toBe('Push (shoulders) + core');
  });

  it('keeps an unmappable component (yoga, climb) rather than guessing', () => {
    const result = deriveCompletedLabel(
      ['Yoga', 'core'],
      'Yoga + core',
      [ex('Plank'), ex('Dead bug')]
    );

    expect(result.components).toEqual(['Yoga', 'core']);
    expect(result.label).toBe('Yoga + core');
  });

  it('treats an unticked session as not diverged and keeps the plan', () => {
    // Freshly started: rows seeded from targets but nothing ticked yet.
    const result = deriveCompletedLabel(
      ['Parkrun', 'core'],
      'Parkrun + core',
      [
        ex('Treadmill run', { done: false, substitutedFor: 'Outdoor run' }),
        ex('Plank', { done: false }),
      ]
    );

    expect(result.components).toEqual(['Parkrun', 'core']);
    expect(result.label).toBe('Parkrun + core');
  });

  it('never blanks the title: keeps the plan when every part dropped', () => {
    // Only off-plan extras were logged; none map back to a planned component.
    const result = deriveCompletedLabel(['Parkrun', 'core'], 'Parkrun + core', [
      ex('Bench press'),
    ]);

    expect(result.components).toEqual(['Parkrun', 'core']);
    expect(result.label).toBe('Parkrun + core');
  });

  it('falls back to joining components when no label was given', () => {
    const result = deriveCompletedLabel(['Push', 'core'], undefined, []);
    expect(result.label).toBe('Push + core');
  });
});
