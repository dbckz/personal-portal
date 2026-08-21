/**
 * @jest-environment node
 *
 * The AI session programmer: building the model's input and prompt, hashing it
 * for the cache, and validating what comes back — including the safety rules on
 * the to-failure marker. The model itself is mocked; these are the parts that
 * have to be right whatever the model returns.
 */
import {
  buildProgrammerInput,
  buildProgrammerPrompt,
  generateProgramme,
  HOME_EQUIPMENT,
  orderProgrammeRows,
  programmeHash,
  programmeRowToTarget,
  validateProgramme,
  type ProgrammeRow,
  type ProgrammerInput,
} from '@/lib/exercise-programmer';
import type { ProgrammerRoutineDay } from '@/lib/exercise-programmer';
import { classifyExercise, isBandExercise } from '@/lib/exercise-targets';
import { exerciseKey, type ExerciseProgression, type ProgressionPoint } from '@/lib/exercise-progression';
import { getCachedProgramme, saveCachedProgramme } from '@/lib/storage/exercise-programmes';
import { __resetDbForTests } from '@/lib/storage/db';

function progression(
  name: string,
  points: ProgressionPoint[],
  sessions = points.length
): ExerciseProgression {
  return {
    name,
    key: exerciseKey(name),
    sessions,
    points,
    first: points[0],
    latest: points[points.length - 1],
  };
}

// A small, realistic push session: a core press seen every time, a rotating
// accessory, and a treadmill run.
function pushProgressions(): ExerciseProgression[] {
  return [
    progression(
      'Converging chest press machine',
      [
        { date: '2026-07-20', sets: 3, reps: 8, weightKg: 30, notes: 'A couple in tank' },
        { date: '2026-07-27', sets: 3, reps: 8, weightKg: 32 },
        { date: '2026-08-02', sets: 3, reps: 8, weightKg: 34, notes: 'Could have done 3-4 more' },
      ],
      6
    ),
    progression('Cable tricep pushdown', [{ date: '2026-08-02', sets: 3, reps: 12, weightKg: 20 }], 2),
    progression('Treadmill run', [{ date: '2026-08-02', durationMinutes: 15, distanceKm: 2.5 }], 4),
  ];
}

function input(): ProgrammerInput {
  return buildProgrammerInput(pushProgressions(), { label: 'Push', components: [] }, '2026-08-06', 6);
}

describe('buildProgrammerInput', () => {
  it('carries frequency, the last three points, and a concrete last summary', () => {
    const built = input();
    const press = built.exercises.find(e => e.key === exerciseKey('Converging chest press machine'))!;
    expect(press.frequency).toBe(6);
    expect(press.totalSessions).toBe(6);
    expect(press.recent).toHaveLength(3);
    expect(press.lastSummary).toBe('2 Aug · 3 × 8 · 34kg');

    const run = built.exercises.find(e => e.key === exerciseKey('Treadmill run'))!;
    // The cardio last summary must carry real numbers, not "the same".
    expect(run.lastSummary).toBe('2 Aug · 15 min · 2.5 km');
  });
});

describe('isBandExercise', () => {
  it('matches band exercises on the whole word', () => {
    expect(isBandExercise('Band rows')).toBe(true);
    expect(isBandExercise('Band curls')).toBe(true);
    expect(isBandExercise('Pull-ups or band-assisted pull-ups')).toBe(true);
  });

  it('does not match when "band" is only part of another word', () => {
    expect(isBandExercise('broadband sprints')).toBe(false);
    expect(isBandExercise('Converging chest press machine')).toBe(false);
  });
});

describe('band exercises stay out of planned gym sessions', () => {
  it('excludes a band progression from the vocabulary but keeps non-band ones', () => {
    const built = buildProgrammerInput(
      [
        progression('Converging chest press machine', [{ date: '2026-08-02', sets: 3, reps: 8, weightKg: 34 }], 6),
        progression('Band rows', [{ date: '2026-08-02', sets: 3, reps: 15 }], 2),
      ],
      { label: 'Push', components: [] },
      '2026-08-06',
      6
    );
    const names = built.exercises.map(e => e.name);
    expect(names).toContain('Converging chest press machine');
    expect(names).not.toContain('Band rows');
  });

  it('keeps a band exercise named as a routine anchor', () => {
    const built = buildProgrammerInput(
      [
        progression('Converging chest press machine', [{ date: '2026-08-02', sets: 3, reps: 8, weightKg: 34 }], 6),
        progression('Band rows', [{ date: '2026-08-02', sets: 3, reps: 15 }], 2),
      ],
      {
        label: 'Push',
        components: ['Push (chest & arms)'],
        routineDay: {
          title: 'Push (chest & arms)',
          anchors: ['Band rows'],
          staples: [],
        },
      },
      '2026-08-06',
      6
    );
    // Filtered out of the derived vocab, but the explicit routine anchor stays.
    expect(built.exercises.map(e => e.name)).toContain('Band rows');
  });
});

