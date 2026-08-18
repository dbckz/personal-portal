/**
 * Tests for the pure "Plan my week" scheduling engine.
 * All Dates are built with the local Date constructor so the tests are
 * timezone-independent.
 */
import {
  proposeBlocks,
  slotIsValid,
  findSlot,
  computeSpareCapacity,
  type BusyMs,
  type WorkRun,
  type WorkingDay,
  type Window,
  type UnplaceableTask,
} from '@/lib/scheduling/engine';
import type { CandidateTask, ProposeBlocksInput } from '@/lib/scheduling/types';
import type { WorkflowConfig } from '@/lib/workflow-config-storage';

const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// A Monday.
const WEEK_START = new Date(2026, 6, 13, 0, 0, 0, 0); // 2026-07-13
const dateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function makeConfig(overrides: {
  quotas?: WorkflowConfig['taskQuotas'];
  typeMapping?: WorkflowConfig['typeMapping'];
  scheduling?: Partial<WorkflowConfig['scheduling']>;
} = {}): WorkflowConfig {
  return {
    taskQuotas: overrides.quotas ?? {
      Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: ['09:00-11:00'] },
    },
    typeMapping: overrides.typeMapping ?? { Deep: ['deep'] },
    scheduling: {
      bufferBetweenTasks: '30min',
      workingDays: ALL_DAYS,
      workingHours: { start: '09:00', end: '17:00' },
      ...overrides.scheduling,
    },
    lastUpdated: '2026-07-12T00:00:00.000Z',
  };
}

function task(overrides: Partial<CandidateTask> & { gid: string }): CandidateTask {
  return {
    title: `Task ${overrides.gid}`,
    typeSignals: ['deep'],
    integrationId: 'asana-1',
    ...overrides,
  };
}

function makeInput(overrides: Partial<ProposeBlocksInput> = {}): ProposeBlocksInput {
  return {
    config: makeConfig(),
    busyIntervals: [],
    candidateTasks: [],
    existingScheduledCounts: {},
    weekStart: WEEK_START,
    now: WEEK_START, // Monday 00:00, no now-cutoff within the week
    ...overrides,
  };
}

describe('proposeBlocks - basics', () => {
  it('places a candidate task in its preferred window', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({ quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['09:00-11:00'] } } }),
        candidateTasks: [task({ gid: 'a' })],
      })
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].category).toBe('Deep');
    expect(proposals[0].task?.gid).toBe('a');
    expect(proposals[0].date).toBe(dateStr(WEEK_START));
    expect(proposals[0].start).toBe('09:00');
    expect(proposals[0].durationMinutes).toBe(60);
  });

  it('emits a reserved block when quota remains but no task is available', () => {
    const proposals = proposeBlocks(
      makeInput({ candidateTasks: [task({ gid: 'a' })] }) // weeklyCount 2, only 1 task
    );
    expect(proposals).toHaveLength(2);
    expect(proposals[0].task?.gid).toBe('a');
    expect(proposals[1].task).toBeUndefined();
    expect(proposals[1].reason).toMatch(/reserved/i);
  });

  it('with no candidates at all, fills the whole quota with reserved blocks', () => {
    const proposals = proposeBlocks(makeInput());
    expect(proposals).toHaveLength(2);
    expect(proposals.every(p => p.task === undefined)).toBe(true);
  });

  it('schedules nothing for a no-weeklyCount category with no candidate tasks', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Todos: { targetLength: '30min', preferredTimes: [] } },
          typeMapping: { Todos: ['todo'] },
        }),
        candidateTasks: [],
      })
    );
    // No target to fill toward and no selected tasks -> no reserved filler.
    expect(proposals).toHaveLength(0);
  });
});

describe('proposeBlocks - no-quota catch-all categories', () => {
  it('schedules one block per selected task for a no-weeklyCount category', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Todos: { targetLength: '30min', preferredTimes: [] } },
          typeMapping: { Todos: ['todo'] },
        }),
        candidateTasks: [
          task({ gid: 'a', typeSignals: ['todo'] }),
          task({ gid: 'b', typeSignals: ['todo'] }),
        ],
      })
    );
    // One block per selected task, each carrying its own single task.
    expect(proposals).toHaveLength(2);
    expect(proposals.every(p => p.category === 'Todos')).toBe(true);
    expect(proposals.map(p => p.task?.gid).sort()).toEqual(['a', 'b']);
  });

  it('never emits a reserved block for a no-weeklyCount category', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Todos: { targetLength: '30min', preferredTimes: [] } },
          typeMapping: { Todos: ['todo'] },
        }),
        candidateTasks: [task({ gid: 'a', typeSignals: ['todo'] })],
      })
    );
    // Exactly the one selected task; no filler despite there being no quota.
    expect(proposals).toHaveLength(1);
    expect(proposals.every(p => p.task !== undefined)).toBe(true);
  });

  it('REGRESSION: schedules a selected General Todo whose type matches no category (catch-all)', () => {
    // Mirrors the user's real config: "General Todos" has no weeklyCount and an
    // EMPTY types list (typeMapping []), so a task typed "todo"/"errand" matches
    // no category's mapped types. Before the catch-all fix, classifyBlockCategory
    // returned null for such a task and the engine silently dropped it from
    // tasksByCategory — so a selected General Todo never became a block. It must
    // now route to the catch-all "General Todos" category and schedule.
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            'Writing/Deep Work': { weeklyCount: 1, targetLength: '1.5h', preferredTimes: ['08:30-11:00'] },
            'General Todos': { targetLength: '30min', preferredTimes: [] },
          },
          // Note the EMPTY types list for General Todos — the crux of the bug.
          typeMapping: { 'Writing/Deep Work': ['writing'], 'General Todos': [] },
          scheduling: { workingHours: { start: '08:30', end: '17:00' } },
        }),
        // Two General Todos whose Asana "Type" is "todo"/"errand" — neither maps
        // to any category. They arrive via the propose route's exact path (which
        // now uses classifyBlockCategoryWithCatchAll before handing tasks here).
        candidateTasks: [
          task({ gid: 'todo-1', typeSignals: ['todo'] }),
          task({ gid: 'todo-2', typeSignals: ['errand'] }),
        ],
      })
    );
    const todos = proposals.filter(p => p.category === 'General Todos');
    expect(todos).toHaveLength(2);
    expect(todos.map(p => p.task?.gid).sort()).toEqual(['todo-1', 'todo-2']);
    // Each is a real single-task block, never a reserved filler.
    expect(todos.every(p => p.task !== undefined)).toBe(true);
  });

  it('processes no-quota categories AFTER quota\'d categories (filler cannot steal slots)', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            'Writing/Deep Work': { weeklyCount: 1, targetLength: '1h', preferredTimes: ['08:30-11:00'] },
            Todos: { targetLength: '30min', preferredTimes: [] },
          },
          typeMapping: { 'Writing/Deep Work': ['deep'], Todos: ['todo'] },
          scheduling: { workingHours: { start: '08:30', end: '17:00' } },
        }),
        candidateTasks: [
          task({ gid: 'd', typeSignals: ['deep'] }),
          task({ gid: 't', typeSignals: ['todo'] }),
        ],
      })
    );
    const deep = proposals.find(p => p.category === 'Writing/Deep Work');
    const todos = proposals.find(p => p.category === 'Todos');
    // Deep work (quota'd) claims its early-morning slot; the no-quota Todo is
    // processed afterwards, landing in the afternoon default window.
    expect(deep?.start).toBe('08:30');
    expect(todos!.start >= '12:00').toBe(true);
  });
});

describe('proposeBlocks - durationOverridesByCategory', () => {
  it('uses the override duration for a category instead of its targetLength', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({ quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['09:00-11:00'] } } }),
        candidateTasks: [task({ gid: 'a' })],
        durationOverridesByCategory: { Deep: 90 },
      })
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].durationMinutes).toBe(90);
  });

  it('falls back to the targetLength-derived duration when no override is given', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({ quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['09:00-11:00'] } } }),
        candidateTasks: [task({ gid: 'a' })],
      })
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].durationMinutes).toBe(60);
  });

  it('only overrides the named category, leaving others at their targetLength', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: [] },
            Todos: { weeklyCount: 1, targetLength: '30min', preferredTimes: [] },
          },
          typeMapping: { Deep: ['deep'], Todos: ['todo'] },
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b', typeSignals: ['todo'] })],
        durationOverridesByCategory: { Deep: 120 },
      })
    );
    const deep = proposals.find(p => p.category === 'Deep');
    const todos = proposals.find(p => p.category === 'Todos');
    expect(deep?.durationMinutes).toBe(120);
    expect(todos?.durationMinutes).toBe(30);
  });
});

describe('proposeBlocks - durationOverridesByTask', () => {
  it("applies a per-task override to that task's block, leaving others at the category default", () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({ quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: [] } } }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' })],
        durationOverridesByTask: { a: 90 },
      })
    );
    const a = proposals.find(p => p.task?.gid === 'a');
    const b = proposals.find(p => p.task?.gid === 'b');
    expect(a?.durationMinutes).toBe(90);
    expect(b?.durationMinutes).toBe(60); // category targetLength default
  });

  it('a per-task override takes precedence over the category override for that task', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({ quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: [] } } }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' })],
        durationOverridesByCategory: { Deep: 45 },
        durationOverridesByTask: { a: 120 },
      })
    );
    const a = proposals.find(p => p.task?.gid === 'a');
    const b = proposals.find(p => p.task?.gid === 'b');
    expect(a?.durationMinutes).toBe(120); // per-task wins
    expect(b?.durationMinutes).toBe(45); // category override, no per-task entry
  });

  it('ignores a per-task override for grouped categories, honoring the category override', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            Engage: { weeklyCount: 2, targetLength: '1h', grouped: true, preferredTimes: ['13:00-17:00'] },
          },
          typeMapping: { Engage: ['engage'] },
        }),
        candidateTasks: [task({ gid: 'a', typeSignals: ['engage'] })],
        durationOverridesByCategory: { Engage: 45 },
        durationOverridesByTask: { a: 120 },
      })
    );
    // Grouped blocks are shared containers: they use the category length and the
    // per-task override is ignored.
    expect(proposals).toHaveLength(2);
    expect(proposals.every(p => p.durationMinutes === 45)).toBe(true);
  });
});

