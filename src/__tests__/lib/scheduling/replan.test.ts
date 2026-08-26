/**
 * Tests for the pure "Mid-week replan" logic.
 * All Dates are built with the local Date constructor so the tests are
 * timezone-independent.
 */
import { planReplan, type ReplanBlock } from '@/lib/scheduling/replan';
import type { CandidateTask } from '@/lib/scheduling/types';
import {
  CONSULTING_TITLE,
  LEARNING_TITLE,
  NEW_BOOKIES_TITLE,
  SIDE_PROJECTS_TITLE,
  newBookiesPlacementIsValid,
} from '@/lib/scheduling/rituals';
import type { BusyInterval } from '@/lib/scheduling/types';
import type { WorkflowConfig } from '@/lib/workflow-config-storage';

const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEK_START = new Date(2026, 6, 13, 0, 0, 0, 0); // Monday 2026-07-13

function makeConfig(overrides: {
  quotas?: WorkflowConfig['taskQuotas'];
  scheduling?: Partial<WorkflowConfig['scheduling']>;
} = {}): WorkflowConfig {
  return {
    taskQuotas: overrides.quotas ?? {
      Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: ['09:00-11:00'] },
    },
    typeMapping: { Deep: ['deep'] },
    scheduling: {
      bufferBetweenTasks: '0min',
      workingDays: ALL_DAYS,
      workingHours: { start: '09:00', end: '17:00' },
      ...overrides.scheduling,
    },
    lastUpdated: '2026-07-12T00:00:00.000Z',
  };
}

// Build a block from a local date + start; startMs/endMs are derived so the
// block's "actual" interval matches its stored schedule.
function block(o: Partial<ReplanBlock> & { date: string; start: string }): ReplanBlock {
  const dur = o.durationMinutes ?? 60;
  const [y, mo, d] = o.date.split('-').map(Number);
  const [h, m] = o.start.split(':').map(Number);
  const startMs = new Date(y, mo - 1, d, h, m, 0, 0).getTime();
  return {
    googleEventId: 'evt',
    googleIntegrationId: 'g1',
    category: 'Deep',
    titles: ['Task'],
    done: false,
    durationMinutes: dur,
    startMs,
    endMs: startMs + dur * 60 * 1000,
    ...o,
  };
}

function busy(d: number, h1: number, m1: number, h2: number, m2: number): BusyInterval {
  return { start: new Date(2026, 6, d, h1, m1), end: new Date(2026, 6, d, h2, m2) };
}

function run(o: {
  blocks: ReplanBlock[];
  otherBusy?: BusyInterval[];
  now: Date;
  config?: WorkflowConfig;
  existingRitualTitlesByDate?: Record<string, Set<string>>;
  candidateTasks?: CandidateTask[];
  deepWorkWeekTasks?: CandidateTask[];
  existingScheduledCounts?: Record<string, number>;
  existingCategoryCountsByDate?: Record<string, Record<string, number>>;
}) {
  return planReplan({
    config: o.config ?? makeConfig(),
    weekStart: WEEK_START,
    now: o.now,
    blocks: o.blocks,
    otherBusy: o.otherBusy ?? [],
    existingRitualTitlesByDate: o.existingRitualTitlesByDate,
    candidateTasks: o.candidateTasks,
    deepWorkWeekTasks: o.deepWorkWeekTasks,
    existingScheduledCounts: o.existingScheduledCounts,
    existingCategoryCountsByDate: o.existingCategoryCountsByDate,
  });
}

// A candidate task in a quota category (typeSignals drive classification).
function cand(o: { gid: string; signal: string; title?: string }): CandidateTask {
  return { gid: o.gid, title: o.title ?? o.gid, typeSignals: [o.signal] };
}

const WED_8AM = new Date(2026, 6, 15, 8, 0, 0, 0); // Wednesday 08:00

describe('planReplan - classification', () => {
  it('classifies a past, incomplete block as missed and re-slots it', () => {
    const { kept, moves, unplaceable } = run({
      blocks: [block({ googleEventId: 'a', date: '2026-07-13', start: '09:00' })], // Monday
      now: WED_8AM,
    });
    expect(kept).toHaveLength(0);
    expect(unplaceable).toHaveLength(0);
    expect(moves).toHaveLength(1);
    expect(moves[0].reason).toBe('missed');
    expect(moves[0].googleEventId).toBe('a');
    expect(moves[0].oldDate).toBe('2026-07-13');
    expect(moves[0].newDate).toBe('2026-07-15'); // Wednesday, first remaining day
    expect(moves[0].newStart).toBe('09:00'); // deep preferred window 09:00-11:00
  });

  it('keeps a past block whose linked work is already done', () => {
    const { kept, moves } = run({
      blocks: [block({ date: '2026-07-13', start: '09:00', done: true })],
      now: WED_8AM,
    });
    expect(moves).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });

  it('classifies a future block overlapping a real meeting as conflicted', () => {
    const { moves } = run({
      blocks: [block({ googleEventId: 'c', date: '2026-07-15', start: '14:00' })], // future
      otherBusy: [busy(15, 14, 0, 15, 0)], // meeting overlapping the block
      now: WED_8AM,
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].reason).toBe('conflict');
    // A full overlap (the whole 14:00–15:00 block is buried) is NOT nibbled in
    // place — it re-slots into the free preferred window.
    expect(moves[0].newStart).toBe('09:00');
    expect(moves[0].newDate).toBe('2026-07-15');
  });

  it('does not treat two app blocks overlapping each other as a conflict', () => {
    // Only otherBusy (real events) can trigger a conflict; app blocks overlapping
    // each other must not, so both pass through as kept.
    const { kept, moves } = run({
      blocks: [
        block({ googleEventId: 'x', date: '2026-07-15', start: '14:00' }),
        block({ googleEventId: 'y', date: '2026-07-15', start: '14:30' }),
      ],
      otherBusy: [],
      now: WED_8AM,
    });
    expect(moves).toHaveLength(0);
    expect(kept).toHaveLength(2);
  });

  it('keeps a part-done category container when the category still has a later block', () => {
    // Dave's deep-work blocks are capacity for the week's longer tasks, not a
    // promise to finish every member that day. A Monday container with a Thursday
    // sibling needs no new slot — the work continues there.
    const { kept, moves, unplaceable } = run({
      blocks: [
        block({
          googleEventId: 'container',
          date: '2026-07-13',
          start: '09:00',
          titles: ['Task A', 'Task B', 'Task C'],
          isCategoryContainer: true,
        }),
        block({ googleEventId: 'later', date: '2026-07-16', start: '09:00' }), // Thursday
      ],
      now: WED_8AM,
    });
    expect(moves).toHaveLength(0);
    expect(unplaceable).toHaveLength(0);
    expect(kept.map(k => k.googleEventId).sort()).toEqual(['container', 'later']);
  });

  it('still re-slots a category container when nothing of its category remains', () => {
    const { moves } = run({
      blocks: [
        block({
          googleEventId: 'container',
          date: '2026-07-13',
          start: '09:00',
          titles: ['Task A', 'Task B'],
          isCategoryContainer: true,
        }),
        // A later block of a DIFFERENT category is no substitute.
        block({ googleEventId: 'other', date: '2026-07-16', start: '09:00', category: 'Admin' }),
      ],
      now: WED_8AM,
    });
    expect(moves.map(m => m.googleEventId)).toEqual(['container']);
    expect(moves[0].reason).toBe('missed');
  });

  it('keeps a future block with no conflict untouched', () => {
    const { kept, moves, unplaceable } = run({
      blocks: [block({ googleEventId: 'k', date: '2026-07-16', start: '10:00' })], // Thursday, future
      now: WED_8AM,
    });
    expect(moves).toHaveLength(0);
    expect(unplaceable).toHaveLength(0);
    expect(kept).toHaveLength(1);
    expect(kept[0].googleEventId).toBe('k');
  });
});