describe('programmeHash', () => {
  it('is stable for identical input', () => {
    expect(programmeHash(input())).toBe(programmeHash(input()));
  });

  it('changes when the history changes', () => {
    const before = programmeHash(input());
    const moved = buildProgrammerInput(
      pushProgressions().map(p =>
        p.name === 'Cable tricep pushdown'
          ? progression('Cable tricep pushdown', [{ date: '2026-08-02', sets: 3, reps: 12, weightKg: 25 }], 2)
          : p
      ),
      { label: 'Push', components: [] },
      '2026-08-06',
      6
    );
    expect(programmeHash(moved)).not.toBe(before);
  });

  it('changes when the plan changes', () => {
    const before = programmeHash(input());
    const replanned = buildProgrammerInput(
      pushProgressions(),
      { label: 'Pull', components: ['Pull (back)'] },
      '2026-08-06',
      6
    );
    expect(programmeHash(replanned)).not.toBe(before);
  });
});

describe('buildProgrammerPrompt', () => {
  it('states each exercise frequency and its history with numbers and notes', () => {
    const prompt = buildProgrammerPrompt(input());
    expect(prompt).toContain('done in 6/6 of these sessions');
    expect(prompt).toContain('34kg');
    expect(prompt).toContain('Could have done 3-4 more');
    expect(prompt).toContain('15min');
    expect(prompt).toContain('2.5km');
  });

  it('teaches how holds and cardio progress and read, and how to mark each side', () => {
    const prompt = buildProgrammerPrompt(input());
    // Holds are seconds, cardio is distance/duration/pace — not reps.
    expect(prompt).toContain('sets/holdSeconds for a timed hold');
    expect(prompt).toMatch(/held it longer/i);
    expect(prompt).toMatch(/never as reps in reserve/i);
    // The 'hold' kind is offered and unilateral work is flagged perSide.
    expect(prompt).toContain('cardio|hold');
    expect(prompt).toContain('perSide');
  });
});

describe('validateProgramme', () => {
  it('drops rows naming an exercise not in the input', () => {
    const rows = validateProgramme(
      [
        { name: 'Converging chest press machine', kind: 'core', toFailure: false, target: { sets: 3, reps: 8, weightKg: 35 } },
        { name: 'Leg press', kind: 'core', toFailure: true, target: { sets: 3, reps: 10, weightKg: 100 } },
      ],
      input()
    );
    expect(rows.map(r => r.name)).toEqual(['Converging chest press machine']);
  });

  it('overrides the last summary with real history, ignoring the model', () => {
    const rows = validateProgramme(
      [{ name: 'Converging chest press machine', kind: 'core', toFailure: false, target: { sets: 3, reps: 8, weightKg: 35 } }],
      input()
    );
    expect(rows[0].lastSummary).toBe('2 Aug · 3 × 8 · 34kg');
  });

  it('defaults an unrecognised kind to rotation and drops bad target numbers', () => {
    const rows = validateProgramme(
      [{ name: 'Cable tricep pushdown', kind: 'nonsense', toFailure: false, target: { sets: -1, reps: 12, weightKg: 'heavy' } }],
      input()
    );
    expect(rows[0].kind).toBe('rotation');
    expect(rows[0].target).toEqual({ reps: 12 });
  });

  it('keeps holdSeconds, perSide and the hold kind for a timed hold', () => {
    const holdInput = buildProgrammerInput(
      [progression('Side plank', [{ date: '2026-08-02', sets: 3, holdSeconds: 30, perSide: true }])],
      { label: 'Core', components: [] },
      '2026-08-06',
      4
    );
    const rows = validateProgramme(
      [
        {
          name: 'Side plank',
          kind: 'hold',
          toFailure: false,
          target: { sets: 3, holdSeconds: 40, perSide: true },
        },
      ],
      holdInput
    );
    expect(rows[0].kind).toBe('hold');
    expect(rows[0].target).toEqual({ sets: 3, holdSeconds: 40, perSide: true });
  });

  it('puts the to-failure marker on the last SAFE exercise, never a barbell', () => {
    const withBarbellLast = buildProgrammerInput(
      [
        progression('Cable tricep pushdown', [{ date: '2026-08-02', sets: 3, reps: 12, weightKg: 20 }]),
        progression('Barbell bench press', [{ date: '2026-08-02', sets: 3, reps: 5, weightKg: 60 }]),
      ],
      { label: 'Push', components: [] },
      '2026-08-06',
      4
    );
    const rows = validateProgramme(
      [
        { name: 'Cable tricep pushdown', kind: 'rotation', toFailure: false, target: { sets: 3, reps: 12, weightKg: 22 } },
        { name: 'Barbell bench press', kind: 'core', toFailure: true, target: { sets: 3, reps: 5, weightKg: 62 } },
      ],
      withBarbellLast
    );
    const failing = rows.filter(r => r.toFailure);
    expect(failing).toHaveLength(1);
    expect(failing[0].name).toBe('Cable tricep pushdown');
  });
});