describe('slotIsValid - work-run rule', () => {
  const WR: WorkRun = { maxMinutes: 120, bufferMinutes: 15 };
  // Absolute ms for a time on Monday 2026-07-13.
  const t = (h: number, m: number) => new Date(2026, 6, 13, h, m).getTime();
  const iv = (h1: number, m1: number, h2: number, m2: number, isBreak?: boolean): BusyMs => ({
    start: t(h1, m1),
    end: t(h2, m2),
    ...(isBreak ? { isBreak: true } : {}),
  });

  it('rejects a placement overlapping any busy interval (breaks included)', () => {
    expect(slotIsValid(t(12, 0), t(12, 30), [iv(12, 0, 12, 30, true)], WR)).toBe(false);
    expect(slotIsValid(t(9, 30), t(10, 0), [iv(9, 0, 10, 0)], WR)).toBe(false);
  });

  it('allows a run of exactly maxMinutes but rejects one over it', () => {
    // 09:00–10:00 busy; a 1h block at 10:00 → 2h run (ok). A 90-min block at 10:00
    // → 2.5h run (rejected).
    expect(slotIsValid(t(10, 0), t(11, 0), [iv(9, 0, 10, 0)], WR)).toBe(true);
    expect(slotIsValid(t(10, 0), t(11, 30), [iv(9, 0, 10, 0)], WR)).toBe(false);
  });

  it('bridges a gap smaller than bufferMinutes into one run', () => {
    // 09:00–11:00 busy (2h). A block at 11:10 is only a 10-min gap (< 15) → bridges
    // into a 09:00–12:10 run (> 2h) → rejected.
    expect(slotIsValid(t(11, 10), t(12, 10), [iv(9, 0, 11, 0)], WR)).toBe(false);
    // A block at 11:15 is a 15-min gap (>= buffer) → a fresh run → allowed.
    expect(slotIsValid(t(11, 15), t(12, 15), [iv(9, 0, 11, 0)], WR)).toBe(true);
  });

  it('lets a break split a run so a block may abut it', () => {
    // Work 09:00–10:00, break 10:00–10:30, candidate 10:30–12:00. The break splits
    // the run, so the candidate's run is just 1.5h → allowed (a work interval in
    // place of the break would bridge to 3h and be rejected).
    const withBreak = [iv(9, 0, 10, 0), iv(10, 0, 10, 30, true)];
    const withWork = [iv(9, 0, 10, 0), iv(10, 0, 10, 30)];
    expect(slotIsValid(t(10, 30), t(12, 0), withBreak, WR)).toBe(true);
    expect(slotIsValid(t(10, 30), t(12, 0), withWork, WR)).toBe(false);
  });
});

describe('proposeBlocks - work-run rule', () => {
  it('places a block immediately after an existing busy interval (runs are continuous)', () => {
    // Busy 09:00-10:00, duration 1h, preferred 09:00-12:00. The block abuts the
    // meeting at 10:00 forming a 2h run (<= maxMinutes) — no flat buffer anymore.
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({ quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['09:00-12:00'] } } }),
        candidateTasks: [task({ gid: 'a' })],
        busyIntervals: [
          { start: new Date(2026, 6, 13, 9, 0), end: new Date(2026, 6, 13, 10, 0) },
        ],
      })
    );
    expect(proposals[0].start).toBe('10:00');
  });

  it('places two same-day proposals back-to-back into a single 2h run', () => {
    // Restrict to a single working day so the spread heuristic can't fan the
    // second block onto another day — this isolates same-day run behaviour.
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: ['09:00-14:00'] } },
          scheduling: { workingDays: ['Monday'] },
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' })],
      })
    );
    expect(proposals).toHaveLength(2);
    const sameDay = proposals.filter(p => p.date === dateStr(WEEK_START));
    // Both fit on Monday: 09:00-10:00 then 10:00-11:00 (a continuous 2h run).
    expect(sameDay.map(p => p.start).sort()).toEqual(['09:00', '10:00']);
  });

  it('rejects a placement that would push a busy run past maxMinutes, leaving a buffer', () => {
    // A meeting already fills 09:00-11:00 (a full 2h run). A 1h block can't abut it
    // (that would be 3h); the earliest valid start is 11:15 — a >=15-min gap that
    // starts a fresh run.
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['09:00-14:00'] } },
          scheduling: { workingDays: ['Monday'] },
        }),
        candidateTasks: [task({ gid: 'a' })],
        busyIntervals: [
          { start: new Date(2026, 6, 13, 9, 0), end: new Date(2026, 6, 13, 11, 0) },
        ],
      })
    );
    expect(proposals[0].start).toBe('11:15');
  });

  it('treats a break interval as splitting runs, so a block may abut it', () => {
    // Work 09:00-10:00, then a 30-min BREAK 10:00-10:30 (lunch). A 90-min block at
    // 10:30 forms its own 1.5h run (the break splits it from the 09:00 work), so it
    // is valid even though 09:00-12:00 spans 3h.
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 1, targetLength: '90min', preferredTimes: ['09:00-14:00'] } },
          scheduling: { workingDays: ['Monday'] },
        }),
        candidateTasks: [task({ gid: 'a' })],
        busyIntervals: [
          { start: new Date(2026, 6, 13, 9, 0), end: new Date(2026, 6, 13, 10, 0) },
          { start: new Date(2026, 6, 13, 10, 0), end: new Date(2026, 6, 13, 10, 30), isBreak: true },
        ],
      })
    );
    expect(proposals[0].start).toBe('10:30');
  });
});

describe('proposeBlocks - preferred windows outside working hours', () => {
  it('honours a preferred window that sits outside working hours', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 1, targetLength: '2h', preferredTimes: ['21:00-23:00'] } },
          scheduling: { workingHours: { start: '09:00', end: '17:00' } },
        }),
        candidateTasks: [task({ gid: 'a' })],
      })
    );
    expect(proposals[0].start).toBe('21:00');
    expect(proposals[0].reason).toMatch(/preferred/i);
  });
});

describe('proposeBlocks - deep-work morning flex (3c)', () => {
  // Deep work must keep its morning claim when a meeting partially blocks the
  // preferred 09:00–11:00 window: slide later (treating the morning as up to
  // ~12:00), then shrink to a 60-min floor to fit the largest morning gap; only a
  // gap under 60 min sends it out of the morning.
  const deepConfig = (targetLength: string) =>
    makeConfig({
      quotas: { 'Writing/Deep Work': { weeklyCount: 1, targetLength, preferredTimes: ['09:00-11:00'] } },
      typeMapping: { 'Writing/Deep Work': ['writing'] },
      scheduling: { workingDays: ['Monday'], workingHours: { start: '09:00', end: '17:00' } },
    });
  const at = (h: number, m: number) => new Date(2026, 6, 13, h, m);

  it('slides the start later within the morning around a meeting (full duration kept)', () => {
    // Meeting 08:30–10:00. A 90-min block can no longer start at 09:00, but the
    // morning still holds it: the earliest run-rule-valid start is 10:15 (a 15-min
    // buffer after the meeting), NOT an afternoon fallback.
    const proposals = proposeBlocks(
      makeInput({
        config: deepConfig('90min'),
        candidateTasks: [task({ gid: 'a', typeSignals: ['writing'] })],
        busyIntervals: [{ start: at(8, 30), end: at(10, 0) }],
      })
    );
    const deep = proposals.find(p => p.category === 'Writing/Deep Work')!;
    expect(deep.start).toBe('10:15');
    expect(deep.durationMinutes).toBe(90); // full duration, just slid later
  });

  it('shrinks to the largest morning gap when the full duration will not fit', () => {
    // Meeting 08:30–10:45 leaves only 10:45–12:00 (75 min) in the morning. A 90-min
    // block shrinks to 75 min to fill that gap rather than leaving the morning.
    const proposals = proposeBlocks(
      makeInput({
        config: deepConfig('90min'),
        candidateTasks: [task({ gid: 'a', typeSignals: ['writing'] })],
        busyIntervals: [{ start: at(8, 30), end: at(10, 45) }],
      })
    );
    const deep = proposals.find(p => p.category === 'Writing/Deep Work')!;
    expect(deep.start).toBe('10:45');
    expect(deep.durationMinutes).toBe(75); // shortened to fit the 75-min gap
    expect(deep.trimmedFromMinutes).toBe(90);
  });

  it('falls through to normal placement when the morning gap is under 60 min', () => {
    // Meeting 08:30–11:30 leaves only 30 min of morning — below the 60-min floor —
    // so the block keeps its full duration and lands via normal placement (after
    // the meeting, past the morning), not shrunk into a sub-60 sliver.
    const proposals = proposeBlocks(
      makeInput({
        config: deepConfig('90min'),
        candidateTasks: [task({ gid: 'a', typeSignals: ['writing'] })],
        busyIntervals: [{ start: at(8, 30), end: at(11, 30) }],
      })
    );
    const deep = proposals.find(p => p.category === 'Writing/Deep Work')!;
    expect(deep.durationMinutes).toBe(90); // not shrunk
    expect(deep.start).toBe('11:45'); // fresh run after the meeting
  });

  it('still places at 09:00 when the morning is free (no regression)', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: deepConfig('90min'),
        candidateTasks: [task({ gid: 'a', typeSignals: ['writing'] })],
      })
    );
    const deep = proposals.find(p => p.category === 'Writing/Deep Work')!;
    expect(deep.start).toBe('09:00');
    expect(deep.durationMinutes).toBe(90);
  });
});

