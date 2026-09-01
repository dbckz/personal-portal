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

describe('resolvePrepCandidates - current week only', () => {
  // Prep is confined to the current week (from now onwards): no next-week bleed.
  it('offers a future meeting this week', async () => {
    const meeting = event('m1', 'Roadmap review', '2026-08-12T10:00:00Z');
    const candidates = await resolvePrepCandidates({
      weekEvents: [meeting],
      nowMs: NOW,
      prepBlocks: [],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ title: 'Roadmap review' });
  });

  it('drops a meeting already in the past', async () => {
    const meeting = event('m1', 'Yesterday standup', '2026-08-09T10:00:00Z');
    const candidates = await resolvePrepCandidates({
      weekEvents: [meeting],
      nowMs: NOW,
      prepBlocks: [],
    });
    expect(candidates).toHaveLength(0);
  });

  it('this-week Prep: events dedupe this-week meetings', async () => {
    const meeting = event('m1', 'Roadmap review', '2026-08-12T10:00:00Z');
    const prepEvent = event('p1', '📖 Prep: Roadmap review', '2026-08-11T09:00:00Z');

    const candidates = await resolvePrepCandidates({
      weekEvents: [meeting, prepEvent],
      nowMs: NOW,
      prepBlocks: [],
    });

    expect(candidates.find(c => c.title === 'Roadmap review')).toBeUndefined();
  });

  it('a stored prep block for a this-week meeting suppresses it', async () => {
    const meeting = event('m1', '1:1 Dave & Lacey', '2026-08-12T09:00:00Z');
    const prepEvent = event('p1', '📖 Prep: 1:1 Dave & Lacey', '2026-08-11T10:00:00Z');

    const candidates = await resolvePrepCandidates({
      weekEvents: [meeting, prepEvent],
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
});
