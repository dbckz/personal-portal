/**
 * @jest-environment node
 *
 * The pure routine planner: deciding which planned sessions to create from the
 * standing weekly routine, which future routine-sourced ones to update when the
 * routine changes, and which to remove when a day becomes rest. No I/O, so every
 * rule is exercised directly here.
 */
import {
  planRoutineMaterialisation,
  type RoutineSessionShape,
} from '@/lib/exercise-routine-materialise';
import type { ExerciseSession, WeeklyRoutineDay } from '@/types/life';

// Monday is today throughout, so the fortnight ahead is 2026-08-17…2026-08-30.
const TODAY = '2026-08-17'; // Monday

// A routine mirroring the seeded week: Fri (dayOfWeek 5) is the rest day.
const ROUTINE: WeeklyRoutineDay[] = [
  { dayOfWeek: 1, title: 'Push (chest & arms)', anchors: ['Incline dumbbell press'] },
  { dayOfWeek: 2, title: 'Run + core', anchors: [], staples: ['Dead bug'] },
  { dayOfWeek: 3, title: 'Pull + Legs', anchors: ['Leg press'] },
  { dayOfWeek: 4, title: 'Push (shoulders) + Run', anchors: ['Seated dumbbell shoulder press'] },
  { dayOfWeek: 5, title: 'Rest', anchors: [], rest: true },
  { dayOfWeek: 6, title: 'Parkrun + core', anchors: [], staples: ['Dead bug'] },
  { dayOfWeek: 0, title: 'Pull (back & arms) + legs', anchors: ['Seated cable row'] },
];

function session(over: Partial<ExerciseSession> & Pick<ExerciseSession, 'id' | 'date'>): ExerciseSession {
  return {
    type: 'strength',
    planned: true,
    completed: false,
    source: 'routine',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...over,
  };
}

// Apply a plan's creates back as stored routine sessions, so a second run can be
// checked for idempotency the way the I/O layer would leave the store.
function applyCreates(creates: RoutineSessionShape[]): ExerciseSession[] {
  return creates.map((shape, i) =>
    session({
      id: `made-${i}`,
      date: shape.date,
      type: shape.type,
      label: shape.label,
      components: shape.components,
      ...(shape.targetDistanceKm ? { targetDistanceKm: shape.targetDistanceKm } : {}),
    })
  );
}

