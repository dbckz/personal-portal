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
  programmeHash,
  programmeRowToTarget,
  validateProgramme,
  type ProgrammerInput,
} from '@/lib/exercise-programmer';
import type { ProgrammerRoutineDay } from '@/lib/exercise-programmer';
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
