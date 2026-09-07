import { planBoardDateMove, canChangeCardDate } from '@/lib/board-move';
import type { AdHocTask, BoardCard, ScheduledAsanaTask } from '@/types';
import type { PrepBlock } from '@/lib/storage/core';

const sched = (over: Partial<ScheduledAsanaTask>): ScheduledAsanaTask => ({
  id: 's1',
  asanaTaskId: 'g1',
  integrationId: 'om',
  scheduledDate: '2026-08-17',
  scheduledTime: '09:00',
  duration: 45,
  ...over,
});

const adhoc = (over: Partial<AdHocTask>): AdHocTask => ({
  id: 'a1',
  title: 'Todo',
  completed: false,
  priority: 'medium',
  taskType: 'focus',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  ...over,
});

const prep = (over: Partial<PrepBlock>): PrepBlock => ({
  id: 'p1',
  googleEventId: 'evp',
  googleIntegrationId: 'g',
  meetingEventId: 'm1',
  meetingTitle: 'Sync',
  meetingStart: '2026-08-18T10:00:00Z',
  date: '2026-08-17',
  start: '09:00',
  durationMinutes: 30,
  done: false,
  createdAt: '2026-08-01T00:00:00Z',
  ...over,
});

const noStores = { scheduledAsanaTasks: [], adHocTasks: [], prepBlocks: [] };

describe('planBoardDateMove', () => {
  it('moves a single scheduled Asana entry by its sched: key', () => {
    const plan = planBoardDateMove({
      key: 'sched:s1',
      scheduledAsanaTasks: [sched({ id: 's1' })],
      adHocTasks: [],
      prepBlocks: [],
    });
    expect(plan).toEqual({ movable: true, scheduledIds: ['s1'], adhocIds: [], prepIds: [] });
  });

  it('moves a single ad-hoc task by its adhoc: key', () => {
    const plan = planBoardDateMove({
      key: 'adhoc:a1',
      scheduledAsanaTasks: [],
      adHocTasks: [adhoc({ id: 'a1' })],
      prepBlocks: [],
    });
    expect(plan).toEqual({ movable: true, scheduledIds: [], adhocIds: ['a1'], prepIds: [] });
  });

  it('moves every member of a grouped block (scheduled + ad-hoc) sharing the event', () => {
    const plan = planBoardDateMove({
      key: 'block:evg',
      scheduledAsanaTasks: [
        sched({ id: 's1', googleEventId: 'evg' }),
        sched({ id: 's2', googleEventId: 'evg' }),
        sched({ id: 's3', googleEventId: 'other' }),
      ],
      adHocTasks: [adhoc({ id: 'a1', googleEventId: 'evg' })],
      prepBlocks: [],
    });
    expect(plan.movable).toBe(true);
    expect(plan.scheduledIds).toEqual(['s1', 's2']);
    expect(plan.adhocIds).toEqual(['a1']);
    expect(plan.prepIds).toEqual([]);
  });

  it('moves a prep block by its block: event key', () => {
    const plan = planBoardDateMove({
      key: 'block:evp',
      scheduledAsanaTasks: [],
      adHocTasks: [],
      prepBlocks: [prep({ id: 'p1', googleEventId: 'evp' })],
    });
    expect(plan).toEqual({ movable: true, scheduledIds: [], adhocIds: [], prepIds: ['p1'] });
  });

  it('is not movable for a ritual block (no dated task/prep record for its event)', () => {
    const plan = planBoardDateMove({ key: 'block:evr', ...noStores });
    expect(plan.movable).toBe(false);
  });

  it('is not movable for a pinned Asana card (state-only)', () => {
    const plan = planBoardDateMove({ key: 'asana:g9', ...noStores });
    expect(plan.movable).toBe(false);
  });

  it('is not movable when the sched/adhoc record is missing', () => {
    expect(planBoardDateMove({ key: 'sched:gone', ...noStores }).movable).toBe(false);
    expect(planBoardDateMove({ key: 'adhoc:gone', ...noStores }).movable).toBe(false);
  });
});

describe('canChangeCardDate', () => {
  const card = (over: Partial<BoardCard>): BoardCard => ({
    key: 'sched:s1',
    stateKey: 'sched:s1',
    source: 'task',
    title: 'T',
    status: 'todo',
    statusSource: 'derived',
    members: [],
    ...over,
  });

  it('offers the action for task, group and prep cards', () => {
    expect(canChangeCardDate(card({ source: 'task', key: 'sched:s1' }))).toBe(true);
    expect(canChangeCardDate(card({ source: 'group', key: 'block:evg' }))).toBe(true);
    expect(canChangeCardDate(card({ source: 'prep', key: 'block:evp' }))).toBe(true);
    expect(canChangeCardDate(card({ source: 'unplanned', key: 'adhoc:a1' }))).toBe(true);
  });

  it('hides the action for rituals and pinned Asana cards', () => {
    expect(canChangeCardDate(card({ source: 'ritual', key: 'block:evr' }))).toBe(false);
    expect(canChangeCardDate(card({ source: 'unplanned', key: 'asana:g9' }))).toBe(false);
  });
});