describe('proposeBlocks - week boundary', () => {
  it('never proposes a block outside the 7-day week', () => {
    const weekEnd = dateStr(new Date(2026, 6, 19)); // Sunday
    const startStr = dateStr(WEEK_START);
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 20, targetLength: '1h', preferredTimes: [] } },
        }),
        candidateTasks: [],
      })
    );
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(p.date >= startStr && p.date <= weekEnd).toBe(true);
    }
  });
});

describe('proposeBlocks - now cutoff', () => {
  it('only proposes slots at or after now, mid-week', () => {
    const now = new Date(2026, 6, 15, 12, 0); // Wednesday noon
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: [] } },
          scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday'] },
        }),
        candidateTasks: [task({ gid: 'a' })],
        now,
      })
    );
    expect(proposals).toHaveLength(1);
    // Monday/Tuesday are in the past; Wednesday preferred none -> working hours,
    // but only >= 12:00.
    expect(proposals[0].date).toBe('2026-07-15');
    expect(proposals[0].start >= '12:00').toBe(true);
  });
});

describe('proposeBlocks - existing scheduled counts', () => {
  it('reduces remaining quota by already-scheduled counts', () => {
    const proposals = proposeBlocks(
      makeInput({
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' })],
        existingScheduledCounts: { Deep: 2 }, // weeklyCount 2 already met
      })
    );
    expect(proposals).toHaveLength(0);
  });
});

describe('proposeBlocks - ranking', () => {
  it('schedules hard-deadline tasks before softer ones', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({ quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: [] } } }),
        candidateTasks: [
          task({ gid: 'soft', deadlineType: 'soft' }),
          task({ gid: 'hard', deadlineType: 'hard' }),
        ],
      })
    );
    expect(proposals[0].task?.gid).toBe('hard');
  });

  it('processes hard-deadline categories first', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            A: { weeklyCount: 1, targetLength: '1h', preferredTimes: [] },
            B: { weeklyCount: 1, targetLength: '1h', preferredTimes: [] },
          },
          typeMapping: { A: ['a'], B: ['b'] },
          scheduling: { workingDays: ['Monday'] },
        }),
        candidateTasks: [
          task({ gid: 'a1', typeSignals: ['a'] }),
          task({ gid: 'b1', typeSignals: ['b'], deadlineType: 'hard' }),
        ],
      })
    );
    // Both categories lack preferredTimes, so they default to the afternoon
    // window (mornings are reserved for deep work); category B (hard deadline)
    // is processed first and claims the earliest afternoon slot.
    const first = proposals.find(p => p.start === '12:00');
    expect(first?.category).toBe('B');
  });

  it('processes Writing/Deep Work first, even ahead of a hard-deadline category', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            'Writing/Deep Work': { weeklyCount: 1, targetLength: '1h', preferredTimes: [] },
            B: { weeklyCount: 1, targetLength: '1h', preferredTimes: [] },
          },
          typeMapping: { 'Writing/Deep Work': ['deep'], B: ['b'] },
          scheduling: { workingDays: ['Monday'] },
        }),
        candidateTasks: [
          task({ gid: 'd1', typeSignals: ['deep'] }),
          task({ gid: 'b1', typeSignals: ['b'], deadlineType: 'hard' }),
        ],
      })
    );
    // Deep work claims the earliest slot despite B having a hard deadline.
    const first = proposals.find(p => p.start === '09:00');
    expect(first?.category).toBe('Writing/Deep Work');
  });
});

describe('proposeBlocks - soft day spread', () => {
  const distinctDates = (proposals: { date: string }[]) =>
    new Set(proposals.map(p => p.date));

  it('spreads same-category blocks across distinct days', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 3, targetLength: '1h', preferredTimes: [] } },
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' }), task({ gid: 'c' })],
      })
    );
    expect(proposals).toHaveLength(3);
    expect(distinctDates(proposals).size).toBe(3);
  });

  it('doubles up on a day only when forced by too few working days', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 3, targetLength: '1h', preferredTimes: [] } },
          scheduling: { workingDays: ['Monday', 'Tuesday'] },
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' }), task({ gid: 'c' })],
      })
    );
    expect(proposals).toHaveLength(3);
    // Two days, three blocks -> one day gets two, the other one.
    expect(distinctDates(proposals).size).toBe(2);
  });

  it('keeps each block in its preferred window while spreading across days', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: ['09:00-11:00'] } },
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' })],
      })
    );
    expect(proposals).toHaveLength(2);
    // Both land at 09:00 (their preferred time), but on distinct days rather
    // than doubling up on Monday.
    expect(proposals.every(p => p.start === '09:00')).toBe(true);
    expect(distinctDates(proposals).size).toBe(2);
  });

  it('seeds spread from existingCategoryCountsByDate', () => {
    const mondayStr = dateStr(WEEK_START);
    const tuesdayStr = dateStr(new Date(2026, 6, 14));
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: [] } },
        }),
        candidateTasks: [task({ gid: 'a' })],
        existingCategoryCountsByDate: { [mondayStr]: { Deep: 1 } },
      })
    );
    expect(proposals).toHaveLength(1);
    // Monday already has a Deep block, so the new one avoids it.
    expect(proposals[0].date).toBe(tuesdayStr);
  });

  it('works without existingCategoryCountsByDate (back-compat)', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['09:00-11:00'] } },
        }),
        candidateTasks: [task({ gid: 'a' })],
      })
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].date).toBe(dateStr(WEEK_START));
    expect(proposals[0].start).toBe('09:00');
  });
});

describe('proposeBlocks - priority ranking', () => {
  it('schedules an isPriority task ahead of a harder-deadline non-priority task', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({ quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: [] } } }),
        candidateTasks: [
          task({ gid: 'hard', deadlineType: 'hard' }),
          task({ gid: 'prio', deadlineType: 'soft', isPriority: true }),
        ],
      })
    );
    expect(proposals[0].task?.gid).toBe('prio');
  });
});

describe('proposeBlocks - must-do first pass', () => {
  it('places a must-do no-quota task earlier in the week than equal-length quota work', () => {
    // One 1h afternoon slot per day (12:00-13:00), three days. Two non-must-do
    // blog tasks (quota'd) plus one must-do General Todo (no-quota catch-all).
    // Without the first pass the quota'd blogs claim Mon+Tue and the must-do is
    // pushed to Wednesday; the first pass must instead land the must-do on Monday.
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            Blogs: { weeklyCount: 2, targetLength: '1h', preferredTimes: [] },
            'General Todos': { targetLength: '1h', preferredTimes: [] },
          },
          typeMapping: { Blogs: ['blog'], 'General Todos': [] },
          scheduling: {
            workingDays: ['Monday', 'Tuesday', 'Wednesday'],
            workingHours: { start: '12:00', end: '13:00' },
          },
        }),
        candidateTasks: [
          task({ gid: 'b1', typeSignals: ['blog'] }),
          task({ gid: 'b2', typeSignals: ['blog'] }),
          task({ gid: 'must', typeSignals: ['todo'], isPriority: true }),
        ],
      })
    );
    const must = proposals.find(p => p.task?.gid === 'must');
    const blogs = proposals.filter(p => p.category === 'Blogs');
    expect(must).toBeDefined();
    // Must-do claims the earliest day (Monday).
    expect(must!.date).toBe(dateStr(WEEK_START));
    // Every non-must-do block is on a strictly later day.
    expect(blogs).toHaveLength(2);
    expect(blogs.every(b => b.date > must!.date)).toBe(true);
  });

  it('a must-do consumes its category quota (placed once, not again in the main pass)', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({ quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: [] } } }),
        candidateTasks: [
          task({ gid: 'p', isPriority: true }),
          task({ gid: 'q' }),
          task({ gid: 'r' }),
        ],
      })
    );
    const deep = proposals.filter(p => p.category === 'Deep');
    // Quota of 2 respected despite 3 candidates — the must-do isn't double-placed.
    expect(deep).toHaveLength(2);
    expect(deep.filter(p => p.task?.gid === 'p')).toHaveLength(1);
  });

  it('bumps a grouped category holding a must-do ahead of other categories', () => {
    // Two days, one 1h slot each. Blogs sorts before Engage by name, so without
    // the bump Blogs would take Monday. Because Engage (grouped) holds a must-do,
    // its container is bumped to the front of the loop and claims Monday.
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            Blogs: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['13:00-14:00'] },
            Engage: { weeklyCount: 1, targetLength: '1h', grouped: true, preferredTimes: ['13:00-14:00'] },
          },
          typeMapping: { Blogs: ['blog'], Engage: ['engage'] },
          scheduling: {
            workingDays: ['Monday', 'Tuesday'],
            workingHours: { start: '13:00', end: '14:00' },
          },
        }),
        candidateTasks: [
          task({ gid: 'blog', typeSignals: ['blog'] }),
          task({ gid: 'eng', typeSignals: ['engage'], isPriority: true }),
        ],
      })
    );
    const engage = proposals.find(p => p.category === 'Engage');
    const blog = proposals.find(p => p.category === 'Blogs');
    expect(engage!.date).toBe(dateStr(WEEK_START));
    expect(blog!.date > engage!.date).toBe(true);
    // The must-do rides the grouped agenda (no standalone block from pass 1).
    expect(engage!.tasks?.some(t => t.gid === 'eng')).toBe(true);
    expect(proposals.some(p => p.task?.gid === 'eng')).toBe(false);
  });

  it('packs multiple must-dos as early in the week as the run rule allows', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({ quotas: { Deep: { weeklyCount: 3, targetLength: '1h', preferredTimes: [] } } }),
        candidateTasks: [
          task({ gid: 'p1', isPriority: true }),
          task({ gid: 'p2', isPriority: true }),
          task({ gid: 'p3', isPriority: true }),
        ],
      })
    );
    const deep = proposals.filter(p => p.category === 'Deep');
    expect(deep).toHaveLength(3);
    // Earliness beats spread for must-dos: with a whole free Monday, all three
    // land on Monday (the run rule inserts the 15-min buffer after the 2h run).
    expect(deep.every(p => p.date === dateStr(WEEK_START))).toBe(true);
  });

  it('takes the earliest free day even when the spread prefers an emptier later day', () => {
    // Regression: the first pass used the leveled spread, whose level-0 search
    // only admits days with ZERO existing blocks of the category — so a must-do
    // General Todo jumped to (empty) Friday while ordinary tasks landed midweek.
    const weekStr = dateStr(WEEK_START);
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { 'General Todos': { targetLength: '1h', preferredTimes: [] } },
          typeMapping: { 'General Todos': [] },
        }),
        candidateTasks: [task({ gid: 'must', typeSignals: ['todo'], isPriority: true })],
        // Monday already has a General Todos block — level 0 would exclude it.
        existingCategoryCountsByDate: { [weekStr]: { 'General Todos': 1 } },
      })
    );
    const must = proposals.find(p => p.task?.gid === 'must');
    expect(must).toBeDefined();
    // Still Monday: earliest day with a free slot wins, spread be damned.
    expect(must!.date).toBe(weekStr);
  });
});

