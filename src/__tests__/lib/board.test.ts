import {
  buildBoardCards,
  filterCardsForDay,
  boardKeyForAsana,
  boardKeyForAdhoc,
  boardKeyForBlock,
  boardKeyForSched,
  asanaTypeLabel,
  weekStartFor,
  WORK_RITUAL_KINDS,
  type BuildBoardCardsInput,
} from '@/lib/board';
import type {
  AdHocTask,
  BoardTaskState,
  CalendarEvent,
  ScheduledAsanaTask,
} from '@/types';
import type { PrepBlock, RitualBlock } from '@/lib/storage/core';

const WEEK = '2026-08-17'; // Monday
// Sun 23 Aug is the week end; Mon 24 Aug is the next week.

function baseInput(over: Partial<BuildBoardCardsInput> = {}): BuildBoardCardsInput {
  return {
    weekStart: WEEK,
    scheduledAsanaTasks: [],
    adHocTasks: [],
    ritualBlocks: [],
    prepBlocks: [],
    states: {},
    asanaTasks: [],
    metadataByGid: {},
    weeklyOutcomes: {},
    blockDoneEventIds: new Set<string>(),
    customTypes: [],
    ...over,
  };
}

let seq = 0;
function scheduled(over: Partial<ScheduledAsanaTask>): ScheduledAsanaTask {
  return {
    id: `s-${seq++}`,
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
    id: `r-${seq++}`,
    googleEventId: `re-${seq}`,
    googleIntegrationId: 'g',
    title: '📧 Emails',
    date: '2026-08-18',
    start: '16:00',
    durationMinutes: 30,
    createdAt: '2026-08-17T00:00:00.000Z',
    ...over,
  };
}

function prep(over: Partial<PrepBlock>): PrepBlock {
  return {
    id: `p-${seq++}`,
    googleEventId: `pe-${seq}`,
    googleIntegrationId: 'g',
    meetingEventId: 'm1',
    meetingTitle: 'Board sync',
    meetingStart: '2026-08-19T14:00:00.000Z',
    date: '2026-08-19',
    start: '12:00',
    durationMinutes: 30,
    done: false,
    createdAt: '2026-08-17T00:00:00.000Z',
    ...over,
  };
}

describe('key helpers', () => {
  it('build the documented key shapes', () => {
    expect(boardKeyForAsana('123')).toBe('asana:123');
    expect(boardKeyForAdhoc('abc')).toBe('adhoc:abc');
    expect(boardKeyForBlock('ev9')).toBe('block:ev9');
    expect(boardKeyForSched('s9')).toBe('sched:s9');
  });
});

describe('WORK_RITUAL_KINDS', () => {
  it('includes the work rituals and excludes the furniture', () => {
    expect(WORK_RITUAL_KINDS.has('emails')).toBe(true);
    expect(WORK_RITUAL_KINDS.has('reading')).toBe(true);
    expect(WORK_RITUAL_KINDS.has('lunch')).toBe(false);
    expect(WORK_RITUAL_KINDS.has('exercise')).toBe(false);
    expect(WORK_RITUAL_KINDS.has('newBookies')).toBe(false);
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
        customFields: [{ gid: '1', name: 'Type', displayValue: 'Blogs', type: 'enum' }],
      })
    ).toBe('Blogs');
    expect(asanaTypeLabel({ customFields: [] })).toBeUndefined();
    expect(asanaTypeLabel({})).toBeUndefined();
  });
});

