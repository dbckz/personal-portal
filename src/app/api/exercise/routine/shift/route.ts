import { NextRequest, NextResponse } from 'next/server';
import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';

import { getAllSessions, updateSession } from '@/lib/storage/exercise';
import { pushPlannedSession } from '@/lib/exercise-calendar';
import { getWeeklyRoutine } from '@/lib/storage/weekly-routine';
import { getRoutineOverrides, setRoutineOverride } from '@/lib/storage/routine-overrides';
import { routineDayForDate } from '@/lib/exercise-routine-day';
import { prewarmProgramme } from '@/lib/exercise-prewarm';
import type { ExerciseSession, RoutineOverride, WeeklyRoutineDay } from '@/types/life';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/exercise/routine/shift { from: 'yyyy-MM-dd', until: 'yyyy-MM-dd' }
//
// Push the training plan one day later across [from, until]: `from` becomes a
// rest day, each day's plan slides onto the next day, and the plan that was on
// `until` lands on `until + 1` (which must currently be a rest day with nothing
// planned). The move is recorded two ways so the calendar sync doesn't undo it:
//   - per-date routine overrides make each shifted date follow the routine entry
//     it now carries (or rest), so a resync keeps the new shape (see
//     lib/storage/routine-overrides);
//   - the dated planned sessions are re-dated and their Google all-day events
//     dragged with them (pushPlannedSession).
// Sessions already started (logged exercises) or completed are left where they
// are and reported back, since moving a done day would rewrite history.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const from = typeof body.from === 'string' ? body.from : '';
    const until = typeof body.until === 'string' ? body.until : '';

    if (!DATE_KEY.test(from) || !DATE_KEY.test(until)) {
      return NextResponse.json(
        { error: 'from and until are required (yyyy-MM-dd)' },
        { status: 400 }
      );
    }
    const span = differenceInCalendarDays(parseISO(until), parseISO(from));
    if (span < 0) {
      return NextResponse.json({ error: 'from must be on or before until' }, { status: 400 });
    }
    if (span > 7) {
      return NextResponse.json({ error: 'shift span must be 7 days or fewer' }, { status: 400 });
    }

    const routine = await getWeeklyRoutine();
    const overrides = await getRoutineOverrides();
    const sessions = await getAllSessions();

    const target = format(addDays(parseISO(until), 1), 'yyyy-MM-dd');

    // The day the last plan slides onto must be free: a rest routine day (under
    // the current overrides) with no planned or completed session already there.
    const targetDay = routineDayForDate(routine, overrides, target);
    if (targetDay && !targetDay.rest) {
      return NextResponse.json(
        { error: `Cannot shift: ${target} is not a rest day in the routine` },
        { status: 400 }
      );
    }
    if (sessions.some(s => s.date === target && (s.planned || s.completed))) {
      return NextResponse.json(
        { error: `Cannot shift: ${target} already holds a session` },
        { status: 400 }
      );
    }

    // Resolve the effective routine day for every date in [from, until] BEFORE
    // writing any override — a later date may itself be shifted, so its "current"
    // routine day has to be read while the old overrides still stand.
    const dates: string[] = [];
    for (let d = 0; d <= span; d++) dates.push(format(addDays(parseISO(from), d), 'yyyy-MM-dd'));
    const effectiveDay = new Map<string, WeeklyRoutineDay | undefined>();
    for (const date of dates) effectiveDay.set(date, routineDayForDate(routine, overrides, date));

    // Write the overrides: each date's plan moves onto the next day, so date+1
    // follows what date used to be; `from` itself becomes a rest day.
    let latest = overrides;
    for (const date of dates) {
      const next = format(addDays(parseISO(date), 1), 'yyyy-MM-dd');
      const day = effectiveDay.get(date);
      const override: RoutineOverride =
        !day || day.rest ? { rest: true } : { dayOfWeek: day.dayOfWeek };
      latest = await setRoutineOverride(next, override);
    }
    latest = await setRoutineOverride(from, { rest: true });

    // Move the dated sessions from `until` down to `from` (reverse order, so a day
    // is vacated before the day behind it slides in). Only untouched plans move;
    // started/completed sessions stay put and are reported.
    const moved: Array<{ id: string; from: string; to: string; label: string }> = [];
    const skipped: Array<{ id: string; date: string; label: string; reason: string }> = [];
    const byDate = new Map<string, ExerciseSession[]>();
    for (const s of sessions) {
      const list = byDate.get(s.date);
      if (list) list.push(s);
      else byDate.set(s.date, [s]);
    }

    for (let d = span; d >= 0; d--) {
      const date = dates[d];
      const next = format(addDays(parseISO(date), 1), 'yyyy-MM-dd');
      for (const session of byDate.get(date) ?? []) {
        const untouched =
          session.planned && !session.completed && (session.exercises?.length ?? 0) === 0;
        if (!untouched) {
          if (session.completed || (session.exercises?.length ?? 0) > 0) {
            skipped.push({
              id: session.id,
              date,
              label: session.label ?? session.type,
              reason: session.completed ? 'completed' : 'started',
            });
          }
          continue;
        }
        const updated = await updateSession(session.id, { date: next });
        if (!updated) continue;
        if (updated.googleEventId) {
          try {
            await pushPlannedSession(updated);
          } catch (error) {
            console.error('Failed to push shifted session to the calendar:', error);
          }
        }
        moved.push({ id: session.id, from: date, to: next, label: updated.label ?? updated.type });
      }
    }

    // The shift reshapes today's programme inputs — pre-generate in the background
    // so the next Today open doesn't wait on Claude.
    void prewarmProgramme().catch(error =>
      console.error('Failed to pre-warm exercise programme:', error)
    );

    return NextResponse.json({ moved, skipped, overrides: latest });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to shift the plan';
    console.error('Error shifting the plan:', error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
