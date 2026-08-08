/**
 * Evidence-based quota + block-size calibration over the durable weekly records:
 * a persistently under-completed quota is suggested down, a maxed one up, and the
 * block length that finished work actually got is surfaced — all gated on enough
 * history so one bad week never moves a suggestion.
 */
import { calibrateQuotas } from '@/lib/quota-calibration';
import type { WeeklyStatsRecord, WeeklyTaskOutcome, WeeklyTaskOutcomeKind } from '@/types';

interface TaskSpec {
  category: string;
  outcome: WeeklyTaskOutcomeKind;
  scheduledMinutes?: number;
  count?: number; // shorthand for repeating the same spec
}

let idSeq = 0;
function week(weekStart: string, specs: TaskSpec[]): WeeklyStatsRecord {
  const tasks: Record<string, WeeklyTaskOutcome> = {};
  for (const s of specs) {
    for (let i = 0; i < (s.count ?? 1); i++) {
      const taskId = `t${idSeq++}`;
      tasks[taskId] = {
        taskId,
        category: s.category,
        scheduledAt: `${weekStart}T09:00:00.000Z`,
        outcome: s.outcome,
        ...(s.scheduledMinutes != null ? { scheduledMinutes: s.scheduledMinutes } : {}),
      };
    }
  }
  return { weekStart, createdAt: '', updatedAt: '', tasks, integrations: {} };
}

function records(...weeks: WeeklyStatsRecord[]): Record<string, WeeklyStatsRecord> {
  return Object.fromEntries(weeks.map(w => [w.weekStart, w]));
}

beforeEach(() => {
  idSeq = 0;
});

describe('quota suggestions', () => {
  it('suggests one fewer when a full quota is persistently under-completed', () => {
    // Writing quota 5, schedules all 5 each week, finishes 2 → 40% over 4 weeks.
    const recs = records(
      week('2026-07-06', [{ category: 'Writing', outcome: 'done', count: 2 }, { category: 'Writing', outcome: 'carried', count: 3 }]),
      week('2026-07-13', [{ category: 'Writing', outcome: 'done', count: 2 }, { category: 'Writing', outcome: 'carried', count: 3 }]),
      week('2026-07-20', [{ category: 'Writing', outcome: 'done', count: 2 }, { category: 'Writing', outcome: 'carried', count: 3 }]),
      week('2026-07-27', [{ category: 'Writing', outcome: 'done', count: 2 }, { category: 'Writing', outcome: 'carried', count: 3 }])
    );
    const cal = calibrateQuotas(recs, { Writing: 5 });
    expect(cal.Writing.weeksOfData).toBe(4);
    expect(cal.Writing.avgCompletionRate).toBeCloseTo(0.4);
    expect(cal.Writing.suggestedQuota).toBe(4);
    expect(cal.Writing.reason).toContain('40%');
    expect(cal.Writing.reason).toContain('4/wk instead of 5');
  });

  it('never suggests below 1', () => {
    const w = (ws: string) => week(ws, [{ category: 'Blogs', outcome: 'carried' }]);
    const recs = records(w('2026-07-06'), w('2026-07-13'), w('2026-07-20'));
    const cal = calibrateQuotas(recs, { Blogs: 1 });
    expect(cal.Blogs.suggestedQuota).toBe(1);
  });

  it('suggests one more when a full quota runs maxed out', () => {
    const w = (ws: string) => week(ws, [{ category: 'Blogs', outcome: 'done', count: 2 }]);
    const recs = records(w('2026-07-06'), w('2026-07-13'), w('2026-07-20'));
    const cal = calibrateQuotas(recs, { Blogs: 2 });
    expect(cal.Blogs.avgCompletionRate).toBeCloseTo(1);
    expect(cal.Blogs.suggestedQuota).toBe(3);
    expect(cal.Blogs.reason).toContain('room for 3/wk');
  });

  it('makes no suggestion with fewer than three weeks of data', () => {
    const w = (ws: string) => week(ws, [{ category: 'Writing', outcome: 'carried', count: 5 }]);
    const cal = calibrateQuotas(records(w('2026-07-13'), w('2026-07-20')), { Writing: 5 });
    expect(cal.Writing.weeksOfData).toBe(2);
    expect(cal.Writing.suggestedQuota).toBeUndefined();
    expect(cal.Writing.reason).toBeUndefined();
  });

  it('does not blame the quota when the category was barely scheduled', () => {
    // Only 1 of a quota-5 scheduled each week: the work isn't being planned, so
    // low completion is not over-scheduling — no downward suggestion.
    const w = (ws: string) => week(ws, [{ category: 'Writing', outcome: 'carried' }]);
    const cal = calibrateQuotas(records(w('2026-07-06'), w('2026-07-13'), w('2026-07-20')), {
      Writing: 5,
    });
    expect(cal.Writing.suggestedQuota).toBeUndefined();
  });

  it('makes no quota suggestion for a no-quota category', () => {
    const w = (ws: string) => week(ws, [{ category: 'General', outcome: 'carried', count: 4 }]);
    const cal = calibrateQuotas(records(w('2026-07-06'), w('2026-07-13'), w('2026-07-20')), {
      General: 0,
    });
    expect(cal.General.suggestedQuota).toBeUndefined();
  });
});

