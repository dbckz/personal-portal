// Canonical exercise names.
//
// Exercise names are typed by hand, standing in a gym, and drift accordingly:
// "Db lateral raise" vs "DB lateral raise", "Paloff press" vs "Paloff press with
// cable", "Treadmill" vs "Treadmill run". This module is the single place that
// decides the one spelling each exercise is stored and grouped under.
//
// The rule has three mechanical steps and then an explicit alias table:
//   1. collapse whitespace and capitalise the first letter;
//   2. uppercase the standalone tokens `db`→`DB` and `kb`→`KB` anywhere;
//   3. apply the ALIAS map for known variants.
//
// There is deliberately NO general "strip the equipment word" rule. Equipment
// usually IS the distinction: per Dave, dumbbell and cable versions of a
// movement are different exercises (7kg of dumbbell lateral raise is not 2.5kg
// on the cable), and an outdoor run is a harder effort than a treadmill one. So
// equivalences are only ever asserted case by case in the table below, never
// inferred.

// Known variants → canonical name. Keys are in POST-STEP-2 form (whitespace
// collapsed, first letter capitalised, db/kb uppercased), which is what
// `normalizeExerciseName` looks them up as. Every canonical value on the right
// must NOT itself appear as a key, so `normalize(normalize(x)) === normalize(x)`.
export const EXERCISE_NAME_ALIASES: Record<string, string> = {
  // Spelling: the exercise is a "Pallof press". Both the bare and the
  // "with cable" forms collapse onto the corrected spelling (it is always a
  // cable movement, so the qualifier is noise).
  'Paloff press': 'Pallof press',
  'Paloff press with cable': 'Pallof press',
  'Pallof press with cable': 'Pallof press',

  // "Treadmill" is shorthand for a treadmill run — merged with the majority
  // spelling. A bare "Run" means outdoors; renamed so the two are clearly
  // distinct at a glance.
  Treadmill: 'Treadmill run',
  Run: 'Outdoor run',

  // Both the bare "Pulldown" and the "Cable lat pulldowns" spelling are the lat
  // pulldown. (Reverses an earlier decision to keep bar and cable pulldowns
  // apart — Dave gets veto.)
  Pulldown: 'Lat pulldown',
  'Cable lat pulldowns': 'Lat pulldown',

  // Drop redundant "machine"/"machines" suffixes where the name is unambiguous
  // without them.
  'Converging chest press machine': 'Converging chest press',
  'Converging shoulder press machine': 'Converging shoulder press',
  'Leg extension machines': 'Leg extension',
  'Seated leg curl machines': 'Seated leg curl',
  'Pectoral fly machine': 'Pec fly',
  'Reverse pec deck machine': 'Reverse pec deck',
  // A rear delt machine is the same reverse-pec-deck movement (run backwards),
  // so it merges into that one history rather than being logged separately.
  'Rear delt machine': 'Reverse pec deck',

  // A bare "Knee raise" is the hanging knee raise Dave logs it as — merged so
  // the prescribed "Hanging knee raise" picks up that history. The live log
  // spells it plural ("Knee raises"), so both forms map.
  'Knee raise': 'Hanging knee raise',
  'Knee raises': 'Hanging knee raise',

  // Singularise where the plural is not the exercise's common name.
  'Cable bicep curls': 'Cable bicep curl',
  // Mid-word capitalisation drift ("Bicep") — only the DB/KB tokens are
  // uppercased, so this one needs an explicit row.
  'DB Bicep curl': 'DB bicep curl',
  'Cable rows': 'Cable row',
  'Reverse lunges': 'Reverse lunge',
  'Neutral grip pullups': 'Neutral-grip pull-up',
};

// Uppercase standalone equipment tokens (db→DB, kb→KB) wherever they appear,
// leaving every other word untouched.
function upperEquipmentTokens(name: string): string {
  return name
    .split(' ')
    .map(token => {
      const lower = token.toLowerCase();
      if (lower === 'db') return 'DB';
      if (lower === 'kb') return 'KB';
      return token;
    })
    .join(' ');
}

// The canonical spelling for a raw, hand-typed exercise name. Idempotent:
// running it on its own output returns the same string.
export function normalizeExerciseName(raw: string): string {
  const collapsed = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';

  const cased = upperEquipmentTokens(collapsed);
  const capitalised = cased.charAt(0).toUpperCase() + cased.slice(1);

  return EXERCISE_NAME_ALIASES[capitalised] ?? capitalised;
}