describe('proposeBlocks - daily categories (one block per working day)', () => {
  const deepDailyConfig = (scheduling: Partial<WorkflowConfig['scheduling']> = {}) =>
    makeConfig({
      quotas: {
        'Writing/Deep Work': {
          weeklyCount: 3,
          targetLength: '1.5h',
          grouped: true,
          daily: true,
          preferredTimes: ['08:30-11:00'],
        },
      },
      typeMapping: { 'Writing/Deep Work': ['deep'] },
      scheduling: { workingHours: { start: '08:30', end: '17:00' }, ...scheduling },
    });

  it('places one deep-work block per working day (5 days → 5 blocks, distinct days, mornings)', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: deepDailyConfig({ workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] }),
        candidateTasks: ['a', 'b', 'c'].map(g => task({ gid: g, typeSignals: ['deep'] })),
      })
    );
    const deep = proposals.filter(p => p.category === 'Writing/Deep Work');
    expect(deep).toHaveLength(5); // one per working day, overriding weeklyCount 3
    expect(new Set(deep.map(p => p.date)).size).toBe(5); // distinct days
    expect(deep.every(p => p.start >= '08:30' && p.start < '11:00')).toBe(true);
  });

  it('scales down to one block per REMAINING day when fewer days are in the window', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: deepDailyConfig({ workingDays: ['Monday', 'Tuesday'] }),
        candidateTasks: [task({ gid: 'a', typeSignals: ['deep'] })],
      })
    );
    const deep = proposals.filter(p => p.category === 'Writing/Deep Work');
    expect(deep).toHaveLength(2); // two working days → two blocks
    expect(new Set(deep.map(p => p.date)).size).toBe(2);
  });

  it('leaves a morning that already holds a deep-work block alone (per-day, not a global count)', () => {
    // The daily shortfall is "remaining mornings lacking a deep-work block", so a
    // day already holding one (seeded per-date) is skipped; the others still fill.
    const proposals = proposeBlocks(
      makeInput({
        config: deepDailyConfig({ workingDays: ['Monday', 'Tuesday', 'Wednesday'] }),
        candidateTasks: [task({ gid: 'a', typeSignals: ['deep'] })],
        existingCategoryCountsByDate: { '2026-07-13': { 'Writing/Deep Work': 1 } }, // Monday taken
      })
    );
    const deep = proposals.filter(p => p.category === 'Writing/Deep Work');
    expect(deep).toHaveLength(2);
    expect(deep.map(p => p.date).sort()).toEqual(['2026-07-14', '2026-07-15']); // Tue + Wed
  });

  it('lists ALL the selected deep-work tasks on EVERY morning block (generic container, no rotation)', () => {
    // Dave's rule: every morning is a generic "Deep work" block whose agenda is the
    // whole week's selected deep-work tasks — the same list on each day, never a
    // single task pinned to a specific morning.
    const proposals = proposeBlocks(
      makeInput({
        config: deepDailyConfig({ workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] }),
        candidateTasks: ['a', 'b', 'c'].map(g => task({ gid: g, typeSignals: ['deep'] })),
      })
    );
    const deep = proposals
      .filter(p => p.category === 'Writing/Deep Work')
      .sort((x, y) => x.date.localeCompare(y.date));
    // Every block is a container: no single `task`, and the same full agenda.
    expect(deep.every(p => p.task === undefined)).toBe(true);
    for (const p of deep) {
      expect(p.tasks?.map(t => t.gid)).toEqual(['a', 'b', 'c']);
    }
  });

  it('fills a morning with a reserved deep-work block when no tasks were selected', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: deepDailyConfig({ workingDays: ['Monday', 'Tuesday'] }),
        candidateTasks: [],
      })
    );
    const deep = proposals.filter(p => p.category === 'Writing/Deep Work');
    expect(deep).toHaveLength(2);
    expect(deep.every(p => p.task === undefined && /reserved/i.test(p.reason))).toBe(true);
  });

  it('skips a day whose morning is genuinely full, placing deep work on the others', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: deepDailyConfig({ workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] }),
        candidateTasks: [task({ gid: 'a', typeSignals: ['deep'] })],
        // Tuesday's whole morning (08:30–12:00) is booked solid → no 60-min gap.
        busyIntervals: [{ start: new Date(2026, 6, 14, 8, 30), end: new Date(2026, 6, 14, 12, 0) }],
      })
    );
    const deep = proposals.filter(p => p.category === 'Writing/Deep Work');
    expect(deep).toHaveLength(4); // Tuesday skipped, the other four mornings kept
    expect(deep.some(p => p.date === '2026-07-14')).toBe(false);
  });
});

describe('proposeBlocks - deep work placed before must-dos', () => {
  it('deep work claims the morning; a morning-preferred must-do slots in AFTER it', () => {
    // Monday only. Deep work (daily, grouped) prefers 08:30-11:00; a Blogs must-do
    // prefers a morning-inclusive 08:30-16:00 window. Deep work must take 08:30
    // and the must-do must land after it, not steal the 08:30 slot.
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            'Writing/Deep Work': {
              weeklyCount: 1,
              targetLength: '1.5h',
              grouped: true,
              daily: true,
              preferredTimes: ['08:30-11:00'],
            },
            Blogs: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['08:30-16:00'] },
          },
          typeMapping: { 'Writing/Deep Work': ['deep'], Blogs: ['blog'] },
          scheduling: { workingDays: ['Monday'], workingHours: { start: '08:30', end: '17:00' } },
        }),
        candidateTasks: [
          task({ gid: 'd', typeSignals: ['deep'] }),
          task({ gid: 'must', typeSignals: ['blog'], isPriority: true }),
        ],
      })
    );
    const deep = proposals.find(p => p.category === 'Writing/Deep Work');
    const blog = proposals.find(p => p.task?.gid === 'must');
    expect(deep!.start).toBe('08:30');
    expect(blog).toBeDefined();
    // The must-do is pushed past deep work's 08:30-10:00 run (+ buffer), never 08:30.
    expect(blog!.start >= '10:00').toBe(true);
  });
});

describe('proposeBlocks - scaleToTasks (block count scales with selected tasks)', () => {
  const batchConfig = () =>
    makeConfig({
      quotas: {
        Batch: {
          weeklyCount: 2,
          targetLength: '15min',
          grouped: true,
          autoSelect: true,
          scaleToTasks: { tasksPerBlock: 7, maxBlocks: 3 },
          preferredTimes: [],
        },
      },
      typeMapping: { Batch: ['batch'] },
      scheduling: { workingHours: { start: '08:30', end: '18:00' } },
    });
  const batchTasks = (n: number) =>
    Array.from({ length: n }, (_, i) => task({ gid: `b${i}`, typeSignals: ['batch'] }));

  it('schedules ZERO blocks when no tasks are selected (overrides weeklyCount)', () => {
    const proposals = proposeBlocks(makeInput({ config: batchConfig(), candidateTasks: [] }));
    expect(proposals.filter(p => p.category === 'Batch')).toHaveLength(0);
  });

  it('1–7 tasks → 1 block, carrying the full agenda', () => {
    const proposals = proposeBlocks(makeInput({ config: batchConfig(), candidateTasks: batchTasks(7) }));
    const batch = proposals.filter(p => p.category === 'Batch');
    expect(batch).toHaveLength(1);
    expect(batch[0].tasks!.map(t => t.gid).sort()).toEqual(batchTasks(7).map(t => t.gid).sort());
    expect(batch[0].durationMinutes).toBe(15);
  });

  it('8 tasks → 2 blocks (ceil(8/7))', () => {
    const proposals = proposeBlocks(makeInput({ config: batchConfig(), candidateTasks: batchTasks(8) }));
    expect(proposals.filter(p => p.category === 'Batch')).toHaveLength(2);
  });

  it('caps at maxBlocks (15 tasks → 3, not 3-plus)', () => {
    const proposals = proposeBlocks(makeInput({ config: batchConfig(), candidateTasks: batchTasks(15) }));
    expect(proposals.filter(p => p.category === 'Batch')).toHaveLength(3);
  });
});

describe('proposeBlocks - out-of-office days', () => {
  it('drops the OOO day and scales weekly quotas: deep 4, Engagement 2, Blogs 2 (5-day week, 1 OOO)', () => {
    const FRIDAY = '2026-07-17';
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            'Writing/Deep Work': {
              weeklyCount: 3,
              targetLength: '1.5h',
              grouped: true,
              daily: true,
              preferredTimes: ['08:30-11:00'],
            },
            'Engagement/Outreach': {
              weeklyCount: 3,
              targetLength: '1h',
              grouped: true,
              preferredTimes: ['13:00-17:00'],
            },
            Blogs: { weeklyCount: 2, targetLength: '1h', preferredTimes: ['08:30-16:00'] },
          },
          typeMapping: {
            'Writing/Deep Work': ['deep'],
            'Engagement/Outreach': ['engage'],
            Blogs: ['blog'],
          },
          scheduling: {
            workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
            workingHours: { start: '08:30', end: '19:00' },
          },
        }),
        candidateTasks: [],
        outOfOfficeDates: new Set([FRIDAY]),
      })
    );
    // Daily deep work: one per REMAINING working day (Mon–Thu) = 4, none on Friday.
    expect(proposals.filter(p => p.category === 'Writing/Deep Work')).toHaveLength(4);
    // Weekly quotas scale by 4/5: Engagement round(3×4/5)=2, Blogs round(2×4/5)=2.
    expect(proposals.filter(p => p.category === 'Engagement/Outreach')).toHaveLength(2);
    expect(proposals.filter(p => p.category === 'Blogs')).toHaveLength(2);
    // Nothing is scheduled on the out-of-office day.
    expect(proposals.every(p => p.date !== FRIDAY)).toBe(true);
  });
});

