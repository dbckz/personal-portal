// Pure view-model builder for the weekly task board.
//
// The board shows every task that touches a week — scheduled Asana tasks,
// ad-hoc tasks and daily/weekly rituals — as a card in one of four status
// columns (To start / In progress / Waiting / Done). This module is I/O-free
// and deterministic so the route/hook stay thin and the logic is unit-tested;
// every input is passed in.

import {
  BUILT_IN_TASK_TYPE_EMOJIS,
  BUILT_IN_TASK_TYPE_LABELS,
  isCustomTaskType,
  getCustomTaskTypeId,
} from '@/types';
import type {
  AdHocTask,
  AsanaCustomField,
  BoardCard,
  BoardCardBlock,
  BoardStatus,
  BoardTaskState,
  BuiltInTaskType,
  CalendarEvent,
  CustomTaskType,
  ScheduledAsanaTask,
  TaskMetadata,
} from '@/types';
import type { RitualBlock } from '@/lib/storage/core';
import { categoryEmoji } from '@/lib/scheduling/event-titles';
import { ritualBaseName, ritualCadenceForTitle, ritualKindForTitle } from '@/lib/scheduling/rituals';

// --- Card keys --------------------------------------------------------------

export function boardKeyForAsana(gid: string): string {
  return `asana:${gid}`;
}
export function boardKeyForAdhoc(id: string): string {
  return `adhoc:${id}`;
}
// The plain ritual key (no week): groups a ritual's blocks into one card.
export function boardKeyForRitual(title: string): string {
  return `ritual:${ritualBaseName(title)}`;
}
// The ritual STORAGE key: a ritual's status is per week, so the persisted key
// carries the week suffix.
export function boardStateKeyForRitual(title: string, weekStart: string): string {
  return `${boardKeyForRitual(title)}:${weekStart}`;
}

// --- Shared getters ---------------------------------------------------------

// The Asana "Type" custom-field value, or undefined. The single shared reader
// for the field that ~10 call sites look up ad hoc.
export function asanaTypeLabel(task: { customFields?: AsanaCustomField[] }): string | undefined {
  const field = task.customFields?.find(cf => cf.name.toLowerCase() === 'type');
  return field?.displayValue ?? undefined;
}

// Ritual titles whose kind is NOT a task (calendar furniture): excluded.
const NON_TASK_RITUAL_KINDS: ReadonlySet<string> = new Set([
  'getReady',
  'commute',
  'travel',
  'break',
]);

// --- Date helpers (yyyy-MM-dd, timezone-safe on local parts) ----------------

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
// The Monday..Sunday span of a week, inclusive.
function makeInWeek(weekStart: string): (date: string | undefined) => boolean {
  const weekEnd = addDaysStr(weekStart, 6);
  return (date?: string) => !!date && date >= weekStart && date <= weekEnd;
}

// The Monday (yyyy-MM-dd) of the week a date falls in. Accepts a Date or a
// yyyy-MM-dd string (built from local parts so a bare date never drifts across
// a timezone boundary). Mirrors weekStartStrFor in scheduling/week-state.
export function weekStartFor(date: Date | string): string {
  let base: Date;
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split('-').map(Number);
    base = new Date(y, m - 1, d);
  } else {
    base = typeof date === 'string' ? new Date(date) : date;
  }
  // Days since Monday (Sun=0 → 6).
  const dow = (base.getDay() + 6) % 7;
  const monday = new Date(base.getFullYear(), base.getMonth(), base.getDate() - dow);
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

// Leading emoji of a title (e.g. "📧 Emails" → "📧"), or undefined.
function leadingEmoji(title: string): string | undefined {
  const match = title.match(/^\s*([\p{Extended_Pictographic}\u{FE0F}\u{200D}]+)/u);
  return match ? match[1].trim() : undefined;
}

// --- Build ------------------------------------------------------------------

export interface BuildBoardCardsInput {
  weekStart: string; // yyyy-MM-dd Monday
  scheduledAsanaTasks: ScheduledAsanaTask[];
  adHocTasks: AdHocTask[];
  ritualBlocks: RitualBlock[];
  states: Record<string, BoardTaskState>;
  asanaTasks: CalendarEvent[]; // live incomplete Asana tasks (source 'asana')
  metadataByGid: Record<string, TaskMetadata>; // portalDone → waiting
  startedTaskIds: Set<string>; // weekly-stats 'started' → in_progress
  customTypes: CustomTaskType[];
}

