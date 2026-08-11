import { NextRequest, NextResponse } from 'next/server';

import { addTaskComment } from '@/lib/asana';
import { commentToAsanaHtmlText, looksLikeAsanaHtmlText } from '@/lib/asana-rich-text';
import { resolveTaskOwner, describeIntegrations } from '@/lib/asana-orchestrator';
import { getEnabledAsanaIntegrations } from '@/lib/integration-storage';
import { getDelegationEntry, removeDraftComment } from '@/lib/user-data-storage';

// POST - Post a pending draft comment to Asana, then remove it from the entry.
// This is the ONLY path that writes a delegated run's proposed comment to Asana,
// and it is user-initiated from the review UI (never the runner). The request
// may carry the latest edited `text`; otherwise the stored draft text is used.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ gid: string; draftId: string }> }
) {
  try {
    const { gid, draftId } = await params;

    const entry = await getDelegationEntry(gid);
    const draft = entry?.draftComments?.find(d => d.id === draftId);
    if (!draft) {
      return NextResponse.json({ error: 'Draft comment not found' }, { status: 404 });
    }

    // Prefer an explicit edited body from the client; fall back to stored text.
    const body = await request.json().catch(() => ({}));
    const text = (typeof body?.text === 'string' ? body.text : draft.text).trim();
    if (!text) {
      return NextResponse.json({ error: 'Draft comment is empty' }, { status: 400 });
    }

    const resolved = await resolveTaskOwner(gid);
    if (!resolved) {
      const integrations = await getEnabledAsanaIntegrations();
      return NextResponse.json(
        {
          error:
            `No enabled Asana integration can access task ${gid}. ` +
            `Tried: ${describeIntegrations(integrations)}. ` +
            `Check the owning workspace is connected in Settings.`,
        },
        { status: 404 }
      );
    }

    const { integration, accessToken } = resolved;
    const htmlText = looksLikeAsanaHtmlText(text) ? text : commentToAsanaHtmlText(text);
    await addTaskComment(accessToken, gid, text, htmlText);

    // Only drop the draft once the post succeeded, so a failed post keeps it for
    // a retry rather than losing the text.
    await removeDraftComment(gid, draftId);

    return NextResponse.json({
      success: true,
      integration: { id: integration.id, name: integration.name },
    });
  } catch (error) {
    console.error('Error posting draft comment:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to post draft comment' },
      { status: 500 }
    );
  }
}
