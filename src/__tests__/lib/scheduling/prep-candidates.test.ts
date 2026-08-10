import { resolvePrepCandidates } from '@/lib/scheduling/prep-candidates';
import type { CalendarEvent } from '@/types';

jest.mock('@/lib/user-data-storage', () => ({
  getMeetingPrepDecisions: jest.fn().mockResolvedValue([]),
  setMeetingPrepDecision: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/prep-classifier', () => {
  const actual = jest.requireActual('@/lib/prep-classifier');
  return { ...actual, classifyPrep: jest.fn().mockResolvedValue([]) };
});
jest.mock('@/lib/classifier-learning', () => ({
  buildExamplesBlock: jest.fn().mockResolvedValue(''),
  isVerdictReusable: jest.fn().mockReturnValue(false),
}));

const NOW = new Date('2026-08-10T08:00:00Z').getTime();
// First working day of the week AFTER the NOW week (Mon 2026-08-17).
const NEXT_MONDAY = '2026-08-17';

function event(id: string, title: string, startIso: string, minutes = 30): CalendarEvent {
  const startTime = new Date(startIso);
  return {
    id,
    title,
    startTime,
    endTime: new Date(startTime.getTime() + minutes * 60_000),
    source: 'google',
  } as CalendarEvent;
}

describe('resolvePrepCandidates cross-week dedupe', () => {
  // The regression from 10 Aug 2026: a prep block placed NEXT week (per-meeting
  // day override put it on the meeting's own day) was invisible to the dedupe,
  // so a wizard re-run scheduled a duplicate prep this week. The meetings here
  // are next-Monday MORNINGS so they still qualify as candidates under the
  // before-noon rule.
  it('drops a next-week meeting whose Prep: event sits in next week', async () => {
    const meeting = event('m1', '1:1 Dave & Lacey', '2026-08-17T09:00:00Z');
    const prepEvent = event('p1', '📖 Prep: 1:1 Dave & Lacey', '2026-08-17T10:00:00Z');

    const candidates = await resolvePrepCandidates({
      weekEvents: [],
      nextWeekEarlyEvents: [meeting, prepEvent],
      nextWeekFirstWorkingDay: NEXT_MONDAY,
      nowMs: NOW,
      prepBlocks: [],
    });

    expect(candidates.find(c => c.title === '1:1 Dave & Lacey')).toBeUndefined();
  });

  it('a stored prep block whose own event lives next week still suppresses', async () => {
    const meeting = event('m1', '1:1 Dave & Lacey', '2026-08-17T09:00:00Z');
    const prepEvent = event('p1', '📖 Prep: 1:1 Dave & Lacey', '2026-08-17T10:00:00Z');

    const candidates = await resolvePrepCandidates({
      weekEvents: [],
      nextWeekEarlyEvents: [meeting, prepEvent],
      nextWeekFirstWorkingDay: NEXT_MONDAY,
      nowMs: NOW,
      prepBlocks: [
        {
          googleEventId: 'p1',
          meetingEventId: 'm1',
          meetingTitle: '1:1 Dave & Lacey',
          done: false,
        } as never,
      ],
    });

    expect(candidates).toHaveLength(0);
  });

  it('still offers a genuinely un-prepped next-week meeting', async () => {
    const meeting = event('m1', '1:1 Dave & Lacey', '2026-08-17T09:00:00Z');

    const candidates = await resolvePrepCandidates({
      weekEvents: [],
      nextWeekEarlyEvents: [meeting],
      nextWeekFirstWorkingDay: NEXT_MONDAY,
      nowMs: NOW,
      prepBlocks: [],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ title: '1:1 Dave & Lacey', nextWeek: true });
  });

  it('this-week Prep: events still dedupe this-week meetings', async () => {
    const meeting = event('m1', 'Roadmap review', '2026-08-12T10:00:00Z');
    const prepEvent = event('p1', '📖 Prep: Roadmap review', '2026-08-11T09:00:00Z');

    const candidates = await resolvePrepCandidates({
      weekEvents: [meeting, prepEvent],
      nextWeekEarlyEvents: [],
      nextWeekFirstWorkingDay: NEXT_MONDAY,
      nowMs: NOW,
      prepBlocks: [],
    });

    expect(candidates.find(c => c.title === 'Roadmap review')).toBeUndefined();
  });
});

describe('resolvePrepCandidates next-week candidacy', () => {
  // Only a meeting on the FIRST working day of next week that starts before noon
  // is worth prepping this week — a later meeting can be prepped on the day by
  // next week's own planning.
  it('does NOT offer an afternoon meeting on the first working day of next week', async () => {
    // 14:30Z = 15:30 BST, after noon either way.
    const meeting = event('m1', '1:1 Dave & Lacey', '2026-08-17T14:30:00Z');

    const candidates = await resolvePrepCandidates({
      weekEvents: [],
      nextWeekEarlyEvents: [meeting],
      nextWeekFirstWorkingDay: NEXT_MONDAY,
      nowMs: NOW,
      prepBlocks: [],
    });

    expect(candidates).toHaveLength(0);
  });

  it('offers a morning meeting on the first working day of next week', async () => {
    const meeting = event('m1', 'Board review', '2026-08-17T09:00:00Z');

    const candidates = await resolvePrepCandidates({
      weekEvents: [],
      nextWeekEarlyEvents: [meeting],
      nextWeekFirstWorkingDay: NEXT_MONDAY,
      nowMs: NOW,
      prepBlocks: [],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ title: 'Board review', nextWeek: true });
  });

  it('does NOT offer a morning meeting on the SECOND working day of next week', async () => {
    // Tuesday 2026-08-18 — past the single-day lookahead, even in the morning.
    const meeting = event('m1', 'Ops standup', '2026-08-18T09:00:00Z');

    const candidates = await resolvePrepCandidates({
      weekEvents: [],
      nextWeekEarlyEvents: [meeting],
      nextWeekFirstWorkingDay: NEXT_MONDAY,
      nowMs: NOW,
      prepBlocks: [],
    });

    expect(candidates).toHaveLength(0);
  });
});
