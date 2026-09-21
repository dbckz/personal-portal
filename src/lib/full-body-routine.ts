// The "Full body (3-day)" routine and the extended daily rehab block, kept as
// constants so both the seed scripts (scripts/seed-full-body-routine.ts,
// scripts/seed-rehab-mcgill.ts) and the tests build from one source of truth.
//
// The routine follows docs/full-body-routine-plan.md §3: Mon/Wed/Fri full-body
// lifts (heavy / moderate / light legs), Tue/Thu treadmill runs, Sat parkrun,
// Sun rest. Day titles carry the parser-recognised group words push, pull and
// legs so the programmer activates all three groups (a plain "Full body" would
// activate nothing — see src/lib/exercise-targets.ts ACTIVATE). Exercise names
// are the exact spellings already used in the routine and history so progression
// carries over.

import type { RehabExercise, WeeklyRoutineDay } from '@/types/life';

// The name the full-body routine is stored under in the routine library.
export const FULL_BODY_3DAY_NAME = 'Full body (3-day)';

// dayOfWeek follows JS Date.getDay(): 0 = Sunday … 6 = Saturday.
export const FULL_BODY_3DAY_ROUTINE: WeeklyRoutineDay[] = [
  {
    dayOfWeek: 1, // Monday
    title: 'Full body A (push + pull + legs)',
    note: 'Heavy legs (6–8 reps on leg press). Pair incline press ⇄ chest-supported row and curl ⇄ pushdown as antagonist pairs with 60–90 s between. Lift earlier in the day; 5-a-side football in the evening. ~55–65 min.',
    anchors: [
      'Leg press',
      'Seated leg curl',
      'Incline dumbbell press',
      'Chest-supported dumbbell row',
      'Seated dumbbell shoulder press',
    ],
    staples: ['Pallof press', '5-a-side football'],
  },
  {
    dayOfWeek: 2, // Tuesday
    title: 'Treadmill run',
    note: 'Treadmill run, distance ramping weekly toward the 10k goal. Daily rehab routine (couch stretch, glute bridges etc.) done separately — do it before the run.',
    anchors: [],
  },
  {
    dayOfWeek: 3, // Wednesday
    title: 'Full body B (push + pull + legs)',
    note: 'Moderate legs. Dumbbell Romanian deadlift is new — progress it normally (strength and mobility are the rehab). Lateral raise ⇄ face pull as an accessory pair. ~55–65 min.',
    anchors: [
      'Bulgarian split squat',
      'Dumbbell Romanian deadlift',
      'Flat dumbbell press',
      'Wide-grip lat pulldown',
    ],
    staples: ['Dead bug'],
  },
  {
    dayOfWeek: 4, // Thursday
    title: 'Treadmill run',
    note: 'Treadmill run, distance ramping weekly toward the 10k goal. Daily rehab routine (couch stretch, glute bridges etc.) done separately — do it before the run.',
    anchors: [],
  },
  {
    dayOfWeek: 5, // Friday
    title: 'Full body C (push + pull + legs)',
    note: 'Light legs (12–15 reps on leg press, or hack squat if available). Machine chest press or dips ⇄ cable row; curl ⇄ overhead tricep extension. ~50–60 min.',
    anchors: [
      'Leg press',
      'Single-leg glute bridge',
      'Seated cable row',
      'Neutral-grip lat pulldown',
    ],
    staples: ['Side plank'],
  },
  {
    dayOfWeek: 6, // Saturday
    title: 'Parkrun',
    note: "Parkrun 5 km is the week's ONE outdoor run — do the daily rehab routine (couch stretch, glute bridges etc.) before leaving, run slower than feels natural, short stride, high cadence, 'run tall, tuck the pelvis'. Cut it short if the back flares.",
    anchors: [],
  },
  {
    dayOfWeek: 0, // Sunday
    title: 'Rest',
    note: 'Long walk + yoga.',
    anchors: [],
    rest: true,
  },
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
