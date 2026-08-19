/**
 * @jest-environment node
 *
 * The session-target recommender. The notes quoted here are real ones from the
 * training log — reading effort out of them is the whole basis of the
 * recommendation, so they are the cases that matter.
 */
import {
  buildTarget,
  buildSessionTargets,
  classifyExercise,
  describeLast,
  describeVolumeLoad,
  formatEntryDuration,
  readEffort,
  selectPlanProgressions,
} from '@/lib/exercise-targets';
import type { ExerciseProgression, ProgressionPoint } from '@/lib/exercise-progression';

function progression(latest: ProgressionPoint, name = 'Converging chest press machine'): ExerciseProgression {
  return { name, key: name.toLowerCase(), sessions: 1, points: [latest], first: latest, latest };
}

describe('readEffort', () => {
  it('reads a numeric range of reps in reserve', () => {
    expect(readEffort('Could have done 1-2 more per set at most').rir).toBe(1.5);
    expect(readEffort('Could have done 3-4 more per set').rir).toBe(3.5);
    expect(readEffort('Could have done 2-3 more').rir).toBe(2.5);
  });

  it('reads vaguer phrasings', () => {
    expect(readEffort('About right — couple in tank').rir).toBe(2);
    expect(readEffort('Could have done quite a few more- up the weight').rir).toBe(4);
    expect(readEffort('Easy — add weight').rir).toBe(4);
  });

  it('recognises being at the limit', () => {
    expect(readEffort('At limit, make lighter').rir).toBe(0);
    expect(readEffort('Incredibly hard').rir).toBe(0);
  });

  it('spots a set that was not completed', () => {
    expect(
      readEffort('Struggled. Second set only did 7, third set reduced to 25.2').failed
    ).toBe(true);
    expect(readEffort('Only managed 8 in second and third set').failed).toBe(true);
  });

  it('picks up explicit instructions in either direction', () => {
    expect(readEffort('Could have done quite a few more- up the weight').explicit).toBe('up');
    expect(readEffort('At limit, make lighter').explicit).toBe('down');
    expect(readEffort('Couldnt do any more - switch to 6kg').explicit).toBe('down');
  });

  it('says nothing when the note says nothing about effort', () => {
    expect(readEffort('')).toEqual({});
    expect(readEffort(undefined)).toEqual({});
    // Silence must not be read as "that was easy".
    expect(readEffort('Did it at the new gym').rir).toBeUndefined();
  });

  it('reads spare capacity from hold and cardio phrasing, not just reps', () => {
    // A hold: seconds it could have held on for.
    expect(readEffort('Could have held it 20 seconds longer').rir).toBe(20);
    // A run: capacity stated as a remainder rather than "could have".
    expect(readEffort('Had another 5 minutes in me').rir).toBe(5);
    expect(readEffort('Could have gone another 2 km').rir).toBe(2);
    // Rep phrasing is unchanged.
    expect(readEffort('Could have done 2 more').rir).toBe(2);
  });
});

