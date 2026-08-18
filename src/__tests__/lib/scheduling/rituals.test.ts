/**
 * Tests for the pure daily-ritual (lunch + emails) block placer.
 * Dates use the local Date constructor so tests are timezone-independent.
 */
import {
  proposeRitualBlocks,
  placeWeekRituals,
  proposedBlockToBusyInterval,
  ritualKindForTitle,
  ritualCadenceForTitle,
  isBreakTitle,
  isRitualTitle,
  isRitualLikeTitle,
  ritualIntegrationIdForKind,
  ritualIntegrationIdForBlock,
  LUNCH_TITLE,
  EXERCISE_TITLE,
  EMAILS_TITLE,
  KINDLE_TITLE,
  GROOMING_TITLE,
  RETRO_TITLE,
  BREAK_TITLE,
  DELEGATION_REVIEW_TITLE,
  DELEGATION_REVIEW_WEEKLY_COUNT,
  WALK_TITLE,
  CONSULTING_TITLE,
  SIDE_PROJECTS_TITLE,
  NEW_BOOKIES_TITLE,
  READING_TITLE,
  LEARNING_TITLE,
  RETIRED_RITUAL_TITLES,
  newBookiesPlacementIsValid,
  placeOfficeAndTravelBlocks,
  sanitizeDayLocations,
  travelBlockTitle,
  isTravelTitle,
  GET_READY_TITLE,
  COMMUTE_TITLE,
} from '@/lib/scheduling/rituals';
import { proposePrepBlocks } from '@/lib/scheduling/prep';
import type { BusyInterval } from '@/lib/scheduling/types';
import type { WorkflowConfig } from '@/lib/workflow-config-storage';

const WEEK_START = new Date(2026, 6, 13, 0, 0, 0, 0); // Monday 2026-07-13

function makeConfig(overrides: Partial<WorkflowConfig['scheduling']> = {}): WorkflowConfig {
  return {
    taskQuotas: {},
    typeMapping: {},
    scheduling: {
      workRun: { maxMinutes: 120, bufferMinutes: 15 },
      workingDays: ['Monday'],
      workingHours: { start: '09:00', end: '17:00' },
      ...overrides,
    },
    lastUpdated: '2026-07-12T00:00:00.000Z',
  };
}

function run(input: {
  scheduling?: Partial<WorkflowConfig['scheduling']>;
  busyIntervals?: BusyInterval[];
  existingRitualTitlesByDate?: Record<string, Set<string>>;
  walkDays?: string[];
  now?: Date;
  phase?: 'all' | 'daily' | 'weekly';
}) {
  return proposeRitualBlocks({
    config: makeConfig(input.scheduling),
    busyIntervals: input.busyIntervals ?? [],
    weekStart: WEEK_START,
    now: input.now ?? WEEK_START,
    existingRitualTitlesByDate: input.existingRitualTitlesByDate ?? {},
    walkDays: input.walkDays,
    phase: input.phase,
  });
}

// The five weekday dates of the test week (Mon 2026-07-13 … Fri 2026-07-17), for
// opting days into a walk.
const WEEK_DAYS = ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17'];

const busy = (h1: number, m1: number, h2: number, m2: number): BusyInterval => ({
  start: new Date(2026, 6, 13, h1, m1),
  end: new Date(2026, 6, 13, h2, m2),
});

describe('break title helpers', () => {
  it('classifies "☕ Break" as a break kind and a break title', () => {
    expect(ritualKindForTitle(BREAK_TITLE)).toBe('break');
    expect(isBreakTitle(BREAK_TITLE)).toBe(true);
    expect(isRitualTitle(BREAK_TITLE)).toBe(true);
    // Lunch + exercise are still breaks; emails is not.
    expect(isBreakTitle(LUNCH_TITLE)).toBe(true);
    expect(isBreakTitle(EXERCISE_TITLE)).toBe(true);
    expect(isBreakTitle(EMAILS_TITLE)).toBe(false);
  });

  it('tags a break block as a break busy interval', () => {
    const interval = proposedBlockToBusyInterval({
      id: 'b',
      category: 'Break',
      kind: 'break',
      title: BREAK_TITLE,
      date: '2026-07-13',
      start: '11:00',
      durationMinutes: 15,
      reason: 'r',
    });
    expect(interval.isBreak).toBe(true);
  });
});

describe('isRitualLikeTitle', () => {
  it('recognises a ritual however the user typed it', () => {
    for (const t of ['Emails', 'emails', '📧 Emails', ' Emails ', 'EMAILS']) {
      expect(isRitualLikeTitle(t)).toBe(true);
    }
  });

  it('recognises every ritual, not just emails', () => {
    for (const t of [
      'Lunch',
      'Exercise',
      'Kindle notes',
      'backlog grooming',
      'Retrospective',
      'Break',
      '🍽️ Lunch',
      '☕ Break',
    ]) {
      expect(isRitualLikeTitle(t)).toBe(true);
    }
  });

  it('does not match prefixes, supersets or unrelated titles', () => {
    for (const t of [
      'Email triage',
      'Emails to send',
      'Lunch with Sam',
      'Pre-lunch prep',
      'Exercise plan doc',
      'Breaking news piece',
      'Email',
      '',
      'Deep work',
    ]) {
      expect(isRitualLikeTitle(t)).toBe(false);
    }
  });
});

