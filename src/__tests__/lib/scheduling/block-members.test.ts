import { resolveBlockMembers, isGroupedBlock } from '@/lib/scheduling/block-members';
import type { AdHocTask, CalendarEvent, ScheduledAsanaTask } from '@/types';

function scheduled(overrides: Partial<ScheduledAsanaTask> = {}): ScheduledAsanaTask {
  return {
    id: 'sched-1',
    asanaTaskId: 'gid-1',
    integrationId: 'int-1',
    scheduledDate: '2026-08-10',
    scheduledTime: '09:00',
    duration: 30,
    googleEventId: 'evt-batch',
    ...overrides,
  };
}

function adhoc(overrides: Partial<AdHocTask> = {}): AdHocTask {
  return {
    id: 'adhoc-1',
    title: 'Ad-hoc thing',
    completed: false,
    priority: 'medium',
    taskType: 'focus',
    dueDate: '2026-08-10',
    dueTime: '09:00',
    googleEventId: 'evt-batch',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function googleEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-batch',
    title: '📦 Batch',
    startTime: new Date('2026-08-10T09:00:00'),
    endTime: new Date('2026-08-10T10:00:00'),
    source: 'google',
    ...overrides,
  };
}

// A lookup over the loaded Asana list (id === gid).
const lookup = (byGid: Record<string, { title: string; completed: boolean; integrationId?: string }>) =>
  (gid: string) => byGid[gid];

describe('resolveBlockMembers', () => {
  it('groups every scheduled Asana task sharing the block event id', () => {
    const tasks = [
      scheduled({ id: 's1', asanaTaskId: 'g1' }),
      scheduled({ id: 's2', asanaTaskId: 'g2', taskName: 'Second' }),
      scheduled({ id: 's3', asanaTaskId: 'g3', googleEventId: 'other-evt' }),
    ];
    // The live list holds only incomplete tasks: g1 is present (not done); g2 has
    // dropped from it (completed) and is treated as done.
    const members = resolveBlockMembers('evt-batch', tasks, [], lookup({
      g1: { title: 'First', completed: false, integrationId: 'int-1' },
    }));

    expect(members.map(m => m.key)).toEqual(['s1', 's2']);
    expect(members[0]).toMatchObject({
      source: 'asana',
      title: 'First',
      done: false,
      taskId: 'g1',
      gid: 'g1',
      scheduleId: 's1',
    });
    expect(members[1]).toMatchObject({ title: 'Second', done: true });
  });

  it('treats a scheduled member absent from the live incomplete list as done, using the captured taskName', () => {
    const members = resolveBlockMembers(
      'evt-batch',
      [scheduled({ id: 's1', asanaTaskId: 'gone', taskName: 'Completed earlier' })],
      [],
      lookup({})
    );
    expect(members[0]).toMatchObject({ title: 'Completed earlier', done: true });
  });

  it('marks a scheduled member present in the live incomplete list as not done', () => {
    const members = resolveBlockMembers(
      'evt-batch',
      [scheduled({ id: 's1', asanaTaskId: 'g1' })],
      [],
      lookup({ g1: { title: 'Still open', completed: false } })
    );
    expect(members[0]).toMatchObject({ title: 'Still open', done: false });
  });

  it('uses the scheduled record integration id, falling back to the live task', () => {
    const withId = resolveBlockMembers('evt-batch', [scheduled({ asanaTaskId: 'g1', integrationId: 'sched-int' })], [], lookup({
      g1: { title: 'x', completed: false, integrationId: 'live-int' },
    }));
    expect(withId[0].integrationId).toBe('sched-int');

    const withoutId = resolveBlockMembers('evt-batch', [scheduled({ asanaTaskId: 'g1', integrationId: undefined })], [], lookup({
      g1: { title: 'x', completed: false, integrationId: 'live-int' },
    }));
    expect(withoutId[0].integrationId).toBe('live-int');
  });

  it('includes ad-hoc tasks carrying the block event id, after the Asana members', () => {
    const members = resolveBlockMembers(
      'evt-batch',
      [scheduled({ id: 's1', asanaTaskId: 'g1' })],
      [adhoc({ id: 'a1', title: 'Ad-hoc', completed: true })],
      lookup({ g1: { title: 'Asana one', completed: false } })
    );
    expect(members.map(m => m.source)).toEqual(['asana', 'adhoc']);
    expect(members[1]).toMatchObject({
      source: 'adhoc',
      title: 'Ad-hoc',
      done: true,
      taskId: 'a1',
      adhocId: 'a1',
    });
  });

  it('returns nothing for an event with no members', () => {
    expect(resolveBlockMembers('evt-empty', [scheduled()], [adhoc()], lookup({}))).toEqual([]);
  });
});

describe('isGroupedBlock', () => {
  it('is true for a Google event backed by two or more member tasks', () => {
    const tasks = [scheduled({ id: 's1', asanaTaskId: 'g1' }), scheduled({ id: 's2', asanaTaskId: 'g2' })];
    expect(isGroupedBlock(googleEvent(), tasks, [])).toBe(true);
  });

  it('counts Asana and ad-hoc members together', () => {
    expect(isGroupedBlock(googleEvent(), [scheduled()], [adhoc({ id: 'a1' })])).toBe(true);
  });

  it('is false for a single-task block', () => {
    expect(isGroupedBlock(googleEvent(), [scheduled()], [])).toBe(false);
  });

  it('is false for a non-Google event', () => {
    const tasks = [scheduled({ id: 's1', asanaTaskId: 'g1' }), scheduled({ id: 's2', asanaTaskId: 'g2' })];
    expect(isGroupedBlock(googleEvent({ source: 'asana' }), tasks, [])).toBe(false);
  });
});
