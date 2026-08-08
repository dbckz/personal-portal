/**
 * @jest-environment node
 *
 * The calendar-category suggestion union: configured quota categories, observed
 * weekly-stats categories, and the fixed attribution categories, deduped and
 * sorted. Pure, so no storage is touched.
 */
import {
  goalCategories,
  mergeGoalCategories,
  observedStatsCategories,
} from '@/lib/goal-categories';
import { ATTRIBUTION_CATEGORIES } from '@/lib/time-attribution';
import type { WorkflowConfig } from '@/lib/workflow-config-storage';
import type { WeeklyStatsRecord } from '@/types';

describe('mergeGoalCategories', () => {
  it('dedupes, sorts and drops blanks', () => {
    expect(mergeGoalCategories(['Deep work', 'Admin'], ['Admin', '  ', 'Calls'])).toEqual([
      'Admin',
      'Calls',
      'Deep work',
    ]);
  });

  it('trims entries before deduping', () => {
    expect(mergeGoalCategories([' Deep work '], ['Deep work'])).toEqual(['Deep work']);
  });

  it('returns an empty list for no input', () => {
    expect(mergeGoalCategories()).toEqual([]);
  });
});

describe('observedStatsCategories', () => {
  it('collects every byCategory key across weeks, integrations and days', () => {
    const stats: Record<string, WeeklyStatsRecord> = {
      '2026-08-03': {
        integrations: {
          om: { days: { '2026-08-04': { byCategory: { 'Deep work': 90, Calls: 30 } } } },
          dbc: { days: { '2026-08-05': { byCategory: { 'Deep work': 45 } } } },
        },
      } as unknown as WeeklyStatsRecord,
    };
    expect(observedStatsCategories(stats).sort()).toEqual(['Calls', 'Deep work']);
  });

  it('tolerates missing integrations/days/byCategory', () => {
    expect(observedStatsCategories({ w: {} as WeeklyStatsRecord })).toEqual([]);
  });
});

describe('goalCategories', () => {
  it('unions config quotas, observed stats and the attribution constants', () => {
    const config = {
      taskQuotas: { 'Deep work': {}, Batch: {} },
    } as unknown as WorkflowConfig;
    const stats: Record<string, WeeklyStatsRecord> = {
      w: {
        integrations: { om: { days: { d: { byCategory: { Reading: 20 } } } } },
      } as unknown as WeeklyStatsRecord,
    };

    const result = goalCategories(config, stats);

    for (const expected of ['Deep work', 'Batch', 'Reading', ...ATTRIBUTION_CATEGORIES]) {
      expect(result).toContain(expected);
    }
    // Sorted and unique.
    expect(result).toEqual([...new Set(result)].sort((a, b) => a.localeCompare(b)));
  });
});
