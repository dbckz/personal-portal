import {
  buildBoardCards,
  filterCardsForDay,
  boardKeyForAsana,
  boardKeyForAdhoc,
  boardKeyForRitual,
  boardStateKeyForRitual,
  asanaTypeLabel,
  weekStartFor,
  type BuildBoardCardsInput,
} from '@/lib/board';
import type {
  AdHocTask,
  BoardTaskState,
  CalendarEvent,
  ScheduledAsanaTask,
} from '@/types';
import type { RitualBlock } from '@/lib/storage/core';

const WEEK = '2026-08-17'; // Monday
// Sun 23 Aug is the week end; Mon 24 Aug is the next week.

function baseInput(over: Partial<BuildBoardCardsInput> = {}): BuildBoardCardsInput {
  return {
    weekStart: WEEK,
    scheduledAsanaTasks: [],
    adHocTasks: [],
    ritualBlocks: [],
    states: {},
    asanaTasks: [],
    metadataByGid: {},
    startedTaskIds: new Set<string>(),
    customTypes: [],
    ...over,
  };
}

function scheduled(over: Partial<ScheduledAsanaTask>): ScheduledAsanaTask {
  return {
    id: `s-${Math.random()}`,
    asanaTaskId: 'g1',
    scheduledDate: '2026-08-18',
    scheduledTime: '09:00',
    duration: 60,
    ...over,
  };
}

function asanaEvent(over: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'g1',
    title: 'Write the report',
    startTime: new Date(),
    endTime: new Date(),
    source: 'asana',
    integrationId: 'om',
    ...over,
  };
}

function adhoc(over: Partial<AdHocTask>): AdHocTask {
  return {
    id: 'a1',
    title: 'Buy milk',
    completed: false,
    priority: 'medium',
    taskType: 'focus',
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    ...over,
  };
}

function ritual(over: Partial<RitualBlock>): RitualBlock {
  return {
    id: `r-${Math.random()}`,
    googleEventId: 'e',
    googleIntegrationId: 'g',
    title: '📧 Emails',
    date: '2026-08-18',
    start: '16:00',
    durationMinutes: 30,
    createdAt: '2026-08-17T00:00:00.000Z',
    ...over,
  };
}

describe('key helpers', () => {
  it('build the documented key shapes', () => {
    expect(boardKeyForAsana('123')).toBe('asana:123');
    expect(boardKeyForAdhoc('abc')).toBe('adhoc:abc');
    expect(boardKeyForRitual('📧 Emails')).toBe('ritual:emails');
    expect(boardStateKeyForRitual('📧 Emails', WEEK)).toBe('ritual:emails:2026-08-17');
  });
});

describe('weekStartFor', () => {
  it('returns the Monday for a string or Date, mid-week or on a Sunday', () => {
    expect(weekStartFor('2026-08-20')).toBe('2026-08-17'); // Thu → Mon
    expect(weekStartFor('2026-08-17')).toBe('2026-08-17'); // Mon → itself
    expect(weekStartFor('2026-08-23')).toBe('2026-08-17'); // Sun → prior Mon
    expect(weekStartFor(new Date(2026, 7, 20))).toBe('2026-08-17');
  });
});

describe('asanaTypeLabel', () => {
  it('reads the Type custom field case-insensitively', () => {
    expect(
      asanaTypeLabel({
        customFields: [
          { gid: '1', name: 'Type', displayValue: 'Blogs', type: 'enum' },
        ],
      })
    ).toBe('Blogs');
    expect(asanaTypeLabel({ customFields: [] })).toBeUndefined();
    expect(asanaTypeLabel({})).toBeUndefined();
  });
});