describe('block-size suggestions', () => {
  it('suggests the median length of done tasks, snapped to a standard block', () => {
    const recs = records(
      week('2026-07-20', [
        { category: 'Writing', outcome: 'done', scheduledMinutes: 60 },
        { category: 'Writing', outcome: 'done', scheduledMinutes: 60 },
        { category: 'Writing', outcome: 'done', scheduledMinutes: 60 },
        { category: 'Writing', outcome: 'done', scheduledMinutes: 90 },
        { category: 'Writing', outcome: 'carried', scheduledMinutes: 30 },
      ])
    );
    const cal = calibrateQuotas(recs, { Writing: 3 });
    expect(cal.Writing.blockSamples).toBe(5);
    expect(cal.Writing.suggestedBlockMinutes).toBe(60);
    expect(cal.Writing.blockReason).toContain('60m');
  });

  it('snaps a non-standard median to the nearest option', () => {
    // Done minutes 50,50,50,50,50 → median 50 → nearest of {45,60} is 45.
    const recs = records(
      week('2026-07-20', [{ category: 'Writing', outcome: 'done', scheduledMinutes: 50, count: 5 }])
    );
    const cal = calibrateQuotas(recs, { Writing: 3 });
    expect(cal.Writing.suggestedBlockMinutes).toBe(45);
  });

  it('gives no block hint below five terminal samples', () => {
    const recs = records(
      week('2026-07-20', [{ category: 'Writing', outcome: 'done', scheduledMinutes: 60, count: 4 }])
    );
    const cal = calibrateQuotas(recs, { Writing: 3 });
    expect(cal.Writing.blockSamples).toBe(4);
    expect(cal.Writing.suggestedBlockMinutes).toBeUndefined();
  });

  it('ignores tasks with no recorded block length (old records)', () => {
    const recs = records(
      week('2026-07-20', [
        { category: 'Writing', outcome: 'done', count: 5 }, // no scheduledMinutes
        { category: 'Writing', outcome: 'done', scheduledMinutes: 90, count: 5 },
      ])
    );
    const cal = calibrateQuotas(recs, { Writing: 3 });
    expect(cal.Writing.blockSamples).toBe(5);
    expect(cal.Writing.suggestedBlockMinutes).toBe(90);
  });

  it('gives no block hint when nothing terminal was ever done', () => {
    const recs = records(
      week('2026-07-20', [{ category: 'Writing', outcome: 'carried', scheduledMinutes: 60, count: 6 }])
    );
    const cal = calibrateQuotas(recs, { Writing: 3 });
    expect(cal.Writing.blockSamples).toBe(6);
    expect(cal.Writing.suggestedBlockMinutes).toBeUndefined();
  });
});

describe('window selection', () => {
  it('excludes the current (in-progress) week and any later week', () => {
    const recs = records(
      week('2026-07-13', [{ category: 'Writing', outcome: 'done', count: 2 }, { category: 'Writing', outcome: 'carried', count: 3 }]),
      week('2026-07-20', [{ category: 'Writing', outcome: 'done', count: 2 }, { category: 'Writing', outcome: 'carried', count: 3 }]),
      week('2026-07-27', [{ category: 'Writing', outcome: 'done', count: 2 }, { category: 'Writing', outcome: 'carried', count: 3 }]),
      // Current week: partial, all still scheduled — must not drag the rate down.
      week('2026-08-03', [{ category: 'Writing', outcome: 'scheduled', count: 5 }]),
      // A future week (should never happen, but must be ignored regardless).
      week('2026-08-10', [{ category: 'Writing', outcome: 'done', count: 5 }])
    );
    const cal = calibrateQuotas(recs, { Writing: 5 }, { currentWeekStart: '2026-08-03' });
    expect(cal.Writing.weeksOfData).toBe(3);
    expect(cal.Writing.avgCompletionRate).toBeCloseTo(0.4);
  });

  it('weighs at most the last N complete weeks', () => {
    const many = Array.from({ length: 10 }, (_, i) => {
      const day = String(1 + i).padStart(2, '0');
      return week(`2026-06-${day}`, [{ category: 'Writing', outcome: 'done', count: 1 }]);
    });
    const cal = calibrateQuotas(records(...many), { Writing: 1 }, { lookbackWeeks: 8 });
    expect(cal.Writing.weeksOfData).toBe(8);
  });
});

describe('empty inputs', () => {
  it('returns a bare entry for a quota category with no history', () => {
    const cal = calibrateQuotas({}, { Writing: 3 });
    expect(cal.Writing).toMatchObject({
      category: 'Writing',
      weeksOfData: 0,
      avgCompletionRate: 0,
      currentQuota: 3,
      blockSamples: 0,
    });
    expect(cal.Writing.suggestedQuota).toBeUndefined();
    expect(cal.Writing.suggestedBlockMinutes).toBeUndefined();
  });
});