describe('buildTarget', () => {
  it('adds weight when there were reps in reserve', () => {
    const target = buildTarget(
      progression({
        date: '2026-08-03',
        weightKg: 32,
        sets: 3,
        reps: 8,
        notes: 'Could have done 3-4 more per set',
      })
    );
    expect(target.action).toBe('increase');
    // 3.5 RIR earns the larger 10% step.
    expect(target.weightKg).toBe(35);
    expect(target.reps).toBe(8);
    expect(target.rationale).toMatch(/reps left in reserve/);
  });

  it('takes a smaller step when there was only a rep or two spare', () => {
    const target = buildTarget(
      progression({ date: '2026-08-03', weightKg: 40, sets: 3, reps: 8, notes: 'About right — couple in tank' })
    );
    expect(target.action).toBe('increase');
    expect(target.weightKg).toBe(42); // 5% of 40, rounded to the half kilo
  });

  it('holds the weight after a session at the limit', () => {
    const target = buildTarget(
      progression({ date: '2026-08-03', weightKg: 45, sets: 3, reps: 8, notes: 'At limit' })
    );
    expect(target.action).toBe('hold');
    expect(target.weightKg).toBe(45);
  });

  it('reduces when the note says it was too heavy', () => {
    // The real case: shoulder press at 25.3kg, "At limit, make lighter".
    const target = buildTarget(
      progression({ date: '2026-07-27', weightKg: 25.3, sets: 3, reps: 8, notes: 'At limit, make lighter' })
    );
    expect(target.action).toBe('reduce');
    expect(target.weightKg).toBe(23);
    expect(target.rationale).toMatch(/too heavy/);
  });

  it('holds rather than reducing when only a rep or two was missed', () => {
    const target = buildTarget(
      progression({
        date: '2026-08-02',
        weightKg: 10,
        sets: 3,
        reps: 10,
        notes: 'Only managed 8 in second and third set',
      })
    );
    // Missing two reps is a completion problem, not a wrong-weight problem —
    // the weight stays and the sets get finished. Only an explicit "too heavy"
    // triggers a cut.
    expect(target.action).toBe('hold');
    expect(target.weightKg).toBe(10);
    expect(target.rationale).toMatch(/complete all 3 sets of 10/);
  });

  it('progresses bodyweight work by reps, not by load', () => {
    const target = buildTarget(
      progression(
        { date: '2026-08-04', sets: 3, reps: 8, notes: 'Felt good, could have done a couple more' },
        'Dead bug'
      )
    );
    expect(target.action).toBe('add-reps');
    expect(target.weightKg).toBeUndefined();
    expect(target.reps).toBe(10);
  });

  it('progresses a timed hold by seconds, tagged as a hold and each side', () => {
    const target = buildTarget(
      progression(
        { date: '2026-08-04', sets: 3, holdSeconds: 30, notes: 'Felt really good, could have done a couple more' },
        'Side plank'
      )
    );
    // A hold gains seconds, not reps, so the action is the distinct 'add-time'.
    expect(target.action).toBe('add-time');
    expect(target.holdSeconds).toBe(40);
    expect(target.reps).toBeUndefined();
    expect(target.kind).toBe('hold');
    // "Side plank" reads as unilateral, so the aim is per side.
    expect(target.perSide).toBe(true);
    expect(target.rationale).toMatch(/each side/);
  });

  it('tags a plank a hold even before any seconds are logged', () => {
    // Named a plank but logged as reps by mistake: still shows as a hold so the
    // Today form asks for seconds.
    const target = buildTarget(progression({ date: '2026-08-04', sets: 3, reps: 30 }, 'Front plank'));
    expect(target.kind).toBe('hold');
  });

  it('does NOT treat a Dead bug as a hold', () => {
    const target = buildTarget(
      progression({ date: '2026-08-04', sets: 3, reps: 8, notes: 'Could have done a couple more' }, 'Dead bug')
    );
    expect(target.kind).toBeUndefined();
    expect(target.action).toBe('add-reps');
  });

  it('lets an explicit rir rating override the prose note', () => {
    const target = buildTarget(
      progression({ date: '2026-08-03', weightKg: 40, sets: 3, reps: 8, notes: 'At limit', rir: 3 })
    );
    // The note alone ("At limit") would hold; the tapped 3-in-reserve is
    // decisive and says go up.
    expect(target.action).toBe('increase');
    expect(target.weightKg).toBe(44); // 10% of 40 for a comfortable set
  });

  it('acts on an explicit rir with no note at all', () => {
    const up = buildTarget(progression({ date: '2026-08-03', weightKg: 40, sets: 3, reps: 8, rir: 2 }));
    expect(up.action).toBe('increase');
    expect(up.weightKg).toBe(42); // 5% of 40 for a rep or two spare

    const hold = buildTarget(progression({ date: '2026-08-03', weightKg: 40, sets: 3, reps: 8, rir: 0 }));
    expect(hold.action).toBe('hold');
    expect(hold.weightKg).toBe(40);
  });

  it('progresses bodyweight work off an explicit rir', () => {
    const target = buildTarget(
      progression({ date: '2026-08-04', sets: 3, reps: 8, rir: 2 }, 'Dead bug')
    );
    expect(target.action).toBe('add-reps');
    expect(target.reps).toBe(10);
  });

  it('holds when the note gives no reason to move', () => {
    const target = buildTarget(progression({ date: '2026-08-03', weightKg: 15, sets: 3, reps: 12 }));
    expect(target.action).toBe('hold');
    expect(target.weightKg).toBe(15);
  });

  it('reports having no history to go on', () => {
    const empty: ExerciseProgression = { name: 'Hack squat', key: 'hack squat', sessions: 0, points: [] };
    expect(buildTarget(empty).action).toBe('no-history');
  });

  it('asks a run with no numbers logged for its distance and time, not reps', () => {
    // A run recognised by name but logged with no measures, and a spare-effort
    // note: it must NOT be told to "add a couple of reps".
    const target = buildTarget(
      progression({ date: '2026-08-02', notes: 'Felt easy, could have kept going' }, 'Outdoor run')
    );
    expect(target.kind).toBe('cardio');
    expect(target.action).toBe('hold');
    expect(target.rationale).toBe('No distance or time logged last time — record them today.');
    expect(target.reps).toBeUndefined();
  });

  it('does not fabricate rep targets for a weighted hold', () => {
    // A weighted plank has a load, so it lands on the loaded path — but the
    // clause must be built from the logged hold, never "3 × 8".
    const target = buildTarget(
      progression(
        { date: '2026-08-02', sets: 3, holdSeconds: 45, weightKg: 10, notes: 'Struggled on the last set' },
        'Weighted plank'
      )
    );
    expect(target.action).toBe('hold');
    expect(target.rationale).toContain('45s');
    expect(target.rationale).not.toMatch(/sets of 8|× ?8\b/);
  });

  it('omits the volume clause when a loaded carry has neither reps nor a hold', () => {
    const target = buildTarget(
      progression({ date: '2026-08-02', sets: 3, weightKg: 24, notes: 'Struggled' }, "Farmer's carry")
    );
    expect(target.rationale).toMatch(/every set is complete/);
    expect(target.rationale).not.toMatch(/sets of/);
  });

  it('targets a treadmill piece in time only, never distance', () => {
    // A treadmill is measured in MINUTES: a logged "distance" is really a speed,
    // so the target carries the duration and drops the distance entirely.
    const target = buildTarget(
      progression({ date: '2026-08-02', durationMinutes: 15, distanceKm: 2.5 }, 'Treadmill run')
    );
    expect(target.kind).toBe('cardio');
    expect(target.durationMinutes).toBe(15);
    expect(target.distanceKm).toBeUndefined();
    // The rationale reads in minutes with no fabricated distance.
    expect(target.rationale).toContain('15 min');
    expect(target.rationale).not.toContain('km');
    // The historical summary still records whatever was logged, distance and all.
    expect(target.lastSummary).toBe('2 Aug · 15 min · 2.5 km');
  });

  it('keeps distance for a non-treadmill cardio piece', () => {
    // An outdoor run's distance is real, so it survives.
    const target = buildTarget(
      progression({ date: '2026-08-02', durationMinutes: 15, distanceKm: 2.5 }, 'Outdoor run')
    );
    expect(target.kind).toBe('cardio');
    expect(target.durationMinutes).toBe(15);
    expect(target.distanceKm).toBe(2.5);
    expect(target.rationale).toContain('15 min · 2.5 km');
  });
});

