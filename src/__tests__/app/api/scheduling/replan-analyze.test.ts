/**
 * @jest-environment node
 *
 * Tests for the replan analyze route's daily-review block assembly — the parts
 * that feed the DailyReviewModal:
 *   * stored-title fallback for an Asana task already complete (and thus absent
 *     from the live incomplete fetch),
 *   * the `completedInAsana` flag distinguishing Asana-complete from a planning
 *     override,
 *   * the actual event interval (`startMs`) preferring the matched calendar
 *     event over the stored slot (so a dragged event shows its real time).
 * gatherWeekContext + the storage getters are mocked so the route runs pure.
 */
import type { WorkflowConfig } from '@/lib/workflow-config-storage';

jest.mock('@/lib/scheduling/gather', () => ({
  ...jest.requireActual('@/lib/scheduling/gather'),
  gatherWeekContext: jest.fn(),
}));

jest.mock('@/lib/user-data-storage', () => ({
  getScheduledAsanaTasks: jest.fn(),
  getAdHocTasks: jest.fn(),
  getCustomTaskTypes: jest.fn(),
  getPrepBlocks: jest.fn(),
  getRitualBlocks: jest.fn(),
  getBlockDoneOverrides: jest.fn(),
  getDailyReviewState: jest.fn(),
  getMeetingPrepDecisions: jest.fn(),
  setMeetingPrepDecision: jest.fn(),
  getCarryOvers: jest.fn(),
  getAllTaskMetadata: jest.fn(),
  getWeeklyStats: jest.fn(),
}));

import { POST } from '@/app/api/scheduling/replan/analyze/route';
import { gatherWeekContext } from '@/lib/scheduling/gather';
import {
  getScheduledAsanaTasks,
  getAdHocTasks,
  getCustomTaskTypes,
  getPrepBlocks,
  getRitualBlocks,
  getBlockDoneOverrides,
  getDailyReviewState,
  getMeetingPrepDecisions,
  setMeetingPrepDecision,
  getCarryOvers,
  getAllTaskMetadata,
  getWeeklyStats,
} from '@/lib/user-data-storage';
import type { ReplanReviewBlock } from '@/lib/scheduling/replan';
import type { ProposedBlock } from '@/lib/scheduling/types';

const mockGather = gatherWeekContext as jest.MockedFunction<typeof gatherWeekContext>;
const mockScheduled = getScheduledAsanaTasks as jest.Mock;
const mockAdHoc = getAdHocTasks as jest.Mock;
const mockCustomTypes = getCustomTaskTypes as jest.Mock;
const mockPrep = getPrepBlocks as jest.Mock;
const mockRitual = getRitualBlocks as jest.Mock;
const mockOverrides = getBlockDoneOverrides as jest.Mock;
const mockReviewState = getDailyReviewState as jest.Mock;
const mockPrepDecisions = getMeetingPrepDecisions as jest.Mock;

const WEEK_START = new Date(2026, 6, 13, 0, 0, 0, 0); // Monday 2026-07-13
const NOW = new Date(2026, 6, 15, 8, 0, 0, 0); // Wednesday 08:00 (after Monday blocks)

const CONFIG: WorkflowConfig = {
  taskQuotas: {},
  typeMapping: {},
  scheduling: {
    bufferBetweenTasks: '0min',
    workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    workingHours: { start: '09:00', end: '17:00' },
  },
  lastUpdated: '2026-07-12T00:00:00.000Z',
};