describe('planReplan - re-slotting', () => {
  it('preserves each moving block’s duration and category', () => {
    const { moves } = run({
      blocks: [block({ date: '2026-07-13', start: '09:00', category: 'Deep', durationMinutes: 90 })],
      now: WED_8AM,
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].category).toBe('Deep');
    expect(moves[0].durationMinutes).toBe(90);
    expect(moves[0].newStart).toBe('09:00'); // 90 mins fits in 09:00-11:00
  });

  it('re-slots a same-day missed block, ignoring its own past interval', () => {
    // A block earlier today (06:00-07:00) has already ended. Today is still a
    // remaining working day; its own past interval must not block re-placement
    // into today's preferred window.
    const { moves } = run({
      blocks: [block({ date: '2026-07-15', start: '06:00' })],
      now: WED_8AM,
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].reason).toBe('missed');
    expect(moves[0].newDate).toBe('2026-07-15');
    expect(moves[0].newStart).toBe('09:00');
  });

  it('places two movers into distinct non-overlapping slots', () => {
    const config = makeConfig({
      quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: ['09:00-11:00'] } },
      scheduling: { workingDays: ['Wednesday'], workingHours: { start: '09:00', end: '11:00' } },
    });
    const { moves, unplaceable } = run({
      blocks: [
        block({ googleEventId: 'a', date: '2026-07-13', start: '09:00' }),
        block({ googleEventId: 'b', date: '2026-07-14', start: '09:00' }),
      ],
      now: WED_8AM,
      config,
    });
    expect(unplaceable).toHaveLength(0);
    expect(moves).toHaveLength(2);
    const starts = moves.map(m => m.newStart).sort();
    expect(starts).toEqual(['09:00', '10:00']);
    expect(moves.every(m => m.newDate === '2026-07-15')).toBe(true);
  });

  it('reports a block as unplaceable when the remaining week is full', () => {
    const config = makeConfig({
      quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['09:00-10:00'] } },
      scheduling: { workingDays: ['Wednesday'], workingHours: { start: '09:00', end: '10:00' } },
    });
    const { moves, unplaceable } = run({
      blocks: [block({ googleEventId: 'a', date: '2026-07-13', start: '09:00' })],
      otherBusy: [busy(15, 9, 0, 10, 0)], // the single remaining slot is taken
      now: WED_8AM,
      config,
    });
    expect(moves).toHaveLength(0);
    expect(unplaceable).toHaveLength(1);
    expect(unplaceable[0].googleEventId).toBe('a');
    expect(unplaceable[0].reason).toBe('missed');
  });

  it('offers an evening-overflow option for an unplaceable block when a window is configured', () => {
    const config = makeConfig({
      quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['09:00-10:00'] } },
      scheduling: {
        workingDays: ['Wednesday'],
        workingHours: { start: '09:00', end: '10:00' },
        overflow: { start: '21:00', end: '23:00' },
      },
    });
    const { moves, unplaceable } = run({
      blocks: [block({ googleEventId: 'a', date: '2026-07-13', start: '09:00' })],
      otherBusy: [busy(15, 9, 0, 10, 0)], // the single working-hours slot is taken
      now: WED_8AM,
      config,
    });
    expect(moves).toHaveLength(0);
    expect(unplaceable).toHaveLength(1);
    expect(unplaceable[0].overflowOption).toEqual({
      date: '2026-07-15',
      start: '21:00',
      durationMinutes: 60,
    });
  });

  it('leaves overflowOption undefined when no overflow window is configured', () => {
    const config = makeConfig({
      quotas: { Deep: { weeklyCount: 1, targetLength: '1h', preferredTimes: ['09:00-10:00'] } },
      scheduling: { workingDays: ['Wednesday'], workingHours: { start: '09:00', end: '10:00' } },
    });
    const { unplaceable, overflowConfigured } = run({
      blocks: [block({ googleEventId: 'a', date: '2026-07-13', start: '09:00' })],
      otherBusy: [busy(15, 9, 0, 10, 0)],
      now: WED_8AM,
      config,
    });
    expect(unplaceable).toHaveLength(1);
    expect(unplaceable[0].overflowOption).toBeUndefined();
    expect(overflowConfigured).toBe(false);
  });

  it('reports overflowConfigured when a window exists but a block still finds no evening slot', () => {
    // One evening hour on the single remaining day; two 60-min blocks compete for
    // it. The first reserves the slot, the second gets no overflowOption — but
    // overflowConfigured stays true so the UI can explain the window is full.
    const config = makeConfig({
      quotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: ['09:00-10:00'] } },
      scheduling: {
        workingDays: ['Wednesday'],
        workingHours: { start: '09:00', end: '10:00' },
        overflow: { start: '21:00', end: '22:00' },
      },
    });
    const { unplaceable, overflowConfigured } = run({
      blocks: [
        block({ googleEventId: 'a', date: '2026-07-13', start: '09:00' }),
        block({ googleEventId: 'b', date: '2026-07-13', start: '10:00' }),
      ],
      otherBusy: [busy(15, 9, 0, 10, 0)], // the single working-hours slot is taken
      now: WED_8AM,
      config,
    });
    expect(overflowConfigured).toBe(true);
    expect(unplaceable).toHaveLength(2);
    const withOverflow = unplaceable.filter(u => u.overflowOption);
    const withoutOverflow = unplaceable.filter(u => !u.overflowOption);
    expect(withOverflow).toHaveLength(1); // only one evening hour to go round
    expect(withoutOverflow).toHaveLength(1);
  });

  it('uses the afternoon default for a non-deep-work category with no preferred times', () => {
    const config = makeConfig({
      quotas: {
        Ops: { weeklyCount: 1, targetLength: '1h', preferredTimes: [] },
      },
    });
    const { moves } = run({
      blocks: [block({ date: '2026-07-13', start: '09:00', category: 'Ops' })],
      now: WED_8AM,
      config,
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].newStart).toBe('12:00'); // afternoon default 12:00-17:00
  });

  it('keeps mornings for a deep-work category with no preferred times', () => {
    const config = makeConfig({
      quotas: {
        'Writing/Deep Work': { weeklyCount: 1, targetLength: '1h', preferredTimes: [] },
      },
    });
    const { moves } = run({
      blocks: [block({ date: '2026-07-13', start: '09:00', category: 'Writing/Deep Work' })],
      now: WED_8AM,
      config,
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].newStart).toBe('09:00'); // deep work falls back to morning working hours
  });
});