describe('planRoutineMaterialisation — create', () => {
  it('materialises every non-rest day in the fortnight when the store is empty', () => {
    const plan = planRoutineMaterialisation(ROUTINE, [], TODAY);
    // 14 days, two of them (Fri 21st and Fri 28th) rest → 12 sessions.
    expect(plan.create).toHaveLength(12);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('derives label/type/components from the routine title, matching the calendar pull', () => {
    const plan = planRoutineMaterialisation(ROUTINE, [], TODAY);
    const tuesday = plan.create.find(s => s.date === '2026-08-18');
    // "Run + core" → a run bolted onto core work, split on '+'.
    expect(tuesday).toMatchObject({
      type: 'strength + cardio',
      label: 'Run + core',
      components: ['Run', 'core'],
    });
    const monday = plan.create.find(s => s.date === '2026-08-17');
    expect(monday).toMatchObject({ type: 'strength', components: ['Push (chest & arms)'] });
  });

  it('never materialises a rest day', () => {
    const plan = planRoutineMaterialisation(ROUTINE, [], TODAY);
    expect(plan.create.some(s => s.date === '2026-08-21')).toBe(false); // Friday rest
    expect(plan.create.some(s => s.date === '2026-08-28')).toBe(false);
  });

  it('skips a date that already holds a session, whoever made it', () => {
    const existing = [
      session({ id: 'cal', date: '2026-08-18', source: 'calendar' }), // hand-made event wins
      session({ id: 'man', date: '2026-08-19', source: 'manual' }),
      session({ id: 'rou', date: '2026-08-20', source: 'routine' }),
      session({ id: 'done', date: '2026-08-22', source: 'manual', planned: false, completed: true }),
    ];
    const plan = planRoutineMaterialisation(ROUTINE, existing, TODAY);
    for (const date of ['2026-08-18', '2026-08-19', '2026-08-20', '2026-08-22']) {
      expect(plan.create.some(s => s.date === date)).toBe(false);
    }
    // The other non-rest days still materialise.
    expect(plan.create.some(s => s.date === '2026-08-17')).toBe(true);
  });

  it('does not look past the horizon', () => {
    const plan = planRoutineMaterialisation(ROUTINE, [], TODAY, 7); // today…+6 → 17th-23rd
    expect(plan.create.every(s => s.date >= '2026-08-17' && s.date <= '2026-08-23')).toBe(true);
  });
});

describe('planRoutineMaterialisation — reconcile', () => {
  // A future routine session whose stored content is stale ("Legs") vs the
  // routine's current Tuesday ("Run + core").
  const staleTuesday = session({
    id: 'tue',
    date: '2026-08-18',
    type: 'strength',
    label: 'Legs',
    components: ['Legs'],
  });

  it('updates a future routine session whose routine title changed', () => {
    const plan = planRoutineMaterialisation(ROUTINE, [staleTuesday], TODAY);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0].sessionId).toBe('tue');
    expect(plan.update[0].shape).toMatchObject({
      type: 'strength + cardio',
      label: 'Run + core',
      components: ['Run', 'core'],
    });
    expect(plan.remove).toEqual([]);
  });

  it('reconciles TODAY when it is unstarted, driving a routine edit into the current day', () => {
    // Today (Monday) is routine "Push (chest & arms)"; the stored session is a
    // stale "Legs" with nothing logged yet — a routine edit must reach it.
    const staleToday = session({ id: 'today', date: TODAY, label: 'Legs', components: ['Legs'] });
    const plan = planRoutineMaterialisation(ROUTINE, [staleToday], TODAY);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0].sessionId).toBe('today');
    expect(plan.update[0].shape).toMatchObject({
      type: 'strength',
      label: 'Push (chest & arms)',
      components: ['Push (chest & arms)'],
    });
  });

  it('reconciles a calendar-sourced session so its event gets retitled', () => {
    // The incident: today's session is source 'calendar' (from a stale event
    // title "Run (4.5 km) + core"); the routine now says Push. It must update.
    const staleCalendar = session({
      id: 'cal',
      date: TODAY,
      source: 'calendar',
      type: 'strength + cardio',
      label: 'Run + core',
      components: ['Run', 'core'],
    });
    const plan = planRoutineMaterialisation(ROUTINE, [staleCalendar], TODAY);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0].sessionId).toBe('cal');
    expect(plan.update[0].shape).toMatchObject({
      label: 'Push (chest & arms)',
      components: ['Push (chest & arms)'],
    });
  });

  it('never touches a completed, started, past, or non-reconcilable session', () => {
    const existing = [
      session({ id: 'past', date: '2026-08-16', label: 'Legs', components: ['Legs'] }), // past
      session({ id: 'done', date: '2026-08-19', label: 'Legs', components: ['Legs'], completed: true }),
      // Started today: a logged exercise means the day is in progress — leave it.
      session({
        id: 'started',
        date: TODAY,
        label: 'Legs',
        components: ['Legs'],
        exercises: [{ id: 'e1', name: 'Leg press', sets: 3, reps: 10, weightKg: 100 }],
      }),
      session({ id: 'man', date: '2026-08-20', source: 'manual', label: 'Legs', components: ['Legs'] }),
    ];
    const plan = planRoutineMaterialisation(ROUTINE, existing, TODAY);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('removes a future routine session whose day became rest', () => {
    const onNowRestDay = session({ id: 'fri', date: '2026-08-21', label: 'Push', components: ['Push'] });
    const plan = planRoutineMaterialisation(ROUTINE, [onNowRestDay], TODAY);
    expect(plan.remove).toEqual(['fri']);
    expect(plan.update).toEqual([]);
  });

  it('leaves a routine session that already matches its day alone', () => {
    const matching = session({
      id: 'tue',
      date: '2026-08-18',
      type: 'strength + cardio',
      label: 'Run + core',
      components: ['Run', 'core'],
    });
    const plan = planRoutineMaterialisation(ROUTINE, [matching], TODAY);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.create.some(s => s.date === '2026-08-18')).toBe(false);
  });
});

describe('planRoutineMaterialisation — idempotency', () => {
  it('produces nothing on a second run once the first run is applied', () => {
    const first = planRoutineMaterialisation(ROUTINE, [], TODAY);
    const stored = applyCreates(first.create);
    const second = planRoutineMaterialisation(ROUTINE, stored, TODAY);
    expect(second.create).toEqual([]);
    expect(second.update).toEqual([]);
    expect(second.remove).toEqual([]);
  });
});