describe('proposeBlocks - soft work-run rule (4-tier search)', () => {
  it('TIER A: places the full duration when the run rule is satisfied (no trim)', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 1, targetLength: '1.5h', preferredTimes: ['08:30-14:00'] } },
          scheduling: { workingDays: ['Monday'], workingHours: { start: '08:30', end: '17:00' } },
        }),
        candidateTasks: [task({ gid: 'a' })],
      })
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].start).toBe('08:30');
    expect(proposals[0].durationMinutes).toBe(90); // full, untrimmed
    expect(proposals[0].reason).not.toMatch(/trimmed/i);
  });

  it('TIER B: trims a CONTAINER block 15 min so a strict placement fits', () => {
    // Only free gap is the morning 08:30-10:00; the rest of the day is busy from
    // 10:00. A grouped (container) block can't fit strictly at full 90 min
    // (08:30-10:00 abuts the busy block), but trims to 75 min (08:30-09:45, then a
    // 15-min buffer) and leads the morning. Containers ARE trimmable. (Uses a
    // grouped Engage category — daily deep work now takes the morning-flex path,
    // which fills the gap at full 90 rather than the container 15-min trim.)
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            Engage: {
              weeklyCount: 1,
              targetLength: '1.5h',
              grouped: true,
              preferredTimes: ['08:30-11:00'],
            },
          },
          typeMapping: { Engage: ['engage'] },
          scheduling: { workingDays: ['Monday'], workingHours: { start: '08:30', end: '17:00' } },
        }),
        candidateTasks: [task({ gid: 'd', typeSignals: ['engage'] })],
        busyIntervals: [{ start: new Date(2026, 6, 13, 10, 0), end: new Date(2026, 6, 13, 17, 0) }],
      })
    );
    const engage = proposals.find(p => p.category === 'Engage');
    expect(engage!.start).toBe('08:30');
    expect(engage!.durationMinutes).toBe(75); // trimmed one 15-min step
    expect(engage!.trimmedFromMinutes).toBe(90); // original length surfaced for the UI
    expect(engage!.reason).toMatch(/trimmed 15 min to fit/i);
  });

  it('a SINGLE-task Blogs block is never trimmed: full length via the cap-ignored tier', () => {
    // Morning-only squeeze (free 08:30-10:00, busy after). A 90-min Blogs block is
    // a single-task block: it must NOT trim to 75. It takes the full 90 via tier
    // (c) (cap ignored), flush 08:30-10:00.
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Blogs: { weeklyCount: 1, targetLength: '1.5h', preferredTimes: ['08:30-11:00'] } },
          typeMapping: { Blogs: ['blog'] },
          scheduling: { workingDays: ['Monday'], workingHours: { start: '08:30', end: '17:00' } },
        }),
        candidateTasks: [task({ gid: 'b', typeSignals: ['blog'] })],
        busyIntervals: [{ start: new Date(2026, 6, 13, 10, 0), end: new Date(2026, 6, 13, 17, 0) }],
      })
    );
    const blog = proposals.find(p => p.category === 'Blogs');
    expect(blog!.start).toBe('08:30');
    expect(blog!.durationMinutes).toBe(90); // full length, NOT trimmed
    expect(blog!.trimmedFromMinutes).toBeUndefined();
  });

  it('a 90-min Blogs block is placed full or NOT AT ALL — never trimmed to fit a 75-min gap', () => {
    // The only free gap is 75 min (09:00-10:15). A container would trim to 75, but
    // Blogs is single-task: it must NOT shrink. With no overflow window it goes
    // unplaced rather than being trimmed.
    const unplaceable: UnplaceableTask[] = [];
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Blogs: { weeklyCount: 1, targetLength: '1.5h', preferredTimes: ['08:30-16:00'] } },
          typeMapping: { Blogs: ['blog'] },
          scheduling: { workingDays: ['Monday'], workingHours: { start: '08:30', end: '17:00' } },
        }),
        candidateTasks: [task({ gid: 'b', typeSignals: ['blog'] })],
        busyIntervals: [
          { start: new Date(2026, 6, 13, 8, 30), end: new Date(2026, 6, 13, 9, 0) },
          { start: new Date(2026, 6, 13, 10, 15), end: new Date(2026, 6, 13, 17, 0) },
        ],
      }),
      unplaceable
    );
    // No Blogs block was placed, and crucially none was trimmed to 75.
    expect(proposals.some(p => p.category === 'Blogs')).toBe(false);
    expect(proposals.some(p => p.durationMinutes === 75)).toBe(false);
    expect(unplaceable.map(u => u.id)).toContain('b');
  });

  it('a RESERVED (task-less) Blogs filler block is also never trimmed', () => {
    // Blogs has an unmet quota but NO candidate task, so it would emit a reserved
    // filler block. Even reserved fillers of a non-grouped category keep their exact
    // length: with only a 75-min gap and a full-90 requirement, the reserved block
    // is NOT trimmed to 75 — it simply isn't placed.
    const squeezed = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Blogs: { weeklyCount: 1, targetLength: '1.5h', preferredTimes: ['08:30-16:00'] } },
          typeMapping: { Blogs: ['blog'] },
          scheduling: { workingDays: ['Monday'], workingHours: { start: '08:30', end: '17:00' } },
        }),
        candidateTasks: [], // no task → reserved filler
        busyIntervals: [
          { start: new Date(2026, 6, 13, 8, 30), end: new Date(2026, 6, 13, 9, 0) },
          { start: new Date(2026, 6, 13, 10, 15), end: new Date(2026, 6, 13, 17, 0) },
        ],
      })
    );
    // Only a 75-min gap: the reserved block must not trim to 75.
    expect(squeezed.some(p => p.durationMinutes === 75)).toBe(false);
    expect(squeezed.some(p => p.trimmedFromMinutes !== undefined)).toBe(false);

    // With a full 90-min morning gap, the reserved Blogs block IS placed — full length.
    const roomy = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Blogs: { weeklyCount: 1, targetLength: '1.5h', preferredTimes: ['08:30-16:00'] } },
          typeMapping: { Blogs: ['blog'] },
          scheduling: { workingDays: ['Monday'], workingHours: { start: '08:30', end: '17:00' } },
        }),
        candidateTasks: [],
        busyIntervals: [{ start: new Date(2026, 6, 13, 10, 0), end: new Date(2026, 6, 13, 17, 0) }],
      })
    );
    const reserved = roomy.find(p => p.category === 'Blogs');
    expect(reserved).toBeDefined();
    expect(reserved!.task).toBeUndefined(); // reserved filler
    expect(reserved!.durationMinutes).toBe(90); // full length
    expect(reserved!.trimmedFromMinutes).toBeUndefined();
  });

  it('TIER C: keeps FULL duration but ignores the run cap when trimming still would not fit strictly', () => {
    // A 90-min gap wedged between two maxed 2h runs (08:30-10:30 and 12:00-14:00):
    // neither a full nor a trimmed block fits STRICTLY (both bridge a maxed run or
    // lack the two-sided buffer), so the soft rule drops the cap and places the
    // FULL 90-min block flush in the gap (overlap still respected).
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 1, targetLength: '1.5h', preferredTimes: ['08:30-14:00'] } },
          scheduling: { workingDays: ['Monday'], workingHours: { start: '08:30', end: '17:00' } },
        }),
        candidateTasks: [task({ gid: 'a' })],
        busyIntervals: [
          { start: new Date(2026, 6, 13, 8, 30), end: new Date(2026, 6, 13, 10, 30) }, // 2h run
          { start: new Date(2026, 6, 13, 12, 0), end: new Date(2026, 6, 13, 17, 0) }, // busy to end of day
        ],
      })
    );
    const deep = proposals.find(p => p.category === 'Deep');
    expect(deep!.start).toBe('10:30');
    expect(deep!.durationMinutes).toBe(90); // full duration, cap ignored (not trimmed)
    expect(deep!.reason).not.toMatch(/trimmed/i);
  });

  it('ACCEPTANCE: deep work lands 08:30 (not overflow) in the reported morning-gap scenario', () => {
    // Monday 08:30-10:00 free; the rest of the day is busy from 10:00. Deep work
    // (daily, grouped, preferred 08:30-11:00) MUST lead the morning at 08:30 —
    // trimmed to 75 min via tier (b) — rather than being refused and pushed to
    // evening overflow (the old hard-rule behaviour).
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            'Writing/Deep Work': {
              weeklyCount: 3,
              targetLength: '1.5h',
              grouped: true,
              daily: true,
              preferredTimes: ['08:30-11:00'],
            },
          },
          typeMapping: { 'Writing/Deep Work': ['deep'] },
          scheduling: {
            workingDays: ['Monday'],
            workingHours: { start: '08:30', end: '19:00' },
            overflow: { start: '21:00', end: '23:00' },
          },
        }),
        candidateTasks: [task({ gid: 'd', typeSignals: ['deep'] })],
        busyIntervals: [{ start: new Date(2026, 6, 13, 10, 0), end: new Date(2026, 6, 13, 19, 0) }],
      })
    );
    const deep = proposals.find(p => p.category === 'Writing/Deep Work');
    expect(deep).toBeDefined();
    expect(deep!.start).toBe('08:30'); // leads the day
    expect(deep!.date).toBe(dateStr(WEEK_START)); // Monday
    expect(proposals.some(p => p.overflow)).toBe(false); // NOT overflow
  });
});