// Absolute ms for a local yyyy-MM-dd + HH:mm (matches the block helper).
function ms(date: string, time: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = time.split(':').map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0).getTime();
}

describe('planReplan - meeting prep blocks', () => {
  const PREP_CONFIG = makeConfig({
    quotas: { 'Meeting prep': { weeklyCount: 0, targetLength: '15min', preferredTimes: [] } },
  });

  it('classifies a past, undone prep block as missed and re-slots it before its meeting', () => {
    // Prep block scheduled Monday for a Friday meeting; Monday has passed.
    const { moves, stale, unplaceable } = run({
      blocks: [
        block({
          googleEventId: 'prep',
          date: '2026-07-13',
          start: '09:00',
          durationMinutes: 15,
          category: 'Meeting prep',
          mustEndBeforeMs: ms('2026-07-17', '10:00'), // Friday 10:00 meeting
        }),
      ],
      now: WED_8AM,
      config: PREP_CONFIG,
    });
    expect(stale).toHaveLength(0);
    expect(unplaceable).toHaveLength(0);
    expect(moves).toHaveLength(1);
    expect(moves[0].reason).toBe('missed');
    // Slot must land before the Friday meeting.
    expect(ms(moves[0].newDate, moves[0].newStart) + 15 * 60 * 1000).toBeLessThanOrEqual(
      ms('2026-07-17', '10:00')
    );
  });

  it('honors mustEndBeforeMs + the morning exclusion when re-slotting a prep block', () => {
    // Meeting is Wednesday 10:00; today is Wednesday 08:00. The only room before it
    // is 08:00–10:00 today, but prep never starts a day: the first 90 minutes
    // (08:00–09:30) are excluded, so the block re-slots to 09:30 (workStart+90) and
    // still ends by 10:00.
    const cfg = makeConfig({
      quotas: { 'Meeting prep': { weeklyCount: 0, targetLength: '30min', preferredTimes: [] } },
      scheduling: { workingHours: { start: '08:00', end: '17:00' } },
    });
    const { moves, stale } = run({
      blocks: [
        block({
          googleEventId: 'prep',
          date: '2026-07-13',
          start: '09:00',
          durationMinutes: 30,
          category: 'Meeting prep',
          mustEndBeforeMs: ms('2026-07-15', '10:00'),
        }),
      ],
      now: WED_8AM,
      config: cfg,
    });
    expect(stale).toHaveLength(0);
    expect(moves).toHaveLength(1);
    expect(moves[0].newStart).toBe('09:30'); // workStart (08:00) + 90 min, not 08:00
    expect(ms(moves[0].newDate, moves[0].newStart) + 30 * 60 * 1000).toBeLessThanOrEqual(
      ms('2026-07-15', '10:00')
    );
  });

  it('marks a prep block stale when its meeting has already happened', () => {
    // Meeting was Monday; it is now Wednesday. Nothing to prepare for.
    const { moves, stale, unplaceable } = run({
      blocks: [
        block({
          googleEventId: 'prep',
          date: '2026-07-13',
          start: '09:00',
          durationMinutes: 15,
          category: 'Meeting prep',
          mustEndBeforeMs: ms('2026-07-13', '10:00'), // Monday meeting, already past
        }),
      ],
      now: WED_8AM,
      config: PREP_CONFIG,
    });
    expect(moves).toHaveLength(0);
    expect(unplaceable).toHaveLength(0);
    expect(stale).toHaveLength(1);
    expect(stale[0].googleEventId).toBe('prep');
    expect(stale[0].reason).toBe('missed');
  });

  it('marks a prep block stale when no slot fits before a still-future meeting', () => {
    // Meeting is today at 09:00 but now is 08:00 and working hours start at 09:00,
    // so there is no working slot that ends before the meeting → stale.
    const { moves, stale } = run({
      blocks: [
        block({
          googleEventId: 'prep',
          date: '2026-07-13',
          start: '09:00',
          durationMinutes: 15,
          category: 'Meeting prep',
          mustEndBeforeMs: ms('2026-07-15', '09:00'), // Wednesday 09:00, right at hours start
        }),
      ],
      now: WED_8AM,
      config: PREP_CONFIG,
    });
    expect(moves).toHaveLength(0);
    expect(stale).toHaveLength(1);
    expect(stale[0].googleEventId).toBe('prep');
  });

  it('keeps a done prep block untouched', () => {
    const { moves, stale, kept } = run({
      blocks: [
        block({
          googleEventId: 'prep',
          date: '2026-07-13',
          start: '09:00',
          durationMinutes: 15,
          category: 'Meeting prep',
          done: true,
          mustEndBeforeMs: ms('2026-07-13', '10:00'),
        }),
      ],
      now: WED_8AM,
      config: PREP_CONFIG,
    });
    expect(moves).toHaveLength(0);
    expect(stale).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });
});

