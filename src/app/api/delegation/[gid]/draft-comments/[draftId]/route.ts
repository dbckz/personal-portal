import { NextRequest, NextResponse } from 'next/server';

import { updateDraftComment, removeDraftComment } from '@/lib/user-data-storage';

// App-facing draft-comment actions for the review UI (DelegationSection). A draft
// is a comment a delegated run proposed but never posted; Dave edits it here
// (PATCH) or throws it away (DELETE). Posting it to Asana lives in ./post.

// PATCH - Edit a pending draft's text.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ gid: string; draftId: string }> }
) {
  try {
    const { gid, draftId } = await params;
    const { text } = await request.json();
    const trimmed = typeof text === 'string' ? text.trim() : '';

    if (!trimmed) {
      return NextResponse.json({ error: 'text must be a non-empty string' }, { status: 400 });
    }

    const draft = await updateDraftComment(gid, draftId, trimmed);
    if (!draft) {
      return NextResponse.json({ error: 'Draft comment not found' }, { status: 404 });
    }
    return NextResponse.json({ draft });
  } catch (error) {
    console.error('Error updating draft comment:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update draft comment' },
      { status: 500 }
    );
  }
}

// DELETE - Discard a pending draft without posting it.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ gid: string; draftId: string }> }
) {
  try {
    const { gid, draftId } = await params;
    const removed = await removeDraftComment(gid, draftId);
    if (!removed) {
      return NextResponse.json({ error: 'Draft comment not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error discarding draft comment:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to discard draft comment' },
      { status: 500 }
    );
  }
}
