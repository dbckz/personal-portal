/**
 * Round-trip tests for goal storage, focused on the rules that keep the
 * quarterly→monthly hierarchy honest: nesting is validated on write, not
 * trusted from the client.
 */
import {
  addCheckIn,
  createGoal,
  deleteGoal,
  getAllGoals,
  queryGoals,
  updateGoal,
} from '@/lib/storage/goals';
import { __resetDbForTests } from '@/lib/storage/db';

describe('goal storage', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  const quarterly = () =>
    createGoal({
      sectionId: 'work',
      periodKind: 'quarter',
      periodKey: '2026-Q3',
      title: 'Land the policy programme',
    });

  it('starts empty', async () => {
    expect(await getAllGoals()).toEqual([]);
  });

  it('creates a goal with sensible defaults', async () => {
    const goal = await createGoal({
      sectionId: 'exercise',
      periodKind: 'month',
      periodKey: '2026-08',
      title: '  Run 60km  ',
      target: { value: 60, unit: 'km' },
    });

    expect(goal.title).toBe('Run 60km');
    expect(goal.status).toBe('active');
    expect(goal.checkIns).toEqual([]);
    // Evidence defaults to self-reported rather than guessing a source.
    expect(goal.evidence).toEqual({ kind: 'manual' });
  });

  it('rejects an unknown section and a malformed period key', async () => {
    await expect(
      createGoal({ sectionId: 'gardening', periodKind: 'month', periodKey: '2026-08', title: 'x' })
    ).rejects.toThrow(/Unknown section/);

    await expect(
      createGoal({ sectionId: 'work', periodKind: 'month', periodKey: '2026-13', title: 'x' })
    ).rejects.toThrow(/Invalid month key/);
  });

  it('rejects an empty title', async () => {
    await expect(
      createGoal({ sectionId: 'work', periodKind: 'month', periodKey: '2026-08', title: '   ' })
    ).rejects.toThrow(/title is required/);
  });

  it('nests a monthly goal under a quarterly goal in the containing quarter', async () => {
    const parent = await quarterly();
    const child = await createGoal({
      sectionId: 'work',
      periodKind: 'month',
      periodKey: '2026-08',
      title: 'Publish two briefs',
      parentGoalId: parent.id,
    });
    expect(child.parentGoalId).toBe(parent.id);
  });

  it('refuses a parent from the wrong quarter, section, or period kind', async () => {
    const parent = await quarterly();

    // 2026-11 is in Q4, not Q3.
    await expect(
      createGoal({
        sectionId: 'work',
        periodKind: 'month',
        periodKey: '2026-11',
        title: 'x',
        parentGoalId: parent.id,
      })
    ).rejects.toThrow(/quarter must contain/);

    await expect(
      createGoal({
        sectionId: 'music',
        periodKind: 'month',
        periodKey: '2026-08',
        title: 'x',
        parentGoalId: parent.id,
      })
    ).rejects.toThrow(/same section/);

    // A quarterly goal can't itself have a parent.
    await expect(
      createGoal({
        sectionId: 'work',
        periodKind: 'quarter',
        periodKey: '2026-Q3',
        title: 'x',
        parentGoalId: parent.id,
      })
    ).rejects.toThrow(/Only monthly goals/);
  });

  it('filters by section, period and status', async () => {
    await quarterly();
    await createGoal({ sectionId: 'exercise', periodKind: 'month', periodKey: '2026-08', title: 'Run' });
    await createGoal({ sectionId: 'work', periodKind: 'month', periodKey: '2026-08', title: 'Write' });

    expect(await queryGoals({ sectionId: 'exercise' })).toHaveLength(1);
    expect(await queryGoals({ periodKind: 'month' })).toHaveLength(2);
    expect(await queryGoals({ periodKey: '2026-Q3' })).toHaveLength(1);
    expect(await queryGoals({ status: 'active' })).toHaveLength(3);
  });

  it('stamps closedAt when a goal reaches a terminal status, and clears it on reopen', async () => {
    const goal = await createGoal({
      sectionId: 'work',
      periodKind: 'month',
      periodKey: '2026-08',
      title: 'Write',
    });

    const closed = await updateGoal(goal.id, { status: 'hit', reflection: 'Went well' });
    expect(closed?.closedAt).toBeTruthy();
    expect(closed?.reflection).toBe('Went well');

    const reopened = await updateGoal(goal.id, { status: 'active' });
    expect(reopened?.closedAt).toBeUndefined();
    // Reopening only touches the status/closedAt — the reflection written when it
    // was closed is left in place.
    expect(reopened?.reflection).toBe('Went well');
  });

  it('records check-ins in order and adopts a reported figure', async () => {
    const goal = await createGoal({
      sectionId: 'work',
      periodKind: 'month',
      periodKey: '2026-08',
      title: 'Write',
    });

    await addCheckIn(goal.id, { status: 'slipping', source: 'weekly-review' });
    const after = await addCheckIn(goal.id, { status: 'on-track', source: 'goals-tab', value: 4 });

    expect(after?.checkIns.map(c => c.status)).toEqual(['slipping', 'on-track']);
    // A check-in carrying a figure IS the manual reading — no separate save.
    expect(after?.manualValue).toBe(4);
  });

  it('orphans children rather than cascading a delete', async () => {
    const parent = await quarterly();
    const child = await createGoal({
      sectionId: 'work',
      periodKind: 'month',
      periodKey: '2026-08',
      title: 'Publish two briefs',
      parentGoalId: parent.id,
    });

    expect(await deleteGoal(parent.id)).toBe(true);
    const remaining = await getAllGoals();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(child.id);
    expect(remaining[0].parentGoalId).toBeUndefined();
  });

  it('reports a delete of something that isn’t there', async () => {
    expect(await deleteGoal('nope')).toBe(false);
  });

  it('stores a progression plan, cleaning it to in-period, monotone milestones', async () => {
    const goal = await createGoal({
      sectionId: 'exercise',
      periodKind: 'quarter',
      periodKey: '2026-Q3',
      title: 'Run 10K',
      target: { value: 10, unit: 'km' },
      evidence: { kind: 'exercise', unit: 'max-distance-km' },
      planSource: 'ai',
      plan: [
        { key: '2026-08-31', value: 7, label: '7 km' },
        { key: '2026-07-31', value: 5, label: '5 km' },
        { key: '2026-12-01', value: 12, label: 'in Q4' }, // out of period, dropped
      ],
    });

    expect(goal.planSource).toBe('ai');
    // Sorted by date, out-of-period entry gone.
    expect(goal.plan?.map(m => m.key)).toEqual(['2026-07-31', '2026-08-31']);
  });

  it('updates and clears a plan', async () => {
    const goal = await createGoal({
      sectionId: 'exercise',
      periodKind: 'month',
      periodKey: '2026-08',
      title: 'Run',
      target: { value: 6, unit: 'km' },
      plan: [{ key: '2026-08-15', value: 4, label: '4 km' }],
    });
    expect(goal.plan).toHaveLength(1);

    const emptied = await updateGoal(goal.id, { plan: [] });
    expect(emptied?.plan).toBeUndefined();
    expect(emptied?.planSource).toBeUndefined();
  });
});