describe('planReplan - ritual blocks', () => {
  it('never treats a past, undone lunch ritual as missed (keeps it, does not re-slot)', () => {
    const { moves, kept, stale } = run({
      blocks: [
        block({
          googleEventId: 'lunch',
          date: '2026-07-13', // Monday, already past
          start: '12:00',
          durationMinutes: 30,
          category: 'Lunch',
          titles: ['🍽️ Lunch'],
          ritualKind: 'lunch',
          isBreak: true,
        }),
      ],
      now: WED_8AM,
    });
    expect(moves).toHaveLength(0);
    expect(stale).toHaveLength(0);
    expect(kept).toHaveLength(1);
    expect(kept[0].googleEventId).toBe('lunch');
  });

  it('re-slots a future lunch that now conflicts with a meeting into its 11:30–13:00 window', () => {
    const { moves } = run({
      blocks: [
        block({
          googleEventId: 'lunch',
          date: '2026-07-15', // Wednesday, future
          start: '12:00',
          durationMinutes: 30,
          category: 'Lunch',
          titles: ['🍽️ Lunch'],
          ritualKind: 'lunch',
          isBreak: true,
        }),
      ],
      otherBusy: [busy(15, 12, 0, 12, 30)], // meeting booked over the lunch slot
      now: WED_8AM,
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].reason).toBe('conflict');
    // Re-slotted within the lunch window, avoiding the 12:00–12:30 meeting.
    expect(moves[0].newStart >= '11:30' && moves[0].newStart <= '13:00').toBe(true);
    expect(moves[0].newStart).not.toBe('12:00');
  });

  it('re-slots a conflicted emails ritual toward the end of the working day', () => {
    const { moves } = run({
      blocks: [
        block({
          googleEventId: 'emails',
          date: '2026-07-15',
          start: '16:00',
          durationMinutes: 30,
          category: 'Emails',
          titles: ['📧 Emails'],
          ritualKind: 'emails',
        }),
      ],
      otherBusy: [busy(15, 16, 0, 16, 30)], // meeting over the emails slot
      now: WED_8AM,
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].reason).toBe('conflict');
    // Stays in the final two hours (15:00–17:00), not on the taken 16:00 slot.
    expect(moves[0].newStart >= '15:00').toBe(true);
    expect(moves[0].newStart).not.toBe('16:00');
  });
});

describe('planReplan - break blocks', () => {
  it('deletes a future break that now conflicts with a meeting (never moves it)', () => {
    const { moves, deletions, kept } = run({
      blocks: [
        block({
          googleEventId: 'brk',
          date: '2026-07-15', // Wednesday, future
          start: '10:30',
          durationMinutes: 15,
          category: 'Break',
          titles: ['☕ Break'],
          ritualKind: 'break',
          isBreak: true,
        }),
      ],
      otherBusy: [busy(15, 10, 30, 11, 0)], // meeting booked over the break slot
      now: WED_8AM,
    });
    expect(moves).toHaveLength(0);
    expect(kept).toHaveLength(0);
    expect(deletions).toHaveLength(1);
    expect(deletions[0].googleEventId).toBe('brk');
    expect(deletions[0].reason).toBe('conflict');
  });

  it('keeps a future break with no conflict, and never treats a past break as missed', () => {
    const { moves, deletions, kept } = run({
      blocks: [
        block({
          googleEventId: 'brk-future',
          date: '2026-07-15',
          start: '10:30',
          durationMinutes: 15,
          category: 'Break',
          titles: ['☕ Break'],
          ritualKind: 'break',
          isBreak: true,
        }),
        block({
          googleEventId: 'brk-past',
          date: '2026-07-13', // Monday, already past
          start: '10:30',
          durationMinutes: 15,
          category: 'Break',
          titles: ['☕ Break'],
          ritualKind: 'break',
          isBreak: true,
        }),
      ],
      now: WED_8AM,
    });
    expect(moves).toHaveLength(0);
    expect(deletions).toHaveLength(0);
    expect(kept.map(k => k.googleEventId).sort()).toEqual(['brk-future', 'brk-past']);
  });
});

describe('planReplan - missing-ritual additions', () => {
  it('proposes exercise/lunch/emails additions for remaining working days missing them', () => {
    // No ritual context at all → every remaining working day (Wed–Sun, from the
    // Wednesday 08:00 "now") is missing all three rituals, so each gets proposed.
    const result = planReplan({
      config: makeConfig({ scheduling: { workingHours: { start: '08:30', end: '18:00' } } }),
      weekStart: WEEK_START,
      now: WED_8AM,
      blocks: [],
      otherBusy: [],
      existingRitualTitlesByDate: {},
    });
    // Wednesday should get an exercise addition at 15:00 (the ideal slot is free).
    const wedExercise = result.additions.find(
      a => a.date === '2026-07-15' && a.title === '🏋️ Exercise'
    );
    expect(wedExercise).toBeDefined();
    expect(wedExercise!.kind).toBe('ritual');
    expect(wedExercise!.start).toBe('15:00');
    // Every remaining working day gets its own exercise addition.
    const exerciseDays = new Set(
      result.additions.filter(a => a.title === '🏋️ Exercise').map(a => a.date)
    );
    expect(exerciseDays.size).toBeGreaterThanOrEqual(3); // Wed, Thu, Fri (+weekend)
    expect(exerciseDays.has('2026-07-14')).toBe(false); // Tuesday is in the past
  });

  it('skips a day that already has the ritual (dedupe by live title) and omits additions when no context is given', () => {
    // Wednesday already has an exercise event on the live calendar → no addition.
    const withContext = planReplan({
      config: makeConfig({ scheduling: { workingHours: { start: '08:30', end: '18:00' } } }),
      weekStart: WEEK_START,
      now: WED_8AM,
      blocks: [],
      otherBusy: [],
      existingRitualTitlesByDate: { '2026-07-15': new Set(['🏋️ Exercise']) },
    });
    expect(
      withContext.additions.find(a => a.date === '2026-07-15' && a.title === '🏋️ Exercise')
    ).toBeUndefined();

    // No ritual-titles context supplied → additions are omitted entirely.
    const noContext = planReplan({
      config: makeConfig(),
      weekStart: WEEK_START,
      now: WED_8AM,
      blocks: [],
      otherBusy: [],
    });
    expect(noContext.additions).toEqual([]);
  });
});

