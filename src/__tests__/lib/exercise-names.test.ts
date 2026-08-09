/**
 * @jest-environment node
 */
import { EXERCISE_NAME_ALIASES, normalizeExerciseName } from '@/lib/exercise-names';

describe('normalizeExerciseName', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeExerciseName('  Leg   press  ')).toBe('Leg press');
    expect(normalizeExerciseName('Dead\thang')).toBe('Dead hang');
  });

  it('capitalises the first letter, leaving other words as typed', () => {
    expect(normalizeExerciseName('leg press')).toBe('Leg press');
    expect(normalizeExerciseName('side plank')).toBe('Side plank');
  });

  it('returns empty for blank input', () => {
    expect(normalizeExerciseName('')).toBe('');
    expect(normalizeExerciseName('   ')).toBe('');
  });

  it('uppercases standalone db/kb tokens anywhere in the name', () => {
    expect(normalizeExerciseName('Db lateral raise')).toBe('DB lateral raise');
    expect(normalizeExerciseName('db lateral raise')).toBe('DB lateral raise');
    expect(normalizeExerciseName('Seated db shoulder press')).toBe('Seated DB shoulder press');
    expect(normalizeExerciseName('Overhead db tricep extension')).toBe(
      'Overhead DB tricep extension'
    );
    expect(normalizeExerciseName('kb swing')).toBe('KB swing');
  });

  it('only uppercases db/kb as whole words, not inside other words', () => {
    // No word "db"/"kb" here, so nothing to change.
    expect(normalizeExerciseName('Dumbbell press')).toBe('Dumbbell press');
    expect(normalizeExerciseName('Deadbug')).toBe('Deadbug');
  });

  it('applies every alias in the exported map', () => {
    for (const [from, to] of Object.entries(EXERCISE_NAME_ALIASES)) {
      expect(normalizeExerciseName(from)).toBe(to);
    }
  });

  it('merges the Paloff spellings onto the corrected Pallof press', () => {
    expect(normalizeExerciseName('Paloff press')).toBe('Pallof press');
    expect(normalizeExerciseName('Paloff press with cable')).toBe('Pallof press');
  });

  it('merges treadmill and both pulldown spellings', () => {
    expect(normalizeExerciseName('Treadmill')).toBe('Treadmill run');
    expect(normalizeExerciseName('Pulldown')).toBe('Lat pulldown');
    expect(normalizeExerciseName('Cable lat pulldowns')).toBe('Lat pulldown');
  });

  it('drops redundant machine suffixes', () => {
    expect(normalizeExerciseName('Converging chest press machine')).toBe('Converging chest press');
    expect(normalizeExerciseName('Leg extension machines')).toBe('Leg extension');
    expect(normalizeExerciseName('Pectoral fly machine')).toBe('Pec fly');
  });

  it('merges the rear delt machine into the reverse pec deck', () => {
    expect(normalizeExerciseName('Rear delt machine')).toBe('Reverse pec deck');
    expect(normalizeExerciseName('Reverse pec deck machine')).toBe('Reverse pec deck');
  });

  it('merges a bare knee raise into the hanging knee raise', () => {
    // History logged as "Knee raise" groups with a prescribed "Hanging knee raise".
    expect(normalizeExerciseName('Knee raise')).toBe('Hanging knee raise');
    expect(normalizeExerciseName('Hanging knee raise')).toBe('Hanging knee raise');
  });

  it('singularises where the plural is not the common name', () => {
    expect(normalizeExerciseName('Cable rows')).toBe('Cable row');
    expect(normalizeExerciseName('Reverse lunges')).toBe('Reverse lunge');
    expect(normalizeExerciseName('Neutral grip pullups')).toBe('Neutral-grip pull-up');
  });

  it('keeps naturally-plural names as-is (only casing db)', () => {
    expect(normalizeExerciseName('Db shrugs')).toBe('DB shrugs');
    expect(normalizeExerciseName('High plank shoulder taps')).toBe('High plank shoulder taps');
  });

  it('merges the plural knee-raise spelling the live log uses', () => {
    expect(normalizeExerciseName('Knee raises')).toBe('Hanging knee raise');
  });

  it('keeps distinct exercises distinct', () => {
    expect(normalizeExerciseName('Run')).toBe('Outdoor run');
    expect(normalizeExerciseName('Run')).not.toBe(normalizeExerciseName('Treadmill'));
    expect(normalizeExerciseName('Cable lateral raise')).not.toBe(
      normalizeExerciseName('DB lateral raise')
    );
  });

  it('is idempotent: normalize(normalize(x)) === normalize(x)', () => {
    const inputs = [
      // The full live inventory of raw spellings.
      'Cable bicep curls', 'Cable crossover', 'Cable high row', 'Cable lat pulldowns',
      'Cable lateral raise', 'Cable pushdown', 'Cable rows', 'Cable y raise',
      'Converging chest press machine', 'Converging shoulder press machine', 'DB Bicep curl',
      'DB lateral raise', 'Db lateral raise', 'Db shrugs', 'Dead bug', 'Dead hang',
      'Flat db press', 'Glute bridge', 'High plank shoulder taps', 'Inclined db press',
      'Knee raises', 'Leg extension machines', 'Leg press', 'Neutral grip pullups',
      'Overhead db tricep extension', 'Paloff press', 'Paloff press with cable',
      'Pectoral fly machine', 'Plank', 'Pulldown', 'Rear delt machine', 'Reverse lunges',
      'Reverse pec deck machine', 'Run', 'Seated db shoulder press', 'Seated leg curl machines',
      'Side plank', 'Standing calf raise (no step)', 'Treadmill', 'Treadmill run',
      // Plus every canonical output, which must be a fixed point.
      ...Object.values(EXERCISE_NAME_ALIASES),
    ];
    for (const input of inputs) {
      const once = normalizeExerciseName(input);
      expect(normalizeExerciseName(once)).toBe(once);
    }
  });
});