describe('formatEntryDuration', () => {
  it('keeps whole minutes as minutes', () => {
    expect(formatEntryDuration(20)).toBe('20 min');
  });

  it('renders a sub-minute piece in seconds', () => {
    expect(formatEntryDuration(0.75)).toBe('45 secs');
    expect(formatEntryDuration(0.5)).toBe('30 secs');
  });

  it('splits a fractional minute over a minute into minutes and seconds', () => {
    expect(formatEntryDuration(1.5)).toBe('1 min 30 secs');
  });
});

describe('describeVolumeLoad', () => {
  it('renders duration and distance for cardio', () => {
    expect(describeVolumeLoad({ durationMinutes: 15, distanceKm: 3.5 })).toBe('15 min · 3.5 km');
  });

  it('renders a sub-minute plank hold in seconds', () => {
    expect(describeVolumeLoad({ durationMinutes: 0.75 })).toBe('45 secs');
  });

  it('renders sets, reps and load for strength', () => {
    expect(describeVolumeLoad({ sets: 3, reps: 8, weightKg: 40 })).toBe('3 × 8 · 40kg');
  });

  it('appends "each side" for unilateral work', () => {
    expect(describeVolumeLoad({ sets: 3, reps: 8, perSide: true })).toBe('3 × 8 each side');
    expect(describeVolumeLoad({ sets: 3, holdSeconds: 30, perSide: true })).toBe('3 × 30s each side');
  });

  it('renders a set-less hold on its own', () => {
    // A lone "90s plank" with no set count must not render blank.
    expect(describeVolumeLoad({ holdSeconds: 90 })).toBe('90s');
  });
});

