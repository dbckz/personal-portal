import { NextRequest, NextResponse } from 'next/server';

import { loadAsanaProjects } from '@/lib/asana-catalogue';
import { inferGoal } from '@/lib/goal-inference';
import { getAllSessions } from '@/lib/storage/exercise';

// POST /api/goals/infer  { text, sectionId? }
//
// Free text in, a structured goal + progression-plan proposal out. Nothing is
// written: the editor prefills from `proposal` and Dave confirms. `proposal` is
// null when the model is unavailable or returns nothing usable, and the editor
// falls back to the blank manual form.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      return NextResponse.json({ error: 'A goal description is required' }, { status: 400 });
    }

    const [sessions, projects] = await Promise.all([getAllSessions(), loadAsanaProjects()]);

    const proposal = await inferGoal(text, {
      requestedSectionId: typeof body.sectionId === 'string' ? body.sectionId : undefined,
      sessions,
      projects,
    });

    return NextResponse.json({ proposal });
  } catch (error) {
    console.error('Error inferring goal:', error);
    return NextResponse.json({ error: 'Failed to infer goal' }, { status: 500 });
  }
}