describe('buildBoardCards — Asana', () => {
  it('merges a multi-block Asana task into one card', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [
          scheduled({ scheduledDate: '2026-08-18', scheduledTime: '09:00', duration: 60 }),
          scheduled({ scheduledDate: '2026-08-20', scheduledTime: '14:00', duration: 30 }),
        ],
        asanaTasks: [asanaEvent({})],
      })
    );
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.key).toBe('asana:g1');
    expect(card.blocks).toHaveLength(2);
    expect(card.plannedDates).toEqual(['2026-08-18', '2026-08-20']);
    expect(card.totalMinutes).toBe(90);
    expect(card.title).toBe('Write the report');
  });

  it('reads the Asana Type field for the card typeLabel', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [scheduled({})],
        asanaTasks: [
          asanaEvent({
            customFields: [{ gid: '1', name: 'Type', displayValue: 'Writing/Deep Work', type: 'enum' }],
            projects: [{ gid: 'p', name: 'Q3 Report' }],
            dueOn: '2026-08-25',
          }),
        ],
      })
    );
    expect(cards[0].typeLabel).toBe('Writing/Deep Work');
    expect(cards[0].typeEmoji).toBe('✍️');
    expect(cards[0].projectName).toBe('Q3 Report');
    expect(cards[0].dueOn).toBe('2026-08-25');
  });

  it('excludes an Asana block scheduled outside the week', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [scheduled({ scheduledDate: '2026-08-24' })], // next Monday
        asanaTasks: [asanaEvent({})],
      })
    );
    expect(cards).toHaveLength(0);
  });

  it('includes the Mon and Sun boundaries', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [
          scheduled({ asanaTaskId: 'mon', scheduledDate: '2026-08-17' }),
          scheduled({ asanaTaskId: 'sun', scheduledDate: '2026-08-23' }),
        ],
        asanaTasks: [asanaEvent({ id: 'mon' }), asanaEvent({ id: 'sun' })],
      })
    );
    expect(cards.map(c => c.key).sort()).toEqual(['asana:mon', 'asana:sun']);
  });

  it('shows a pinned Asana state with no block, using the snapshot title', () => {
    const cards = buildBoardCards(
      baseInput({
        states: {
          'asana:g9': {
            key: 'asana:g9',
            status: 'todo',
            weekStart: WEEK,
            title: 'Pinned task',
            integrationId: 'om',
            updatedAt: '2026-08-18T00:00:00.000Z',
          },
        },
      })
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Pinned task');
    expect(cards[0].blocks).toHaveLength(0);
    expect(cards[0].plannedDates).toEqual([]);
  });

  it('derives status: portalDone → waiting, started → in_progress, else todo', () => {
    const base = { scheduledAsanaTasks: [scheduled({})], asanaTasks: [asanaEvent({})] };
    expect(buildBoardCards(baseInput(base)).find(c => c.gid === 'g1')!.status).toBe('todo');
    expect(
      buildBoardCards(baseInput({ ...base, startedTaskIds: new Set(['g1']) })).find(
        c => c.gid === 'g1'
      )!.status
    ).toBe('in_progress');
    expect(
      buildBoardCards(
        baseInput({
          ...base,
          metadataByGid: {
            g1: { asanaTaskGid: 'g1', integrationId: 'om', portalDone: true, updatedAt: '' },
          },
        })
      ).find(c => c.gid === 'g1')!.status
    ).toBe('waiting');
  });

  it('lets an explicit state win over the derived status', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [scheduled({})],
        asanaTasks: [asanaEvent({})],
        startedTaskIds: new Set(['g1']), // would derive in_progress
        states: {
          'asana:g1': {
            key: 'asana:g1',
            status: 'done',
            updatedAt: '2026-08-18T00:00:00.000Z',
          },
        },
      })
    );
    expect(cards[0].status).toBe('done');
    expect(cards[0].statusSource).toBe('explicit');
  });
});