describe('ritual kind + cadence helpers', () => {
  it('resolves the WORK ritual titles to their kinds', () => {
    expect(ritualKindForTitle(KINDLE_TITLE)).toBe('kindleNotes');
    expect(ritualKindForTitle(GROOMING_TITLE)).toBe('grooming');
    expect(ritualKindForTitle(RETRO_TITLE)).toBe('retro');
  });

  it('classifies cadence: kindle/grooming/retro weekly, lunch daily', () => {
    expect(ritualCadenceForTitle(KINDLE_TITLE)).toBe('weekly');
    expect(ritualCadenceForTitle(LUNCH_TITLE)).toBe('daily');
    expect(ritualCadenceForTitle(GROOMING_TITLE)).toBe('weekly');
    expect(ritualCadenceForTitle(RETRO_TITLE)).toBe('weekly');
  });

  it('treats the WORK rituals as rituals but NOT breaks', () => {
    for (const t of [KINDLE_TITLE, GROOMING_TITLE, RETRO_TITLE]) {
      expect(isRitualTitle(t)).toBe(true);
      expect(isBreakTitle(t)).toBe(false);
    }
  });
});

describe('ritualIntegrationIdForKind', () => {
  const scheduling = {
    ritualCalendars: { lunch: 'om', emails: 'om', exercise: 'personal' },
  } as WorkflowConfig['scheduling'];

  it('routes exercise and break to the exercise calendar, lunch/emails to theirs', () => {
    expect(ritualIntegrationIdForKind(scheduling, 'exercise')).toBe('personal');
    expect(ritualIntegrationIdForKind(scheduling, 'break')).toBe('personal');
    expect(ritualIntegrationIdForKind(scheduling, 'lunch')).toBe('om');
    expect(ritualIntegrationIdForKind(scheduling, 'emails')).toBe('om');
    expect(ritualIntegrationIdForBlock(scheduling, BREAK_TITLE)).toBe('personal');
    expect(ritualIntegrationIdForBlock(scheduling, LUNCH_TITLE)).toBe('om');
  });

  it('defaults kindle/grooming/retro to the emails calendar setting, still per-kind overridable', () => {
    // Unset → follow the emails calendar (→ OM).
    expect(ritualIntegrationIdForKind(scheduling, 'kindleNotes')).toBe('om');
    expect(ritualIntegrationIdForKind(scheduling, 'grooming')).toBe('om');
    expect(ritualIntegrationIdForKind(scheduling, 'retro')).toBe('om');
    expect(ritualIntegrationIdForBlock(scheduling, KINDLE_TITLE)).toBe('om');
    // An explicit per-kind override wins over the emails default.
    const overridden = {
      ritualCalendars: { emails: 'om', retro: 'retro-cal' },
    } as WorkflowConfig['scheduling'];
    expect(ritualIntegrationIdForKind(overridden, 'retro')).toBe('retro-cal');
    expect(ritualIntegrationIdForKind(overridden, 'grooming')).toBe('om');
  });

  it('falls back to the legacy single id for lunch/emails, but not exercise/break', () => {
    const legacy = { ritualGoogleIntegrationId: 'om-legacy' } as WorkflowConfig['scheduling'];
    expect(ritualIntegrationIdForKind(legacy, 'lunch')).toBe('om-legacy');
    expect(ritualIntegrationIdForKind(legacy, 'emails')).toBe('om-legacy');
    expect(ritualIntegrationIdForKind(legacy, 'exercise')).toBeUndefined();
    expect(ritualIntegrationIdForKind(legacy, 'break')).toBeUndefined();
    // The WORK rituals fall through emails → legacy when nothing per-kind is set.
    expect(ritualIntegrationIdForKind(legacy, 'kindleNotes')).toBe('om-legacy');
    expect(ritualIntegrationIdForKind(legacy, 'grooming')).toBe('om-legacy');
    expect(ritualIntegrationIdForKind(legacy, 'retro')).toBe('om-legacy');
  });
});

