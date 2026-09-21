import { NextRequest, NextResponse } from 'next/server';

import {
  deleteRoutine,
  getRoutine,
  getWeeklyRoutine,
  listRoutines,
  saveRoutine,
} from '@/lib/storage/weekly-routine';

// The GET shape shared by every routine endpoint: the active routine's days, its
// name, and every routine name in the library.
async function routineState() {
  const routine = await getWeeklyRoutine();
  const { names, active } = await listRoutines();
  return { routine, active, names };
}

// POST /api/exercise/routine/library { name, days?, copyFrom? } — create or
// replace a named routine. The days come from `days` when given, else a copy of
// the `copyFrom` routine, else a copy of the currently-active routine (the
// "Duplicate as…" default). Creating does NOT activate — editing a non-active
// routine is deliberately possible. Returns the GET shape.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    let days = Array.isArray(body?.days) ? body.days : null;
    if (!days) {
      const copyFrom = typeof body?.copyFrom === 'string' ? body.copyFrom.trim() : '';
      if (copyFrom) {
        const source = await getRoutine(copyFrom);
        if (!source) {
          return NextResponse.json({ error: `Unknown routine: ${copyFrom}` }, { status: 400 });
        }
        days = source;
      } else {
        days = await getWeeklyRoutine();
      }
    }

    await saveRoutine(name, days);
    return NextResponse.json(await routineState());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save routine';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE /api/exercise/routine/library?name=… — remove a named routine. Refuses
// to delete the active one. Returns the GET shape.
export async function DELETE(request: NextRequest) {
  try {
    const name = request.nextUrl.searchParams.get('name')?.trim() ?? '';
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    await deleteRoutine(name);
    return NextResponse.json(await routineState());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete routine';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