describe('proposeBlocks - must-do preferred-tier priority', () => {
  it('a must-do afternoon task with its earliest day full lands the next day AFTERNOON, not that day\'s morning', () => {
    // Calls prefers afternoons (13:00-17:00). Monday afternoon is fully busy but
    // Monday morning is free. A tier-first search must try EVERY preferred
    // (afternoon) window before any fallback, so the must-do lands Tuesday
    // afternoon rather than invading Monday morning (which deep work needs).
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Calls: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['13:00-17:00'] } },
          typeMapping: { Calls: ['call'] },
          scheduling: {
            workingDays: ['Monday', 'Tuesday'],
            workingHours: { start: '08:30', end: '17:00' },
          },
        }),
        candidateTasks: [task({ gid: 'must', typeSignals: ['call'], isPriority: true })],
        busyIntervals: [
          // Monday afternoon full (13:00-17:00).
          { start: new Date(2026, 6, 13, 13, 0), end: new Date(2026, 6, 13, 17, 0) },
        ],
      })
    );
    const must = proposals.find(p => p.task?.gid === 'must');
    expect(must).toBeDefined();
    expect(must!.date).toBe(dateStr(new Date(2026, 6, 14))); // Tuesday
    expect(must!.start >= '13:00').toBe(true); // afternoon (preferred), not morning
  });

  it('a must-do with ALL preferred windows full still falls back, earliest day first', () => {
    // Both afternoons full; mornings free. With no preferred window available the
    // must-do drops to fallback (whole working day) and takes the EARLIEST day's
    // morning.
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Calls: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['13:00-17:00'] } },
          typeMapping: { Calls: ['call'] },
          scheduling: {
            workingDays: ['Monday', 'Tuesday'],
            workingHours: { start: '08:30', end: '17:00' },
          },
        }),
        candidateTasks: [task({ gid: 'must', typeSignals: ['call'], isPriority: true })],
        busyIntervals: [
          { start: new Date(2026, 6, 13, 13, 0), end: new Date(2026, 6, 13, 17, 0) },
          { start: new Date(2026, 6, 14, 13, 0), end: new Date(2026, 6, 14, 17, 0) },
        ],
      })
    );
    const must = proposals.find(p => p.task?.gid === 'must');
    expect(must).toBeDefined();
    expect(must!.date).toBe(dateStr(WEEK_START)); // Monday (earliest day)
    expect(must!.start < '13:00').toBe(true); // fell back to the morning
  });
});

describe('proposeBlocks - unplaceable tasks', () => {
  it('SOFT RULE: a run-rule-blocked SINGLE task is placed full (cap ignored), not unplaceable', () => {
    // Monday only, 09:00-12:00. Two 1h tasks fill a maxed 09:00-11:00 run; a third
    // can't abut it strictly (would be 3h). Single tasks are never trimmed, so it
    // is placed at its FULL 60 min via the cap-ignored tier (11:00-12:00), and
    // nothing is unplaceable — the soft rule still fills the visible gap.
    const unplaceable: UnplaceableTask[] = [];
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 3, targetLength: '1h', preferredTimes: [] } },
          scheduling: { workingDays: ['Monday'], workingHours: { start: '09:00', end: '12:00' } },
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' }), task({ gid: 'c' })],
      }),
      unplaceable
    );
    expect(unplaceable).toHaveLength(0);
    const deep = proposals.filter(p => p.category === 'Deep');
    expect(deep).toHaveLength(3); // all three placed
    expect(deep.every(p => p.durationMinutes === 60)).toBe(true); // none trimmed
    expect(deep.every(p => p.trimmedFromMinutes === undefined)).toBe(true);
    const third = deep.find(p => p.start === '11:00');
    expect(third).toBeDefined(); // the squeezed one, placed full via tier (c)
  });

  it('reports a task as unplaceable when working hours are genuinely full', () => {
    // Monday only, 09:00-10:00 (one hour). One task fills it; the second has no
    // free gap of its length anywhere and no overflow window to fall to.
    const unplaceable: UnplaceableTask[] = [];
    proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: [] } },
          scheduling: { workingDays: ['Monday'], workingHours: { start: '09:00', end: '10:00' } },
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' })],
      }),
      unplaceable
    );
    expect(unplaceable).toHaveLength(1);
    expect(unplaceable[0].id).toBe('b');
  });

  it('a task with no free gap at all overflows to the evening (reason: no free gap)', () => {
    // A genuinely full working day (09:00-10:00, one task fills it) forces the
    // second task to the evening even under the soft rule — there is no gap of any
    // length. The overflow block explains it was lack of free time, not the run cap
    // (which the soft rule would otherwise have bent to fit).
    const unplaceable: UnplaceableTask[] = [];
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: [] } },
          scheduling: {
            workingDays: ['Monday'],
            workingHours: { start: '09:00', end: '10:00' },
            overflow: { start: '21:00', end: '23:00' },
          },
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' })],
      }),
      unplaceable
    );
    expect(unplaceable).toHaveLength(0);
    const overflow = proposals.find(p => p.overflow);
    expect(overflow).toBeDefined();
    expect(overflow!.reason).toMatch(/no free gap/i);
  });

  it('leaves the collector empty when everything is placed', () => {
    const unplaceable: UnplaceableTask[] = [];
    proposeBlocks(
      makeInput({ candidateTasks: [task({ gid: 'a' })] }),
      unplaceable
    );
    expect(unplaceable).toHaveLength(0);
  });
});

describe('proposeBlocks - grouped blocks', () => {
  // A grouped Engagement-style category: 3 blocks/week, where every block shares
  // the SAME full agenda of all selected tasks rather than one task per block.
  const groupedConfig = () =>
    makeConfig({
      quotas: {
        Engage: { weeklyCount: 3, targetLength: '1h', grouped: true, preferredTimes: ['13:00-17:00'] },
      },
      typeMapping: { Engage: ['engage'] },
    });
  const engageTask = (gid: string) => task({ gid, typeSignals: ['engage'] });

  it('places weeklyCount blocks with no single task, each carrying the full agenda', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: groupedConfig(),
        candidateTasks: ['a', 'b', 'c', 'd', 'e'].map(engageTask),
      })
    );
    // 3 blocks (weeklyCount), never one-per-task.
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.task).toBeUndefined();
      expect(Array.isArray(p.tasks)).toBe(true);
    }
    // Every block lists the identical full set of selected tasks.
    for (const p of proposals) {
      expect(p.tasks!.map(t => t.gid).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    }
    // Reason reflects the full agenda size, not a per-block bucket.
    expect(proposals.every(p => p.reason.includes('5 tasks on the agenda'))).toBe(true);
  });

  it('places in the afternoon preferred window', () => {
    const proposals = proposeBlocks(
      makeInput({ config: groupedConfig(), candidateTasks: [engageTask('a')] })
    );
    expect(proposals.every(p => p.start >= '13:00')).toBe(true);
  });

  it('gives every one of the N blocks the same single-task agenda', () => {
    const proposals = proposeBlocks(
      makeInput({ config: groupedConfig(), candidateTasks: [engageTask('a')] })
    );
    expect(proposals).toHaveLength(3);
    // All three blocks carry the same one selected task.
    expect(proposals.every(p => p.tasks!.length === 1 && p.tasks![0].gid === 'a')).toBe(true);
  });

  it('schedules N reserved-style blocks with no tasks when none are selected', () => {
    const proposals = proposeBlocks(
      makeInput({ config: groupedConfig(), candidateTasks: [] })
    );
    expect(proposals).toHaveLength(3);
    expect(proposals.every(p => p.tasks!.length === 0)).toBe(true);
  });

  it('reduces block count by existing scheduled blocks, keeping the full agenda in each', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: groupedConfig(),
        candidateTasks: ['a', 'b'].map(engageTask),
        existingScheduledCounts: { Engage: 1 },
      })
    );
    expect(proposals).toHaveLength(2); // 3 - 1 already scheduled
    for (const p of proposals) {
      expect(p.tasks!.map(t => t.gid).sort()).toEqual(['a', 'b']);
    }
  });

  it('composes grouped + autoSelect: N container blocks with all candidates as the shared agenda', () => {
    // Batch becomes a grouped, auto-select category: 2 blocks/week, 30 min each,
    // where every block shares the full agenda of ALL its candidates (auto-select
    // means the engine receives every candidate — no manual selection filter).
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            Batch: {
              weeklyCount: 2,
              targetLength: '30min',
              grouped: true,
              autoSelect: true,
              preferredTimes: [],
            },
          },
          typeMapping: { Batch: ['batch'] },
          scheduling: { workingHours: { start: '08:30', end: '18:00' } },
        }),
        candidateTasks: ['a', 'b', 'c'].map(g => task({ gid: g, typeSignals: ['batch'] })),
      })
    );
    // Exactly weeklyCount (2) container blocks, 30 min each, never one-per-task.
    expect(proposals).toHaveLength(2);
    for (const p of proposals) {
      expect(p.category).toBe('Batch');
      expect(p.task).toBeUndefined();
      expect(p.durationMinutes).toBe(30);
      // Each block carries the identical full agenda of all candidates.
      expect(p.tasks!.map(t => t.gid).sort()).toEqual(['a', 'b', 'c']);
    }
  });

  it('grouped Writing/Deep Work places its blocks in the morning preferred window with a shared agenda', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            'Writing/Deep Work': {
              weeklyCount: 3,
              targetLength: '1.5h',
              grouped: true,
              preferredTimes: ['08:30-11:00'],
            },
          },
          typeMapping: { 'Writing/Deep Work': ['deep'] },
          scheduling: { workingHours: { start: '08:30', end: '18:00' } },
        }),
        candidateTasks: ['a', 'b', 'c', 'd'].map(g => task({ gid: g, typeSignals: ['deep'] })),
      })
    );
    // weeklyCount (3) container blocks, never one-per-task, in the 08:30-11:00
    // morning window, each carrying the identical full agenda of selected tasks.
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.category).toBe('Writing/Deep Work');
      expect(p.task).toBeUndefined();
      expect(p.durationMinutes).toBe(90);
      expect(p.start >= '08:30' && p.start < '11:00').toBe(true);
      expect(p.tasks!.map(t => t.gid).sort()).toEqual(['a', 'b', 'c', 'd']);
    }
  });
});