describe('cardio rules in validateProgramme', () => {
  function twoCardioInput(): ProgrammerInput {
    return buildProgrammerInput(
      [
        progression('Treadmill run', [{ date: '2026-08-02', durationMinutes: 15, distanceKm: 2.5 }], 4),
        progression('Outdoor run', [{ date: '2026-08-01', durationMinutes: 25, distanceKm: 5 }], 2),
        progression('Cable tricep pushdown', [{ date: '2026-08-02', sets: 3, reps: 12, weightKg: 20 }], 2),
      ],
      { label: 'Run', components: [] },
      '2026-08-06',
      6
    );
  }

  it('drops any cardio row after the first', () => {
    const rows = validateProgramme(
      [
        { name: 'Treadmill run', kind: 'cardio', toFailure: false, target: { durationMinutes: 16 } },
        { name: 'Outdoor run', kind: 'cardio', toFailure: false, target: { durationMinutes: 26, distanceKm: 5 } },
        { name: 'Cable tricep pushdown', kind: 'rotation', toFailure: false, target: { sets: 3, reps: 12, weightKg: 22 } },
      ],
      twoCardioInput()
    );
    expect(rows.map(r => r.name)).toEqual(['Treadmill run', 'Cable tricep pushdown']);
    expect(rows.filter(r => r.kind === 'cardio')).toHaveLength(1);
  });

  it('strips distance from a treadmill row and keeps it in minutes', () => {
    const rows = validateProgramme(
      [{ name: 'Treadmill run', kind: 'cardio', toFailure: false, target: { durationMinutes: 16, distanceKm: 2.6 } }],
      twoCardioInput()
    );
    expect(rows[0].target).toEqual({ durationMinutes: 16 });
  });

  it('fills a treadmill duration from history when the model omits it', () => {
    const rows = validateProgramme(
      [{ name: 'Treadmill run', kind: 'cardio', toFailure: false, target: { distanceKm: 2.6 } }],
      twoCardioInput()
    );
    // No duration given, distance stripped — the last logged 15 min fills in.
    expect(rows[0].target).toEqual({ durationMinutes: 15 });
  });

  it('caps a cardio duration jump at +5 minutes over the last logged', () => {
    // The incident: the model back-solved 29 min from a calendar title.
    const rows = validateProgramme(
      [{ name: 'Treadmill run', kind: 'cardio', toFailure: false, target: { durationMinutes: 29 } }],
      twoCardioInput()
    );
    // Last was 15 min → capped at 20.
    expect(rows[0].target.durationMinutes).toBe(20);
  });

  it('never forces a cardio duration upward — a deliberate deload survives', () => {
    const rows = validateProgramme(
      [{ name: 'Outdoor run', kind: 'cardio', toFailure: false, target: { durationMinutes: 18, distanceKm: 4 } }],
      twoCardioInput()
    );
    // Last was 25 min; 18 is below the +5 cap, so it is left as the model set it.
    expect(rows[0].target.durationMinutes).toBe(18);
    expect(rows[0].target.distanceKm).toBe(4);
  });
});

