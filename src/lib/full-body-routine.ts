// The "Full body (3-day)" routine (v2) and the extended daily rehab block, kept
// as constants so both the seed script (scripts/seed-full-body-routine.ts) and
// the tests build from one source of truth.
//
// The routine follows docs/full-body-routine-plan.md §3–§4 (v2, finalised
// 21 Sep 2026):
//   Mon/Wed/Fri/Sun — the 15-minute HOME core + mobility block (a fixed day: its
//     checklist is exactly its staples with fixed doses, no AI, no progression).
//     Monday also carries 5-a-side football in the evening; Sunday adds a long
//     walk + yoga (the block is recovery, not training).
//   Tue/Thu — a full-body GYM session (A / B) of four antagonist PAIRS plus
//     calves, with the treadmill run done AFTER the lifts (cardioAfter).
//   Sat — parkrun FIRST, then full-body GYM session C.
//
// Gym day titles carry the parser-recognised group words push, pull and legs so
// the programmer activates all three groups (a plain "Full body" would activate
// nothing — see src/lib/exercise-targets.ts ACTIVATE); home titles carry "core"
// so they activate the core group. Exercise names are the exact spellings used in
// the history where one exists so progression carries over.

import type { RehabExercise, WeeklyRoutineDay } from '@/types/life';

// The name the full-body routine is stored under in the routine library.
export const FULL_BODY_3DAY_NAME = 'Full body (3-day)';

// The 15-minute home core + mobility block, in the order it is done. Shared by
// the Mon/Wed/Fri/Sun fixed days. These are FIXED prescriptions: no progression,
// no accessories — the day's checklist is exactly this list with these doses.
const HOME_BLOCK: string[] = [
  'Cat-cow',
  'Couch stretch',
  '90/90 hip switch',
  'McGill curl-up',
  'Side plank',
  'Bird dog',
  'Glute bridge',
  'Standing pelvic tilt',
];

const HOME_BLOCK_PRESCRIPTIONS: Record<string, string> = {
  'Cat-cow': '8 slow',
  'Couch stretch': '90 s per side',
  '90/90 hip switch': '8 per side',
  'McGill curl-up': '3-2-1 × 10 s holds',
  'Side plank': '3-2-1 × 10 s per side',
  'Bird dog': '3-2-1 × 10 s per side',
  'Glute bridge': '2 × 15, 2 s squeeze',
  'Standing pelvic tilt': '10',
};

// A standing home day: the fixed block, done at home, with an optional extra note
// and extra staples (Monday's football). Kept as a helper so the four home days
// stay identical bar their note and extras.
function homeDay(
  dayOfWeek: number,
  note: string,
  extraStaples: string[] = []
): WeeklyRoutineDay {
  return {
    dayOfWeek,
    title: 'Home core + mobility',
    note,
    venue: 'home',
    fixed: true,
    anchors: [],
    staples: [...HOME_BLOCK, ...extraStaples],
    prescriptions: HOME_BLOCK_PRESCRIPTIONS,
  };
}

// The shared rest/progression guidance shown on the gym days.
const GYM_NOTE =
  'Antagonist pairs done back-to-back: 30–60 s between the two halves, ~90 s before the next round. Two light warm-up sets on the first movement of each pair. Double progression — top of the range on all 3 sets → add weight and reset reps; below the bottom → drop about 10%. All working sets 8–12 reps unless stated; calves and carries 12–15.';

