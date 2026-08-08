/**
 * @jest-environment node
 *
 * The timed-event enrichment: reading a session's duration off a same-day timed
 * exercise event on the calendar, without ever creating a session from one. The
 * matching and overwrite rules are pure, so they are exercised directly here.
 */
import { planTimedEnrichments, type TimedExerciseEvent } from '@/lib/exercise-calendar';
import { parseTimedExerciseTitle } from '@/lib/exercise-parse';
import type { ExerciseSession } from '@/types/life';

type Plan = Pick<ExerciseSession, 'id' | 'date' | 'type' | 'durationMinutes' | 'durationSource'>;

function plan(over: Partial<Plan> & Pick<Plan, 'id'>): Plan {
  return { date: '2026-08-10', type: 'strength', ...over };
}

function timed(over: Partial<TimedExerciseEvent> & Pick<TimedExerciseEvent, 'summary'>): TimedExerciseEvent {
  return {
    startDateTime: '2026-08-10T18:00:00+01:00',
    endDateTime: '2026-08-10T19:00:00+01:00',
    ...over,
  };
}

describe('parseTimedExerciseTitle', () => {
  it('recognises a bare gym slot a plan title would be too vague to trust', () => {
    expect(parseTimedExerciseTitle('🏋️ Gym')?.type).toBe('strength');
  });

  it('classifies a timed run as cardio', () => {
    expect(parseTimedExerciseTitle('🏃 Track @Southwark Park')?.type).toBe('run');
  });

  it('ignores anything without an exercise emoji prefix', () => {
    expect(parseTimedExerciseTitle('Gym')).toBeNull();
    expect(parseTimedExerciseTitle('Team standup')).toBeNull();
  });
});

describe('planTimedEnrichments', () => {
  it('fills a blank plan duration from a same-day timed slot', () => {
    const out = planTimedEnrichments([plan({ id: 'a' })], [timed({ summary: '🏋️ Gym' })]);
    expect(out).toEqual([{ sessionId: 'a', durationMinutes: 60 }]);
  });

  it('leaves a duration a human logged alone', () => {
    const out = planTimedEnrichments(
      [plan({ id: 'a', durationMinutes: 45 })], // no durationSource → manual
      [timed({ summary: '🏋️ Gym' })]
    );
    expect(out).toEqual([]);
  });

  it('refreshes a duration a previous calendar sync set', () => {
    const out = planTimedEnrichments(
      [plan({ id: 'a', durationMinutes: 45, durationSource: 'calendar' })],
      [timed({ summary: '🏋️ Gym' })] // now 60 minutes
    );
    expect(out).toEqual([{ sessionId: 'a', durationMinutes: 60 }]);
  });

  it('ignores a timed event with no plan that day', () => {
    const out = planTimedEnrichments(
      [plan({ id: 'a', date: '2026-08-11' })],
      [timed({ summary: '🏋️ Gym' })]
    );
    expect(out).toEqual([]);
  });

  it('ignores a non-exercise timed event', () => {
    const out = planTimedEnrichments([plan({ id: 'a' })], [timed({ summary: 'Dentist' })]);
    expect(out).toEqual([]);
  });

  it('skips an unusable duration (end before start)', () => {
    const out = planTimedEnrichments(
      [plan({ id: 'a' })],
      [timed({ summary: '🏋️ Gym', endDateTime: '2026-08-10T17:00:00+01:00' })]
    );
    expect(out).toEqual([]);
  });

  it('matches by cardio/strength side when two plans share a day', () => {
    const out = planTimedEnrichments(
      [plan({ id: 'lift', type: 'strength' }), plan({ id: 'run', type: 'run' })],
      [timed({ summary: '🏃 Track', endDateTime: '2026-08-10T18:30:00+01:00' })]
    );
    expect(out).toEqual([{ sessionId: 'run', durationMinutes: 30 }]);
  });

  it('gives each plan at most one timed slot', () => {
    const out = planTimedEnrichments(
      [plan({ id: 'a' }), plan({ id: 'b' })],
      [
        timed({ summary: '🏋️ Gym' }),
        timed({ summary: '🏋️ Gym', startDateTime: '2026-08-10T20:00:00+01:00', endDateTime: '2026-08-10T20:30:00+01:00' }),
      ]
    );
    // Two slots, two plans — the second slot lands on the still-free plan.
    expect(out).toEqual([
      { sessionId: 'a', durationMinutes: 60 },
      { sessionId: 'b', durationMinutes: 30 },
    ]);
  });
});