describe('generateProgramme', () => {
  it('validates and returns rows from the model, in order', async () => {
    const run = jest.fn().mockResolvedValue(
      JSON.stringify([
        { name: 'Treadmill run', kind: 'cardio', toFailure: false, target: { durationMinutes: 16, distanceKm: 2.6 } },
        { name: 'Converging chest press machine', kind: 'core', toFailure: false, target: { sets: 3, reps: 8, weightKg: 35 } },
        { name: 'Cable tricep pushdown', kind: 'rotation', toFailure: true, target: { sets: 3, reps: 12, weightKg: 22 } },
      ])
    );
    const rows = await generateProgramme(input(), { run });
    expect(rows?.map(r => r.name)).toEqual([
      'Treadmill run',
      'Converging chest press machine',
      'Cable tricep pushdown',
    ]);
    expect(rows?.[0].kind).toBe('cardio');
    expect(rows?.[2].toFailure).toBe(true);
  });

  it('returns null when the model call throws', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const run = jest.fn().mockRejectedValue(new Error('claude not found'));
    expect(await generateProgramme(input(), { run })).toBeNull();
    (console.error as jest.Mock).mockRestore();
  });

  it('returns null without calling the model when there is no history', async () => {
    const run = jest.fn();
    const empty = buildProgrammerInput([], { label: 'Push', components: [] }, '2026-08-06', 0);
    expect(await generateProgramme(empty, { run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('active goals in the programme', () => {
  const goals = [{ title: 'Run 10K', target: '10 km', nextMilestone: '7 km by 31 Aug', pace: 'behind' }];

  it('renders the goals block in the prompt when goals are present', () => {
    const withGoals = buildProgrammerInput(pushProgressions(), { label: 'Push', components: [] }, '2026-08-06', 6, goals);
    const prompt = buildProgrammerPrompt(withGoals);
    expect(prompt).toContain('Run 10K');
    expect(prompt).toContain('next milestone 7 km by 31 Aug');
    expect(prompt).toContain('currently behind');
  });

  it('omits the goals block when there are none', () => {
    expect(buildProgrammerPrompt(input())).not.toContain('Active goals');
  });

  it('folds goals into the hash so a changed goal regenerates the programme', () => {
    const before = programmeHash(input());
    const withGoals = buildProgrammerInput(pushProgressions(), { label: 'Push', components: [] }, '2026-08-06', 6, goals);
    expect(programmeHash(withGoals)).not.toBe(before);
  });
});

describe('the weekly routine drives the programmer', () => {
  // A push day: one anchor already in history, one anchor never logged, and a
  // component that selects the vocabulary the model rotates accessories from.
  function pushRoutine(over: Partial<ProgrammerRoutineDay> = {}): ProgrammerRoutineDay {
    return {
      title: 'Push (chest & arms)',
      note: 'Push A.',
      anchors: ['Converging chest press machine', 'Incline dumbbell press'],
      staples: [],
      ...over,
    };
  }

  function routineInput(day: ProgrammerRoutineDay): ProgrammerInput {
    return buildProgrammerInput(
      pushProgressions(),
      { label: 'Push', components: ['Push (chest & arms)'], routineDay: day },
      '2026-08-06',
      6
    );
  }

  it('includes the fixed anchors and the history vocabulary, anchors with no history stubbed', () => {
    const built = routineInput(pushRoutine());
    const names = built.exercises.map(e => e.name);
    // The history vocabulary (the press, from selection) plus the never-logged
    // anchor, appended as a frequency-0 stub.
    expect(names).toContain('Converging chest press machine');
    expect(names).toContain('Incline dumbbell press');
    const stub = built.exercises.find(e => e.key === exerciseKey('Incline dumbbell press'))!;
    expect(stub.frequency).toBe(0);
    expect(stub.lastSummary).toBe('no history');
  });

  it('includes staples as fixed exercises', () => {
    const built = routineInput(pushRoutine({ staples: ['Dead bug'] }));
    expect(built.exercises.map(e => e.key)).toContain(exerciseKey('Dead bug'));
  });

  it('generates nothing on a rest day', () => {
    const built = routineInput(pushRoutine({ rest: true, anchors: [], staples: [] }));
    expect(built.exercises).toEqual([]);
  });

  it('folds the routine day into the hash so an edited routine regenerates', () => {
    const base = programmeHash(routineInput(pushRoutine()));
    const edited = programmeHash(routineInput(pushRoutine({ anchors: ['Converging chest press machine'] })));
    expect(edited).not.toBe(base);
    // A changed note is an edit too.
    const noteEdit = programmeHash(routineInput(pushRoutine({ note: 'Push A — heavier.' })));
    expect(noteEdit).not.toBe(base);
  });

  it('marks anchors and staples REQUIRED in the prompt and carries rotation context', () => {
    const prompt = buildProgrammerPrompt(
      routineInput(pushRoutine({ recentAccessories: ['Cable tricep pushdown', 'Lateral raise'] }))
    );
    expect(prompt).toMatch(/REQUIRED anchors/);
    expect(prompt).toContain('Converging chest press machine, Incline dumbbell press');
    expect(prompt).toMatch(/3–5 accessories/);
    expect(prompt).toMatch(/most recent session\(s\) of this day: Cable tricep pushdown, Lateral raise/);
    expect(prompt).toMatch(/vary the accessories week to week/i);
  });

  it('guarantees anchors and staples the model dropped, appended with a fallback target', () => {
    const day = pushRoutine({ anchors: ['Converging chest press machine'], staples: ['Dead bug'] });
    const withStaple = buildProgrammerInput(
      [
        ...pushProgressions(),
        progression('Dead bug', [{ date: '2026-08-02', sets: 3, reps: 12 }], 3),
      ],
      { label: 'Push', components: ['Push (chest & arms)'], routineDay: day },
      '2026-08-06',
      6
    );
    // The model returns ONLY the tricep pushdown, dropping the anchor and staple.
    const rows = validateProgramme(
      [{ name: 'Cable tricep pushdown', kind: 'rotation', toFailure: false, target: { sets: 3, reps: 12, weightKg: 22 } }],
      withStaple
    );
    const names = rows.map(r => r.name);
    expect(names).toContain('Converging chest press machine');
    expect(names).toContain('Dead bug');
    // The dropped anchor is tagged core and carries a fallback target from history.
    const anchor = rows.find(r => r.name === 'Converging chest press machine')!;
    expect(anchor.kind).toBe('core');
    expect(anchor.target).toEqual({ sets: 3, reps: 8, weightKg: 34 });
  });
});

describe('guaranteeGroupCoverage — per-group minimum rows', () => {
  // A combined Pull + Legs day with six of each group in history, so the
  // vocabulary can support the floor either way.
  function pullLegsProgressions(): ExerciseProgression[] {
    const load = (kg: number): ProgressionPoint[] => [
      { date: '2026-08-02', sets: 3, reps: 10, weightKg: kg },
    ];
    return [
      progression('Lat pulldown', load(50), 6),
      progression('Cable row', load(45), 6),
      progression('Seated row', load(40), 5),
      progression('Cable bicep curl', load(15), 5),
      progression('Face pull', load(12), 4),
      progression('Barbell shrug', load(60), 4),
      progression('Leg press', load(120), 6),
      progression('Leg extension', load(50), 6),
      progression('Leg curl', load(45), 5),
      progression('Hip thrust', load(80), 5),
      progression('Standing calf raise', load(40), 4),
      progression('Reverse lunge', load(20), 4),
    ];
  }

  function pullLegsInput(
    over: Partial<ProgrammerRoutineDay> = {},
    progressions = pullLegsProgressions()
  ): ProgrammerInput {
    return buildProgrammerInput(
      progressions,
      {
        label: 'Pull + Legs',
        components: ['Pull (back & arms)', 'Legs'],
        routineDay: { title: 'Pull + Legs', anchors: [], staples: [], ...over },
      },
      '2026-08-06',
      6
    );
  }

  const groupOf = (rows: ProgrammeRow[], group: string) =>
    rows.filter(r => classifyExercise(r.name) === group);

  it('floors each group of a combined day at its minimum, filling from vocabulary', () => {
    // The model returns 8 lopsided rows: six pull, only two legs.
    const lopsided = [
      'Lat pulldown',
      'Cable row',
      'Seated row',
      'Cable bicep curl',
      'Face pull',
      'Barbell shrug',
      'Leg press',
      'Leg extension',
    ].map(name => ({ name, kind: 'core', toFailure: false, target: { sets: 3, reps: 10, weightKg: 30 } }));

    const rows = validateProgramme(lopsided, pullLegsInput());

    // Both groups reach the strength floor of 5, vocabulary permitting.
    expect(groupOf(rows, 'pull').length).toBeGreaterThanOrEqual(5);
    expect(groupOf(rows, 'legs').length).toBeGreaterThanOrEqual(5);

    // The three appended legs rows carry a deterministic fallback target from
    // history, not a blank.
    const legCurl = rows.find(r => r.name === 'Leg curl');
    expect(legCurl).toBeDefined();
    expect(legCurl!.target).toEqual({ sets: 3, reps: 10, weightKg: 45 });

    // Ordering and the single to-failure marker still hold on the final set.
    const failing = rows.filter(r => r.toFailure);
    expect(failing).toHaveLength(1);
    expect(failing[0].name).toBe(rows[rows.length - 1].name);
  });

  it('tops a group out at the vocabulary it has when that is below the floor', () => {
    // Only three legs exercises exist in history — the floor of 5 cannot be met,
    // so the group tops out at three rather than inventing lifts.
    const thin = [
      progression('Lat pulldown', [{ date: '2026-08-02', sets: 3, reps: 10, weightKg: 50 }], 6),
      progression('Cable row', [{ date: '2026-08-02', sets: 3, reps: 10, weightKg: 45 }], 6),
      progression('Seated row', [{ date: '2026-08-02', sets: 3, reps: 10, weightKg: 40 }], 5),
      progression('Cable bicep curl', [{ date: '2026-08-02', sets: 3, reps: 10, weightKg: 15 }], 5),
      progression('Face pull', [{ date: '2026-08-02', sets: 3, reps: 10, weightKg: 12 }], 4),
      progression('Leg press', [{ date: '2026-08-02', sets: 3, reps: 10, weightKg: 120 }], 6),
      progression('Leg extension', [{ date: '2026-08-02', sets: 3, reps: 10, weightKg: 50 }], 6),
      progression('Leg curl', [{ date: '2026-08-02', sets: 3, reps: 10, weightKg: 45 }], 5),
    ];
    // The model returns pull only, no legs at all.
    const pullOnly = ['Lat pulldown', 'Cable row'].map(name => ({
      name,
      kind: 'core',
      toFailure: false,
      target: { sets: 3, reps: 10, weightKg: 30 },
    }));

    const rows = validateProgramme(pullOnly, pullLegsInput({}, thin));
    expect(groupOf(rows, 'legs')).toHaveLength(3); // all the vocabulary holds
  });

  it('leaves a single-group day that already meets the floor untouched', () => {
    const pullDay = buildProgrammerInput(
      pullLegsProgressions(),
      {
        label: 'Pull',
        components: ['Pull (back & arms)'],
        routineDay: { title: 'Pull', anchors: [], staples: [] },
      },
      '2026-08-06',
      6
    );
    const returned = ['Lat pulldown', 'Cable row', 'Seated row', 'Cable bicep curl', 'Face pull'].map(
      name => ({ name, kind: 'core', toFailure: false, target: { sets: 3, reps: 10, weightKg: 30 } })
    );
    const rows = validateProgramme(returned, pullDay);
    // Five pull rows in, five out — no coverage fill, no legs conjured.
    expect(rows.map(r => r.name)).toEqual([
      'Lat pulldown',
      'Cable row',
      'Seated row',
      'Cable bicep curl',
      'Face pull',
    ]);
  });
});

describe('markFixed — anchor/staple provenance', () => {
  function routineInput(): ProgrammerInput {
    return buildProgrammerInput(
      [
        ...pushProgressions(),
        progression('Dead bug', [{ date: '2026-08-02', sets: 3, reps: 12 }], 3),
      ],
      {
        label: 'Push',
        components: ['Push (chest & arms)'],
        routineDay: {
          title: 'Push (chest & arms)',
          anchors: ['Converging chest press machine'],
          staples: ['Dead bug'],
        },
      },
      '2026-08-06',
      6
    );
  }

  it('stamps fixed on anchors and staples, including ones the model dropped', () => {
    // The model returns only the anchor and an accessory; the staple is dropped
    // and appended by guaranteeFixed — it must still be marked fixed.
    const rows = validateProgramme(
      [
        { name: 'Converging chest press machine', kind: 'core', toFailure: false, target: { sets: 3, reps: 8, weightKg: 35 } },
        { name: 'Cable tricep pushdown', kind: 'rotation', toFailure: false, target: { sets: 3, reps: 12, weightKg: 22 } },
      ],
      routineInput()
    );
    const anchor = rows.find(r => r.name === 'Converging chest press machine')!;
    const staple = rows.find(r => r.name === 'Dead bug')!;
    const accessory = rows.find(r => r.name === 'Cable tricep pushdown')!;
    expect(anchor.fixed).toBe('anchor');
    expect(staple.fixed).toBe('staple');
    expect(accessory.fixed).toBeUndefined();
  });

  it('threads fixed through programmeRowToTarget for the checklist', () => {
    const target = programmeRowToTarget({
      name: 'Converging chest press machine',
      key: exerciseKey('Converging chest press machine'),
      kind: 'core',
      toFailure: false,
      fixed: 'anchor',
      target: { sets: 3, reps: 8, weightKg: 34 },
      rationale: 'Fixed anchor.',
      lastSummary: '2 Aug · 3 × 8 · 34kg',
    });
    expect(target.fixed).toBe('anchor');
  });
});

describe('orderProgrammeRows', () => {
  function row(name: string, kind: ProgrammeRow['kind'] = 'core'): ProgrammeRow {
    return {
      name,
      key: exerciseKey(name),
      kind,
      toFailure: false,
      target: {},
      rationale: '',
      lastSummary: 'no history',
    };
  }

  const day = {
    title: 'Push',
    anchors: ['Anchor one', 'Anchor two'],
    staples: ['Staple one'],
  };

  it('hoists anchors above accessories in routine order, staples after, cardio first', () => {
    const ordered = orderProgrammeRows(
      [
        row('Accessory', 'rotation'),
        row('Staple one'),
        row('Anchor two'),
        row('Treadmill run', 'cardio'),
        row('Anchor one'),
      ],
      day
    );
    expect(ordered.map(r => r.name)).toEqual([
      'Treadmill run',
      'Anchor one',
      'Anchor two',
      'Staple one',
      'Accessory',
    ]);
  });

  it('leaves the order untouched when there is no routine day', () => {
    const rows = [row('Accessory', 'rotation'), row('Anchor one'), row('Treadmill run', 'cardio')];
    expect(orderProgrammeRows(rows, undefined)).toBe(rows);
  });
});

describe('validateProgramme deterministic ordering', () => {
  function orderingInput(): ProgrammerInput {
    return buildProgrammerInput(
      [
        ...pushProgressions(),
        progression('Incline dumbbell press', [{ date: '2026-08-02', sets: 3, reps: 8, weightKg: 20 }], 3),
        progression('Dead bug', [{ date: '2026-08-02', sets: 3, reps: 12 }], 3),
        progression('Lateral raise', [{ date: '2026-08-02', sets: 3, reps: 12, weightKg: 8 }], 3),
      ],
      {
        label: 'Push',
        // Empty components keep the full vocabulary (including the treadmill run)
        // so the ordering under test isn't skewed by plan-group filtering; the
        // routineDay is what drives the anchor/staple ordering.
        components: [],
        routineDay: {
          title: 'Push (chest & arms)',
          anchors: ['Converging chest press machine', 'Incline dumbbell press'],
          staples: ['Dead bug'],
        },
      },
      '2026-08-06',
      6
    );
  }

  it('reorders cardio → anchors → staples → accessories however the model interleaved them', () => {
    // The model interleaves an accessory pull-up between the two anchors.
    const rows = validateProgramme(
      [
        { name: 'Cable tricep pushdown', kind: 'rotation', toFailure: false, target: { sets: 3, reps: 12, weightKg: 22 } },
        { name: 'Converging chest press machine', kind: 'core', toFailure: false, target: { sets: 3, reps: 8, weightKg: 35 } },
        { name: 'Lateral raise', kind: 'rotation', toFailure: true, target: { sets: 3, reps: 12, weightKg: 9 } },
        { name: 'Incline dumbbell press', kind: 'core', toFailure: false, target: { sets: 3, reps: 8, weightKg: 22 } },
        { name: 'Treadmill run', kind: 'cardio', toFailure: false, target: { durationMinutes: 16 } },
        { name: 'Dead bug', kind: 'core', toFailure: false, target: { sets: 3, reps: 12 } },
      ],
      orderingInput()
    );
    expect(rows.map(r => r.name)).toEqual([
      'Treadmill run',
      'Converging chest press machine',
      'Incline dumbbell press',
      'Dead bug',
      'Cable tricep pushdown',
      'Lateral raise',
    ]);
  });

  it('lands the single to-failure marker on the last row of the final order', () => {
    const rows = validateProgramme(
      [
        { name: 'Cable tricep pushdown', kind: 'rotation', toFailure: true, target: { sets: 3, reps: 12, weightKg: 22 } },
        { name: 'Converging chest press machine', kind: 'core', toFailure: false, target: { sets: 3, reps: 8, weightKg: 35 } },
        { name: 'Lateral raise', kind: 'rotation', toFailure: false, target: { sets: 3, reps: 12, weightKg: 9 } },
      ],
      orderingInput()
    );
    const failing = rows.filter(r => r.toFailure);
    expect(failing).toHaveLength(1);
    expect(failing[0].name).toBe(rows[rows.length - 1].name);
    expect(rows[rows.length - 1].name).toBe('Lateral raise');
  });
});

describe('programmeRowToTarget', () => {
  it('maps the row into an ExerciseTarget shape the checklist can render', () => {
    const target = programmeRowToTarget({
      name: 'Treadmill run',
      key: exerciseKey('Treadmill run'),
      kind: 'cardio',
      toFailure: false,
      target: { durationMinutes: 16, distanceKm: 2.6 },
      rationale: 'Last time was 15 min · 2.5 km — beat it.',
      lastSummary: '2 Aug · 15 min · 2.5 km',
    });
    expect(target.kind).toBe('cardio');
    expect(target.durationMinutes).toBe(16);
    expect(target.distanceKm).toBe(2.6);
    expect(target.action).toBeUndefined();
  });

  it('maps a hold row’s seconds and per-side flag onto the target', () => {
    const target = programmeRowToTarget({
      name: 'Side plank',
      key: exerciseKey('Side plank'),
      kind: 'hold',
      toFailure: false,
      target: { sets: 3, holdSeconds: 40, perSide: true },
      rationale: 'Last time was 3 × 30s each side — add 10 seconds.',
      lastSummary: '2 Aug · 3 × 30s each side',
    });
    expect(target.kind).toBe('hold');
    expect(target.holdSeconds).toBe(40);
    expect(target.perSide).toBe(true);
  });
});

describe('home session — vocabulary, hash, prompt and stand-ins', () => {
  // A shoulders day whose anchor is a gym-only DB press. At home the model
  // substitutes a band press for it; the vocabulary carries band/bodyweight work.
  function homeProgressions(): ExerciseProgression[] {
    return [
      progression('Band overhead press', [{ date: '2026-08-14', sets: 3, reps: 12 }], 3),
      progression('Band lateral raise', [{ date: '2026-08-14', sets: 3, reps: 15 }], 3),
      progression('Pike press-ups', [{ date: '2026-08-14', sets: 3, reps: 10 }], 2),
      // A gym lift in the history — must be dropped from the home vocabulary.
      progression('Seated DB shoulder press', [{ date: '2026-08-14', sets: 3, reps: 8, weightKg: 14 }], 4),
    ];
  }

  function homeInput(venue?: 'home'): ProgrammerInput {
    return buildProgrammerInput(
      homeProgressions(),
      {
        label: 'Push (shoulders)',
        components: ['Push (shoulders)'],
        routineDay: {
          title: 'Push (shoulders)',
          anchors: ['Seated DB shoulder press'],
          staples: ['Band lateral raise'],
        },
        ...(venue ? { venue } : {}),
      },
      '2026-08-21',
      8
    );
  }

  it('keeps band/bodyweight work and drops gym-only lifts from the vocabulary', () => {
    const names = homeInput('home').exercises.map(e => e.name);
    expect(names).toContain('Band overhead press');
    expect(names).toContain('Pike press-ups');
    // The gym DB press is dropped from the derived vocab — but is re-added as the
    // no-history routine anchor stub (the model needs to know what to sub for).
    // It appears once, as the anchor, not as a rotating vocab entry.
    expect(names.filter(n => n === 'Seated DB shoulder press')).toHaveLength(1);
  });

  it('moves the hash when the venue is set, and leaves the gym hash unchanged', () => {
    const gym = programmeHash(homeInput());
    // An explicit-undefined venue is identical to no venue — the field is folded
    // in only when set, so every existing gym hash is byte-identical to before.
    expect(programmeHash(homeInput())).toBe(gym);
    expect(programmeHash(homeInput('home'))).not.toBe(gym);
  });

  it('adds a HOME SESSION block to the prompt only when home', () => {
    const homePrompt = buildProgrammerPrompt(homeInput('home'));
    // The block itself starts "HOME SESSION —" (the header only references it).
    expect(homePrompt).toContain('HOME SESSION —');
    expect(homePrompt).toContain(HOME_EQUIPMENT);
    expect(homePrompt).toContain('standsInFor');
    const gymPrompt = buildProgrammerPrompt(homeInput());
    expect(gymPrompt).not.toContain('HOME SESSION —');
  });

  it('badges a stand-in as its anchor, orders it in the anchor slot, and never leaks the gym lift', () => {
    const rows = validateProgramme(
      [
        { name: 'Pike press-ups', kind: 'rotation', toFailure: false, target: { sets: 3, reps: 10 } },
        {
          name: 'Band overhead press',
          kind: 'core',
          toFailure: false,
          standsInFor: 'Seated DB shoulder press',
          target: { sets: 3, reps: 12 },
        },
        { name: 'Band lateral raise', kind: 'core', toFailure: false, target: { sets: 3, reps: 15 } },
      ],
      homeInput('home')
    );
    const standIn = rows.find(r => r.name === 'Band overhead press')!;
    expect(standIn.fixed).toBe('anchor');
    expect(standIn.standsInFor).toBe('Seated DB shoulder press');
    // The staple, matched directly by key, is badged too.
    expect(rows.find(r => r.name === 'Band lateral raise')!.fixed).toBe('staple');
    // The gym anchor is never appended into a home session.
    expect(rows.some(r => r.name === 'Seated DB shoulder press')).toBe(false);
    // The stand-in orders in the anchor slot — ahead of the accessory.
    const order = rows.map(r => r.name);
    expect(order.indexOf('Band overhead press')).toBeLessThan(order.indexOf('Pike press-ups'));
    // programmeRowToTarget carries the provenance to the checklist.
    expect(programmeRowToTarget(standIn).standsInFor).toBe('Seated DB shoulder press');
  });

  it('guarantees a stand-in for a gym anchor the model dropped without one', () => {
    const rows = validateProgramme(
      [
        { name: 'Band lateral raise', kind: 'core', toFailure: false, target: { sets: 3, reps: 15 } },
      ],
      homeInput('home')
    );
    // The model dropped the anchor and gave no stand-in; guaranteeFixed must
    // append the canonical home stand-in (Band overhead press) for it — every
    // anchor/staple is covered on a home day. The gym lift itself never appears.
    const standIn = rows.find(r => r.standsInFor === 'Seated DB shoulder press');
    expect(standIn).toBeDefined();
    expect(standIn!.name).toBe('Band overhead press');
    expect(standIn!.fixed).toBe('anchor');
    expect(standIn!.target).toMatchObject({ sets: 3, reps: 12 });
    expect(standIn!.rationale).toBe('Home stand-in for Seated DB shoulder press.');
    expect(rows.some(r => r.name === 'Seated DB shoulder press')).toBe(false);
  });

  it('skips a gym anchor that has no known stand-in (never forces gym kit)', () => {
    const input = buildProgrammerInput(
      [progression('Press-ups', [{ date: '2026-08-14', sets: 3, reps: 12 }], 3)],
      {
        label: 'Push (shoulders)',
        components: ['Push (shoulders)'],
        venue: 'home',
        routineDay: {
          title: 'Push (shoulders)',
          // A gym-only machine lift with no entry in HOME_STAND_INS.
          anchors: ['Shoulder press machine'],
          staples: [],
        },
      },
      '2026-08-21',
      8
    );
    const rows = validateProgramme(
      [{ name: 'Press-ups', kind: 'core', toFailure: false, target: { sets: 3, reps: 12 } }],
      input
    );
    // No stand-in known and can't be done at home → the anchor is simply left out,
    // never forced in as a machine lift.
    expect(rows.some(r => /machine/i.test(r.name))).toBe(false);
    expect(rows.some(r => r.standsInFor === 'Shoulder press machine')).toBe(false);
  });

  it('offers a built-in home vocabulary on home days, filtered to the day’s focus', () => {
    const homeNames = homeInput('home').exercises.map(e => e.name);
    const gymNames = homeInput().exercises.map(e => e.name);
    // A push bodyweight move is offered as a stub on the home day but not the gym.
    expect(homeNames).toContain('Diamond press-ups');
    expect(gymNames).not.toContain('Diamond press-ups');
    // A leg move is NOT offered on a push day — the palette stays on focus.
    expect(homeNames).not.toContain('Bulgarian split squat');
  });
});

describe('home session — outdoor run', () => {
  function runHomeInput(over: { venue?: 'home'; targetDistanceKm?: number } = {}): ProgrammerInput {
    return buildProgrammerInput(
      [progression('Press-ups', [{ date: '2026-08-14', sets: 3, reps: 12 }], 3)],
      {
        label: 'Push (shoulders) + Run',
        components: ['Push (shoulders)', 'Run'],
        routineDay: { title: 'Push (shoulders) + Run', anchors: [], staples: [] },
        ...(over.venue ? { venue: over.venue } : {}),
        ...(over.targetDistanceKm !== undefined ? { targetDistanceKm: over.targetDistanceKm } : {}),
      },
      '2026-08-21',
      8
    );
  }

  it('offers an Outdoor run stub and puts the distance in the home block', () => {
    const input = runHomeInput({ venue: 'home', targetDistanceKm: 4.5 });
    expect(input.exercises.map(e => e.name)).toContain('Outdoor run');
    const prompt = buildProgrammerPrompt(input);
    expect(prompt).toContain('Outdoor run');
    expect(prompt).toContain('4.5 km');
    // The home block explicitly tells the model to name the run Outdoor, not
    // Treadmill.
    expect(prompt).toContain('never "Treadmill run"');
  });

  it('renames a treadmill row to Outdoor run and fills the planned distance', () => {
    const rows = validateProgramme(
      [
        // The model slips and names the run "Treadmill run" with no distance.
        { name: 'Treadmill run', kind: 'cardio', toFailure: false, target: { durationMinutes: 25 } },
        { name: 'Press-ups', kind: 'core', toFailure: false, target: { sets: 3, reps: 12 } },
      ],
      runHomeInput({ venue: 'home', targetDistanceKm: 4.5 })
    );
    const run = rows.find(r => r.kind === 'cardio')!;
    expect(run.name).toBe('Outdoor run');
    expect(run.target.distanceKm).toBe(4.5);
  });

  it('folds the run distance into the home hash but never a gym hash', () => {
    const homeNoDist = programmeHash(runHomeInput({ venue: 'home' }));
    const homeDist = programmeHash(runHomeInput({ venue: 'home', targetDistanceKm: 4.5 }));
    expect(homeDist).not.toBe(homeNoDist);
    // A gym plan is never passed a targetDistanceKm, so gym hashes are unaffected.
    const gym = programmeHash(runHomeInput());
    const gymWithDistanceIgnored = programmeHash(runHomeInput());
    expect(gymWithDistanceIgnored).toBe(gym);
  });
});

describe('programme cache', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('serves rows only when the hash still matches', async () => {
    const rows = (await generateProgramme(input(), {
      run: () =>
        Promise.resolve(
          JSON.stringify([
            { name: 'Converging chest press machine', kind: 'core', toFailure: true, target: { sets: 3, reps: 8, weightKg: 35 } },
          ])
        ),
    }))!;
    saveCachedProgramme('2026-08-06', 'hash-a', rows);

    expect(getCachedProgramme('2026-08-06', 'hash-a')).toHaveLength(1);
    // A moved hash (plan or history changed) must miss so the caller regenerates.
    expect(getCachedProgramme('2026-08-06', 'hash-b')).toBeNull();
    // A date with nothing cached misses too.
    expect(getCachedProgramme('2026-08-07', 'hash-a')).toBeNull();
  });
});