describe('planReplan - retired ritual + mis-placed new-bookies removals', () => {
  // A ritual block built like the analyze route builds them (ritualKind + titles).
  const ritual = (o: {
    googleEventId: string;
    date: string;
    start: string;
    durationMinutes?: number;
    ritualKind: ReplanBlock['ritualKind'];
    title: string;
  }): ReplanBlock =>
    block({
      googleEventId: o.googleEventId,
      date: o.date,
      start: o.start,
      durationMinutes: o.durationMinutes ?? 30,
      category: 'Ritual',
      titles: [o.title],
      ritualKind: o.ritualKind,
    });

  it('proposes REMOVAL of a future retired-ritual block (never kept or moved)', () => {
    // Consulting/Side projects/Learning are retired; a future block gets removed.
    const { removals, kept, moves } = run({
      blocks: [
        ritual({ googleEventId: 'c', date: '2026-07-17', start: '14:00', durationMinutes: 60, ritualKind: 'consulting', title: CONSULTING_TITLE }),
        ritual({ googleEventId: 's', date: '2026-07-16', start: '15:00', durationMinutes: 90, ritualKind: 'sideProjects', title: SIDE_PROJECTS_TITLE }),
        ritual({ googleEventId: 'l', date: '2026-07-17', start: '13:00', durationMinutes: 60, ritualKind: 'learning', title: LEARNING_TITLE }),
      ],
      now: WED_8AM,
    });
    expect(removals.map(r => r.googleEventId).sort()).toEqual(['c', 'l', 's']);
    expect(removals.every(r => r.reason === 'retired')).toBe(true);
    expect(kept).toHaveLength(0);
    expect(moves).toHaveLength(0);
  });

  it('leaves a PAST retired-ritual block alone (only future ones are removed)', () => {
    const { removals, kept } = run({
      blocks: [
        ritual({ googleEventId: 'c', date: '2026-07-13', start: '14:00', ritualKind: 'consulting', title: CONSULTING_TITLE }), // Monday, past
      ],
      now: WED_8AM,
    });
    expect(removals).toHaveLength(0);
    expect(kept).toHaveLength(1); // a past ritual is kept as history
  });

  it('removes a mis-placed future new-bookies block and re-places it in the evening', () => {
    // A new-bookies block sitting inside working hours on a Wednesday breaks the
    // rule (Mon/Fri evening only) → removed as mis-placed and re-added on Friday.
    const misplacedDate = '2026-07-15'; // Wednesday
    const { removals, additions } = planReplan({
      config: makeConfig(),
      weekStart: WEEK_START,
      now: WED_8AM,
      blocks: [
        ritual({ googleEventId: 'nb', date: misplacedDate, start: '14:00', ritualKind: 'newBookies', title: NEW_BOOKIES_TITLE }),
      ],
      otherBusy: [],
      existingRitualTitlesByDate: { [misplacedDate]: new Set([NEW_BOOKIES_TITLE]) },
    });
    expect(removals).toHaveLength(1);
    expect(removals[0].googleEventId).toBe('nb');
    expect(removals[0].reason).toBe('misplaced');
    // Re-placed validly (Friday evening, since Monday is already past).
    const readded = additions.find(a => a.title === NEW_BOOKIES_TITLE)!;
    expect(readded).toBeDefined();
    expect(newBookiesPlacementIsValid(readded.date, readded.start)).toBe(true);
    expect(readded.date).toBe('2026-07-17'); // Friday
  });

  it('keeps a correctly-placed future new-bookies block (no removal)', () => {
    const { removals, kept } = run({
      blocks: [
        ritual({ googleEventId: 'nb', date: '2026-07-17', start: '18:00', ritualKind: 'newBookies', title: NEW_BOOKIES_TITLE }), // Friday evening
      ],
      now: WED_8AM,
    });
    expect(removals).toHaveLength(0);
    expect(kept.map(k => k.googleEventId)).toContain('nb');
  });
});

describe('planReplan - deep-work morning flex on re-slot (3c)', () => {
  const deepConfig = makeConfig({
    quotas: {
      'Writing/Deep Work': { weeklyCount: 2, targetLength: '90min', preferredTimes: ['09:00-11:00'] },
    },
  });

  it('slides a re-slotted deep-work block later in the morning around a meeting', () => {
    // A missed deep-work block re-slots to Wednesday; a 08:30–10:00 meeting there
    // pushes it to 10:15 (still the morning) rather than out of it.
    const { moves } = run({
      config: deepConfig,
      blocks: [
        block({
          googleEventId: 'd',
          date: '2026-07-13', // Monday, missed
          start: '09:00',
          durationMinutes: 90,
          category: 'Writing/Deep Work',
        }),
      ],
      otherBusy: [busy(15, 8, 30, 10, 0)], // Wednesday 08:30–10:00
      now: WED_8AM,
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].newDate).toBe('2026-07-15'); // Wednesday
    expect(moves[0].newStart).toBe('10:15');
    expect(moves[0].durationMinutes).toBe(90); // full duration kept
  });
});