// dayOfWeek follows JS Date.getDay(): 0 = Sunday … 6 = Saturday.
export const FULL_BODY_3DAY_ROUTINE: WeeklyRoutineDay[] = [
  homeDay(
    1, // Monday
    'The 15-minute home core + mobility block, in order. Plus 5-a-side football in the evening (cardio).',
    ['5-a-side football']
  ),
  {
    dayOfWeek: 2, // Tuesday
    title: 'Full body A (push + pull + legs) + Treadmill run',
    note: `${GYM_NOTE} Calf press on the leg press, straight after each leg-press set. Treadmill run AFTER the lifts, easy pace, distance ramping toward the 10k goal.`,
    anchors: [
      'Leg press',
      'Seated leg curl',
      'Incline DB press',
      'Chest-supported DB row',
      'Neutral-grip pull-up',
      "Captain's chair knee raise",
      'DB bicep curl',
      'Lying DB tricep extension',
    ],
    staples: ['Calf press'],
    pairs: [
      ['Leg press', 'Seated leg curl'],
      ['Incline DB press', 'Chest-supported DB row'],
      ['Neutral-grip pull-up', "Captain's chair knee raise"],
      ['DB bicep curl', 'Lying DB tricep extension'],
    ],
    alternatives: {
      'Chest-supported DB row': ['Single-arm DB row'],
      'Neutral-grip pull-up': ['Neutral-grip lat pulldown'],
      'DB bicep curl': ['Hammer curls'],
      "Captain's chair knee raise": ['Hanging knee raise'],
      'Lying DB tricep extension': ['Machine tricep pushdown'],
    },
    cardioAfter: true,
  },
  homeDay(3, 'The 15-minute home core + mobility block, in order.'), // Wednesday
  {
    dayOfWeek: 4, // Thursday
    title: 'Full body B (push + pull + legs) + Treadmill run',
    note: `${GYM_NOTE} Seated calf raise as straight sets, 3 × 12–15. Treadmill run AFTER the lifts, easy pace, distance ramping toward the 10k goal.`,
    anchors: [
      'Converging chest press',
      'Seated cable row',
      'Converging shoulder press',
      'Wide-grip lat pulldown',
      'Leg extension',
      'Back extension',
      'Machine bicep curl',
      'Machine tricep extension',
    ],
    staples: ['Seated calf raise'],
    pairs: [
      ['Converging chest press', 'Seated cable row'],
      ['Converging shoulder press', 'Wide-grip lat pulldown'],
      ['Leg extension', 'Back extension'],
      ['Machine bicep curl', 'Machine tricep extension'],
    ],
    alternatives: {
      'Wide-grip lat pulldown': ['Diverging lat pulldown'],
      'Back extension': ['DB good morning'],
      'Machine bicep curl': ['Hammer curls'],
      'Machine tricep extension': ['Lying DB tricep extension', 'Machine tricep pushdown'],
    },
    cardioAfter: true,
  },
  homeDay(5, 'The 15-minute home core + mobility block, in order.'), // Friday
  {
    dayOfWeek: 6, // Saturday
    title: 'Parkrun + Full body C (push + pull + legs)',
    note: `Parkrun 5 km FIRST — run slower than feels natural, short stride, high cadence, 'run tall, tuck the pelvis'. Then the gym session. ${GYM_NOTE} Standing calf raise on a step in the last pair.`,
    anchors: [
      'DB Romanian deadlift',
      'DB lateral raise',
      'Flat DB press',
      'Single-arm DB row',
      'Bulgarian split squat',
      'Incline dumbbell curls',
      'Machine tricep pushdown',
      'Standing calf raise (step)',
    ],
    staples: [],
    pairs: [
      ['DB Romanian deadlift', 'DB lateral raise'],
      ['Flat DB press', 'Single-arm DB row'],
      ['Bulgarian split squat', 'Incline dumbbell curls'],
      ['Machine tricep pushdown', 'Standing calf raise (step)'],
    ],
    alternatives: {
      'Single-arm DB row': ['Chest-supported DB row'],
      'Bulgarian split squat': ['Reverse lunge'],
      'Incline dumbbell curls': ['Hammer curls'],
      'Machine tricep pushdown': ['Lying DB tricep extension'],
    },
  },
  homeDay(
    0, // Sunday
    'Long walk + yoga; the 15-minute block is recovery, not training.'
  ),
];

// The extended daily rehab block (docs/full-body-routine-plan.md §4): the McGill
// Big 3 at their proper 5-3-1 × 10 s dosing, plus a spine warm-up (cat-cow) and
// a hip-rotation drill (90/90 hip switch). The existing six ids and their order
// are preserved so past ticks stay valid; the three new movements slot in around
// them per §4, and Side plank + Bird dog take the McGill dose.
export const MCGILL_REHAB_EXERCISES: RehabExercise[] = [
  {
    id: 'cat-cow',
    name: 'Cat-cow',
    prescription: '8 slow',
    note: 'Warm the spine — move gently through the full range, don’t force the ends',
  },
  {
    id: 'couch-stretch',
    name: 'Couch stretch',
    prescription: '90 s per side',
    note: 'Back knee against sofa/wall, glute squeezed, torso tall — feel it in the front of the hip, not the lower back',
  },
  {
    id: '90-90-hip-switch',
    name: '90/90 hip switch',
    prescription: '8 per side',
    note: 'Sit tall, rotate both knees side to side through 90/90, chest up — mobility, not a stretch to force',
  },
  {
    id: 'mcgill-curl-up',
    name: 'McGill curl-up',
    prescription: '5-3-1 × 10 s holds',
    note: 'Hands under the low back, one knee bent; lift head and shoulders a touch and brace — keep the lower back still, never flatten or round it',
  },
  {
    id: 'side-plank',
    name: 'Side plank',
    prescription: '5-3-1 × 10 s per side',
    note: 'On knees if the full version aggravates anything; McGill dose — 5 holds, then 3, then 1',
  },
  {
    id: 'bird-dog',
    name: 'Bird dog',
    prescription: '5-3-1 × 10 s per side',
    note: 'Hips level; McGill dose — 5 holds, then 3, then 1',
  },
  {
    id: 'glute-bridge',
    name: 'Glute bridge',
    prescription: '2×15',
    note: "2 s squeeze at the top, ribs down, don't arch the lower back",
  },
  {
    id: 'dead-bug',
    name: 'Dead bug',
    prescription: '10 per side, slow',
    note: 'Lower back pressed into the floor',
  },
  {
    id: 'standing-pelvic-tilt',
    name: 'Standing pelvic tilt',
    prescription: '10 reps',
    note: "Tuck into POSTERIOR tilt and hold a beat — the tuck is the rep. Practise 'run tall, tuck the pelvis'",
  },
];