function sortBlocks(blocks: BoardCardBlock[]): BoardCardBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.start ?? '').localeCompare(b.start ?? '');
  });
}

function distinctSortedDates(blocks: BoardCardBlock[]): string[] {
  return [...new Set(blocks.map(b => b.date))].sort();
}

function sumMinutes(blocks: BoardCardBlock[]): number {
  return blocks.reduce((total, b) => total + (b.durationMinutes ?? 0), 0);
}

// Explicit state wins; otherwise the source-specific derivation.
function resolveStatus(
  state: BoardTaskState | undefined,
  derived: BoardStatus
): { status: BoardStatus; statusSource: 'explicit' | 'derived' } {
  if (state) return { status: state.status, statusSource: 'explicit' };
  return { status: derived, statusSource: 'derived' };
}

export function buildBoardCards(input: BuildBoardCardsInput): BoardCard[] {
  const {
    weekStart,
    scheduledAsanaTasks,
    adHocTasks,
    ritualBlocks,
    states,
    asanaTasks,
    metadataByGid,
    startedTaskIds,
    customTypes,
  } = input;
  const inWeek = makeInWeek(weekStart);
  const liveByGid = new Map(asanaTasks.map(t => [t.id, t]));
  const cards: BoardCard[] = [];

  // --- Asana: one card per gid, blocks merged from this week's scheduled
  // entries; plus any state pinned to this week with no block. ---
  interface AsanaGroup {
    blocks: BoardCardBlock[];
    taskName?: string;
    integrationId?: string;
  }
  const asanaByGid = new Map<string, AsanaGroup>();
  for (const s of scheduledAsanaTasks) {
    if (!inWeek(s.scheduledDate)) continue;
    const group = asanaByGid.get(s.asanaTaskId) ?? { blocks: [] };
    group.blocks.push({
      date: s.scheduledDate,
      start: s.scheduledTime,
      durationMinutes: s.duration,
      googleEventId: s.googleEventId,
    });
    if (s.taskName && !group.taskName) group.taskName = s.taskName;
    if (s.integrationId && !group.integrationId) group.integrationId = s.integrationId;
    asanaByGid.set(s.asanaTaskId, group);
  }
  // Pinned Asana cards: a state for this week whose task has no block here.
  for (const [k, st] of Object.entries(states)) {
    if (st.weekStart !== weekStart || !k.startsWith('asana:')) continue;
    const gid = k.slice('asana:'.length);
    if (!asanaByGid.has(gid)) {
      asanaByGid.set(gid, { blocks: [], integrationId: st.integrationId });
    }
  }

  for (const [gid, group] of asanaByGid) {
    const key = boardKeyForAsana(gid);
    const stateKey = key;
    const state = states[stateKey];
    const live = liveByGid.get(gid);
    const blocks = sortBlocks(group.blocks);
    const title = live?.title ?? state?.title ?? group.taskName ?? 'Task';
    const typeLabel = (live ? asanaTypeLabel(live) : undefined) ?? state?.typeLabel;
    const meta = metadataByGid[gid];
    const derived: BoardStatus = meta?.portalDone
      ? 'waiting'
      : startedTaskIds.has(gid)
        ? 'in_progress'
        : 'todo';
    cards.push({
      key,
      stateKey,
      source: 'asana',
      title,
      typeLabel,
      typeEmoji: typeLabel ? categoryEmoji(typeLabel) : undefined,
      ...resolveStatus(state, derived),
      recurring: false,
      blocks,
      plannedDates: distinctSortedDates(blocks),
      totalMinutes: sumMinutes(blocks),
      gid,
      integrationId: live?.integrationId ?? state?.integrationId ?? group.integrationId,
      projectName: live?.projects?.[0]?.name,
      dueOn: live?.dueOn,
    });
  }

  // --- Ad-hoc ---
  for (const task of adHocTasks) {
    const key = boardKeyForAdhoc(task.id);
    const stateKey = key;
    const state = states[stateKey];
    const dueInWeek = !!task.dueDate && inWeek(task.dueDate);
    let include = false;
    if (dueInWeek) include = true;
    else if (!task.dueDate && !task.completed) include = true; // unplanned, every week
    else if (task.completed) {
      // A completed task shows only in the week of its state (or, absent a
      // state, the week it was last updated).
      if (state?.weekStart === weekStart) include = true;
      else if (!state && inWeek(task.updatedAt.slice(0, 10))) include = true;
    }
    if (!include) continue;

    const blocks: BoardCardBlock[] = task.dueDate
      ? [
          {
            date: task.dueDate,
            start: task.dueTime,
            durationMinutes: task.duration,
            googleEventId: task.googleEventId,
          },
        ]
      : [];
    const { label, emoji } = adhocTypeDisplay(task, customTypes);
    const derived: BoardStatus = task.completed ? 'done' : 'todo';
    cards.push({
      key,
      stateKey,
      source: 'adhoc',
      title: task.title,
      typeLabel: label,
      typeEmoji: emoji,
      ...resolveStatus(state, derived),
      recurring: false,
      blocks,
      plannedDates: distinctSortedDates(blocks),
      totalMinutes: sumMinutes(blocks),
      adhocId: task.id,
      priority: task.priority,
    });
  }

  // --- Rituals: this week's blocks grouped by base name; furniture excluded. ---
  const ritualGroups = new Map<string, RitualBlock[]>();
  for (const rb of ritualBlocks) {
    if (!inWeek(rb.date)) continue;
    if (NON_TASK_RITUAL_KINDS.has(ritualKindForTitle(rb.title))) continue;
    const base = ritualBaseName(rb.title);
    const list = ritualGroups.get(base) ?? [];
    list.push(rb);
    ritualGroups.set(base, list);
  }
  for (const list of ritualGroups.values()) {
    const first = list[0];
    const title = first.title;
    const key = boardKeyForRitual(title);
    const stateKey = boardStateKeyForRitual(title, weekStart);
    const state = states[stateKey];
    const blocks = sortBlocks(
      list.map(rb => ({
        date: rb.date,
        start: rb.start,
        durationMinutes: rb.durationMinutes,
        googleEventId: rb.googleEventId,
      }))
    );
    cards.push({
      key,
      stateKey,
      source: 'ritual',
      title,
      typeEmoji: leadingEmoji(title),
      ...resolveStatus(state, 'todo'),
      recurring: true,
      cadence: ritualCadenceForTitle(title),
      blocks,
      plannedDates: distinctSortedDates(blocks),
      totalMinutes: sumMinutes(blocks),
    });
  }

  return sortCards(cards);
}