describe('proposeRitualBlocks', () => {
  it('places a lunch in the 11:30–13:00 window and emails at the end of the day', () => {
    const blocks = run({});
    const lunch = blocks.find(b => b.title === LUNCH_TITLE);
    const emails = blocks.find(b => b.title === EMAILS_TITLE);

    expect(lunch).toBeDefined();
    expect(lunch!.kind).toBe('ritual');
    expect(lunch!.category).toBe('Lunch');
    expect(lunch!.durationMinutes).toBe(30);
    expect(lunch!.start).toBe('11:30'); // earliest free within the ideal window
    expect(lunch!.date).toBe('2026-07-13');

    expect(emails).toBeDefined();
    expect(emails!.category).toBe('Emails');
    expect(emails!.durationMinutes).toBe(30);
    // End of the day: last free 30-min slot in the final two hours (15:00–17:00).
    expect(emails!.start).toBe('16:30');
  });

  it('falls back to 11:00–14:00 when the ideal lunch window is busy', () => {
    // Block 11:30–13:00 entirely; lunch should fall back to a free slot 11:00–14:00.
    // Mark the walk as already present so it doesn't auto-place into the late
    // morning and eat the 11:00 fallback slot — this test isolates lunch.
    const blocks = run({
      busyIntervals: [busy(11, 30, 13, 0)],
      existingRitualTitlesByDate: { '2026-07-13': new Set([WALK_TITLE]) },
    });
    const lunch = blocks.find(b => b.title === LUNCH_TITLE);
    expect(lunch).toBeDefined();
    // 11:00 is free within the fallback window (before the 11:30 block).
    expect(lunch!.start).toBe('11:00');
  });

  it('skips lunch when nothing fits in 11:00–14:00', () => {
    const blocks = run({ busyIntervals: [busy(11, 0, 14, 0)] });
    expect(blocks.find(b => b.title === LUNCH_TITLE)).toBeUndefined();
    // Emails still fits at the end of the day.
    expect(blocks.find(b => b.title === EMAILS_TITLE)).toBeDefined();
  });

  it('dedupes: skips a ritual whose exact title already exists that day', () => {
    const blocks = run({
      existingRitualTitlesByDate: { '2026-07-13': new Set([LUNCH_TITLE]) },
    });
    // Lunch already present → not re-proposed; emails still proposed.
    expect(blocks.find(b => b.title === LUNCH_TITLE)).toBeUndefined();
    expect(blocks.find(b => b.title === EMAILS_TITLE)).toBeDefined();
  });

  it('does not double-book lunch and emails against each other', () => {
    // A tiny day (11:00–12:00 working hours) with room for only one 30-min ritual.
    const blocks = run({ scheduling: { workingHours: { start: '11:00', end: '12:00' } } });
    const starts = blocks.map(b => b.start);
    // No two rituals share a slot.
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('skips emails when the afternoon is full', () => {
    const blocks = run({ busyIntervals: [busy(12, 0, 17, 0)] });
    expect(blocks.find(b => b.title === EMAILS_TITLE)).toBeUndefined();
  });

  it('places rituals on every working day', () => {
    const blocks = run({
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    });
    const lunches = blocks.filter(b => b.title === LUNCH_TITLE);
    expect(lunches).toHaveLength(5);
    expect(new Set(lunches.map(l => l.date)).size).toBe(5);
  });

  it('places a 60-min exercise block starting at exactly 15:00 when free', () => {
    const blocks = run({ scheduling: { workingHours: { start: '08:30', end: '19:00' } } });
    const exercise = blocks.find(b => b.title === EXERCISE_TITLE);
    expect(exercise).toBeDefined();
    expect(exercise!.kind).toBe('ritual');
    expect(exercise!.category).toBe('Exercise');
    expect(exercise!.durationMinutes).toBe(60);
    expect(exercise!.start).toBe('15:00');
    expect(exercise!.date).toBe('2026-07-13');
  });

  it('places exercise at the free 60-min slot closest to 15:00 (earlier on a tie)', () => {
    // Block 15:00–16:00, so a 15:00 start is impossible. The two nearest free
    // 60-min slots are 14:00 and 16:00 (both 60 min away); the earlier wins.
    const blocks = run({
      scheduling: { workingHours: { start: '08:30', end: '19:00' } },
      busyIntervals: [busy(15, 0, 16, 0)],
    });
    const exercise = blocks.find(b => b.title === EXERCISE_TITLE);
    expect(exercise).toBeDefined();
    expect(exercise!.start).toBe('14:00');
  });

  it('skips exercise only when no free 60-min slot exists in the whole working day', () => {
    // The entire working day is busy → even the whole-day fallback finds nothing.
    const blocks = run({
      scheduling: { workingHours: { start: '13:00', end: '18:00' } },
      busyIntervals: [busy(13, 0, 18, 0)],
    });
    expect(blocks.find(b => b.title === EXERCISE_TITLE)).toBeUndefined();
  });

  it('dedupes exercise against an existing exercise event that day', () => {
    const blocks = run({
      scheduling: { workingHours: { start: '08:30', end: '19:00' } },
      existingRitualTitlesByDate: { '2026-07-13': new Set([EXERCISE_TITLE]) },
    });
    expect(blocks.find(b => b.title === EXERCISE_TITLE)).toBeUndefined();
    // Lunch + emails still proposed.
    expect(blocks.find(b => b.title === LUNCH_TITLE)).toBeDefined();
    expect(blocks.find(b => b.title === EMAILS_TITLE)).toBeDefined();
  });

  it('widens the exercise search to the whole working day when 13:00–18:00 is full', () => {
    // The core 13:00–18:00 window is entirely busy, so no 60-min slot fits there.
    // Exercise is priority one, so the search widens to the whole working day and
    // still places it — here 12:00 is the free hour closest to 15:00.
    const blocks = run({
      scheduling: { workingHours: { start: '09:00', end: '18:00' } },
      busyIntervals: [busy(13, 0, 18, 0)],
    });
    const exercise = blocks.find(b => b.title === EXERCISE_TITLE);
    expect(exercise).toBeDefined();
    expect(exercise!.start).toBe('12:00');
  });
});

describe('proposeRitualBlocks — Kindle notes (weekly x2, work)', () => {
  it('places exactly TWO 30-min Kindle blocks a week, on distinct days, in the afternoon', () => {
    const blocks = run({
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    });
    const kindles = blocks.filter(b => b.title === KINDLE_TITLE);
    expect(kindles).toHaveLength(2);
    expect(new Set(kindles.map(k => k.date)).size).toBe(2); // distinct days
    for (const k of kindles) {
      expect(k.kind).toBe('ritual');
      expect(k.category).toBe('Kindle notes');
      expect(k.durationMinutes).toBe(30);
      expect(k.start >= '12:00').toBe(true); // afternoon preference
    }
  });

  it('spreads the two Kindle blocks earliest-days-first', () => {
    const blocks = run({
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    });
    const dates = blocks.filter(b => b.title === KINDLE_TITLE).map(k => k.date).sort();
    expect(dates).toEqual(['2026-07-13', '2026-07-14']); // Monday + Tuesday
  });

  it('counts existing Kindle events toward the two (tops up rather than re-adding)', () => {
    const blocks = run({
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
      // One kindle already on Wednesday → only ONE more should be proposed.
      existingRitualTitlesByDate: { '2026-07-15': new Set([KINDLE_TITLE]) },
    });
    const kindles = blocks.filter(b => b.title === KINDLE_TITLE);
    expect(kindles).toHaveLength(1);
    expect(kindles[0].date).not.toBe('2026-07-15'); // not the day that already has one
  });

  it('proposes no Kindle when two already exist across the week', () => {
    const blocks = run({
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
      existingRitualTitlesByDate: {
        '2026-07-13': new Set([KINDLE_TITLE]),
        '2026-07-14': new Set([KINDLE_TITLE]),
      },
    });
    expect(blocks.filter(b => b.title === KINDLE_TITLE)).toHaveLength(0);
  });
});

describe('proposeRitualBlocks — weekly rituals (grooming + retro)', () => {
  const week = { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] };

  it('places backlog grooming ONCE for the week, on the earliest working day, in the afternoon', () => {
    const blocks = run({ scheduling: week });
    const grooming = blocks.filter(b => b.title === GROOMING_TITLE);
    expect(grooming).toHaveLength(1);
    expect(grooming[0].kind).toBe('ritual');
    expect(grooming[0].category).toBe('Backlog grooming');
    expect(grooming[0].durationMinutes).toBe(60);
    expect(grooming[0].date).toBe('2026-07-13'); // Monday, earliest-day-first
    expect(grooming[0].start >= '12:00').toBe(true);
  });

  it('places the retrospective ONCE, preferring the LAST working day, late in the day', () => {
    const blocks = run({ scheduling: week });
    const retro = blocks.filter(b => b.title === RETRO_TITLE);
    expect(retro).toHaveLength(1);
    expect(retro[0].category).toBe('Retrospective');
    expect(retro[0].durationMinutes).toBe(60);
    expect(retro[0].date).toBe('2026-07-17'); // Friday, last working day
  });

  it('falls the retrospective back to an earlier day when the last day is full', () => {
    // Friday entirely busy → retro cannot land there, so it falls back to Thursday.
    const fridayFull: BusyInterval = {
      start: new Date(2026, 6, 17, 0, 0),
      end: new Date(2026, 6, 17, 23, 59),
    };
    const blocks = run({ scheduling: week, busyIntervals: [fridayFull] });
    const retro = blocks.filter(b => b.title === RETRO_TITLE);
    expect(retro).toHaveLength(1);
    expect(retro[0].date).toBe('2026-07-16'); // Thursday
  });

  it('dedupes a weekly ritual by title across the WHOLE week (present any day → skip)', () => {
    const blocks = run({
      scheduling: week,
      // Grooming present on Wednesday, retro present on Tuesday → neither re-proposed.
      existingRitualTitlesByDate: {
        '2026-07-15': new Set([GROOMING_TITLE]),
        '2026-07-14': new Set([RETRO_TITLE]),
      },
    });
    expect(blocks.find(b => b.title === GROOMING_TITLE)).toBeUndefined();
    expect(blocks.find(b => b.title === RETRO_TITLE)).toBeUndefined();
    // Kindle (no existing events here) is unaffected by the grooming/retro dedupe.
    expect(blocks.filter(b => b.title === KINDLE_TITLE).length).toBeGreaterThan(0);
  });
});

describe('placeWeekRituals — prep/propose determinism', () => {
  // A full working week so the whole ritual set (daily + weekly, including the
  // walk and the weekly work singles) has room to land without spilling into the
  // mornings the synthetic prep below occupies.
  const wide = makeConfig({
    workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    workingHours: { start: '08:30', end: '19:00' },
  });

  const placeWith = (busyIntervals: BusyInterval[]) =>
    placeWeekRituals({
      config: wide,
      weekEvents: [],
      busyIntervals,
      weekStart: WEEK_START,
      now: WEEK_START,
      // Opt every day into a walk so the full ritual set (including the 10:30
      // walk) is exercised for the prep/propose determinism check.
      walkDays: WEEK_DAYS,
    });

  it('places the same ritual slots in the prep step and the propose step (prep never steals the exercise slot)', () => {
    // Prep step: rituals placed against the calendar busy only (no prep yet).
    const prepStep = placeWith([]);
    const exercise = prepStep.find(b => b.title === EXERCISE_TITLE);
    expect(exercise!.start).toBe('15:00');

    // Prep is then placed with the rituals reserved, so it lands elsewhere; that
    // accepted prep block never overlaps a ritual slot. Early Monday (before the
    // 10:30 walk) is ritual-free, so it stands in for a real prep placement.
    const acceptedPrep: BusyInterval = {
      start: new Date(2026, 6, 13, 8, 30),
      end: new Date(2026, 6, 13, 9, 30),
    };

    // Propose step: rituals placed against calendar + accepted prep. Because the
    // prep avoids every ritual slot, the placements are byte-for-byte identical.
    const proposeStep = placeWith([acceptedPrep]);
    expect(proposeStep).toEqual(prepStep);
  });

  it('prep cannot take the 15:00 exercise slot once rituals are reserved first', () => {
    // Wednesday carries the daily rituals plus a single weekly work block, so it
    // has room for a same-day prep while still reserving the 15:00 exercise slot.
    const rituals = placeWith([]);
    const exercise = rituals.find(b => b.title === EXERCISE_TITLE && b.date === '2026-07-15')!;
    expect(exercise.start).toBe('15:00');

    // Mirror the prep-candidates route: rituals join the busy set before prep.
    const prepBusy = rituals.map(proposedBlockToBusyInterval);
    const { placed } = proposePrepBlocks({
      meetings: [
        {
          eventId: 'm1',
          title: 'Sync',
          startMs: new Date(2026, 6, 15, 17, 0).getTime(),
          date: '2026-07-15',
          durationMinutes: 60,
        },
      ],
      config: wide,
      busyIntervals: prepBusy,
      weekStart: WEEK_START,
      now: WEEK_START,
    });
    expect(placed).toHaveLength(1);
    const prep = placed[0];
    const [ph, pm] = prep.start.split(':').map(Number);
    const prepStartMs = new Date(2026, 6, 15, ph, pm).getTime();
    const prepEndMs = prepStartMs + prep.durationMinutes * 60 * 1000;
    const exStartMs = new Date(2026, 6, 15, 15, 0).getTime();
    const exEndMs = new Date(2026, 6, 15, 16, 0).getTime();
    // Prep must not overlap the reserved 15:00–16:00 exercise slot.
    expect(prepStartMs < exEndMs && prepEndMs > exStartMs).toBe(false);
  });
});

describe('delegation review ritual', () => {
  // A wide working week, so slot availability never masks the placement rules.
  const wide = makeConfig({
    workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    workingHours: { start: '08:30', end: '19:00' },
  });

  const place = (weekEvents: Parameters<typeof placeWeekRituals>[0]['weekEvents'] = []) =>
    placeWeekRituals({
      config: wide,
      weekEvents,
      busyIntervals: [],
      weekStart: WEEK_START,
      now: WEEK_START,
    });

  it('resolves to its own kind and a weekly cadence', () => {
    expect(ritualKindForTitle(DELEGATION_REVIEW_TITLE)).toBe('delegationReview');
    expect(ritualCadenceForTitle(DELEGATION_REVIEW_TITLE)).toBe('weekly');
  });

  it('is placed twice a week, on distinct days, at 30 minutes', () => {
    const review = place().filter(b => b.title === DELEGATION_REVIEW_TITLE);

    expect(review).toHaveLength(DELEGATION_REVIEW_WEEKLY_COUNT);
    expect(new Set(review.map(r => r.date)).size).toBe(review.length);
    expect(review.every(r => r.durationMinutes === 30)).toBe(true);
  });

  it('counts as work, not as a break', () => {
    // It forms part of a work run rather than splitting one.
    expect(isBreakTitle(DELEGATION_REVIEW_TITLE)).toBe(false);
    expect(isRitualTitle(DELEGATION_REVIEW_TITLE)).toBe(true);
  });
});

describe('walk ritual (daily, break)', () => {
  it('resolves to its own kind, a daily cadence, and reads as a break', () => {
    expect(ritualKindForTitle(WALK_TITLE)).toBe('walk');
    expect(ritualCadenceForTitle(WALK_TITLE)).toBe('daily');
    expect(isBreakTitle(WALK_TITLE)).toBe(true);
    expect(isRitualTitle(WALK_TITLE)).toBe(true);
    expect(isRitualLikeTitle('walk')).toBe(true);
  });

  it('places NO walks by default (opt-in per day)', () => {
    const blocks = run({
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    });
    expect(blocks.filter(b => b.title === WALK_TITLE)).toHaveLength(0);
  });

  it('places a 45-min walk mid-morning (from 10:30) only on opted-in working days, as a break', () => {
    const blocks = run({
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
      // Opt only Monday + Wednesday into a walk.
      walkDays: ['2026-07-13', '2026-07-15'],
    });
    const walks = blocks.filter(b => b.title === WALK_TITLE);
    expect(walks).toHaveLength(2);
    expect(new Set(walks.map(w => w.date))).toEqual(new Set(['2026-07-13', '2026-07-15']));
    for (const w of walks) {
      expect(w.kind).toBe('ritual');
      expect(w.category).toBe('Walk');
      expect(w.durationMinutes).toBe(45);
      expect(w.start).toBe('10:30'); // earliest free within the ideal window
    }
  });

  it('ignores an opted-in day that is not a working day', () => {
    // Only Monday is a working day; opting Tuesday in as well places nothing there.
    const blocks = run({
      scheduling: { workingDays: ['Monday'] },
      walkDays: ['2026-07-13', '2026-07-14'],
    });
    const walks = blocks.filter(b => b.title === WALK_TITLE);
    expect(walks).toHaveLength(1);
    expect(walks[0].date).toBe('2026-07-13');
  });

  it('tags the walk block as a break busy interval (splits work runs)', () => {
    const walk = run({ walkDays: ['2026-07-13'] }).find(b => b.title === WALK_TITLE)!;
    expect(proposedBlockToBusyInterval(walk).isBreak).toBe(true);
  });

  it('widens to 09:30–12:00 when the ideal 10:30–11:30 window is busy', () => {
    // Block the ideal window; the walk falls back to the earliest free 45-min
    // slot in 09:30–12:00 (here 09:30, before the block).
    const blocks = run({ busyIntervals: [busy(10, 30, 11, 30)], walkDays: ['2026-07-13'] });
    const walk = blocks.find(b => b.title === WALK_TITLE);
    expect(walk).toBeDefined();
    expect(walk!.start).toBe('09:30');
  });

  it('dedupes against an existing walk that day', () => {
    const blocks = run({
      walkDays: ['2026-07-13'],
      existingRitualTitlesByDate: { '2026-07-13': new Set([WALK_TITLE]) },
    });
    expect(blocks.find(b => b.title === WALK_TITLE)).toBeUndefined();
  });

  it('routes to its own calendar, else the exercise (personal) calendar', () => {
    const scheduling = {
      ritualCalendars: { exercise: 'personal', walk: 'walk-cal' },
    } as WorkflowConfig['scheduling'];
    expect(ritualIntegrationIdForKind(scheduling, 'walk')).toBe('walk-cal');
    const noWalkCal = {
      ritualCalendars: { exercise: 'personal' },
    } as WorkflowConfig['scheduling'];
    expect(ritualIntegrationIdForKind(noWalkCal, 'walk')).toBe('personal');
  });
});

const FULL_WEEK = {
  workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  workingHours: { start: '08:30', end: '19:00' },
};

describe('retired rituals (side projects / learning / consulting)', () => {
  it('never proposes a retired ritual', () => {
    const blocks = run({ scheduling: FULL_WEEK });
    for (const title of [CONSULTING_TITLE, SIDE_PROJECTS_TITLE, LEARNING_TITLE]) {
      expect(blocks.find(b => b.title === title)).toBeUndefined();
    }
  });

  it('lists them in RETIRED_RITUAL_TITLES but still recognises them as rituals', () => {
    expect([...RETIRED_RITUAL_TITLES]).toEqual([
      CONSULTING_TITLE,
      SIDE_PROJECTS_TITLE,
      LEARNING_TITLE,
    ]);
    for (const t of RETIRED_RITUAL_TITLES) expect(isRitualTitle(t)).toBe(true);
  });
});

describe('🎰 New bookies (evening, Mon/Fri, outside working hours)', () => {
  it('resolves to its own kind and a weekly cadence, not a break', () => {
    expect(ritualKindForTitle(NEW_BOOKIES_TITLE)).toBe('newBookies');
    expect(ritualCadenceForTitle(NEW_BOOKIES_TITLE)).toBe('weekly');
    expect(isBreakTitle(NEW_BOOKIES_TITLE)).toBe(false);
    expect(isRitualTitle(NEW_BOOKIES_TITLE)).toBe(true);
  });

  it('validates placement: Monday/Friday >= 18:00 only', () => {
    expect(newBookiesPlacementIsValid('2026-07-13', '18:00')).toBe(true); // Monday
    expect(newBookiesPlacementIsValid('2026-07-17', '19:30')).toBe(true); // Friday
    expect(newBookiesPlacementIsValid('2026-07-13', '17:45')).toBe(false); // before 18:00
    expect(newBookiesPlacementIsValid('2026-07-13', '09:30')).toBe(false); // working hours
    expect(newBookiesPlacementIsValid('2026-07-15', '18:00')).toBe(false); // Wednesday
  });

  it('places once, Monday preferred, in the 18:00–22:00 evening window', () => {
    const blocks = run({ scheduling: FULL_WEEK });
    const nb = blocks.filter(b => b.title === NEW_BOOKIES_TITLE);
    expect(nb).toHaveLength(1);
    expect(nb[0].date).toBe('2026-07-13'); // Monday
    expect(nb[0].durationMinutes).toBe(30);
    expect(newBookiesPlacementIsValid(nb[0].date, nb[0].start)).toBe(true);
  });

  it('never places inside working hours (09:00–17:00)', () => {
    const blocks = run({ scheduling: FULL_WEEK });
    const nb = blocks.find(b => b.title === NEW_BOOKIES_TITLE)!;
    const hour = Number(nb.start.split(':')[0]);
    expect(hour).toBeGreaterThanOrEqual(18);
  });

  it('falls back to Friday when Monday is already past', () => {
    // now = Tuesday, so Monday has dropped out of the working days entirely.
    const blocks = run({ scheduling: FULL_WEEK, now: new Date(2026, 6, 14, 9, 0) });
    const nb = blocks.find(b => b.title === NEW_BOOKIES_TITLE)!;
    expect(nb.date).toBe('2026-07-17'); // Friday
  });

  it('falls back to Friday when Monday evening is full', () => {
    const blocks = run({
      scheduling: FULL_WEEK,
      busyIntervals: [busy(18, 0, 22, 0)], // Monday 18:00–22:00 blocked
    });
    const nb = blocks.find(b => b.title === NEW_BOOKIES_TITLE)!;
    expect(nb.date).toBe('2026-07-17'); // Friday
  });

  it('dedupes across the whole week (present any day → skip)', () => {
    const blocks = run({
      scheduling: FULL_WEEK,
      existingRitualTitlesByDate: { '2026-07-15': new Set([NEW_BOOKIES_TITLE]) },
    });
    expect(blocks.find(b => b.title === NEW_BOOKIES_TITLE)).toBeUndefined();
  });
});

describe('📖 Reading weekly single', () => {
  it('resolves to its own kind and a weekly cadence, not a break', () => {
    expect(ritualKindForTitle(READING_TITLE)).toBe('reading');
    expect(ritualCadenceForTitle(READING_TITLE)).toBe('weekly');
    expect(isBreakTitle(READING_TITLE)).toBe(false);
  });

  it('places once for the week, in the afternoon (>= 12:00), 60 min', () => {
    const blocks = run({ scheduling: FULL_WEEK });
    const reading = blocks.filter(b => b.title === READING_TITLE);
    expect(reading).toHaveLength(1);
    expect(reading[0].durationMinutes).toBe(60);
    expect(reading[0].start >= '12:00').toBe(true);
  });

  it('dedupes by title across the whole week (present any day → skip)', () => {
    const blocks = run({
      scheduling: FULL_WEEK,
      existingRitualTitlesByDate: { '2026-07-15': new Set([READING_TITLE]) },
    });
    expect(blocks.find(b => b.title === READING_TITLE)).toBeUndefined();
  });

  it('routes to the emails calendar by default, per-kind overridable', () => {
    const scheduling = {
      ritualCalendars: { emails: 'om', reading: 'reading-cal' },
    } as WorkflowConfig['scheduling'];
    expect(ritualIntegrationIdForKind(scheduling, 'newBookies')).toBe('om');
    expect(ritualIntegrationIdForKind(scheduling, 'reading')).toBe('reading-cal');
  });
});

describe('ritual placement phases', () => {
  it("phase 'daily' places only the per-day rituals, no weekly ones", () => {
    const blocks = run({ scheduling: FULL_WEEK, phase: 'daily' });
    expect(blocks.some(b => b.title === LUNCH_TITLE)).toBe(true);
    expect(blocks.some(b => b.title === EXERCISE_TITLE)).toBe(true);
    expect(blocks.some(b => b.title === EMAILS_TITLE)).toBe(true);
    for (const t of [KINDLE_TITLE, GROOMING_TITLE, RETRO_TITLE, NEW_BOOKIES_TITLE, READING_TITLE]) {
      expect(blocks.some(b => b.title === t)).toBe(false);
    }
  });

  it("phase 'weekly' places only the weekly rituals, no per-day ones", () => {
    const blocks = run({ scheduling: FULL_WEEK, phase: 'weekly' });
    expect(blocks.some(b => b.title === LUNCH_TITLE)).toBe(false);
    expect(blocks.some(b => b.title === EXERCISE_TITLE)).toBe(false);
    expect(blocks.some(b => b.title === EMAILS_TITLE)).toBe(false);
    expect(blocks.some(b => b.title === READING_TITLE)).toBe(true);
    expect(blocks.some(b => b.title === NEW_BOOKIES_TITLE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Office / travel day blocks (per-day work location)
// ---------------------------------------------------------------------------

const MON = '2026-07-13';
// Absolute ms for an hour/minute on Monday 2026-07-13 (local), matching the
// placer's own day maths so cap assertions are timezone-independent.
const monMs = (h: number, m = 0) => new Date(2026, 6, 13, h, m, 0, 0).getTime();

function runOffice(input: {
  dayLocations: Parameters<typeof placeOfficeAndTravelBlocks>[0]['dayLocations'];
  busyIntervals?: BusyInterval[];
  existingRitualTitlesByDate?: Record<string, Set<string>>;
  existingTravelDates?: Set<string>;
  now?: Date;
}) {
  return placeOfficeAndTravelBlocks({
    config: makeConfig(),
    busyIntervals: input.busyIntervals ?? [],
    weekStart: WEEK_START,
    now: input.now ?? WEEK_START,
    dayLocations: input.dayLocations,
    existingRitualTitlesByDate: input.existingRitualTitlesByDate,
    existingTravelDates: input.existingTravelDates,
  });
}

describe('office-day get-ready + commute pair', () => {
  it('places the pair ending at 12:00 when the morning is clear (10:30 / 11:15)', () => {
    const { blocks, deepWorkEndByDate } = runOffice({
      dayLocations: { [MON]: { type: 'office' } },
    });
    const getReady = blocks.find(b => b.title === GET_READY_TITLE)!;
    const commute = blocks.find(b => b.title === COMMUTE_TITLE)!;
    expect(getReady.start).toBe('10:30');
    expect(getReady.durationMinutes).toBe(45);
    expect(commute.start).toBe('11:15');
    expect(commute.durationMinutes).toBe(45);
    // Get-ready immediately before commute, commute ends 12:00.
    expect(commute.date).toBe(MON);
    // Deep work is capped at the get-ready start (10:30).
    expect(deepWorkEndByDate[MON]).toBe(monMs(10, 30));
  });

  it('pulls the pair earlier so the commute ends by a morning meeting (11:00)', () => {
    const { blocks, deepWorkEndByDate } = runOffice({
      dayLocations: { [MON]: { type: 'office' } },
      // A fixed 11:00 meeting: the commute must end by then.
      busyIntervals: [busy(11, 0, 12, 0)],
    });
    const getReady = blocks.find(b => b.title === GET_READY_TITLE)!;
    const commute = blocks.find(b => b.title === COMMUTE_TITLE)!;
    expect(getReady.start).toBe('09:30');
    expect(commute.start).toBe('10:15'); // ends 11:00, at/before the meeting
    // Deep work capped at 09:30 (only 30 min of morning left → engine skips it).
    expect(deepWorkEndByDate[MON]).toBe(monMs(9, 30));
  });

  it('places the pair before a very early meeting (deep work then skipped)', () => {
    const { blocks, deepWorkEndByDate } = runOffice({
      dayLocations: { [MON]: { type: 'office' } },
      busyIntervals: [busy(9, 30, 10, 30)],
    });
    const commute = blocks.find(b => b.title === COMMUTE_TITLE)!;
    // Commute ends at 09:30 (the meeting start); get ready 08:00, commute 08:45.
    expect(commute.start).toBe('08:45');
    expect(blocks.find(b => b.title === GET_READY_TITLE)!.start).toBe('08:00');
    // Cap is before the working day starts → engine gets no deep-work morning.
    expect(deepWorkEndByDate[MON]).toBe(monMs(8, 0));
  });

  it('does not duplicate a pair already on the calendar', () => {
    const { blocks } = runOffice({
      dayLocations: { [MON]: { type: 'office' } },
      existingRitualTitlesByDate: { [MON]: new Set([GET_READY_TITLE, COMMUTE_TITLE]) },
    });
    expect(blocks).toHaveLength(0);
  });
});

describe('travel-day block', () => {
  it('inserts a fixed travel block at the depart time', () => {
    const { blocks, deepWorkEndByDate } = runOffice({
      dayLocations: {
        [MON]: { type: 'travel', destination: 'Paris', departTime: '08:00', travelMinutes: 180 },
      },
    });
    expect(blocks).toHaveLength(1);
    const travel = blocks[0];
    expect(travel.title).toBe('✈️ Travel to Paris');
    expect(travel.start).toBe('08:00');
    expect(travel.durationMinutes).toBe(180);
    expect(isTravelTitle(travel.title!)).toBe(true);
    // Travel days never cap deep work.
    expect(deepWorkEndByDate[MON]).toBeUndefined();
  });

  it('defaults depart 09:00 / 120 min and a bare title when unspecified', () => {
    const { blocks } = runOffice({ dayLocations: { [MON]: { type: 'travel' } } });
    expect(blocks[0].title).toBe(travelBlockTitle());
    expect(blocks[0].start).toBe('09:00');
    expect(blocks[0].durationMinutes).toBe(120);
  });

  it('does not duplicate a travel block already on the calendar', () => {
    const { blocks } = runOffice({
      dayLocations: { [MON]: { type: 'travel', destination: 'Paris' } },
      existingTravelDates: new Set([MON]),
    });
    expect(blocks).toHaveLength(0);
  });
});

describe('home day (and missing entry) adds nothing', () => {
  it('produces no blocks and no deep-work cap', () => {
    const { blocks, deepWorkEndByDate } = runOffice({ dayLocations: {} });
    expect(blocks).toHaveLength(0);
    expect(Object.keys(deepWorkEndByDate)).toHaveLength(0);
  });
});

describe('sanitizeDayLocations', () => {
  const week = new Set([MON, '2026-07-14', '2026-07-15']);

  it('keeps office, drops home/unknown and out-of-week dates', () => {
    const out = sanitizeDayLocations(
      {
        [MON]: { type: 'office' },
        '2026-07-14': { type: 'home' },
        '2026-07-15': { type: 'nonsense' },
        '2026-07-20': { type: 'office' }, // outside the week
      },
      week
    );
    expect(out).toEqual({ [MON]: { type: 'office' } });
  });

  it('clamps travelMinutes to 15–720 and validates depart time', () => {
    expect(sanitizeDayLocations({ [MON]: { type: 'travel', travelMinutes: 5 } }, week)[MON]).toEqual({
      type: 'travel',
      travelMinutes: 15,
    });
    expect(sanitizeDayLocations({ [MON]: { type: 'travel', travelMinutes: 5000 } }, week)[MON]).toEqual({
      type: 'travel',
      travelMinutes: 720,
    });
    // A malformed depart time is dropped; a valid one kept; destination trimmed.
    expect(
      sanitizeDayLocations(
        { [MON]: { type: 'travel', destination: '  Paris  ', departTime: '25:99', travelMinutes: 90 } },
        week
      )[MON]
    ).toEqual({ type: 'travel', destination: 'Paris', travelMinutes: 90 });
    expect(
      sanitizeDayLocations({ [MON]: { type: 'travel', departTime: '08:30' } }, week)[MON]
    ).toEqual({ type: 'travel', departTime: '08:30' });
  });

  it('tolerates a non-object payload', () => {
    expect(sanitizeDayLocations(undefined, week)).toEqual({});
    expect(sanitizeDayLocations('nope', week)).toEqual({});
  });
});

describe('office/travel ritual identity', () => {
  it('classifies get-ready, commute and travel as breaks', () => {
    expect(isBreakTitle(GET_READY_TITLE)).toBe(true);
    expect(isBreakTitle(COMMUTE_TITLE)).toBe(true);
    expect(isBreakTitle('✈️ Travel to Paris')).toBe(true);
    expect(ritualKindForTitle(GET_READY_TITLE)).toBe('getReady');
    expect(ritualKindForTitle(COMMUTE_TITLE)).toBe('commute');
    expect(ritualKindForTitle('✈️ Travel to Paris')).toBe('travel');
  });

  it('tags an office/travel block busy interval as a break', () => {
    const { blocks } = runOffice({ dayLocations: { [MON]: { type: 'office' } } });
    for (const b of blocks) {
      expect(proposedBlockToBusyInterval(b).isBreak).toBe(true);
    }
  });
});