describe('planReplan - in-place conflict resolution + unplaceable slot reservation', () => {
  const deepConfig = makeConfig({
    quotas: {
      'Writing/Deep Work': { weeklyCount: 2, targetLength: '90min', preferredTimes: ['09:00-11:00'] },
    },
  });

  // The 25 Aug 2026 incident: a plain 15-minute calendar event overlapped only the
  // first 15 minutes of a 90-minute deep-work container. The old code uprooted the
  // whole container (and then packed new blocks into its "vacated" time). It must
  // instead resolve IN PLACE — slid past the meeting on the same day.
  it('slides a conflicted deep-work container past a small edge overlap instead of uprooting it', () => {
    const { moves, unplaceable, backfill, conversions } = run({
      config: deepConfig,
      blocks: [
        block({
          googleEventId: 'deepwork',
          date: '2026-07-15', // Wednesday, future (now Wed 08:00)
          start: '08:30',
          durationMinutes: 90, // 08:30–10:00
          category: 'Writing/Deep Work',
          isCategoryContainer: true,
          titles: ['✍️ Deep work'],
        }),
      ],
      otherBusy: [busy(15, 8, 30, 8, 45)], // a 15-min event over the first 15 minutes
      now: WED_8AM,
    });
    expect(unplaceable).toHaveLength(0);
    expect(conversions).toHaveLength(0); // a container is not converted
    expect(moves).toHaveLength(1);
    expect(moves[0].googleEventId).toBe('deepwork');
    expect(moves[0].reason).toBe('conflict');
    expect(moves[0].oldDate).toBe('2026-07-15');
    expect(moves[0].newDate).toBe('2026-07-15'); // same day — never uprooted
    expect(moves[0].newStart).toBe('08:45'); // slid to the end of the overlap
    expect(moves[0].durationMinutes).toBe(90); // full duration kept
    // Nothing is packed into the block's original 08:30 start.
    expect(backfill.some(b => b.date === '2026-07-15' && b.start < '10:15')).toBe(false);
  });

  // A conflicted block ≥90 min with a PARTIAL overlap that cannot slide at full
  // length trims toward the 60-min floor to stay on its own day rather than
  // moving off it.
  it('trims a long conflicted block to fit the same day rather than uprooting it', () => {
    const config = makeConfig({
      quotas: { Ops: { weeklyCount: 1, targetLength: '90min', preferredTimes: ['09:00-11:00'] } },
      scheduling: { workingDays: ['Wednesday'], workingHours: { start: '09:00', end: '10:40' } },
    });
    const { moves, unplaceable } = run({
      config,
      blocks: [
        block({
          googleEventId: 'ops',
          date: '2026-07-15',
          start: '09:00',
          durationMinutes: 90, // 09:00–10:30
          category: 'Ops',
        }),
      ],
      otherBusy: [busy(15, 9, 0, 9, 40)], // 40-min overlap on a 90-min block (< half)
      now: WED_8AM,
    });
    expect(unplaceable).toHaveLength(0);
    expect(moves).toHaveLength(1);
    expect(moves[0].newDate).toBe('2026-07-15'); // same day
    expect(moves[0].newStart).toBe('09:40'); // slid past the meeting
    expect(moves[0].durationMinutes).toBe(60); // trimmed from 90 to the 60-min floor to fit before 10:40
  });

  // A conflicted block half-or-more buried under a meeting is NOT nibbled in
  // place (the in-place window ignores the preferred-window end); it re-slots
  // into its category's preferred window via the cross-day mover logic.
  it('does not resolve a majority-overlap conflict in place', () => {
    const { moves } = run({
      blocks: [
        block({
          googleEventId: 'c',
          date: '2026-07-15',
          start: '14:00',
          durationMinutes: 60, // 14:00–15:00
        }),
      ],
      otherBusy: [busy(15, 14, 0, 14, 45)], // 45-min overlap on a 60-min block (≥ half)
      now: WED_8AM,
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].reason).toBe('conflict');
    // Falls through to the preferred-window re-slot (09:00) rather than sliding
    // in place to 14:45.
    expect(moves[0].newStart).toBe('09:00');
    expect(moves[0].newStart).not.toBe('14:45');
  });

  // When a block genuinely cannot be placed anywhere (in place or otherwise), its
  // event still sits on the calendar — so its ORIGINAL slot must be reserved and
  // never handed to a ritual addition, task backfill or free-slot listing.
  it('reserves an unplaceable block’s original slot against additions, backfill and free slots', () => {
    const config = makeConfig({
      quotas: {
        Ops: { weeklyCount: 1, targetLength: '60min', preferredTimes: ['09:00-10:40'] },
        Todos: { targetLength: '30min', preferredTimes: [] }, // quota-less catch-all → free slots
      },
      scheduling: { workingDays: ['Wednesday'], workingHours: { start: '09:00', end: '10:40' } },
    });
    // Free gaps in 09:00–10:40 are 09:00–09:40 (40m) and 10:00–10:40 (40m): a
    // 60-min Ops block fits in neither (and, being < 90 min, cannot trim), so it is
    // unplaceable. Its original slot is 09:00–10:00 with a genuinely free 09:00–09:40
    // head that free slots would otherwise grab.
    const { moves, unplaceable, backfill, freeSlots } = run({
      config,
      blocks: [
        block({
          googleEventId: 'ops',
          date: '2026-07-15',
          start: '09:00',
          durationMinutes: 60, // 09:00–10:00
          category: 'Ops',
        }),
      ],
      otherBusy: [busy(15, 9, 40, 10, 0)], // a meeting over the block's last 20 minutes
      candidateTasks: [cand({ gid: 'todo1', signal: 'todo' })],
      existingScheduledCounts: { Ops: 1 }, // Ops quota met → no Ops backfill
      now: WED_8AM,
    });
    expect(moves).toHaveLength(0);
    expect(unplaceable.map(u => u.googleEventId)).toEqual(['ops']);

    // Nothing may occupy any part of the reserved original interval [09:00, 10:00).
    const origStart = ms('2026-07-15', '09:00');
    const origEnd = ms('2026-07-15', '10:00');
    const overlapsOriginal = (date: string, start: string, durationMinutes: number) => {
      const s = ms(date, start);
      return s < origEnd && s + durationMinutes * 60 * 1000 > origStart;
    };
    for (const s of freeSlots) {
      expect(overlapsOriginal(s.date, s.start, s.durationMinutes)).toBe(false);
    }
    for (const b of backfill) {
      expect(overlapsOriginal(b.date, b.start, b.durationMinutes)).toBe(false);
    }
    // The genuinely-free tail (10:00–10:40) is still offered as free space.
    expect(freeSlots.some(s => s.date === '2026-07-15' && s.start === '10:00')).toBe(true);
  });
});