function setContext(
  over: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    weekEvents?: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    asanaCandidates?: any[];
    asanaNameByGid?: Map<string, string>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nextWeekEarlyEvents?: any[];
    nextWeekFirstWorkingDay?: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candidateTasks?: any[];
    existingScheduledCounts?: Record<string, number>;
    config?: WorkflowConfig;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    quotas?: any[];
  } = {}
) {
  mockGather.mockResolvedValue({
    now: NOW,
    weekStart: WEEK_START,
    weekStartStr: '2026-07-13',
    weekEndStr: '2026-07-19',
    weekEvents: over.weekEvents ?? [],
    nextWeekEarlyEvents: over.nextWeekEarlyEvents ?? [],
    // First working day of next week (Mon 2026-07-20) — gates next-week prep.
    nextWeekFirstWorkingDay:
      over.nextWeekFirstWorkingDay !== undefined ? over.nextWeekFirstWorkingDay : '2026-07-20',
    asanaCandidates: over.asanaCandidates ?? [],
    asanaNameByGid: over.asanaNameByGid ?? new Map(),
    candidateTasks: over.candidateTasks ?? [],
    existingScheduledCounts: over.existingScheduledCounts ?? {},
    quotas: over.quotas ?? [],
    config: over.config ?? CONFIG,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

async function analyze(): Promise<{
  reviewBlocks: ReplanReviewBlock[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tomorrowBlocks: any[];
  additions: ProposedBlock[];
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST({ json: async () => ({}) } as any);
  return res.json();
}

// Full response (moves / unplaceable / review / etc.) for the tests that assert
// prior-week blocks stay OUT of planning and check the catch-up context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function analyzeFull(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST({ json: async () => ({}) } as any);
  return res.json();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAdHoc.mockResolvedValue([]);
  mockCustomTypes.mockResolvedValue([]);
  mockPrep.mockResolvedValue([]);
  mockRitual.mockResolvedValue([]);
  mockOverrides.mockResolvedValue({});
  mockPrepDecisions.mockResolvedValue({});
  (setMeetingPrepDecision as jest.Mock).mockResolvedValue(undefined);
  (getCarryOvers as jest.Mock).mockResolvedValue({});
  (getAllTaskMetadata as jest.Mock).mockResolvedValue({});
  (getWeeklyStats as jest.Mock).mockResolvedValue(null);
  // A last-review well before the week's blocks, so the "since last review"
  // window includes them (these tests exercise title/interval logic, not the
  // window itself — see the dedicated window test below).
  mockReviewState.mockResolvedValue({ lastReviewedAt: '2026-07-01T00:00:00.000Z', dismissedTitles: [] });
});

describe('replan analyze — daily review blocks', () => {
  it('falls back to the stored task name when the Asana task is already complete', async () => {
    mockScheduled.mockResolvedValue([
      {
        id: 's1',
        asanaTaskId: 'g-done',
        scheduledDate: '2026-07-13',
        scheduledTime: '09:00',
        duration: 60,
        googleEventId: 'evt-done',
        googleIntegrationId: 'gi1',
        taskName: 'Write the report',
      },
    ]);
    setContext({ asanaCandidates: [] }); // g-done absent → complete in Asana

    const { reviewBlocks } = await analyze();
    const block = reviewBlocks.find(b => b.googleEventId === 'evt-done');

    expect(block).toBeDefined();
    expect(block!.titles).toEqual(['Write the report']);
    expect(block!.tasks[0].title).toBe('Write the report');
    expect(block!.done).toBe(true);
    expect(block!.tasks[0].completedInAsana).toBe(true);
  });

  it('prefers the live Asana name and omits completedInAsana for an incomplete task', async () => {
    mockScheduled.mockResolvedValue([
      {
        id: 's1',
        asanaTaskId: 'g-open',
        scheduledDate: '2026-07-13',
        scheduledTime: '09:00',
        duration: 60,
        googleEventId: 'evt-open',
        googleIntegrationId: 'gi1',
        taskName: 'Stale stored name',
      },
    ]);
    setContext({
      asanaCandidates: [{ task: { gid: 'g-open', name: 'Live name' }, typeValue: 'deep' }],
    });

    const { reviewBlocks } = await analyze();
    const block = reviewBlocks.find(b => b.googleEventId === 'evt-open');

    expect(block!.titles).toEqual(['Live name']);
    expect(block!.done).toBe(false);
    expect(block!.tasks[0].completedInAsana).toBeUndefined();
  });

  it('recovers a legacy single-task title from the calendar event title', async () => {
    mockScheduled.mockResolvedValue([
      {
        id: 's1',
        asanaTaskId: 'g-done',
        scheduledDate: '2026-07-13',
        scheduledTime: '09:00',
        duration: 60,
        googleEventId: 'evt-legacy',
        googleIntegrationId: 'gi1',
        // no taskName: entry predates title capture
      },
    ]);
    setContext({
      weekEvents: [
        {
          id: 'evt-legacy',
          allDay: false,
          title: '✍️ Write the report',
          startTime: new Date(2026, 6, 13, 9, 0).toISOString(),
          endTime: new Date(2026, 6, 13, 10, 0).toISOString(),
        },
      ],
    });

    const { reviewBlocks } = await analyze();
    const block = reviewBlocks.find(b => b.googleEventId === 'evt-legacy');

    expect(block!.titles).toEqual(['Write the report']);
  });

  it('recovers legacy grouped-task titles from the event description agenda', async () => {
    const shared = {
      scheduledDate: '2026-07-13',
      scheduledTime: '09:00',
      duration: 60,
      googleEventId: 'evt-group',
      googleIntegrationId: 'gi1',
    };
    mockScheduled.mockResolvedValue([
      { id: 's1', asanaTaskId: '111', ...shared },
      { id: 's2', asanaTaskId: '222', ...shared },
    ]);
    setContext({
      weekEvents: [
        {
          id: 'evt-group',
          allDay: false,
          title: '🤝 Engagement / Outreach',
          description:
            'Grouped block\n\n• First task\n  https://app.asana.com/0/0/111/f\n• Second task\n  https://app.asana.com/0/0/222/f',
          startTime: new Date(2026, 6, 13, 9, 0).toISOString(),
          endTime: new Date(2026, 6, 13, 10, 0).toISOString(),
        },
      ],
    });

    const { reviewBlocks } = await analyze();
    const block = reviewBlocks.find(b => b.googleEventId === 'evt-group');

    expect(block!.titles).toEqual(['First task', 'Second task']);
  });

  it('resolves a completed grouped member from the completed-inclusive name map', async () => {
    // A Batch block with two members: one still open (in the live incomplete
    // fetch) and one completed this week (absent from candidates, present in
    // asanaNameByGid). The completed member must show its real name, not the
    // "Scheduled task" placeholder — no stored taskName, no event agenda.
    const shared = {
      scheduledDate: '2026-07-13',
      scheduledTime: '09:00',
      duration: 60,
      googleEventId: 'evt-batch',
      googleIntegrationId: 'gi1',
    };
    mockScheduled.mockResolvedValue([
      { id: 's1', asanaTaskId: 'g-open', ...shared },
      { id: 's2', asanaTaskId: 'g-done', ...shared },
    ]);
    setContext({
      asanaCandidates: [{ task: { gid: 'g-open', name: 'Check MLex' }, typeValue: 'batch' }],
      asanaNameByGid: new Map([
        ['g-open', 'Check MLex'],
        ['g-done', 'File the expenses'],
      ]),
    });

    const { reviewBlocks } = await analyze();
    const block = reviewBlocks.find(b => b.googleEventId === 'evt-batch');

    expect(block!.titles).toEqual(['Check MLex', 'File the expenses']);
    // The open member stays open; the completed one reads as complete in Asana.
    expect(block!.tasks[0].completedInAsana).toBeUndefined();
    expect(block!.tasks[1].completedInAsana).toBe(true);
  });

  it('uses the matched calendar event interval for startMs (dragged event)', async () => {
    // Stored slot says 09:00; the live event was dragged to 14:00.
    const draggedStart = new Date(2026, 6, 13, 14, 0, 0, 0);
    const draggedEnd = new Date(2026, 6, 13, 15, 0, 0, 0);
    mockScheduled.mockResolvedValue([
      {
        id: 's1',
        asanaTaskId: 'g-done',
        scheduledDate: '2026-07-13',
        scheduledTime: '09:00',
        duration: 60,
        googleEventId: 'evt-done',
        googleIntegrationId: 'gi1',
        taskName: 'Write the report',
      },
    ]);
    setContext({
      weekEvents: [
        {
          id: 'evt-done',
          allDay: false,
          startTime: draggedStart.toISOString(),
          endTime: draggedEnd.toISOString(),
        },
      ],
    });

    const { reviewBlocks } = await analyze();
    const block = reviewBlocks.find(b => b.googleEventId === 'evt-done');

    // Stored slot fields stay intact for the apply payload…
    expect(block!.date).toBe('2026-07-13');
    expect(block!.start).toBe('09:00');
    // …but the displayed interval is the actual (dragged) event time.
    expect(block!.startMs).toBe(draggedStart.getTime());
  });

  it('excludes blocks that ended before the last review (since-last-review window)', async () => {
    // A Monday 09:00–10:00 block; last review was Monday 12:00 → already covered.
    mockScheduled.mockResolvedValue([
      {
        id: 's1',
        asanaTaskId: 'g-done',
        scheduledDate: '2026-07-13',
        scheduledTime: '09:00',
        duration: 60,
        googleEventId: 'evt-old',
        googleIntegrationId: 'gi1',
        taskName: 'Already reviewed',
      },
    ]);
    mockReviewState.mockResolvedValue({
      lastReviewedAt: new Date(2026, 6, 13, 12, 0, 0).toISOString(),
      dismissedTitles: [],
    });
    setContext({ asanaCandidates: [] });

    const { reviewBlocks } = await analyze();
    expect(reviewBlocks.find(b => b.googleEventId === 'evt-old')).toBeUndefined();
  });

  it('offers tomorrow\'s displaceable task blocks as prioritise-tomorrow victims', async () => {
    // NOW is Wed 2026-07-15 08:00 → tomorrow is Thu 2026-07-16. A future Thursday
    // task block is a valid victim; a Wednesday (today) block is not.
    mockScheduled.mockResolvedValue([
      {
        id: 's-thu',
        asanaTaskId: 'g-thu',
        scheduledDate: '2026-07-16',
        scheduledTime: '09:00',
        duration: 60,
        googleEventId: 'evt-thu',
        googleIntegrationId: 'gi1',
        taskName: 'Thursday task',
      },
      {
        id: 's-wed',
        asanaTaskId: 'g-wed',
        scheduledDate: '2026-07-15',
        scheduledTime: '09:00',
        duration: 60,
        googleEventId: 'evt-wed',
        googleIntegrationId: 'gi1',
        taskName: 'Wednesday task',
      },
    ]);
    setContext({
      asanaCandidates: [
        { task: { gid: 'g-thu', name: 'Thursday task' }, typeValue: 'deep' },
        { task: { gid: 'g-wed', name: 'Wednesday task' }, typeValue: 'deep' },
      ],
      asanaNameByGid: new Map([
        ['g-thu', 'Thursday task'],
        ['g-wed', 'Wednesday task'],
      ]),
    });

    const { tomorrowBlocks } = await analyze();
    expect(tomorrowBlocks.map(b => b.googleEventId)).toEqual(['evt-thu']);
    expect(tomorrowBlocks[0]).toMatchObject({
      date: '2026-07-16',
      start: '09:00',
      durationMinutes: 60,
      taskIds: ['g-thu'],
    });
  });

  it('excludes rituals from tomorrow\'s displaceable blocks', async () => {
    mockScheduled.mockResolvedValue([]);
    // A Thursday ritual must never be offered as a bump victim.
    mockRitual.mockResolvedValue([
      {
        id: 'r1',
        title: '🏋️ Exercise',
        date: '2026-07-16',
        start: '15:00',
        durationMinutes: 60,
        googleEventId: 'evt-ritual',
        googleIntegrationId: 'gi1',
      },
    ]);
    setContext({});

    const { tomorrowBlocks } = await analyze();
    expect(tomorrowBlocks).toHaveLength(0);
  });

  it('drops a bare calendar event whose title was dismissed as "not a task"', async () => {
    // A solo, ended, unowned calendar event that the user dismissed by title.
    mockReviewState.mockResolvedValue({
      lastReviewedAt: '2026-07-01T00:00:00.000Z',
      dismissedTitles: ['300k review'],
    });
    setContext({
      weekEvents: [
        {
          id: 'cal-1',
          title: '300k review',
          allDay: false,
          startTime: new Date(2026, 6, 13, 9, 0, 0).toISOString(),
          endTime: new Date(2026, 6, 13, 10, 0, 0).toISOString(),
          integrationId: 'gi1',
        },
      ],
    });

    const { reviewBlocks } = await analyze();
    expect(reviewBlocks.find(b => b.googleEventId === 'cal-1')).toBeUndefined();
  });
});

describe('replan analyze — previouslyStarted seeding from weekly stats', () => {
  const scheduled = {
    id: 's1',
    asanaTaskId: 'g-open',
    scheduledDate: '2026-07-13',
    scheduledTime: '09:00',
    duration: 60,
    googleEventId: 'evt-open',
    googleIntegrationId: 'gi1',
    taskName: 'Deep work task',
  };

  it('flags a not-done task recorded "started" this week as previouslyStarted', async () => {
    mockScheduled.mockResolvedValue([scheduled]);
    setContext({
      asanaCandidates: [{ task: { gid: 'g-open', name: 'Deep work task' }, typeValue: 'deep' }],
    });
    (getWeeklyStats as jest.Mock).mockResolvedValue({
      weekStart: '2026-07-13',
      tasks: {
        'g-open': { taskId: 'g-open', category: 'deep', scheduledAt: '2026-07-13T09:00:00.000Z', outcome: 'started' },
      },
      integrations: {},
    });

    const { reviewBlocks } = await analyze();
    const block = reviewBlocks.find(b => b.googleEventId === 'evt-open');

    expect(block!.tasks[0].done).toBe(false);
    expect(block!.tasks[0].previouslyStarted).toBe(true);
  });

  it('does not flag a task whose stats outcome is not "started"', async () => {
    mockScheduled.mockResolvedValue([scheduled]);
    setContext({
      asanaCandidates: [{ task: { gid: 'g-open', name: 'Deep work task' }, typeValue: 'deep' }],
    });
    // Recorded 'done' (a positive outcome) — must not seed a started state.
    (getWeeklyStats as jest.Mock).mockResolvedValue({
      weekStart: '2026-07-13',
      tasks: {
        'g-open': { taskId: 'g-open', category: 'deep', scheduledAt: '2026-07-13T09:00:00.000Z', outcome: 'done' },
      },
      integrations: {},
    });

    const { reviewBlocks } = await analyze();
    const block = reviewBlocks.find(b => b.googleEventId === 'evt-open');

    expect(block!.tasks[0].previouslyStarted).toBeUndefined();
  });
});

describe('replan analyze — 7-day catch-up window across the week boundary', () => {
  // A block dated last Friday (2026-07-10), before this week's Monday. The route
  // fetches only this week's events, so intervalFor falls back to the stored slot.
  const priorFridayBlock = {
    id: 's-prior',
    asanaTaskId: 'g-prior',
    scheduledDate: '2026-07-10',
    scheduledTime: '09:00',
    duration: 60,
    googleEventId: 'evt-prior',
    googleIntegrationId: 'gi1',
    taskName: 'Friday leftover',
  };

  it('surfaces a prior-week block in reviewBlocks but never in planning (moves/kept/unplaceable)', async () => {
    // Last review Thursday last week, so the window reaches back to Friday.
    mockReviewState.mockResolvedValue({
      lastReviewedAt: new Date(2026, 6, 9, 0, 0, 0).toISOString(),
      dismissedTitles: [],
    });
    mockScheduled.mockResolvedValue([priorFridayBlock]);
    // Still incomplete → not done, so if it wrongly entered planning it would be
    // classified "missed" and show up as a move or unplaceable.
    setContext({
      asanaCandidates: [{ task: { gid: 'g-prior', name: 'Friday leftover' }, typeValue: 'deep' }],
    });

    const out = await analyzeFull();
    expect(out.reviewBlocks.find((b: ReplanReviewBlock) => b.googleEventId === 'evt-prior')).toBeDefined();
    // Absent from every planning channel.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(out.moves.find((m: any) => m.googleEventId === 'evt-prior')).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(out.kept.find((k: any) => k.googleEventId === 'evt-prior')).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(out.unplaceable.find((u: any) => u.googleEventId === 'evt-prior')).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(out.tomorrowBlocks.find((t: any) => t.googleEventId === 'evt-prior')).toBeUndefined();
  });

  it('clamps the lookback at 7 days — a block older than the cap is dropped', async () => {
    // Last review a month ago, so the effective window start is now − 7 days
    // (2026-07-08 08:00). A block on 07-05 is out; one on 07-10 is in.
    mockReviewState.mockResolvedValue({
      lastReviewedAt: new Date(2026, 5, 15, 0, 0, 0).toISOString(),
      dismissedTitles: [],
    });
    mockScheduled.mockResolvedValue([
      priorFridayBlock, // 07-10, within the 7-day window
      { ...priorFridayBlock, id: 's-old', asanaTaskId: 'g-old', googleEventId: 'evt-old', scheduledDate: '2026-07-05', taskName: 'Too old' },
    ]);
    setContext({
      asanaCandidates: [
        { task: { gid: 'g-prior', name: 'Friday leftover' }, typeValue: 'deep' },
        { task: { gid: 'g-old', name: 'Too old' }, typeValue: 'deep' },
      ],
    });

    const out = await analyzeFull();
    const ids = out.reviewBlocks.map((b: ReplanReviewBlock) => b.googleEventId);
    expect(ids).toContain('evt-prior');
    expect(ids).not.toContain('evt-old');
    expect(out.review.clamped).toBe(true);
  });

  it('leaves the never-reviewed fallback at today (no prior-week reach, sinceIso null)', async () => {
    mockReviewState.mockResolvedValue({ lastReviewedAt: undefined, dismissedTitles: [] });
    mockScheduled.mockResolvedValue([priorFridayBlock]);
    setContext({
      asanaCandidates: [{ task: { gid: 'g-prior', name: 'Friday leftover' }, typeValue: 'deep' }],
    });

    const out = await analyzeFull();
    // Window is today's logical start, so last week's block never reaches it.
    expect(out.reviewBlocks.find((b: ReplanReviewBlock) => b.googleEventId === 'evt-prior')).toBeUndefined();
    expect(out.review.sinceIso).toBeNull();
    expect(out.review.clamped).toBe(false);
    expect(out.review.missedWorkingDays).toBe(0);
  });
});

describe('replan analyze — catch-up context (missedWorkingDays / sinceIso)', () => {
  // A Monday review that follows a Friday-evening one: the weekend in between is
  // not working time, so nothing was "missed". Uses its own gather mock so `now`
  // can be a Monday.
  it('counts zero missed working days for a Friday→Monday gap (weekend skipped)', async () => {
    const monday = new Date(2026, 6, 20, 9, 0, 0);
    mockGather.mockResolvedValue({
      now: monday,
      weekStart: new Date(2026, 6, 20, 0, 0, 0),
      weekStartStr: '2026-07-20',
      weekEndStr: '2026-07-26',
      weekEvents: [],
      nextWeekEarlyEvents: [],
      asanaCandidates: [],
      asanaNameByGid: new Map(),
      quotas: [],
      config: CONFIG,
      outOfOfficeDates: new Set<string>(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    mockReviewState.mockResolvedValue({
      lastReviewedAt: new Date(2026, 6, 17, 18, 0, 0).toISOString(), // Fri 18:00
      dismissedTitles: [],
    });
    mockScheduled.mockResolvedValue([]);

    const out = await analyzeFull();
    expect(out.review.missedWorkingDays).toBe(0);
    expect(out.review.clamped).toBe(false);
    expect(out.review.sinceIso).toBe(new Date(2026, 6, 17, 18, 0, 0).toISOString());
  });

  it('counts the working days missed after a mid-week gap', async () => {
    // Last review Monday, now Wednesday (NOW). Strictly between: Tuesday only —
    // today (Wed) is the review being done now and is excluded.
    mockReviewState.mockResolvedValue({
      lastReviewedAt: new Date(2026, 6, 13, 9, 0, 0).toISOString(),
      dismissedTitles: [],
    });
    mockScheduled.mockResolvedValue([]);
    setContext({});

    const out = await analyzeFull();
    expect(out.review.missedWorkingDays).toBe(1);
    expect(out.review.clamped).toBe(false);
  });
});

describe('replan analyze — prep additions for early-next-week meetings', () => {
  // A meeting on next Monday, offered as a prep candidate this week. `startTime`
  // is a real Date (gather returns Dates), so resolvePrepCandidates can read it.
  const nextMondayMeeting = {
    id: 'evt-next-mon',
    title: 'Board review',
    allDay: false,
    startTime: new Date(2026, 6, 20, 10, 0, 0), // next Mon 10:00
    endTime: new Date(2026, 6, 20, 11, 0, 0),
    integrationId: 'gi1',
    attendeeCount: 4,
  };

  it('adds a prep block this week for a next-week meeting the user wants prepped', async () => {
    // A stored USER decision means no AI classification call is needed.
    mockPrepDecisions.mockResolvedValue({
      'board review': { needsPrep: true, decidedBy: 'user', updatedAt: '2026-07-14T00:00:00.000Z' },
    });
    setContext({ nextWeekEarlyEvents: [nextMondayMeeting] });

    const { additions } = await analyze();
    const prep = additions.filter(a => a.kind === 'prep');
    expect(prep).toHaveLength(1);
    expect(prep[0].meeting?.eventId).toBe('evt-next-mon');
    expect(prep[0].meeting?.title).toBe('Board review');
    // Placed on one of THIS week's remaining working days (Wed–Fri), latest-first.
    expect(prep[0].date >= '2026-07-15' && prep[0].date <= '2026-07-17').toBe(true);
  });

  it('does not add prep for a next-week meeting the user declined to prep', async () => {
    mockPrepDecisions.mockResolvedValue({
      'board review': { needsPrep: false, decidedBy: 'user', updatedAt: '2026-07-14T00:00:00.000Z' },
    });
    setContext({ nextWeekEarlyEvents: [nextMondayMeeting] });

    const { additions } = await analyze();
    expect(additions.filter(a => a.kind === 'prep')).toHaveLength(0);
  });

  it('does not re-offer prep for a next-week meeting already prepped (done) last week', async () => {
    mockPrepDecisions.mockResolvedValue({
      'board review': { needsPrep: true, decidedBy: 'user', updatedAt: '2026-07-14T00:00:00.000Z' },
    });
    // A done prep block from last week for the exact meeting instance suppresses it.
    mockPrep.mockResolvedValue([
      {
        id: 'p1',
        googleEventId: 'evt-prep-lastweek',
        googleIntegrationId: 'gi1',
        meetingEventId: 'evt-next-mon',
        meetingTitle: 'Board review',
        meetingStart: new Date(2026, 6, 20, 10, 0, 0).toISOString(),
        date: '2026-07-10',
        start: '15:00',
        durationMinutes: 15,
        done: true,
        createdAt: '2026-07-10T00:00:00.000Z',
      },
    ]);
    setContext({ nextWeekEarlyEvents: [nextMondayMeeting] });

    const { additions } = await analyze();
    expect(additions.filter(a => a.kind === 'prep')).toHaveLength(0);
  });
});

describe('replan analyze — task backfill wiring', () => {
  const BACKFILL_CONFIG: WorkflowConfig = {
    taskQuotas: { Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: ['09:00-11:00'] } },
    typeMapping: { Deep: ['deep'] },
    scheduling: {
      bufferBetweenTasks: '0min',
      workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      workingHours: { start: '09:00', end: '17:00' },
    },
    lastUpdated: '2026-07-12T00:00:00.000Z',
  };

  it('returns backfill task blocks for the unmet quota from the candidate pool', async () => {
    mockScheduled.mockResolvedValue([]);
    setContext({
      config: BACKFILL_CONFIG,
      candidateTasks: [{ gid: 'a1', title: 'Write memo', typeSignals: ['deep'] }],
      existingScheduledCounts: {},
    });

    const full = await analyzeFull();
    expect(Array.isArray(full.backfill)).toBe(true);
    expect(full.backfill.length).toBeGreaterThanOrEqual(1);
    expect(full.backfill[0].category).toBe('Deep');
    expect(full.backfill[0].task.gid).toBe('a1');
  });

  it('returns no backfill when the candidate pool is empty', async () => {
    mockScheduled.mockResolvedValue([]);
    setContext({ config: BACKFILL_CONFIG, candidateTasks: [], existingScheduledCounts: {} });

    const full = await analyzeFull();
    expect(full.backfill).toEqual([]);
  });

  // The quota-less General Todos catch-all is never auto-placed: its candidates are
  // returned as `todoCandidates` and the leftover space as `freeSlots`, for the
  // user to fill by hand.
  it('does not auto-place General Todos — returns todoCandidates + freeSlots instead', async () => {
    const TODO_CONFIG: WorkflowConfig = {
      taskQuotas: {
        Deep: { weeklyCount: 2, targetLength: '1h', preferredTimes: ['09:00-11:00'] },
        'General Todos': { targetLength: '30min', preferredTimes: [] }, // no weeklyCount
      },
      typeMapping: { Deep: ['deep'], 'General Todos': ['todo'] },
      scheduling: {
        bufferBetweenTasks: '0min',
        workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        workingHours: { start: '09:00', end: '17:00' },
      },
      lastUpdated: '2026-07-12T00:00:00.000Z',
    };
    mockScheduled.mockResolvedValue([]);
    setContext({
      config: TODO_CONFIG,
      quotas: [
        { category: 'Deep', weeklyCount: 2, targetLength: '1h', types: ['deep'] },
        { category: 'General Todos', weeklyCount: undefined, targetLength: '30min', types: ['todo'] },
      ],
      candidateTasks: [{ gid: 'todo1', title: 'Reply to X', typeSignals: ['todo'] }],
      existingScheduledCounts: { Deep: 2 }, // Deep met; the rest is free space
    });

    const full = await analyzeFull();
    // No auto-placed todo block.
    expect(full.backfill.some((b: ProposedBlock) => b.category === 'General Todos')).toBe(false);
    // The todo pool is handed to the user to pick from.
    expect(full.todoCandidates.map((t: { gid?: string }) => t.gid)).toEqual(['todo1']);
    expect(full.todoCandidates[0].category).toBe('General Todos');
    // Free space is reported for him to fill.
    expect(Array.isArray(full.freeSlots)).toBe(true);
    expect(full.freeSlots.length).toBeGreaterThanOrEqual(1);
    expect(full.freeSlots.every((s: { durationMinutes: number }) => s.durationMinutes === 30)).toBe(true);
  });
});