describe('buildBoardCards — ad-hoc', () => {
  it('shows an unplanned (no due date, incomplete) task every week', () => {
    const cards = buildBoardCards(baseInput({ adHocTasks: [adhoc({ dueDate: undefined })] }));
    expect(cards).toHaveLength(1);
    expect(cards[0].plannedDates).toEqual([]);
    expect(cards[0].priority).toBe('medium');
  });

  it('shows a due-this-week task with its block', () => {
    const cards = buildBoardCards(
      baseInput({ adHocTasks: [adhoc({ dueDate: '2026-08-19', dueTime: '10:00', duration: 45 })] })
    );
    expect(cards[0].blocks).toEqual([
      { date: '2026-08-19', start: '10:00', durationMinutes: 45, googleEventId: undefined },
    ]);
  });

  it('shows a completed task only in the week of its state', () => {
    const state: BoardTaskState = {
      key: 'adhoc:a1',
      status: 'done',
      weekStart: WEEK,
      updatedAt: '2026-08-19T00:00:00.000Z',
    };
    const task = adhoc({ completed: true, dueDate: undefined });
    // In the state's week → shown.
    expect(
      buildBoardCards(baseInput({ adHocTasks: [task], states: { 'adhoc:a1': state } }))
    ).toHaveLength(1);
    // A different week → hidden.
    expect(
      buildBoardCards(
        baseInput({
          weekStart: '2026-08-24',
          adHocTasks: [task],
          states: { 'adhoc:a1': { ...state, weekStart: WEEK } },
        })
      )
    ).toHaveLength(0);
  });

  it('derives done for a completed task and todo otherwise', () => {
    expect(
      buildBoardCards(baseInput({ adHocTasks: [adhoc({ dueDate: '2026-08-19', completed: true })] }))[0]
        .status
    ).toBe('done');
    expect(
      buildBoardCards(baseInput({ adHocTasks: [adhoc({ dueDate: '2026-08-19' })] }))[0].status
    ).toBe('todo');
  });
});

describe('buildBoardCards — rituals', () => {
  it('collapses five daily ritual blocks into one recurring card', () => {
    const days = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'];
    const cards = buildBoardCards(
      baseInput({ ritualBlocks: days.map(date => ritual({ date })) })
    );
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.recurring).toBe(true);
    expect(card.cadence).toBe('daily');
    expect(card.plannedDates).toHaveLength(5);
    expect(card.typeEmoji).toBe('📧');
    expect(card.stateKey).toBe('ritual:emails:2026-08-17');
  });

  it('excludes furniture ritual kinds (commute, break)', () => {
    const cards = buildBoardCards(
      baseInput({
        ritualBlocks: [
          ritual({ title: '🚇 Commute to office' }),
          ritual({ title: '☕ Break' }),
          ritual({ title: '📧 Emails' }),
        ],
      })
    );
    expect(cards.map(c => c.title)).toEqual(['📧 Emails']);
  });

  it('honours an explicit ritual state for the week', () => {
    const cards = buildBoardCards(
      baseInput({
        ritualBlocks: [ritual({})],
        states: {
          'ritual:emails:2026-08-17': {
            key: 'ritual:emails:2026-08-17',
            status: 'done',
            weekStart: WEEK,
            updatedAt: '2026-08-18T00:00:00.000Z',
          },
        },
      })
    );
    expect(cards[0].status).toBe('done');
    expect(cards[0].statusSource).toBe('explicit');
  });
});

describe('ordering and filtering', () => {
  it('orders by earliest planned date, unplanned last, then title', () => {
    const cards = buildBoardCards(
      baseInput({
        adHocTasks: [
          adhoc({ id: 'unplanned', title: 'Zed unplanned', dueDate: undefined }),
          adhoc({ id: 'late', title: 'Later', dueDate: '2026-08-21' }),
          adhoc({ id: 'early', title: 'Earlier', dueDate: '2026-08-18' }),
        ],
      })
    );
    expect(cards.map(c => c.title)).toEqual(['Earlier', 'Later', 'Zed unplanned']);
  });

  it('filterCardsForDay matches a day, unplanned, and all', () => {
    const cards = buildBoardCards(
      baseInput({
        adHocTasks: [
          adhoc({ id: 'planned', title: 'Planned', dueDate: '2026-08-19' }),
          adhoc({ id: 'unplanned', title: 'Unplanned', dueDate: undefined }),
        ],
      })
    );
    expect(filterCardsForDay(cards, 'all')).toHaveLength(2);
    expect(filterCardsForDay(cards, '2026-08-19').map(c => c.title)).toEqual(['Planned']);
    expect(filterCardsForDay(cards, 'unplanned').map(c => c.title)).toEqual(['Unplanned']);
  });
});