// Type label + emoji for an ad-hoc task's built-in or custom type.
function adhocTypeDisplay(
  task: AdHocTask,
  customTypes: CustomTaskType[]
): { label?: string; emoji?: string } {
  const taskType = task.taskType;
  if (isCustomTaskType(taskType)) {
    const custom = customTypes.find(ct => ct.id === getCustomTaskTypeId(taskType));
    return { label: custom?.label, emoji: custom?.emoji };
  }
  const builtIn = taskType as BuiltInTaskType;
  return {
    label: BUILT_IN_TASK_TYPE_LABELS[builtIn],
    emoji: BUILT_IN_TASK_TYPE_EMOJIS[builtIn],
  };
}

// Order for a column: earliest planned date first, unplanned last, then title.
function sortCards(cards: BoardCard[]): BoardCard[] {
  return [...cards].sort((a, b) => {
    const aDate = a.plannedDates[0];
    const bDate = b.plannedDates[0];
    if (aDate && bDate) {
      if (aDate !== bDate) return aDate < bDate ? -1 : 1;
    } else if (aDate) {
      return -1;
    } else if (bDate) {
      return 1;
    }
    return a.title.localeCompare(b.title);
  });
}

// --- Day filtering ----------------------------------------------------------

// A card matches a day if any planned date equals it; 'unplanned' = no blocks;
// 'all' returns everything.
export function filterCardsForDay(
  cards: BoardCard[],
  day: string | 'all' | 'unplanned'
): BoardCard[] {
  if (day === 'all') return cards;
  if (day === 'unplanned') return cards.filter(c => c.plannedDates.length === 0);
  return cards.filter(c => c.plannedDates.includes(day));
}