describe('describeLast', () => {
  it('leads with the date and includes the numbers', () => {
    expect(describeLast({ date: '2026-08-02', sets: 3, reps: 10, weightKg: 39 })).toBe(
      '2 Aug · 3 × 10 · 39kg'
    );
    expect(describeLast({ date: '2026-08-02', durationMinutes: 15 })).toBe('2 Aug · 15 min');
  });
});

describe('classifyExercise', () => {
  it('assigns each name to exactly one group by precedence', () => {
    // The cases that regressed in production: a shared word must not pull an
    // exercise into the wrong group.
    expect(classifyExercise('Leg press')).toBe('legs'); // not push (\bpress\b)
    expect(classifyExercise('Reverse pec deck machine')).toBe('pull'); // not push (\bpec\b)
    expect(classifyExercise('Converging shoulder press')).toBe('push');
    expect(classifyExercise('High plank shoulder taps')).toBe('core'); // not push (\bshoulder\b)
    expect(classifyExercise('Treadmill run')).toBe('run');
    expect(classifyExercise('Paloff press')).toBe('core'); // not push (\bpress\b)
    expect(classifyExercise('Pallof press')).toBe('core');
  });

  it("classifies Dave's real pull staples as pull", () => {
    for (const name of [
      'Lat pulldown',
      'Cable row',
      'Seated row',
      'Cable bicep curl',
      'DB bicep curl',
      'Face pull',
      'Rear delt machine',
      'Neutral-grip pull-up',
    ]) {
      expect(classifyExercise(name)).toBe('pull');
    }
  });

  it('returns null for a name that matches no group', () => {
    expect(classifyExercise('Farmer carry')).toBeNull();
  });
});

describe('selectPlanProgressions', () => {
  function prog(name: string): ExerciseProgression {
    const point: ProgressionPoint = { date: '2026-08-01', sets: 3, reps: 8, weightKg: 20 };
    return { name, key: name.toLowerCase(), sessions: 1, points: [point], first: point, latest: point };
  }

  it('returns only pull and core work for a pull + core day', () => {
    const progressions = [
      prog('Lat pulldown'),
      prog('Cable row'),
      prog('Cable bicep curl'),
      prog('Pallof press'),
      prog('High plank shoulder taps'),
      // Contaminants that a shared-word filter used to sweep in.
      prog('Leg press'),
      prog('Converging chest press'),
      prog('Converging shoulder press'),
      prog('DB lateral raise'),
    ];
    const selected = selectPlanProgressions(progressions, ['Pull (back & arms)', 'core']);
    const names = selected.map(p => p.name);
    expect(names).toEqual([
      'Lat pulldown',
      'Cable row',
      'Cable bicep curl',
      'Pallof press',
      'High plank shoulder taps',
    ]);
    expect(names).not.toContain('Leg press');
    expect(names).not.toContain('Converging chest press');
  });

  it('does not activate push on a "Pull (back & arms)" day', () => {
    // 'arms' must not switch push on — the regression that put pushes on a pull
    // day.
    const selected = selectPlanProgressions(
      [prog('Converging chest press'), prog('Lat pulldown')],
      ['Pull (back & arms)']
    );
    expect(selected.map(p => p.name)).toEqual(['Lat pulldown']);
  });

  it('keeps pushes on a push day', () => {
    const selected = selectPlanProgressions(
      [prog('Converging chest press'), prog('Lat pulldown')],
      ['Push (chest & arms)']
    );
    expect(selected.map(p => p.name)).toEqual(['Converging chest press']);
  });

  it('falls back to the full list when the plan words are unfamiliar', () => {
    const progressions = [prog('Lat pulldown'), prog('Leg press')];
    expect(selectPlanProgressions(progressions, ['Mobility flow'])).toEqual(progressions);
  });

  it('budgets each group independently on a combined day, yielding more candidates', () => {
    // A combined Pull + Legs day is its own two mini-sessions: each group gets its
    // own budget (6 strength), so a pull-heavy history still keeps every leg piece
    // AND the total is larger than a single-group day drawing on the same history.
    const progressions = [
      prog('Lat pulldown'),
      prog('Cable row'),
      prog('Cable bicep curl'),
      prog('Face pull'),
      prog('Chin-up'),
      prog('Barbell shrug'),
      prog('Rear delt fly'),
      prog('Leg extension'),
      prog('Glute bridge'),
      prog('Standing calf raise'),
      prog('Reverse lunge'),
    ];
    const legNames = ['Leg extension', 'Glute bridge', 'Standing calf raise', 'Reverse lunge'];
    const combined = selectPlanProgressions(progressions, ['Pull (back & arms)', 'Legs']).map(p => p.name);
    // Pull budget 6 (of 7 available) + all 4 legs = 10 candidates.
    expect(combined).toHaveLength(10);
    expect(combined.filter(n => legNames.includes(n))).toEqual(legNames);
    expect(combined.filter(n => !legNames.includes(n))).toHaveLength(6);
    // The same history on a single-group day yields fewer — the combined day is
    // intentionally longer, not squeezed into one shared cap.
    const pullOnly = selectPlanProgressions(progressions, ['Pull (back & arms)']).map(p => p.name);
    expect(pullOnly).toHaveLength(7);
    expect(combined.length).toBeGreaterThan(pullOnly.length);
  });

  it('caps the core group lower so core never balloons a combined day', () => {
    const progressions = [
      prog('Lat pulldown'),
      prog('Cable row'),
      prog('Plank'),
      prog('Dead bug'),
      prog('Hanging leg raise'),
      prog('Pallof press'),
      prog('Cable crunch'),
      prog('Hollow hold'),
    ];
    const coreNames = ['Plank', 'Dead bug', 'Hanging leg raise', 'Pallof press', 'Cable crunch', 'Hollow hold'];
    const names = selectPlanProgressions(progressions, ['Pull (back)', 'core']).map(p => p.name);
    // Six core exercises available, but core is capped at 4.
    expect(names.filter(n => coreNames.includes(n))).toHaveLength(4);
    // The pull group is unaffected by the core cap.
    expect(names).toContain('Lat pulldown');
    expect(names).toContain('Cable row');
  });

  it('leaves a single-group day as the top-N by frequency', () => {
    const progressions = Array.from({ length: 10 }, (_, i) => prog(`Cable row ${i}`));
    const names = selectPlanProgressions(progressions, ['Pull (back)']).map(p => p.name);
    expect(names).toEqual(progressions.slice(0, 8).map(p => p.name));
  });
});

