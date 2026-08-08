// The calendar-category suggestions the goal editor offers: the union of the
// workflow's configured quota categories, the categories actually observed in
// the durable weekly stats (guaranteed resolvable — the evidence resolver reads
// the same byCategory keys), and the fixed attribution categories the
// time-tracker can emit. Deduped and sorted.
//
// The union is a pure function so it stays unit-testable; the
// /api/goals/categories route gathers the raw inputs and calls it.

import type { WeeklyStatsRecord } from '@/types';
import type { WorkflowConfig } from '@/lib/workflow-config-storage';
import { ATTRIBUTION_CATEGORIES } from '@/lib/time-attribution';

// Merge any number of category groups into a sorted, deduped list, dropping
// blank entries.
export function mergeGoalCategories(...groups: Array<Iterable<string>>): string[] {
  const set = new Set<string>();
  for (const group of groups) {
    for (const raw of group) {
      const category = raw?.trim();
      if (category) set.add(category);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Every category seen in the durable weekly stats' per-day byCategory maps.
export function observedStatsCategories(
  stats: Record<string, WeeklyStatsRecord>
): string[] {
  const categories = new Set<string>();
  for (const week of Object.values(stats)) {
    for (const integration of Object.values(week.integrations ?? {})) {
      for (const day of Object.values(integration.days ?? {})) {
        for (const category of Object.keys(day.byCategory ?? {})) {
          categories.add(category);
        }
      }
    }
  }
  return [...categories];
}

export function goalCategories(
  config: WorkflowConfig,
  stats: Record<string, WeeklyStatsRecord>
): string[] {
  return mergeGoalCategories(
    Object.keys(config.taskQuotas ?? {}),
    observedStatsCategories(stats),
    ATTRIBUTION_CATEGORIES
  );
}
