import { NextResponse } from 'next/server';

import { goalCategories } from '@/lib/goal-categories';
import { getWorkflowConfig } from '@/lib/workflow-config-storage';
import { getAllWeeklyStats } from '@/lib/storage/weekly-stats';

// GET /api/goals/categories
//
// The calendar-category suggestions the goal editor's datalist offers: the union
// of configured quota categories, categories seen in the durable weekly stats,
// and the fixed attribution categories. Autocomplete only — free text still
// resolves, so an unlisted category is fine.
export async function GET() {
  try {
    const [config, stats] = await Promise.all([getWorkflowConfig(), getAllWeeklyStats()]);
    return NextResponse.json({ categories: goalCategories(config, stats) });
  } catch (error) {
    console.error('Error fetching goal categories:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch categories' },
      { status: 500 }
    );
  }
}
