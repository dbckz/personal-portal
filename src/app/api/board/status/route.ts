import { NextRequest, NextResponse } from 'next/server';

import { upsertBoardTaskState } from '@/lib/user-data-storage';
import { BOARD_COLUMNS, type BoardStatus } from '@/types';

const VALID_STATUSES: ReadonlySet<string> = new Set(BOARD_COLUMNS.map(c => c.id));

// PATCH → upsert one card's board status. Deliberately DUMB: it only persists
// the status snapshot. Side effects that a status change implies (completing an
// Asana task on → Done, flagging portal-done on → Waiting) are performed
// client-side through the existing APIs (see useBoard).
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { stateKey, key, status, weekStart, title, typeLabel, integrationId } = body;

    if (!stateKey || typeof stateKey !== 'string') {
      return NextResponse.json({ error: 'stateKey is required' }, { status: 400 });
    }
    if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
      return NextResponse.json({ error: 'invalid status' }, { status: 400 });
    }

    const state = await upsertBoardTaskState({
      key: stateKey,
      status: status as BoardStatus,
      ...(typeof weekStart === 'string' ? { weekStart } : {}),
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof typeLabel === 'string' ? { typeLabel } : {}),
      ...(typeof integrationId === 'string' ? { integrationId } : {}),
      updatedAt: new Date().toISOString(),
    });
    // `key` (the plain card key) is accepted for client symmetry but not stored
    // separately — the stored record is keyed by stateKey.
    void key;

    return NextResponse.json({ state });
  } catch (error) {
    console.error('Error saving board status:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save board status' },
      { status: 500 }
    );
  }
}