describe('buildSessionTargets', () => {
  function prog(name: string): ExerciseProgression {
    const point: ProgressionPoint = { date: '2026-08-01', sets: 3, reps: 8, weightKg: 20 };
    return { name, key: name.toLowerCase(), sessions: 1, points: [point], first: point, latest: point };
  }

  it('builds targets only for the plan-relevant exercises', () => {
    const targets = buildSessionTargets(
      [prog('Lat pulldown'), prog('Leg press'), prog('Pallof press')],
      ['Pull (back & arms)', 'core']
    );
    expect(targets.map(t => t.name)).toEqual(['Lat pulldown', 'Pallof press']);
  });

  function cardioProg(name: string, sessions: number): ExerciseProgression {
    const point: ProgressionPoint = { date: '2026-08-01', durationMinutes: 15, distanceKm: 3 };
    return { name, key: name.toLowerCase(), sessions, points: [point], first: point, latest: point };
  }

  it('keeps at most one cardio piece, leading the session', () => {
    // Two runs are offered; only one survives, and it comes first.
    const targets = buildSessionTargets(
      [cardioProg('Treadmill run', 5), cardioProg('Outdoor run', 2), prog('Pallof press')],
      ['Run', 'core']
    );
    const cardio = targets.filter(t => t.kind === 'cardio');
    expect(cardio).toHaveLength(1);
    // With no distinguishing wording, the most-trained cardio (Treadmill, seen
    // more often) wins, and cardio leads.
    expect(targets[0].name).toBe('Treadmill run');
  });

  it('prefers the cardio whose name echoes the plan wording', () => {
    // Outdoor run is the most-trained, but the plan names the treadmill.
    const targets = buildSessionTargets(
      [cardioProg('Outdoor run', 5), cardioProg('Treadmill run', 2)],
      ['Treadmill']
    );
    const cardio = targets.filter(t => t.kind === 'cardio');
    expect(cardio).toHaveLength(1);
    expect(cardio[0].name).toBe('Treadmill run');
  });
});
