import { NextResponse } from 'next/server';

import { getAllTaskMetadata } from '@/lib/user-data-storage';

// The "Waiting on others" list: tasks Dave marked portal-done (his work is
// finished, but the task can't be closed in Asana yet — awaiting someone else).
// Read straight from the gid-keyed task metadata; the title is the snapshot taken
// when the task was flagged, so the widget renders without an Asana fetch.
// Newest first, so the freshest waits sit at the top.
export async function GET() {
  try {
    const metadata = await getAllTaskMetadata();
    const tasks = Object.entries(metadata)
      .filter(([, m]) => m?.portalDone)
      .map(([gid, m]) => ({
        gid,
        integrationId: m.integrationId,
        title: m.portalDoneTitle || 'Task',
        portalDoneAt: m.portalDoneAt ?? m.updatedAt,
      }))
      .sort((a, b) => (b.portalDoneAt ?? '').localeCompare(a.portalDoneAt ?? ''));
    return NextResponse.json({ tasks });
  } catch (error) {
    console.error('Error fetching waiting-on-others tasks:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch waiting tasks' },
      { status: 500 }
    );
  }
}
