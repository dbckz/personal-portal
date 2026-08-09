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
import { exerciseKey, type ExerciseProgression, type ProgressionPoint } from '@/lib/exercise-progression';
import { getCachedProgramme, saveCachedProgramme } from '@/lib/storage/exercise-programmes';
import { parsePrescription } from '@/lib/exercise-prescription';
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

describe('a prescription constrains the programmer', () => {
  const { sections } = parsePrescription(
    'Anchors:\n- Converging chest press machine: 3 x 8–12\n- Cable shrugs: 2 x 15'
  );

  it('feeds the model exactly the prescribed exercises, in order, history or not', () => {
    const built = buildProgrammerInput(
      pushProgressions(),
      { label: 'Pull', components: ['Pull'], prescription: sections },
      '2026-08-06',
      6
    );
    // Only the two prescribed exercises — the treadmill run and tricep pushdown
    // from history are NOT offered.
    expect(built.exercises.map(e => e.name)).toEqual(['Converging chest press machine', 'Cable shrugs']);
    // The prescribed lift with no history is still included so the model loads it.
    const shrugs = built.exercises.find(e => e.key === exerciseKey('Cable shrugs'))!;
    expect(shrugs.frequency).toBe(0);
    expect(shrugs.lastSummary).toBe('no history');
  });

  it('writes a loads-only prompt that fixes the list, order and scheme', () => {
    const built = buildProgrammerInput(
      pushProgressions(),
      { label: 'Pull', components: ['Pull'], prescription: sections },
      '2026-08-06',
      6
    );
    const prompt = buildProgrammerPrompt(built);
    expect(prompt).toMatch(/ALREADY FIXED/);
    expect(prompt).toMatch(/Do NOT add, remove, reorder or substitute/i);
    expect(prompt).toContain('prescribed 3 x 8–12');
    expect(prompt).toContain('Anchors:');
  });

  it('folds the prescription into the hash so an edited plan regenerates', () => {
    const base = buildProgrammerInput(
      pushProgressions(),
      { label: 'Pull', components: ['Pull'], prescription: sections },
      '2026-08-06',
      6
    );
    const edited = parsePrescription(
      'Anchors:\n- Converging chest press machine: 3 x 6–10\n- Cable shrugs: 2 x 15'
    ).sections;
    const moved = buildProgrammerInput(
      pushProgressions(),
      { label: 'Pull', components: ['Pull'], prescription: edited },
      '2026-08-06',
      6
    );
    expect(programmeHash(moved)).not.toBe(programmeHash(base));
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
