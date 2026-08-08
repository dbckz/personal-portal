/**
 * @jest-environment node
 *
 * Tests that the plan-week candidates endpoint surfaces the carry-over flag and
 * floats carried tasks up their category (behind pinned priorities).
 */
jest.mock('@/lib/scheduling/gather', () => ({ gatherWeekContext: jest.fn() }));
jest.mock('@/lib/integration-storage', () => ({ getEnabledAsanaIntegrations: jest.fn() }));
jest.mock('@/lib/user-data-storage', () => ({ getAllWeeklyStats: jest.fn() }));

import { POST } from '@/app/api/scheduling/candidates/route';
import { gatherWeekContext } from '@/lib/scheduling/gather';
import { getEnabledAsanaIntegrations } from '@/lib/integration-storage';
import { getAllWeeklyStats } from '@/lib/user-data-storage';
import type { WorkflowConfig } from '@/lib/workflow-config-storage';
import type { CandidateTask } from '@/lib/scheduling/types';

const mockGather = gatherWeekContext as jest.MockedFunction<typeof gatherWeekContext>;

const CONFIG: WorkflowConfig = {
  taskQuotas: { Writing: { weeklyCount: 3, targetLength: '60min', preferredTimes: [] } },
  typeMapping: { Writing: ['Writing'] },
  scheduling: {
    bufferBetweenTasks: '0min',
    workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    workingHours: { start: '09:00', end: '17:00' },
  },
  lastUpdated: '2026-07-12T00:00:00.000Z',
};

function setCandidates(candidateTasks: CandidateTask[]) {
  mockGather.mockResolvedValue({
    config: CONFIG,
    weekStartStr: '2026-07-20',
    weekEndStr: '2026-07-26',
    candidateTasks,
    quotas: [{ category: 'Writing', weeklyCount: 3, targetLength: '60min', types: ['Writing'] }],
    existingScheduledCounts: {},
    deferredCountsByCategory: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function candidates(body: any = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST({ json: async () => body } as any);
  return res.json();
}

const task = (over: Partial<CandidateTask> & { gid: string; title: string }): CandidateTask => ({
  typeSignals: ['Writing'],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  (getEnabledAsanaIntegrations as jest.Mock).mockResolvedValue([]);
  (getAllWeeklyStats as jest.Mock).mockResolvedValue({});
});

describe('candidates — carry-over surfacing', () => {
  it('exposes carriedOver / carriedFromWeek only for carried tasks', async () => {
    setCandidates([
      task({ gid: 'g-plain', title: 'Plain' }),
      task({ gid: 'g-carried', title: 'Carried', carriedOver: true, carriedFromWeek: '2026-07-13' }),
    ]);

    const out = await candidates();
    const byId = Object.fromEntries(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      out.categories[0].candidates.map((c: any) => [c.id, c])
    );
    expect(byId['g-carried']).toEqual(
      expect.objectContaining({ carriedOver: true, carriedFromWeek: '2026-07-13' })
    );
    expect(byId['g-plain']).not.toHaveProperty('carriedOver');
  });

  it('surfaces per-category calibration from recent weekly history', async () => {
    setCandidates([task({ gid: 'g1', title: 'Draft' })]);
    // Four complete weeks that scheduled the full quota of 3 Writing tasks but
    // finished only one each → 33% completion, so the quota should be nudged down.
    const wk = (weekStart: string) => {
      const tasks: Record<string, unknown> = {};
      for (let i = 0; i < 3; i++) {
        tasks[`${weekStart}-${i}`] = {
          taskId: `${weekStart}-${i}`,
          category: 'Writing',
          scheduledAt: `${weekStart}T09:00:00.000Z`,
          outcome: i === 0 ? 'done' : 'carried',
        };
      }
      return [weekStart, { weekStart, createdAt: '', updatedAt: '', tasks, integrations: {} }];
    };
    (getAllWeeklyStats as jest.Mock).mockResolvedValue(
      Object.fromEntries(
        ['2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06'].map(wk)
      )
    );

    const out = await candidates();
    const cal = out.categories[0].calibration;
    expect(cal.weeksOfData).toBe(4);
    expect(cal.avgCompletionRate).toBeCloseTo(1 / 3);
    expect(cal.suggestedQuota).toBe(2);
  });

  it('sorts priorities first, then carried-over, then the rest', async () => {
    setCandidates([
      task({ gid: 'g-plain', title: 'Plain' }),
      task({ gid: 'g-carried', title: 'Carried', carriedOver: true, carriedFromWeek: '2026-07-13' }),
      task({ gid: 'g-priority', title: 'Priority' }),
    ]);

    const out = await candidates({ priorityGids: ['g-priority'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(out.categories[0].candidates.map((c: any) => c.id)).toEqual([
      'g-priority',
      'g-carried',
      'g-plain',
    ]);
  });
});
