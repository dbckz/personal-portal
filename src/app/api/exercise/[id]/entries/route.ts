import { NextRequest, NextResponse } from 'next/server';

import { addSessionEntry } from '@/lib/storage/exercise';
import { parseLoad, parseVolume } from '@/lib/exercise-parse';
import { prewarmProgramme } from '@/lib/exercise-prewarm';

// POST /api/exercise/:id/entries — add an exercise to a session in progress.
// Volume and load come in as the same shorthand used in the training log
// ("3*8", "27kg") and are parsed here.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

    const volumeText = typeof body.volumeText === 'string' ? body.volumeText.trim() : '';
    const loadText = typeof body.loadText === 'string' ? body.loadText.trim() : '';

    const result = await addSessionEntry(id, {
      name,
      ...parseVolume(volumeText),
      ...parseLoad(loadText),
      ...(volumeText ? { volumeText } : {}),
      ...(loadText ? { loadText } : {}),
      ...(body.notes ? { notes: String(body.notes).trim() } : {}),
      done: body.done ?? true,
    });
    if (!result) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

    // Logging an exercise changes history — a backdated entry moves today's
    // programme hash. Pre-generate so the next Today open doesn't wait on Claude
    // (a no-op via hash dedup + cache hit when today's inputs are unchanged).
    void prewarmProgramme().catch(error =>
      console.error('Failed to pre-warm exercise programme:', error)
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error adding exercise entry:', error);
    return NextResponse.json({ error: 'Failed to add the exercise' }, { status: 500 });
  }
}