describe('proposeBlocks - afternoon default for non-deep-work', () => {
  it('lands empty-preferredTimes categories at/after 12:00 while deep work keeps its morning window', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            'Writing/Deep Work': { weeklyCount: 1, targetLength: '1h', preferredTimes: ['08:30-11:00'] },
            Todos: { weeklyCount: 1, targetLength: '30min', preferredTimes: [] },
          },
          typeMapping: { 'Writing/Deep Work': ['deep'], Todos: ['todo'] },
          scheduling: { workingHours: { start: '08:30', end: '17:00' } },
        }),
        candidateTasks: [
          task({ gid: 'd', typeSignals: ['deep'] }),
          task({ gid: 't', typeSignals: ['todo'] }),
        ],
      })
    );
    const deep = proposals.find(p => p.category === 'Writing/Deep Work');
    const todos = proposals.find(p => p.category === 'Todos');
    // Deep work owns the morning; the non-deep category defaults to afternoon.
    expect(deep?.start).toBe('08:30');
    expect(todos?.start).toBeDefined();
    expect(todos!.start >= '12:00').toBe(true);
  });

  it('keeps a configured preferredTimes window (does not force afternoon)', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            Blogs: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['08:30-16:00'] },
          },
          typeMapping: { Blogs: ['blog'] },
          scheduling: { workingHours: { start: '08:30', end: '17:00' } },
        }),
        candidateTasks: [task({ gid: 'b', typeSignals: ['blog'] })],
      })
    );
    expect(proposals).toHaveLength(1);
    // Its explicit morning-inclusive window is honoured, not overridden to 12:00.
    expect(proposals[0].start).toBe('08:30');
  });
});

describe('proposeBlocks - over-quota manual selection', () => {
  it('places a block per explicit pick beyond the weekly quota (manual category)', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: ['09:00-11:00'] } },
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' }), task({ gid: 'c' })],
        selectedCountsByCategory: { Deep: 3 }, // user picked all 3 despite quota 2
      })
    );
    const deep = proposals.filter(p => p.category === 'Deep');
    expect(deep).toHaveLength(3);
    expect(deep.every(p => p.task !== undefined)).toBe(true);
    expect(new Set(deep.map(p => p.task!.gid))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('keeps the quota cap for an auto-select category regardless of candidate count', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: {
            Batch: { weeklyCount: 2, targetLength: '1h', preferredTimes: [], autoSelect: true },
          },
          typeMapping: { Batch: ['batch'] },
        }),
        candidateTasks: [
          task({ gid: 'a', typeSignals: ['batch'] }),
          task({ gid: 'b', typeSignals: ['batch'] }),
          task({ gid: 'c', typeSignals: ['batch'] }),
          task({ gid: 'd', typeSignals: ['batch'] }),
        ],
        selectedCountsByCategory: { Batch: 4 }, // ignored for auto-select
      })
    );
    // Auto-select stays capped at the weekly quota (2), not the 4 candidates.
    expect(proposals.filter(p => p.category === 'Batch')).toHaveLength(2);
  });

  it('under-picking a manual category still fills the rest of the quota with reserved blocks', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 3, targetLength: '1h', preferredTimes: ['09:00-11:00'] } },
        }),
        candidateTasks: [task({ gid: 'a' })],
        selectedCountsByCategory: { Deep: 1 }, // picked fewer than quota
      })
    );
    const deep = proposals.filter(p => p.category === 'Deep');
    // 1 real task + 2 reserved = quota of 3; reserved fill stays bounded by quota.
    expect(deep).toHaveLength(3);
    expect(deep.filter(p => p.task !== undefined)).toHaveLength(1);
    expect(deep.filter(p => p.task === undefined)).toHaveLength(2);
  });
});

// --- Spare-capacity assessment ---------------------------------------------

describe('computeSpareCapacity', () => {
  const WR: WorkRun = { maxMinutes: 120, bufferMinutes: 15 };
  const MON = new Date(2026, 6, 13); // 2026-07-13
  const TUE = new Date(2026, 6, 14);

  const at = (d: Date, h: number, m = 0) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();

  const workingDay = (d: Date, startH = 9, endH = 17): WorkingDay => ({
    date: new Date(d.getFullYear(), d.getMonth(), d.getDate()),
    dateStr: dateStr(d),
    whStartMs: at(d, startH),
    whEndMs: at(d, endH),
  });

  const busy = (d: Date, sh: number, sm: number, eh: number, em: number, isBreak = false): BusyMs => ({
    start: at(d, sh, sm),
    end: at(d, eh, em),
    ...(isBreak ? { isBreak: true } : {}),
  });

  it('counts the whole working window when a day is entirely free', () => {
    const cap = computeSpareCapacity([workingDay(MON)], [], WR, at(MON, 0));
    expect(cap.totalMinutes).toBe(480); // 09:00-17:00
    expect(cap.gapCount).toBe(1);
    expect(cap.largestGapMinutes).toBe(480);
    expect(cap.byDate).toEqual([{ date: dateStr(MON), freeMinutes: 480 }]);
  });

  it('counts the whole gap after a maxed run (relaxed: no buffer deduction)', () => {
    // 09:00-11:00 is a full 120-min run. Under the SOFT run rule, placement can
    // abut it (dropping the cap), so spare measures the whole 11:00-17:00 gap with
    // NO buffer carved out — matching what the planner could actually use.
    const cap = computeSpareCapacity([workingDay(MON)], [busy(MON, 9, 0, 11, 0)], WR, at(MON, 0));
    expect(cap.totalMinutes).toBe(360); // 11:00-17:00, whole gap
    expect(cap.byDate).toEqual([{ date: dateStr(MON), freeMinutes: 360 }]);
  });

  it('does not deduct a buffer next to a sub-max run', () => {
    // 09:00-10:00 is only 60 min (< max), so no buffer is owed to the gap.
    const cap = computeSpareCapacity([workingDay(MON)], [busy(MON, 9, 0, 10, 0)], WR, at(MON, 0));
    expect(cap.totalMinutes).toBe(420); // 10:00-17:00, no deduction
  });

  it('does not deduct a buffer next to a break (breaks are not work runs)', () => {
    // Maxed run 09:00-11:00, then a lunch break 11:00-11:30, then free to 17:00.
    // The break separates the gap from the run, so no buffer is deducted.
    const cap = computeSpareCapacity(
      [workingDay(MON)],
      [busy(MON, 9, 0, 11, 0), busy(MON, 11, 0, 11, 30, true)],
      WR,
      at(MON, 0)
    );
    expect(cap.totalMinutes).toBe(330); // 11:30-17:00
  });

  it('ignores gaps shorter than the 30-minute minimum', () => {
    // Only a 20-min tail (16:40-17:00) is free — too small to hold a block.
    const cap = computeSpareCapacity([workingDay(MON)], [busy(MON, 9, 0, 16, 40)], WR, at(MON, 0));
    expect(cap.totalMinutes).toBe(0);
    expect(cap.gapCount).toBe(0);
    expect(cap.byDate).toEqual([]);
  });

  it('clips to the now-cutoff and splits free time per date', () => {
    const cap = computeSpareCapacity(
      [workingDay(MON), workingDay(TUE)],
      [],
      WR,
      at(MON, 14) // now = Monday 14:00
    );
    // Monday counts only 14:00-17:00 (180); Tuesday counts the full 480.
    expect(cap.byDate).toEqual([
      { date: dateStr(MON), freeMinutes: 180 },
      { date: dateStr(TUE), freeMinutes: 480 },
    ]);
    expect(cap.totalMinutes).toBe(660);
    expect(cap.largestGapMinutes).toBe(480);
  });

  it('excludes a fully-past day entirely', () => {
    const cap = computeSpareCapacity(
      [workingDay(MON), workingDay(TUE)],
      [],
      WR,
      at(TUE, 9) // now = Tuesday 09:00, Monday is fully past
    );
    expect(cap.byDate).toEqual([{ date: dateStr(TUE), freeMinutes: 480 }]);
  });
});

describe('proposeBlocks - determinism', () => {
  it('produces identical output across runs', () => {
    const build = () =>
      proposeBlocks(
        makeInput({
          candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' })],
        })
      );
    expect(build()).toEqual(build());
  });
});