describe('buildBoardCards — single-task blocks', () => {
  it('makes one task card per calendar block, keyed by the event id', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [scheduled({ googleEventId: 'ev1' })],
        asanaTasks: [asanaEvent({})],
      })
    );
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.key).toBe('block:ev1');
    expect(card.source).toBe('task');
    expect(card.title).toBe('Write the report');
    expect(card.date).toBe('2026-08-18');
    expect(card.start).toBe('09:00');
    expect(card.durationMinutes).toBe(60);
    expect(card.members).toHaveLength(1);
    expect(card.members[0].gid).toBe('g1');
  });

  it('keys a block-less scheduled entry as sched:<id>', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [scheduled({ id: 's7', googleEventId: undefined })],
        asanaTasks: [asanaEvent({})],
      })
    );
    expect(cards[0].key).toBe('sched:s7');
    expect(cards[0].source).toBe('task');
  });

  it('prefers the scheduled entry category, then live Asana Type, for the type label', () => {
    const withCategory = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [scheduled({ googleEventId: 'ev1', category: 'Blogs' })],
        asanaTasks: [
          asanaEvent({
            customFields: [{ gid: '1', name: 'Type', displayValue: 'Writing/Deep Work', type: 'enum' }],
            projects: [{ gid: 'p', name: 'Q3 Report' }],
            dueOn: '2026-08-25',
          }),
        ],
      })
    );
    expect(withCategory[0].typeLabel).toBe('Blogs');
    expect(withCategory[0].typeEmoji).toBe('📝');
    expect(withCategory[0].projectName).toBe('Q3 Report');
    expect(withCategory[0].dueOn).toBe('2026-08-25');

    const withoutCategory = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [scheduled({ googleEventId: 'ev1' })],
        asanaTasks: [
          asanaEvent({
            customFields: [{ gid: '1', name: 'Type', displayValue: 'Writing/Deep Work', type: 'enum' }],
          }),
        ],
      })
    );
    expect(withoutCategory[0].typeLabel).toBe('Writing/Deep Work');
    expect(withoutCategory[0].typeEmoji).toBe('✍️');
  });

  it('excludes a block scheduled outside the week and includes both boundaries', () => {
    expect(
      buildBoardCards(
        baseInput({
          scheduledAsanaTasks: [scheduled({ scheduledDate: '2026-08-24', googleEventId: 'ev1' })],
          asanaTasks: [asanaEvent({})],
        })
      )
    ).toHaveLength(0);

    const boundaries = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [
          scheduled({ asanaTaskId: 'mon', scheduledDate: '2026-08-17', googleEventId: 'evMon' }),
          scheduled({ asanaTaskId: 'sun', scheduledDate: '2026-08-23', googleEventId: 'evSun' }),
        ],
        asanaTasks: [asanaEvent({ id: 'mon' }), asanaEvent({ id: 'sun' })],
      })
    );
    expect(boundaries.map(c => c.key).sort()).toEqual(['block:evMon', 'block:evSun']);
  });
});

describe('buildBoardCards — grouped blocks', () => {
  it('collapses several members sharing an event id into one group card', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [
          scheduled({ id: 's1', asanaTaskId: 'g1', googleEventId: 'ev1', category: 'Engagement/Outreach' }),
          scheduled({ id: 's2', asanaTaskId: 'g2', googleEventId: 'ev1', category: 'Engagement/Outreach' }),
        ],
        asanaTasks: [
          asanaEvent({ id: 'g1', title: 'Email the funder' }),
          asanaEvent({ id: 'g2', title: 'Call the partner' }),
        ],
      })
    );
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.source).toBe('group');
    expect(card.key).toBe('block:ev1');
    expect(card.title).toBe('🤝 Engagement/Outreach');
    expect(card.typeLabel).toBe('Engagement/Outreach');
    expect(card.members.map(m => m.title).sort()).toEqual(['Call the partner', 'Email the funder']);
    // No single-task convenience fields on a group.
    expect(card.gid).toBeUndefined();
  });

  it('includes an ad-hoc task sharing the block as a member', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [scheduled({ asanaTaskId: 'g1', googleEventId: 'ev1', category: 'Batch' })],
        adHocTasks: [adhoc({ id: 'a1', title: 'Tidy the folder', googleEventId: 'ev1' })],
        asanaTasks: [asanaEvent({ id: 'g1' })],
      })
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].source).toBe('group');
    expect(cards[0].members).toHaveLength(2);
    // The ad-hoc member is not re-emitted as its own card.
    expect(cards.filter(c => c.key === 'adhoc:a1')).toHaveLength(0);
  });
});

