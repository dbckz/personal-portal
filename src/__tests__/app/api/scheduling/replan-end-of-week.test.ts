/**
 * @jest-environment node
 *
 * Tests for the replan analyze route's end-of-week mode: on the last working day
 * (and the weekend after it) unfinished task-backed blocks come back as
 * `carryBlocks` with their member tasks, rituals never appear, and a mid-week
 * analyze is left exactly as it was.
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
  getCarryOvers,
  getAllTaskMetadata,
  getWeeklyStats,
} from '@/lib/user-data-storage';
import type { ReplanCarryBlock } from '@/lib/scheduling/replan';

const mockGather = gatherWeekContext as jest.MockedFunction<typeof gatherWeekContext>;

const WEEK_START = new Date(2026, 6, 13, 0, 0, 0, 0); // Monday 2026-07-13
const FRIDAY_EVENING = new Date(2026, 6, 17, 18, 30, 0, 0); // after working hours
const WEDNESDAY = new Date(2026, 6, 15, 8, 0, 0, 0);

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

// A grouped Asana block on Monday with two members, one already complete.
const GROUPED = [
  {
    id: 's1',
    asanaTaskId: 'g-open',
    integrationId: 'ai1',
    scheduledDate: '2026-07-13',
    scheduledTime: '09:00',
    duration: 60,
    googleEventId: 'evt-group',
    googleIntegrationId: 'gi1',
    taskName: 'Draft the brief',
  },
  {
    id: 's2',
    asanaTaskId: 'g-done',
    integrationId: 'ai1',
    scheduledDate: '2026-07-13',
    scheduledTime: '09:00',
    duration: 60,
    googleEventId: 'evt-group',
    googleIntegrationId: 'gi1',
    taskName: 'Send the invites',
  },
];

// A second Writing block later the same week over an OVERLAPPING agenda: the
// planner places one grouped block per quota slot, all sharing the same tasks.
const SIBLING = [
  {
    id: 's3',
    asanaTaskId: 'g-open',
    integrationId: 'ai1',
    scheduledDate: '2026-07-16',
    scheduledTime: '12:00',
    duration: 60,
    googleEventId: 'evt-group-2',
    googleIntegrationId: 'gi1',
    taskName: 'Draft the brief',
  },
  {
    id: 's4',
    asanaTaskId: 'g-extra',
    integrationId: 'ai1',
    scheduledDate: '2026-07-16',
    scheduledTime: '12:00',
    duration: 60,
    googleEventId: 'evt-group-2',
    googleIntegrationId: 'gi1',
    taskName: 'Outline the deck',
  },
];

function setContext(now: Date, extraCandidates: Array<{ gid: string; name: string }> = []) {
  mockGather.mockResolvedValue({
    now,
    weekStart: WEEK_START,
    weekStartStr: '2026-07-13',
    weekEndStr: '2026-07-19',
    weekEvents: [],
    nextWeekEarlyEvents: [],
    // Only g-open is still incomplete in Asana.
    asanaCandidates: [
      { task: { gid: 'g-open', name: 'Draft the brief' }, integrationId: 'ai1', typeValue: null },
      ...extraCandidates.map(t => ({ task: t, integrationId: 'ai1', typeValue: null })),
    ],
    asanaNameByGid: new Map([['g-done', 'Send the invites']]),
    quotas: [],
    config: CONFIG,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

async function analyze() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST({ json: async () => ({}) } as any);
  return res.json() as Promise<{
    endOfWeek: boolean;
    carryBlocks?: ReplanCarryBlock[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    moves: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unplaceable: any[];
  }>;
}

beforeEach(() => {
  jest.clearAllMocks();
  (getScheduledAsanaTasks as jest.Mock).mockResolvedValue(GROUPED);
  (getAdHocTasks as jest.Mock).mockResolvedValue([]);
  (getCustomTaskTypes as jest.Mock).mockResolvedValue([]);
  (getPrepBlocks as jest.Mock).mockResolvedValue([]);
  (getRitualBlocks as jest.Mock).mockResolvedValue([]);
  (getBlockDoneOverrides as jest.Mock).mockResolvedValue({});
  (getCarryOvers as jest.Mock).mockResolvedValue({});
  (getAllTaskMetadata as jest.Mock).mockResolvedValue({});
  (getWeeklyStats as jest.Mock).mockResolvedValue(null);
  (getDailyReviewState as jest.Mock).mockResolvedValue({
    lastReviewedAt: '2026-07-01T00:00:00.000Z',
    dismissedTitles: [],
  });
});

describe('replan analyze — end-of-week mode', () => {
  it('flags end of week on Friday evening and returns the block per member task', async () => {
    setContext(FRIDAY_EVENING);
    const out = await analyze();

    expect(out.endOfWeek).toBe(true);
    expect(out.carryBlocks).toHaveLength(1);
    const block = out.carryBlocks![0];
    expect(block.googleEventId).toBe('evt-group');
    expect(block.reason).toBe('unplaceable');
    expect(block.tasks).toEqual([
      expect.objectContaining({ id: 'g-open', title: 'Draft the brief', done: false, integrationId: 'ai1' }),
      expect.objectContaining({ id: 'g-done', title: 'Send the invites', done: true }),
    ]);
  });

  it('never offers a ritual block for carry-over', async () => {
    (getRitualBlocks as jest.Mock).mockResolvedValue([
      {
        id: 'r1',
        googleEventId: 'evt-lunch',
        googleIntegrationId: 'gi1',
        title: '🍽️ Lunch',
        date: '2026-07-17',
        start: '12:30',
        durationMinutes: 30,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
    ]);
    setContext(FRIDAY_EVENING);
    const out = await analyze();

    expect(out.carryBlocks!.map(b => b.googleEventId)).toEqual(['evt-group']);
  });

  it('merges sibling blocks of a grouped category into one card with unique tasks', async () => {
    (getScheduledAsanaTasks as jest.Mock).mockResolvedValue([...GROUPED, ...SIBLING]);
    setContext(FRIDAY_EVENING, [{ gid: 'g-extra', name: 'Outline the deck' }]);

    const out = await analyze();

    // One card, not one per block — and no repeated member task.
    expect(out.carryBlocks).toHaveLength(1);
    const block = out.carryBlocks![0];
    expect(block.tasks.map(t => t.id)).toEqual(['g-open', 'g-done', 'g-extra']);
    expect(block.mergedEventIds).toEqual(['evt-group', 'evt-group-2']);
  });

  it('never offers a ritual that was adopted as an ad-hoc task (bare "Emails")', async () => {
    // Reproduces the production bug: a hand-made "Emails" event with no emoji was
    // adopted as an ad-hoc task, which then surfaced as a "Scheduled" carry card.
    (getAdHocTasks as jest.Mock).mockResolvedValue([
      {
        id: 'b74f1700-820c-4a35-96a0-d5fb087ff106',
        title: 'Emails',
        completed: false,
        taskType: 'focus',
        dueDate: '2026-07-16',
        dueTime: '14:00',
        duration: 30,
        googleEventId: '7pi8pnfd2gl4fsemevfjbvibo5',
        googleIntegrationId: 'gi1',
      },
      {
        id: 'adhoc-real',
        title: 'Email triage',
        completed: false,
        taskType: 'focus',
        dueDate: '2026-07-16',
        dueTime: '15:00',
        duration: 30,
        googleEventId: 'evt-triage',
        googleIntegrationId: 'gi1',
      },
    ]);
    setContext(FRIDAY_EVENING);

    const out = await analyze();

    const ids = out.carryBlocks!.map(b => b.googleEventId);
    expect(ids).not.toContain('7pi8pnfd2gl4fsemevfjbvibo5');
    // A real task whose title merely starts with a ritual word is untouched.
    expect(ids).toContain('evt-triage');
  });

  it('leaves a mid-week analyze untouched (no carry blocks, same moves/unplaceable)', async () => {
    setContext(WEDNESDAY);
    const out = await analyze();

    expect(out.endOfWeek).toBe(false);
    expect(out).not.toHaveProperty('carryBlocks');
    // The Monday block is still re-slotted into the remaining week as before.
    expect(out.moves).toHaveLength(1);
    expect(out.moves[0]).toEqual(
      expect.objectContaining({ googleEventId: 'evt-group', reason: 'missed' })
    );
    expect(out.unplaceable).toEqual([]);
  });
});

describe('replan analyze — carry escalation signals', () => {
  it('surfaces the carry streak and AI-runnable flag on carry tasks', async () => {
    (getCarryOvers as jest.Mock).mockResolvedValue({
      'g-open': { fromWeek: '2026-07-06', at: 0, carries: 3 },
    });
    (getAllTaskMetadata as jest.Mock).mockResolvedValue({
      'g-open': { asanaTaskGid: 'g-open', integrationId: 'ai1', aiDelegable: true, updatedAt: '' },
    });
    setContext(FRIDAY_EVENING);

    const out = await analyze();
    const task = out.carryBlocks![0].tasks.find(t => t.id === 'g-open')!;

    expect(task.carryStreak).toBe(3);
    expect(task.aiDelegable).toBe(true);
  });

  it('leaves a never-carried, non-delegable task unmarked', async () => {
    setContext(FRIDAY_EVENING);

    const out = await analyze();
    const task = out.carryBlocks![0].tasks.find(t => t.id === 'g-open')!;

    expect(task.carryStreak).toBeUndefined();
    expect(task.aiDelegable).toBeUndefined();
  });

  it('treats a carry-over with no stored count as one carry', async () => {
    (getCarryOvers as jest.Mock).mockResolvedValue({ 'g-open': { fromWeek: '2026-07-06', at: 0 } });
    setContext(FRIDAY_EVENING);

    const out = await analyze();
    expect(out.carryBlocks![0].tasks.find(t => t.id === 'g-open')!.carryStreak).toBe(1);
  });
});

describe('replan analyze — portal-done (waiting on others)', () => {
  // Grouped block whose remaining open member (g-open) is flagged portal-done.
  function setPortalDoneContext(now: Date) {
    mockGather.mockResolvedValue({
      now,
      weekStart: WEEK_START,
      weekStartStr: '2026-07-13',
      weekEndStr: '2026-07-19',
      weekEvents: [],
      nextWeekEarlyEvents: [],
      asanaCandidates: [
        // g-open is still incomplete in Asana (only Dave's part is done).
        { task: { gid: 'g-open', name: 'Draft the brief' }, integrationId: 'ai1', typeValue: null },
      ],
      asanaNameByGid: new Map([['g-open', 'Draft the brief'], ['g-done', 'Send the invites']]),
      quotas: [],
      config: CONFIG,
      portalDoneGids: new Set(['g-open']),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    (getAllTaskMetadata as jest.Mock).mockResolvedValue({
      'g-open': {
        asanaTaskGid: 'g-open',
        integrationId: 'ai1',
        portalDone: true,
        portalDoneAt: '2026-07-15T09:00:00.000Z',
        portalDoneTitle: 'Draft the brief',
        updatedAt: '2026-07-15T09:00:00.000Z',
      },
    });
  }

  it('does not carry a block whose only open member is portal-done', async () => {
    setPortalDoneContext(FRIDAY_EVENING);
    const out = await analyze();

    // Both members now read done (g-done complete, g-open portal-done), so the
    // block never surfaces as a carry / missed block.
    expect(out.carryBlocks ?? []).toHaveLength(0);
    expect(out.moves).toEqual([]);
  });

  it('lists portal-done tasks under `waiting` at end of week', async () => {
    setPortalDoneContext(FRIDAY_EVENING);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST({ json: async () => ({}) } as any);
    const out = await res.json();

    expect(out.waiting).toEqual([
      expect.objectContaining({ gid: 'g-open', integrationId: 'ai1', title: 'Draft the brief' }),
    ]);
  });

  it('omits `waiting` on a mid-week analyze', async () => {
    setPortalDoneContext(WEDNESDAY);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST({ json: async () => ({}) } as any);
    const out = await res.json();

    expect(out.endOfWeek).toBe(false);
    expect(out).not.toHaveProperty('waiting');
  });
});
