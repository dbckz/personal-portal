import { NextRequest, NextResponse } from 'next/server';

import { loadAsanaProjects } from '@/lib/asana-catalogue';
import { goalCategories } from '@/lib/goal-categories';
import { inferEvidence } from '@/lib/goal-inference';
import { getGoal } from '@/lib/storage/goals';
import { getAllSessions } from '@/lib/storage/exercise';
import { getAllWeeklyStats } from '@/lib/storage/weekly-stats';
import { getWorkflowConfig } from '@/lib/workflow-config-storage';

// POST /api/goals/[id]/suggest-evidence  →  { proposal }
//
// Proposes an auto-tracking source for a goal Dave has been self-reporting.
// Nothing is written: the editor shows `proposal` and Dave applies it with a
// PATCH. `proposal` is null when the goal isn't manual, the model is
// unavailable, or nothing usable comes back.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const goal = await getGoal(id);
    if (!goal) return NextResponse.json({ error: 'Goal not found' }, { status: 404 });

    const [sessions, projects, config, stats] = await Promise.all([
      getAllSessions(),
      loadAsanaProjects(),
      getWorkflowConfig(),
      getAllWeeklyStats(),
    ]);

    const proposal = await inferEvidence(goal, {
      sessions,
      projects,
      categories: goalCategories(config, stats),
    });

    return NextResponse.json({ proposal });
  } catch (error) {
    console.error('Error suggesting goal evidence:', error);
    return NextResponse.json({ error: 'Failed to suggest a tracking source' }, { status: 500 });
  }
}
