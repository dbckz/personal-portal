/**
 * @jest-environment node
 *
 * Prescription-driven targets. When the day's plan carries a prescription the
 * target list is EXACTLY the prescribed exercises, in the prescribed order:
 * their scheme (sets, rep/hold ranges, each-side) comes from the prescription,
 * their load and progression from history. A cached AI programme only refines
 * loads/rationales — it can never change the membership or order.
 */
import { buildPrescribedTargets } from '@/lib/exercise-targets';
import { parsePrescription } from '@/lib/exercise-prescription';
import { buildProgressions } from '@/lib/exercise-progression';
import type { ExerciseSession } from '@/types/life';
import type { ProgrammeRow } from '@/lib/exercise-programmer';
import { exerciseKey } from '@/lib/exercise-progression';

jest.mock('@/lib/storage/goals', () => ({ queryGoals: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/storage/exercise-programmes', () => ({
  getCachedProgramme: jest.fn(),
  saveCachedProgramme: jest.fn(),
}));

import { resolveSessionTargets } from '@/lib/exercise-session-targets';
import { getCachedProgramme } from '@/lib/storage/exercise-programmes';

const mockGetCached = getCachedProgramme as jest.Mock;

const DESCRIPTION = `Pull B — back width & arms.

Anchors (drive these up, log & beat last week):
- Seated cable row: 3 x 8–12

This week's accessories:
- Cable shrugs: 2 x 15

Core (proper session, ~15–20 min):
- Side plank: 3 x 30–45 sec each side`;