describe('proposeBlocks - evening overflow', () => {
  const OVERFLOW = { start: '21:00', end: '23:00' };
  // A single working day with only one free hour forces a second task to overflow.
  const tightScheduling = (extra: Partial<WorkflowConfig['scheduling']> = {}) => ({
    workingDays: ['Monday'],
    workingHours: { start: '09:00', end: '10:00' },
    ...extra,
  });

  it('places an overflow block for a real task that did not fit in working hours', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: [] } },
          scheduling: tightScheduling({ overflow: OVERFLOW }),
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' })],
      })
    );
    const overflow = proposals.filter(p => p.overflow);
    const normal = proposals.filter(p => !p.overflow);
    // One task fits the single working hour; the other overflows to the evening.
    expect(normal).toHaveLength(1);
    expect(overflow).toHaveLength(1);
    const o = overflow[0];
    expect(o.overflow).toBe(true);
    expect(o.kind).toBe('task');
    expect(o.task?.gid).toBeDefined();
    expect(o.date).toBe(dateStr(WEEK_START));
    expect(o.durationMinutes).toBe(60);
    // Slot sits inside the 21:00–23:00 window (60-min block → start 21:00–22:00).
    expect(o.start >= '21:00' && o.start <= '22:00').toBe(true);
    // The two blocks together cover both distinct tasks.
    expect(new Set([...normal, ...overflow].map(p => p.task?.gid))).toEqual(new Set(['a', 'b']));
  });

  it('does not create overflow blocks for reserved (task-less) filler', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: [] } },
          scheduling: tightScheduling({ overflow: OVERFLOW }),
        }),
        candidateTasks: [], // no real tasks → only reserved filler, which never overflows
      })
    );
    expect(proposals.some(p => p.overflow)).toBe(false);
  });

  it('respects the work-run rule inside the overflow window', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 3, targetLength: '1h', preferredTimes: [] } },
          scheduling: tightScheduling({
            workRun: { maxMinutes: 60, bufferMinutes: 15 },
            overflow: OVERFLOW,
          }),
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' }), task({ gid: 'c' })],
      })
    );
    const overflow = proposals.filter(p => p.overflow);
    // Max run 60 → after the first 60-min overflow block (a maxed run) a 15-min
    // gap is required, leaving no room for a second 60-min block before 23:00.
    expect(overflow).toHaveLength(1);
    expect(overflow[0].start).toBe('21:00');
  });

  it('emits no overflow blocks when the window is not configured', () => {
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: [] } },
          scheduling: tightScheduling(),
        }),
        candidateTasks: [task({ gid: 'a' }), task({ gid: 'b' })],
      })
    );
    expect(proposals.some(p => p.overflow)).toBe(false);
  });

  it('overflow-window time is not counted in spare capacity', () => {
    const MON = new Date(2026, 6, 13);
    const at = (d: Date, h: number, m = 0) =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
    const wd: WorkingDay = {
      date: MON,
      dateStr: dateStr(MON),
      whStartMs: at(MON, 9),
      whEndMs: at(MON, 19),
    };
    // A busy block in the evening overflow window (21:00–22:00) must not reduce
    // the spare capacity measured across the 09:00–19:00 working window.
    const busy: BusyMs[] = [{ start: at(MON, 21), end: at(MON, 22) }];
    const cap = computeSpareCapacity([wd], busy, { maxMinutes: 120, bufferMinutes: 15 }, at(MON, 9));
    expect(cap.byDate).toEqual([{ date: dateStr(MON), freeMinutes: 600 }]);
  });
});

// --- Regression: spare capacity and placement must never disagree ----------
// Reproduces the reported screenshot bug: the review step advertised "~1h of
// usable free time (largest gap 1h)" while a 30-min task fell to evening
// overflow. Two independent divergences caused it:
//   (1) the 15-min slot grid could not land in a gap whose only run-rule-valid
//       offset sat off-grid (busy edges at :50 forced a valid start at :05); and
//   (2) computeSpareCapacity counted usable minutes a gap could not actually
//       hold under the work-run rule.
describe('proposeBlocks - placement/spare agreement (screenshot regression)', () => {
  const WR: WorkRun = { maxMinutes: 120, bufferMinutes: 15 };
  const MON = new Date(2026, 6, 13);
  const at = (h: number, m = 0) => new Date(2026, 6, 13, h, m).getTime();
  const timeAt = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const dstr = dateStr(MON);
  const win = (startH: number, endH: number, endM = 0): Window => ({
    date: MON,
    dateStr: dstr,
    startMs: at(startH, 0),
    endMs: at(endH, endM),
    preferred: false,
    bestTimeMatch: false,
  });

  it('findSlot lands on the off-grid valid offset (11:05) a fixed 15-min grid would skip', () => {
    // Runs 09:10-10:50 (100min) and 11:50-13:30 (100min): the 60-min gap between
    // them admits exactly one valid 30-min placement, 11:05-11:35 (15-min buffer
    // both sides). A :00/:15/:30 grid never tries :05.
    const busy: BusyMs[] = [
      { start: at(9, 10), end: at(10, 50) },
      { start: at(11, 50), end: at(13, 30) },
    ];
    const slot = findSlot([win(10, 11, 50)], 30, WR, busy, at(9, 0));
    expect(slot).not.toBeNull();
    expect(timeAt(slot!.startMs)).toBe('11:05');
    expect(slotIsValid(slot!.startMs, slot!.endMs, busy, WR)).toBe(true);
  });

  it('places a 30-min task in a working-hours gap instead of sending it to overflow', () => {
    // The only free slot all day is the off-grid 11:05-11:35 window; everything
    // else is busy. The task must be placed in working hours, not overflowed.
    const busyIntervals = [
      { start: new Date(at(9, 0)), end: new Date(at(10, 50)) },
      { start: new Date(at(11, 50)), end: new Date(at(17, 0)) },
    ];
    const proposals = proposeBlocks(
      makeInput({
        config: makeConfig({
          quotas: { Blogs: { weeklyCount: 1, targetLength: '30min', preferredTimes: [] } },
          typeMapping: { Blogs: ['blog'] },
          scheduling: {
            workingDays: ['Monday'],
            workingHours: { start: '09:00', end: '17:00' },
            overflow: { start: '21:00', end: '23:00' },
          },
        }),
        candidateTasks: [
          { gid: 'blog-1', title: 'Convert to blogpost', typeSignals: ['blog'], integrationId: 'asana-1' },
        ],
        busyIntervals,
      })
    );
    expect(proposals.some(p => p.overflow)).toBe(false);
    const placed = proposals.find(p => p.task?.gid === 'blog-1');
    expect(placed).toBeDefined();
    expect(placed!.overflow).toBeUndefined();
    expect(placed!.date).toBe(dstr);
    expect(placed!.start).toBe('11:05');
  });

  it('computeSpareCapacity counts a gap the SOFT rule could use (relaxed: overlap only)', () => {
    // 110-min run, a 45-min gap, then busy to end. A strict run-cap would reject
    // any 30-min block here (it bridges a run past 120), but the soft rule would
    // place a trimmed block, so spare measures the whole 45-min gap — relaxed spare
    // agrees with relaxed placement.
    const busy: BusyMs[] = [
      { start: at(9, 0), end: at(10, 50) }, // 110-min run
      { start: at(11, 35), end: at(17, 0) }, // fills the rest of the day
    ];
    const wd: WorkingDay = { date: MON, dateStr: dstr, whStartMs: at(9, 0), whEndMs: at(17, 0) };
    const cap = computeSpareCapacity([wd], busy, WR, at(9, 0));
    expect(cap.totalMinutes).toBe(45); // whole 10:50-11:35 gap
    expect(cap.gapCount).toBe(1);
    expect(cap.largestGapMinutes).toBe(45);
  });

  it('spare capacity measures the whole free gap (run-cap ignored, overlap only)', () => {
    // The 60-min gap between two 100-min runs: relaxed spare counts the full 60
    // (the soft rule can fill it), not the strict-only 30-min buffered span.
    const busy: BusyMs[] = [
      { start: at(9, 10), end: at(10, 50) },
      { start: at(11, 50), end: at(13, 30) },
    ];
    const wd: WorkingDay = { date: MON, dateStr: dstr, whStartMs: at(10, 50), whEndMs: at(11, 50) };
    const cap = computeSpareCapacity([wd], busy, WR, at(9, 0));
    expect(cap.totalMinutes).toBe(60); // the whole gap is usable under the soft rule
    // Strict findSlot still lands off-grid at 11:05 (tier a of the soft search).
    expect(findSlot([win(10, 11, 50)], 30, WR, busy, at(9, 0))).not.toBeNull();
  });
});

describe('proposeBlocks - office-day deep-work cap (perDayDeepWorkEndMs)', () => {
  // Daily deep work, morning window 08:30–11:00. The office-day get-ready block
  // caps how late deep work may run in the morning; the engine honours it.
  const deepDailyConfig = () =>
    makeConfig({
      quotas: {
        'Writing/Deep Work': {
          weeklyCount: 3,
          targetLength: '1.5h',
          grouped: true,
          daily: true,
          preferredTimes: ['08:30-11:00'],
        },
      },
      typeMapping: { 'Writing/Deep Work': ['deep'] },
      scheduling: { workingDays: ['Monday'], workingHours: { start: '08:30', end: '17:00' } },
    });
  const MON = '2026-07-13';
  const monMs = (h: number, m = 0) => new Date(2026, 6, 13, h, m, 0, 0).getTime();

  it('places a full 90-min block when uncapped (baseline)', () => {
    const proposals = proposeBlocks(
      makeInput({ config: deepDailyConfig(), candidateTasks: [task({ gid: 'a', typeSignals: ['deep'] })] })
    );
    const deep = proposals.find(p => p.category === 'Writing/Deep Work')!;
    expect(deep.start).toBe('08:30');
    expect(deep.durationMinutes).toBe(90);
  });

  it('shrinks deep work to end at the get-ready block on an office day', () => {
    // Cap at 09:45 (a get-ready block starts there) → only 75 min of morning, so
    // the 90-min block shrinks to fill it rather than running past the commute.
    const proposals = proposeBlocks(
      makeInput({
        config: deepDailyConfig(),
        candidateTasks: [task({ gid: 'a', typeSignals: ['deep'] })],
        perDayDeepWorkEndMs: { [MON]: monMs(9, 45) },
      })
    );
    const deep = proposals.find(p => p.category === 'Writing/Deep Work')!;
    expect(deep.start).toBe('08:30');
    expect(deep.durationMinutes).toBe(75);
    expect(deep.trimmedFromMinutes).toBe(90);
  });

  it('skips deep work when fewer than 60 min remain before the get-ready block', () => {
    // Cap at 09:15 → only 45 min of morning, under the 60-min floor, so the daily
    // deep-work placement skips the day entirely (no afternoon fallback).
    const proposals = proposeBlocks(
      makeInput({
        config: deepDailyConfig(),
        candidateTasks: [task({ gid: 'a', typeSignals: ['deep'] })],
        perDayDeepWorkEndMs: { [MON]: monMs(9, 15) },
      })
    );
    expect(proposals.some(p => p.category === 'Writing/Deep Work')).toBe(false);
  });
});