describe('planReplan - task backfill', () => {
  // A retired 💼 Consulting block on Wednesday morning is removed (freeing its
  // slot). The Deep quota is unmet and a Deep candidate exists, so the freed
  // 09:00 slot is backfilled with a task block.
  it('backfills a freed slot with an eligible task block', () => {
    const { removals, backfill } = run({
      blocks: [
        block({
          googleEventId: 'consult',
          category: 'Consulting',
          date: '2026-07-15', // Wednesday, future (now Wed 08:00)
          start: '09:00',
          titles: [CONSULTING_TITLE],
        }),
      ],
      candidateTasks: [cand({ gid: 'a1', signal: 'deep', title: 'Write memo' })],
      existingScheduledCounts: {}, // Deep quota (2) fully unmet
      now: WED_8AM,
    });
    expect(removals).toHaveLength(1); // the consulting block is removed
    // The freed morning slot is reused by a Deep task block (removed blocks never
    // enter the busy set, so 09:00 is genuinely free).
    expect(backfill.length).toBeGreaterThanOrEqual(1);
    const first = backfill.find(b => b.date === '2026-07-15' && b.start === '09:00');
    expect(first).toBeDefined();
    expect(first!.category).toBe('Deep');
    expect(first!.task?.gid).toBe('a1');
  });

  // Quota-less General Todos are NEVER auto-placed: the planner must not pick which
  // todos to do. Instead the leftover working-hours space is returned as freeSlots
  // for the user to fill by hand, and no Todos block appears in backfill.
  it('never auto-places quota-less General Todos — returns free slots instead', () => {
    const { backfill, freeSlots } = run({
      blocks: [],
      config: makeConfig({
        quotas: {
          Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: ['09:00-11:00'] },
          Todos: { targetLength: '30min', preferredTimes: [] }, // no weeklyCount
        },
      }),
      candidateTasks: [
        cand({ gid: 't1', signal: 'todo' }),
        cand({ gid: 't2', signal: 'todo' }),
      ],
      existingScheduledCounts: { Deep: 2 }, // Deep met; the rest is free space
      now: WED_8AM,
    });
    expect(backfill.some(b => b.category === 'Todos')).toBe(false);
    // Free space is reported at the catch-all category's 30-min granularity.
    expect(freeSlots.length).toBeGreaterThanOrEqual(1);
    expect(freeSlots.every(s => s.durationMinutes === 30)).toBe(true);
    // Every free slot is at/after now and never in the past.
    for (const s of freeSlots) {
      const [y, mo, d] = s.date.split('-').map(Number);
      const [h, m] = s.start.split(':').map(Number);
      expect(new Date(y, mo - 1, d, h, m).getTime()).toBeGreaterThanOrEqual(WED_8AM.getTime());
    }
  });

  // Deep work leads every remaining working morning: a mid-week replan proposes a
  // morning deep-work block for each remaining weekday that hasn't got one.
  it('backfills a morning deep-work block for each remaining day lacking one (daily deep work)', () => {
    const config = makeConfig({
      quotas: {
        'Writing/Deep Work': {
          weeklyCount: 3,
          targetLength: '1.5h',
          grouped: true,
          daily: true,
          preferredTimes: ['08:30-11:00'],
        },
      },
      scheduling: {
        workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        workingHours: { start: '08:30', end: '17:00' },
      },
    });
    config.typeMapping = { 'Writing/Deep Work': ['deep'] };
    const { backfill } = run({
      blocks: [],
      config,
      candidateTasks: [cand({ gid: 'd1', signal: 'deep' })],
      now: WED_8AM, // Wednesday 08:00 → remaining working days Wed, Thu, Fri
    });
    const deep = backfill.filter(b => b.category === 'Writing/Deep Work');
    expect(deep.map(b => b.date).sort()).toEqual(['2026-07-15', '2026-07-16', '2026-07-17']);
    expect(deep.every(b => b.start >= '08:30' && b.start < '11:00')).toBe(true);
  });

  it('proposes no backfill for a category whose quota is already met', () => {
    const { backfill } = run({
      blocks: [],
      candidateTasks: [cand({ gid: 'a1', signal: 'deep' })],
      existingScheduledCounts: { Deep: 2 }, // quota is 2 → nothing remaining
      now: WED_8AM,
    });
    expect(backfill).toHaveLength(0);
  });

  it('places deep-work backfill in the morning, sliding past a meeting rather than to the afternoon', () => {
    const config = makeConfig({
      quotas: {
        'Writing/Deep Work': { weeklyCount: 1, targetLength: '1h', preferredTimes: ['09:00-11:00'] },
      },
    });
    // typeMapping must map the signal to the deep-work category.
    config.typeMapping = { 'Writing/Deep Work': ['deep'] };
    const { backfill } = run({
      blocks: [],
      config,
      candidateTasks: [cand({ gid: 'd1', signal: 'deep' })],
      existingScheduledCounts: {},
      // A real meeting blocks 09:00–10:00 on Wednesday; the deep-work morning flex
      // slides the block to 10:00 (still the morning) instead of the afternoon.
      otherBusy: [busy(15, 9, 0, 10, 0)],
      now: WED_8AM,
    });
    expect(backfill).toHaveLength(1);
    expect(backfill[0].category).toBe('Writing/Deep Work');
    expect(backfill[0].date).toBe('2026-07-15');
    expect(backfill[0].start).toBe('10:00'); // morning, slid past the meeting
  });

  it('only proposes tasks in the candidate pool (already-scheduled tasks are excluded upstream)', () => {
    // Deep quota is 2; one block is already scheduled+counted, so one slot remains.
    // The candidate pool holds one unscheduled task — the already-scheduled task's
    // gid is absent (as gather excludes it), so it is never re-proposed.
    const { backfill } = run({
      blocks: [],
      candidateTasks: [cand({ gid: 'fresh', signal: 'deep' })],
      existingScheduledCounts: { Deep: 1 },
      now: WED_8AM,
    });
    expect(backfill).toHaveLength(1); // only the remaining quota (2 − 1)
    expect(backfill[0].task?.gid).toBe('fresh');
    expect(backfill.some(b => b.task?.gid === 'already')).toBe(false);
  });

  it('never backfills into the past (respects the now-cutoff)', () => {
    const NOW = new Date(2026, 6, 15, 10, 0, 0, 0); // Wednesday 10:00
    const { backfill } = run({
      blocks: [],
      candidateTasks: [cand({ gid: 'a1', signal: 'deep' })],
      existingScheduledCounts: {},
      now: NOW,
    });
    expect(backfill.length).toBeGreaterThanOrEqual(1);
    // Every proposed block starts at/after now — never in the already-past 09:00
    // slice of the preferred morning window.
    for (const b of backfill) {
      const [y, mo, d] = b.date.split('-').map(Number);
      const [h, m] = b.start.split(':').map(Number);
      expect(new Date(y, mo - 1, d, h, m).getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    }
  });
});