describe('buildBoardCards — ad-hoc tasks', () => {
  it('makes a single-task block card for an ad-hoc with a due date + event id', () => {
    const cards = buildBoardCards(
      baseInput({
        adHocTasks: [adhoc({ dueDate: '2026-08-19', dueTime: '10:00', duration: 45, googleEventId: 'evA' })],
      })
    );
    expect(cards[0].key).toBe('block:evA');
    expect(cards[0].source).toBe('task');
    expect(cards[0].date).toBe('2026-08-19');
    expect(cards[0].start).toBe('10:00');
    expect(cards[0].durationMinutes).toBe(45);
  });

  it('makes a dated (no time) task card for a board-added ad-hoc', () => {
    const cards = buildBoardCards(
      baseInput({ adHocTasks: [adhoc({ dueDate: '2026-08-19' })] })
    );
    expect(cards[0].key).toBe('adhoc:a1');
    expect(cards[0].source).toBe('task');
    expect(cards[0].date).toBe('2026-08-19');
    expect(cards[0].start).toBeUndefined();
  });

  it('shows an unplanned (no due date, incomplete) task every week', () => {
    const cards = buildBoardCards(baseInput({ adHocTasks: [adhoc({ dueDate: undefined })] }));
    expect(cards).toHaveLength(1);
    expect(cards[0].source).toBe('unplanned');
    expect(cards[0].date).toBeUndefined();
    expect(cards[0].priority).toBe('medium');
  });

  it('shows a completed, block-less task only in the week of its state', () => {
    const state: BoardTaskState = {
      key: 'adhoc:a1',
      status: 'done',
      weekStart: WEEK,
      updatedAt: '2026-08-19T00:00:00.000Z',
    };
    const task = adhoc({ completed: true, dueDate: undefined });
    expect(
      buildBoardCards(baseInput({ adHocTasks: [task], states: { 'adhoc:a1': state } }))
    ).toHaveLength(1);
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

  it('derives done for a completed ad-hoc and todo otherwise', () => {
    expect(
      buildBoardCards(baseInput({ adHocTasks: [adhoc({ dueDate: '2026-08-19', completed: true })] }))[0].status
    ).toBe('done');
    expect(
      buildBoardCards(baseInput({ adHocTasks: [adhoc({ dueDate: '2026-08-19' })] }))[0].status
    ).toBe('todo');
  });
});

describe('buildBoardCards — rituals', () => {
  it('makes one card per WORK ritual block (no grouping across days)', () => {
    const cards = buildBoardCards(
      baseInput({
        ritualBlocks: [
          ritual({ googleEventId: 'mon', date: '2026-08-17' }),
          ritual({ googleEventId: 'tue', date: '2026-08-18' }),
        ],
      })
    );
    expect(cards).toHaveLength(2);
    expect(cards.map(c => c.key).sort()).toEqual(['block:mon', 'block:tue']);
    expect(cards[0].source).toBe('ritual');
    expect(cards[0].typeEmoji).toBe('📧');
    expect(cards[0].typeLabel).toBe('Emails');
    expect(cards[0].members).toHaveLength(0);
  });

  it('excludes non-work rituals (lunch, exercise, commute, break)', () => {
    const cards = buildBoardCards(
      baseInput({
        ritualBlocks: [
          ritual({ googleEventId: 'l', title: '🍽️ Lunch' }),
          ritual({ googleEventId: 'e', title: '🏋️ Exercise' }),
          ritual({ googleEventId: 'c', title: '🚇 Commute to office' }),
          ritual({ googleEventId: 'b', title: '☕ Break' }),
          ritual({ googleEventId: 'm', title: '📧 Emails' }),
        ],
      })
    );
    expect(cards.map(c => c.title)).toEqual(['📧 Emails']);
  });

  it('derives done from a block-done override and honours an explicit state', () => {
    expect(
      buildBoardCards(
        baseInput({ ritualBlocks: [ritual({ googleEventId: 'mon' })], blockDoneEventIds: new Set(['mon']) })
      )[0].status
    ).toBe('done');

    const withState = buildBoardCards(
      baseInput({
        ritualBlocks: [ritual({ googleEventId: 'mon' })],
        states: {
          'block:mon': { key: 'block:mon', status: 'in_progress', updatedAt: '2026-08-18T00:00:00.000Z' },
        },
      })
    );
    expect(withState[0].status).toBe('in_progress');
    expect(withState[0].statusSource).toBe('explicit');
  });
});

describe('buildBoardCards — prep', () => {
  it('makes a prep card titled from the meeting', () => {
    const cards = buildBoardCards(baseInput({ prepBlocks: [prep({ googleEventId: 'pe1' })] }));
    expect(cards).toHaveLength(1);
    expect(cards[0].source).toBe('prep');
    expect(cards[0].key).toBe('block:pe1');
    expect(cards[0].title).toBe('📖 Prep: Board sync');
    expect(cards[0].typeLabel).toBe('Meeting prep');
    expect(cards[0].status).toBe('todo');
  });

  it('derives done from the prep done flag', () => {
    const cards = buildBoardCards(baseInput({ prepBlocks: [prep({ googleEventId: 'pe1', done: true })] }));
    expect(cards[0].status).toBe('done');
  });
});

describe('buildBoardCards — pinned Asana (unplanned)', () => {
  it('shows a pinned Asana state with no block, using the snapshot title', () => {
    const cards = buildBoardCards(
      baseInput({
        states: {
          'asana:g9': {
            key: 'asana:g9',
            status: 'todo',
            weekStart: WEEK,
            title: 'Pinned task',
            typeLabel: 'Batch',
            integrationId: 'om',
            updatedAt: '2026-08-18T00:00:00.000Z',
          },
        },
      })
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].source).toBe('unplanned');
    expect(cards[0].key).toBe('asana:g9');
    expect(cards[0].title).toBe('Pinned task');
    expect(cards[0].typeLabel).toBe('Batch');
    expect(cards[0].date).toBeUndefined();
    expect(cards[0].gid).toBe('g9');
  });

  it('does not duplicate a pinned Asana task that also has a block this week', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [scheduled({ asanaTaskId: 'g9', googleEventId: 'ev1' })],
        asanaTasks: [asanaEvent({ id: 'g9' })],
        states: {
          'asana:g9': { key: 'asana:g9', status: 'todo', weekStart: WEEK, updatedAt: '' },
        },
      })
    );
    // Only the block card, not a second pinned card.
    expect(cards).toHaveLength(1);
    expect(cards[0].key).toBe('block:ev1');
  });
});