function plannedSession(): ExerciseSession {
  const { sections } = parsePrescription(DESCRIPTION);
  return {
    id: 'plan',
    date: '2026-08-10',
    type: 'strength',
    planned: true,
    completed: false,
    source: 'calendar',
    label: 'Pull (back & arms) + core',
    components: ['Pull (back & arms)', 'core'],
    prescription: sections,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

// A previous logged session: the cable row hit the TOP of its range (12) with
// reps to spare, the side plank held its lower bound, and an off-plan lift
// (bench press) that must NOT appear in the prescribed list.
function history(): ExerciseSession {
  return {
    id: 'prev',
    date: '2026-08-03',
    type: 'gym',
    planned: false,
    completed: true,
    source: 'manual',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    exercises: [
      { id: 'e1', name: 'Seated cable row', sets: 3, reps: 12, weightKg: 40, notes: 'could have done 3-4 more', done: true },
      { id: 'e2', name: 'Side plank', sets: 3, holdSeconds: 30, perSide: true, done: true },
      { id: 'e3', name: 'Bench press', sets: 3, reps: 8, weightKg: 60, done: true },
    ],
  };
}

describe('resolveSessionTargets — with a prescription', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCached.mockReturnValue(null);
  });

  it('returns exactly the prescribed exercises, in prescribed order', async () => {
    const { targets, source } = await resolveSessionTargets('2026-08-10', [plannedSession(), history()]);
    expect(source).toBe('fallback');
    expect(targets.map(t => t.name)).toEqual(['Seated cable row', 'Cable shrugs', 'Side plank']);
    // The off-plan bench press from history is not swept in.
    expect(targets.some(t => t.name === 'Bench press')).toBe(false);
  });

  it('carries the section, anchor flag and rep range onto the anchor lift', async () => {
    const { targets } = await resolveSessionTargets('2026-08-10', [plannedSession(), history()]);
    const row = targets.find(t => t.name === 'Seated cable row')!;
    expect(row.section).toBe('Anchors');
    expect(row.isAnchor).toBe(true);
    expect(row.kind).toBe('core');
    expect(row.sets).toBe(3);
    // Seeds the lower bound; the range is kept for the display text.
    expect(row.reps).toBe(8);
    expect(row.repsMin).toBe(8);
    expect(row.repsMax).toBe(12);
  });

  it('adds weight when history hit the top of the range with reps to spare', async () => {
    const { targets } = await resolveSessionTargets('2026-08-10', [plannedSession(), history()]);
    const row = targets.find(t => t.name === 'Seated cable row')!;
    // Last time was 12 reps (the top) at 40kg with 3-4 in reserve → go up.
    expect(row.action).toBe('increase');
    expect(row.weightKg).toBeGreaterThan(40);
  });

  it('reads a hold range in seconds and marks it each side', async () => {
    const { targets } = await resolveSessionTargets('2026-08-10', [plannedSession(), history()]);
    const plank = targets.find(t => t.name === 'Side plank')!;
    expect(plank.kind).toBe('hold');
    expect(plank.section).toBe('Core');
    expect(plank.perSide).toBe(true);
    expect(plank.holdSeconds).toBe(30);
    expect(plank.holdSecondsMin).toBe(30);
    expect(plank.holdSecondsMax).toBe(45);
  });

  it('gives an exercise with no history a no-history target rather than dropping it', async () => {
    const { targets } = await resolveSessionTargets('2026-08-10', [plannedSession(), history()]);
    const shrugs = targets.find(t => t.name === 'Cable shrugs')!;
    expect(shrugs.action).toBe('no-history');
    expect(shrugs.sets).toBe(2);
    expect(shrugs.reps).toBe(15);
    expect(shrugs.weightKg).toBeUndefined();
  });

  it('overlays a cached AI programme’s loads and rationale, keeping the prescribed list and order', async () => {
    const rows: ProgrammeRow[] = [
      // The model's chosen load and rationale for a prescribed lift.
      {
        name: 'Seated cable row',
        key: exerciseKey('Seated cable row'),
        kind: 'core',
        toFailure: false,
        target: { weightKg: 44 },
        rationale: 'Hit 12 at 40kg with plenty left — 44kg this week.',
        lastSummary: '3 Aug · 3 × 12 · 40kg',
      },
      // An off-plan exercise the model should never be able to inject.
      {
        name: 'Bench press',
        key: exerciseKey('Bench press'),
        kind: 'core',
        toFailure: false,
        target: { sets: 3, reps: 8, weightKg: 62 },
        rationale: 'should be ignored',
        lastSummary: '3 Aug · 3 × 8 · 60kg',
      },
    ];
    mockGetCached.mockReturnValue(rows);

    const { targets, source } = await resolveSessionTargets('2026-08-10', [plannedSession(), history()]);
    expect(source).toBe('ai');
    // Still exactly the prescription, in order — the AI's bench press is dropped
    // and the un-programmed shrugs are backfilled deterministically.
    expect(targets.map(t => t.name)).toEqual(['Seated cable row', 'Cable shrugs', 'Side plank']);

    const row = targets.find(t => t.name === 'Seated cable row')!;
    expect(row.weightKg).toBe(44);
    expect(row.rationale).toBe('Hit 12 at 40kg with plenty left — 44kg this week.');
    // The scheme is still the prescription's, not the model's.
    expect(row.reps).toBe(8);
    expect(row.repsMax).toBe(12);

    const shrugs = targets.find(t => t.name === 'Cable shrugs')!;
    expect(shrugs.action).toBe('no-history');
  });
});

describe('buildPrescribedTargets — progression semantics', () => {
  function progressionsFrom(session: ExerciseSession) {
    return buildProgressions([session]);
  }

  it('holds the weight and drives reps up when below the top of the range', () => {
    const { sections } = parsePrescription('Anchors:\n- Seated cable row: 3 x 8–12');
    // Last time only 9 reps (mid-range) at 40kg → stay and build reps.
    const prog = progressionsFrom({
      id: 'h', date: '2026-08-03', type: 'gym', planned: false, completed: true, source: 'manual',
      createdAt: '', updatedAt: '',
      exercises: [{ id: 'x', name: 'Seated cable row', sets: 3, reps: 9, weightKg: 40, done: true }],
    });
    const [row] = buildPrescribedTargets(sections, prog);
    expect(row.action).toBe('add-reps');
    expect(row.weightKg).toBe(40);
  });

  it('parses a single value as reps, not a range (no en-dash)', () => {
    const { sections } = parsePrescription('Work:\n- Cable shrugs: 2 x 15');
    const [row] = buildPrescribedTargets(sections, []);
    expect(row.sets).toBe(2);
    expect(row.reps).toBe(15);
    expect(row.repsMin).toBe(15);
    expect(row.repsMax).toBe(15);
  });
});