describe('planReplan - legacy deep-work conversion', () => {
  // A future, not-done deep-work block still in the OLD single-task shape is
  // proposed for in-place conversion to a generic "Deep work" container.
  const deepBlock = (o: Partial<ReplanBlock> & { date: string; start: string }) =>
    block({ category: 'Writing/Deep Work', ...o });

  it('proposes an in-place conversion for a future single-task deep-work block', () => {
    const { conversions, moves, kept } = run({
      blocks: [
        deepBlock({ googleEventId: 'dw', date: '2026-07-16', start: '09:00', titles: ['Old single task'] }),
      ], // Thursday, future
      deepWorkWeekTasks: [
        cand({ gid: 't1', signal: 'deep', title: 'T1' }),
        cand({ gid: 't2', signal: 'deep', title: 'T2' }),
      ],
      now: WED_8AM,
    });
    expect(moves).toHaveLength(0);
    expect(conversions).toHaveLength(1);
    const c = conversions[0];
    expect(c.googleEventId).toBe('dw');
    expect(c.date).toBe('2026-07-16'); // same slot — no reschedule
    expect(c.start).toBe('09:00');
    expect(c.tasks.map(t => t.gid)).toEqual(['t1', 't2']); // the week's agenda
    // It gets its own entry — never counted as kept or moved.
    expect(kept.some(k => k.googleEventId === 'dw')).toBe(false);
  });

  it('leaves an already-container deep-work block alone (no conversion)', () => {
    const { conversions, kept } = run({
      blocks: [
        deepBlock({
          googleEventId: 'dw',
          date: '2026-07-16',
          start: '09:00',
          titles: ['A', 'B'],
          isCategoryContainer: true,
        }),
      ],
      deepWorkWeekTasks: [cand({ gid: 't1', signal: 'deep' })],
      now: WED_8AM,
    });
    expect(conversions).toHaveLength(0);
    expect(kept.some(k => k.googleEventId === 'dw')).toBe(true);
  });

  it('does not convert a PAST deep-work block, nor a DONE future one', () => {
    const { conversions } = run({
      blocks: [
        deepBlock({ googleEventId: 'past', date: '2026-07-13', start: '09:00' }), // Monday, past
        deepBlock({ googleEventId: 'done', date: '2026-07-16', start: '09:00', done: true }),
      ],
      deepWorkWeekTasks: [cand({ gid: 't1', signal: 'deep' })],
      now: WED_8AM,
    });
    expect(conversions).toHaveLength(0);
  });
});

describe('planReplan - deep-work containers (backfill)', () => {
  // A daily deep-work category: one block per remaining working morning.
  function dailyDeepConfig(): WorkflowConfig {
    const config = makeConfig({
      quotas: {
        'Writing/Deep Work': {
          weeklyCount: 3,
          targetLength: '1h',
          daily: true,
          preferredTimes: ['09:00-11:00'],
        },
      },
      scheduling: {
        workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        workingHours: { start: '09:00', end: '17:00' },
      },
    });
    config.typeMapping = { 'Writing/Deep Work': ['deep'] };
    return config;
  }

  // Every remaining morning (Wed/Thu/Fri) is a generic container listing the SAME
  // week-selected deep-work tasks — never a task from the general candidate pool,
  // never a single task pinned to a day.
  it('lists the week-selected deep-work tasks on every morning, never a pool candidate', () => {
    const { backfill } = run({
      blocks: [],
      config: dailyDeepConfig(),
      candidateTasks: [cand({ gid: 'pool', signal: 'deep', title: 'Pool task' })],
      deepWorkWeekTasks: [
        cand({ gid: 't1', signal: 'deep', title: 'T1' }),
        cand({ gid: 't2', signal: 'deep', title: 'T2' }),
      ],
      existingScheduledCounts: {},
      now: WED_8AM, // remaining working days: Wed, Thu, Fri
    });
    const deep = backfill.filter(b => b.category === 'Writing/Deep Work');
    expect(deep.map(b => b.date)).toEqual(['2026-07-15', '2026-07-16', '2026-07-17']);
    // Every morning is a container carrying the whole week's agenda [t1, t2].
    expect(deep.every(b => b.task === undefined)).toBe(true);
    for (const b of deep) {
      expect(b.tasks?.map(t => t.gid)).toEqual(['t1', 't2']);
    }
    // The general-pool deep-work task never enters the schedule.
    expect(backfill.some(b => (b.tasks ?? []).some(t => t.gid === 'pool'))).toBe(false);
  });

  // An empty selection (all the week's deep-work tasks are done, or none were
  // selected) yields RESERVED deep-work blocks — never a new pool task.
  it('reserves the mornings when no deep-work task is selected', () => {
    const { backfill } = run({
      blocks: [],
      config: dailyDeepConfig(),
      candidateTasks: [cand({ gid: 'pool', signal: 'deep', title: 'Pool task' })],
      deepWorkWeekTasks: [],
      existingScheduledCounts: {},
      now: WED_8AM,
    });
    const deep = backfill.filter(b => b.category === 'Writing/Deep Work');
    expect(deep).toHaveLength(3);
    expect(deep.every(b => !b.task && b.tasks === undefined)).toBe(true); // reserved, task-less
    expect(backfill.some(b => b.task?.gid === 'pool')).toBe(false);
  });

  // The membership never depends on how many deep-work blocks the week already
  // holds: every new morning lists the SAME full agenda (no rotation seed).
  it('lists the full agenda on every new morning regardless of existing blocks', () => {
    const { backfill } = run({
      blocks: [],
      config: dailyDeepConfig(),
      candidateTasks: [cand({ gid: 'pool', signal: 'deep', title: 'Pool task' })],
      deepWorkWeekTasks: [
        cand({ gid: 't1', signal: 'deep', title: 'T1' }),
        cand({ gid: 't2', signal: 'deep', title: 'T2' }),
        cand({ gid: 't3', signal: 'deep', title: 'T3' }),
      ],
      // Mon + Tue already had deep-work blocks — this must NOT change the agenda.
      existingScheduledCounts: { 'Writing/Deep Work': 2 },
      now: WED_8AM,
    });
    const deep = backfill.filter(b => b.category === 'Writing/Deep Work');
    for (const b of deep) {
      expect(b.tasks?.map(t => t.gid)).toEqual(['t1', 't2', 't3']);
    }
  });
});