describe('status derivation', () => {
  const block = (over: Partial<ScheduledAsanaTask> = {}) => ({
    scheduledAsanaTasks: [scheduled({ googleEventId: 'ev1', ...over })],
    asanaTasks: [asanaEvent({})],
  });

  it('all members done → done (from weekly outcomes when dropped from live)', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [scheduled({ googleEventId: 'ev1', taskName: 'Action MU membership' })],
        asanaTasks: [], // dropped from the incomplete-only live fetch
        weeklyOutcomes: { g1: { outcome: 'done', category: 'Batch', title: 'Action MU membership' } },
      })
    );
    expect(cards[0].status).toBe('done');
    expect(cards[0].statusSource).toBe('derived');
    expect(cards[0].members[0].done).toBe(true);
    expect(cards[0].title).toBe('Action MU membership');
    expect(cards[0].typeLabel).toBe('Batch');
  });

  it('blockDone → done', () => {
    const cards = buildBoardCards(baseInput({ ...block(), blockDoneEventIds: new Set(['ev1']) }));
    expect(cards[0].status).toBe('done');
  });

  it('a started weekly outcome → in_progress', () => {
    const cards = buildBoardCards(baseInput({ ...block(), weeklyOutcomes: { g1: { outcome: 'started' } } }));
    expect(cards[0].status).toBe('in_progress');
  });

  it('portal-done metadata → waiting', () => {
    const cards = buildBoardCards(
      baseInput({
        ...block(),
        metadataByGid: { g1: { asanaTaskGid: 'g1', integrationId: 'om', portalDone: true, updatedAt: '' } },
      })
    );
    expect(cards[0].status).toBe('waiting');
    expect(cards[0].members[0].portalDone).toBe(true);
  });

  it('a group is waiting when a portal-done member sits among otherwise-done members', () => {
    const cards = buildBoardCards(
      baseInput({
        scheduledAsanaTasks: [
          scheduled({ id: 's1', asanaTaskId: 'g1', googleEventId: 'ev1', category: 'Batch' }),
          scheduled({ id: 's2', asanaTaskId: 'g2', googleEventId: 'ev1', category: 'Batch' }),
        ],
        asanaTasks: [asanaEvent({ id: 'g1' })], // g2 dropped (done); g1 portal-done
        weeklyOutcomes: { g2: { outcome: 'done' } },
        metadataByGid: { g1: { asanaTaskGid: 'g1', integrationId: 'om', portalDone: true, updatedAt: '' } },
      })
    );
    expect(cards[0].source).toBe('group');
    expect(cards[0].status).toBe('waiting');
  });

  it('lets an explicit state win over the derived status', () => {
    const cards = buildBoardCards(
      baseInput({
        ...block(),
        weeklyOutcomes: { g1: { outcome: 'started' } }, // would derive in_progress
        states: {
          'block:ev1': { key: 'block:ev1', status: 'done', updatedAt: '2026-08-18T00:00:00.000Z' },
        },
      })
    );
    expect(cards[0].status).toBe('done');
    expect(cards[0].statusSource).toBe('explicit');
  });
});

describe('ordering and filtering', () => {
  it('orders by date then start, undated last, then title', () => {
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
