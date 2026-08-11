import { NextRequest, NextResponse } from 'next/server';

import { resolveTaskOwner } from '@/lib/asana-orchestrator';
import { addDraftComment, getDelegationEntry } from '@/lib/user-data-storage';

// Orchestrator-scoped draft-comment route for the headless delegation runner
// (via the calendar-asana MCP server's draft_comment tool). A delegated run must
// NEVER post to Asana, so instead of writing a story it stores the comment
// LOCALLY on the task's delegation entry, where Dave reviews, edits, and either
// posts or discards it. Nothing is written to Asana here.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ gid: string }> }
) {
  try {
    const { gid } = await params;
    const { text } = await request.json();
    const comment = typeof text === 'string' ? text.trim() : '';

    if (!comment) {
      return NextResponse.json(
        { error: 'text must be a non-empty string' },
        { status: 400 }
      );
    }

    // A run implies an entry exists; use its integrationId. If somehow there is
    // no entry, resolve the owning workspace so the skeleton entry is created
    // with the right integrationId rather than losing the draft.
    const existing = await getDelegationEntry(gid);
    let integrationId = existing?.integrationId;
    if (!integrationId) {
      const resolved = await resolveTaskOwner(gid);
      integrationId = resolved?.integration.id ?? '';
    }

    const draft = await addDraftComment(gid, integrationId, comment);

    return NextResponse.json({ draft });
  } catch (error) {
    console.error('[orchestrator/asana] Error saving draft comment:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save draft comment' },
      { status: 500 }
    );
  }
}
