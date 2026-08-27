// Pure view-model builder for the weekly task board.
//
// The board mirrors the calendar: every app-created WORK block that touches a
// week becomes one card. A single-task block is one card; a grouped block (a
// calendar event holding several Asana / ad-hoc tasks) is one card with its
// member tasks listed underneath. Rituals that are work (emails, kindle notes,
// grooming, retro, delegation review, reading) each get a card; meeting-prep
// blocks get a card; a task with no block this week (a pinned Asana task, or an
// ad-hoc task with no due date) shows as an unplanned card.
//
// This module is I/O-free and deterministic so the route/hook stay thin and the
// logic is unit-tested; every input is passed in.

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
  BoardCardMember,
  BoardStatus,
  BoardTaskState,
  BuiltInTaskType,
  CalendarEvent,
  CustomTaskType,
  ScheduledAsanaTask,
  TaskMetadata,
  WeeklyTaskOutcomeKind,
} from '@/types';
import type { PrepBlock, RitualBlock } from '@/lib/storage/core';
import { categoryBlockTitle, categoryEmoji, prepTitle } from '@/lib/scheduling/event-titles';
import { ritualBaseName, ritualKindForTitle, type RitualKind } from '@/lib/scheduling/rituals';
import { resolveBlockMembers, type BlockMember } from '@/lib/scheduling/block-members';

// --- Card keys --------------------------------------------------------------

// A pinned Asana task (added from the board): stable across weeks, carries a
// weekStart in its state.
export function boardKeyForAsana(gid: string): string {
  return `asana:${gid}`;
}
// An ad-hoc task with no calendar event (board-added, or unplanned).
export function boardKeyForAdhoc(id: string): string {
  return `adhoc:${id}`;
}
// A calendar-backed block, keyed by its Google event id (task / group / ritual /
// prep). Its status is inherently per-occurrence.
export function boardKeyForBlock(googleEventId: string): string {
  return `block:${googleEventId}`;
}
// A scheduled Asana entry with no Google event id yet.
export function boardKeyForSched(scheduleId: string): string {
  return `sched:${scheduleId}`;
}

// --- Shared getters ---------------------------------------------------------

// The Asana "Type" custom-field value, or undefined. The single shared reader
// for the field that ~10 call sites look up ad hoc.
export function asanaTypeLabel(task: { customFields?: AsanaCustomField[] }): string | undefined {
  const field = task.customFields?.find(cf => cf.name.toLowerCase() === 'type');
  return field?.displayValue ?? undefined;
}

// The ritual kinds that count as WORK, so they belong on the board. Everything
// else (lunch, exercise, walk, commute, get-ready, travel, break, new bookies,
// and the retired kinds) is excluded. Flagged here so the set is easy to change.
export const WORK_RITUAL_KINDS: ReadonlySet<RitualKind> = new Set<RitualKind>([
  'emails',
  'kindleNotes',
  'grooming',
  'retro',
  'delegationReview',
  'reading',
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

// "emails" → "Emails" (the bare ritual name, capitalised, for the type chip).
function capitalise(name: string): string {
  return name.length === 0 ? name : name[0].toUpperCase() + name.slice(1);
}

// --- Build ------------------------------------------------------------------

// One task's outcome in this week's WeeklyStatsRecord, keyed by taskId (Asana
// gid or ad-hoc id). Carries the durable title/category snapshot so a card can
// still show its type/title once the task drops out of the live (incomplete-
// only) Asana fetch.
export interface BoardWeeklyOutcome {
  outcome: WeeklyTaskOutcomeKind;
  category?: string;
  title?: string;
}

export interface BuildBoardCardsInput {
  weekStart: string; // yyyy-MM-dd Monday
  scheduledAsanaTasks: ScheduledAsanaTask[];
  adHocTasks: AdHocTask[];
  ritualBlocks: RitualBlock[];
  prepBlocks: PrepBlock[];
  states: Record<string, BoardTaskState>;
  asanaTasks: CalendarEvent[]; // live incomplete Asana tasks (source 'asana')
  metadataByGid: Record<string, TaskMetadata>; // portalDone → waiting
  // This week's weekly-stats outcomes, keyed by taskId (gid or adhoc id).
  weeklyOutcomes: Record<string, BoardWeeklyOutcome>;
  // Google event ids the user marked "done for planning" (blockDoneOverrides).
  blockDoneEventIds: Set<string>;
  customTypes: CustomTaskType[];
}

// The card's rollover badge fields, from its backing dated record. Emitted only
// when the task was rolled to a LATER day than originally planned (i.e. the
// original differs from the card's current date), so the card can be badged
// "from Tue". See src/lib/board-rollover.ts.
function rolloverFields(
  date: string | undefined,
  rec: { originallyPlannedFor?: string; rolls?: number } | undefined
): { originallyPlannedFor?: string; rolls?: number } {
  if (!rec?.originallyPlannedFor || !date || rec.originallyPlannedFor === date) return {};
  return {
    originallyPlannedFor: rec.originallyPlannedFor,
    ...(rec.rolls ? { rolls: rec.rolls } : {}),
  };
}

// Explicit state wins; otherwise the source-specific derivation.
function resolveStatus(
  state: BoardTaskState | undefined,
  derived: BoardStatus
): { status: BoardStatus; statusSource: 'explicit' | 'derived' } {
  if (state) return { status: state.status, statusSource: 'explicit' };
  return { status: derived, statusSource: 'derived' };
}

// The derived status for a card, from its members' facts and the block-done
// overrides. Exported so the hook can recompute a card's status after an
// optimistic member toggle. Explicit state wins upstream; this is the fallback.
export function deriveBoardCardStatus(
  card: Pick<BoardCard, 'source' | 'members' | 'googleEventId'>,
  opts: { blockDoneEventIds: Set<string>; startedTaskIds: Set<string>; prepDone?: boolean }
): BoardStatus {
  const { source, members, googleEventId } = card;
  const blockDone = !!googleEventId && opts.blockDoneEventIds.has(googleEventId);

  if (source === 'ritual') return blockDone ? 'done' : 'todo';
  if (source === 'prep') return opts.prepDone || blockDone ? 'done' : 'todo';

  if (members.length > 0 && members.every(m => m.done)) return 'done';
  if (blockDone) return 'done';
  const nonPortal = members.filter(m => !m.portalDone);
  if (members.some(m => m.portalDone) && nonPortal.every(m => m.done)) return 'waiting';
  if (members.length === 1 && members[0].portalDone) return 'waiting';
  if (members.some(m => opts.startedTaskIds.has(m.gid ?? m.adhocId ?? ''))) return 'in_progress';
  return 'todo';
}

export function buildBoardCards(input: BuildBoardCardsInput): BoardCard[] {
  const {
    weekStart,
    scheduledAsanaTasks,
    adHocTasks,
    ritualBlocks,
    prepBlocks,
    states,
    asanaTasks,
    metadataByGid,
    weeklyOutcomes,
    blockDoneEventIds,
    customTypes,
  } = input;
  const inWeek = makeInWeek(weekStart);
  const liveByGid = new Map(asanaTasks.map(t => [t.id, t]));
  const adhocById = new Map(adHocTasks.map(t => [t.id, t]));
  const portalDoneGids = new Set(
    Object.entries(metadataByGid)
      .filter(([, m]) => m?.portalDone)
      .map(([gid]) => gid)
  );
  const startedTaskIds = new Set(
    Object.entries(weeklyOutcomes)
      .filter(([, o]) => o.outcome === 'started')
      .map(([taskId]) => taskId)
  );
  const lookup = (gid: string) => {
    const live = liveByGid.get(gid);
    return live
      ? { title: live.title, completed: false, integrationId: live.integrationId }
      : undefined;
  };
  const cards: BoardCard[] = [];

  // gids + adhoc ids already shown by a block/sched card, so a pinned Asana state
  // or an unplanned ad-hoc is not duplicated.
  const shownGids = new Set<string>();
  const shownAdhocIds = new Set<string>();

  // Enrich a raw BlockMember with live / snapshot facts.
  const enrich = (base: BlockMember): BoardCardMember => {
    if (base.source === 'asana' && base.gid) {
      const live = liveByGid.get(base.gid);
      const outcome = weeklyOutcomes[base.gid];
      return {
        key: base.key,
        source: 'asana',
        title: live?.title ?? base.title ?? outcome?.title ?? 'Task',
        done: live ? !!live.completed : outcome?.outcome === 'done',
        ...(portalDoneGids.has(base.gid) ? { portalDone: true } : {}),
        gid: base.gid,
        integrationId: base.integrationId ?? live?.integrationId,
        ...(live ? { typeLabel: asanaTypeLabel(live) } : outcome?.category ? { typeLabel: outcome.category } : {}),
        ...(live?.projects?.[0]?.name ? { projectName: live.projects[0].name } : {}),
      };
    }
    const task = base.adhocId ? adhocById.get(base.adhocId) : undefined;
    const display = task ? adhocTypeDisplay(task, customTypes) : {};
    return {
      key: base.key,
      source: 'adhoc',
      title: base.title,
      done: base.done,
      ...(base.adhocId ? { adhocId: base.adhocId } : {}),
      ...(display.label ? { typeLabel: display.label } : {}),
    };
  };

  // --- Calendar-backed blocks (task / group), grouped by Google event id. ---
  // An event id is seeded by any in-week scheduled Asana entry or ad-hoc task
  // carrying it; resolveBlockMembers then gathers all of that block's members.
  const eventIds = new Set<string>();
  for (const s of scheduledAsanaTasks) {
    if (inWeek(s.scheduledDate) && s.googleEventId) eventIds.add(s.googleEventId);
  }
  for (const t of adHocTasks) {
    if (t.googleEventId && !!t.dueDate && inWeek(t.dueDate)) eventIds.add(t.googleEventId);
  }

  for (const eventId of eventIds) {
    const members = resolveBlockMembers(
      eventId,
      scheduledAsanaTasks,
      adHocTasks,
      lookup,
      portalDoneGids
    ).map(enrich);
    if (members.length === 0) continue;
    for (const m of members) {
      if (m.gid) shownGids.add(m.gid);
      if (m.adhocId) shownAdhocIds.add(m.adhocId);
    }

    // Representative timing + category from the block's scheduled entries.
    const entry = scheduledAsanaTasks.find(s => s.googleEventId === eventId);
    const adhocEntry = adHocTasks.find(t => t.googleEventId === eventId);
    const date = entry?.scheduledDate ?? adhocEntry?.dueDate;
    const start = entry?.scheduledTime ?? adhocEntry?.dueTime;
    const durationMinutes = entry?.duration ?? adhocEntry?.duration;
    const category = entry?.category ?? members[0].typeLabel;

    const key = boardKeyForBlock(eventId);
    const state = states[key];
    const isGroup = members.length >= 2;
    const single = members[0];
    const derived = deriveBoardCardStatus(
      { source: isGroup ? 'group' : 'task', members, googleEventId: eventId },
      { blockDoneEventIds, startedTaskIds }
    );

    cards.push({
      key,
      stateKey: key,
      source: isGroup ? 'group' : 'task',
      title: isGroup ? categoryBlockTitle(category ?? 'General Todos') : single.title,
      typeLabel: isGroup ? (category ?? 'General Todos') : (category ?? single.typeLabel),
      typeEmoji: isGroup
        ? categoryEmoji(category ?? 'General Todos')
        : (category ?? single.typeLabel)
          ? categoryEmoji(category ?? single.typeLabel!)
          : undefined,
      ...resolveStatus(state, derived),
      ...(date ? { date } : {}),
      ...rolloverFields(date, entry ?? adhocEntry),
      ...(start ? { start } : {}),
      ...(durationMinutes ? { durationMinutes } : {}),
      googleEventId: eventId,
      members,
      ...(isGroup
        ? {}
        : {
            ...(single.projectName ? { projectName: single.projectName } : {}),
            ...(single.gid ? { gid: single.gid } : {}),
            ...(single.integrationId ? { integrationId: single.integrationId } : {}),
            ...(single.adhocId ? { adhocId: single.adhocId } : {}),
            ...(single.gid && liveByGid.get(single.gid)?.dueOn
              ? { dueOn: liveByGid.get(single.gid)!.dueOn }
              : {}),
            ...(single.adhocId && adhocById.get(single.adhocId)?.priority
              ? { priority: adhocById.get(single.adhocId)!.priority }
              : {}),
          }),
    });
  }

  // --- Scheduled Asana entries with no Google event id → one card each. ---
  for (const s of scheduledAsanaTasks) {
    if (!inWeek(s.scheduledDate) || s.googleEventId) continue;
    const live = liveByGid.get(s.asanaTaskId);
    const outcome = weeklyOutcomes[s.asanaTaskId];
    const member: BoardCardMember = {
      key: s.id,
      source: 'asana',
      title: live?.title ?? s.taskName ?? outcome?.title ?? 'Task',
      done: live ? !!live.completed : outcome?.outcome === 'done',
      ...(portalDoneGids.has(s.asanaTaskId) ? { portalDone: true } : {}),
      gid: s.asanaTaskId,
      integrationId: s.integrationId ?? live?.integrationId,
      ...(live ? { typeLabel: asanaTypeLabel(live) } : outcome?.category ? { typeLabel: outcome.category } : {}),
      ...(live?.projects?.[0]?.name ? { projectName: live.projects[0].name } : {}),
    };
    shownGids.add(s.asanaTaskId);
    const key = boardKeyForSched(s.id);
    const state = states[key];
    const typeLabel = s.category ?? member.typeLabel;
    const derived = deriveBoardCardStatus(
      { source: 'task', members: [member], googleEventId: undefined },
      { blockDoneEventIds, startedTaskIds }
    );
    cards.push({
      key,
      stateKey: key,
      source: 'task',
      title: member.title,
      ...(typeLabel ? { typeLabel, typeEmoji: categoryEmoji(typeLabel) } : {}),
      ...resolveStatus(state, derived),
      date: s.scheduledDate,
      ...rolloverFields(s.scheduledDate, s),
      start: s.scheduledTime,
      durationMinutes: s.duration,
      members: [member],
      ...(member.projectName ? { projectName: member.projectName } : {}),
      gid: s.asanaTaskId,
      ...(member.integrationId ? { integrationId: member.integrationId } : {}),
      ...(live?.dueOn ? { dueOn: live.dueOn } : {}),
    });
  }

  // --- Ad-hoc tasks with no Google event id. ---
  for (const task of adHocTasks) {
    if (task.googleEventId) continue; // handled as a block member above
    if (shownAdhocIds.has(task.id)) continue;
    const key = boardKeyForAdhoc(task.id);
    const state = states[key];
    const dueInWeek = !!task.dueDate && inWeek(task.dueDate);

    let include = false;
    let planned = false; // has a date (board-added / dated) vs unplanned
    if (dueInWeek) {
      include = true;
      planned = true;
    } else if (!task.dueDate && !task.completed) {
      include = true; // unplanned, every week
    } else if (task.completed && !task.dueDate) {
      // A completed, block-less task shows only in the week of its state.
      if (state?.weekStart === weekStart) include = true;
    }
    if (!include) continue;

    const display = adhocTypeDisplay(task, customTypes);
    const member: BoardCardMember = {
      key: task.id,
      source: 'adhoc',
      title: task.title,
      done: task.completed,
      adhocId: task.id,
      ...(display.label ? { typeLabel: display.label } : {}),
    };
    const source = planned ? 'task' : 'unplanned';
    const derived = deriveBoardCardStatus(
      { source, members: [member], googleEventId: undefined },
      { blockDoneEventIds, startedTaskIds }
    );
    cards.push({
      key,
      stateKey: key,
      source,
      title: task.title,
      ...(display.label ? { typeLabel: display.label } : {}),
      ...(display.emoji ? { typeEmoji: display.emoji } : {}),
      ...resolveStatus(state, derived),
      ...(planned && task.dueDate ? { date: task.dueDate } : {}),
      ...(planned ? rolloverFields(task.dueDate, task) : {}),
      ...(planned && task.dueTime ? { start: task.dueTime } : {}),
      ...(planned && task.duration ? { durationMinutes: task.duration } : {}),
      members: [member],
      adhocId: task.id,
      priority: task.priority,
    });
  }

  // --- WORK ritual blocks in the week → one card each (no grouping). ---
  for (const rb of ritualBlocks) {
    if (!inWeek(rb.date)) continue;
    if (!WORK_RITUAL_KINDS.has(ritualKindForTitle(rb.title))) continue;
    const key = boardKeyForBlock(rb.googleEventId);
    const state = states[key];
    const derived = deriveBoardCardStatus(
      { source: 'ritual', members: [], googleEventId: rb.googleEventId },
      { blockDoneEventIds, startedTaskIds }
    );
    cards.push({
      key,
      stateKey: key,
      source: 'ritual',
      title: rb.title,
      typeEmoji: leadingEmoji(rb.title),
      typeLabel: capitalise(ritualBaseName(rb.title)),
      ...resolveStatus(state, derived),
      date: rb.date,
      start: rb.start,
      durationMinutes: rb.durationMinutes,
      googleEventId: rb.googleEventId,
      members: [],
    });
  }

  // --- Meeting-prep blocks in the week → one card each. ---
  for (const pb of prepBlocks) {
    if (!inWeek(pb.date)) continue;
    const key = boardKeyForBlock(pb.googleEventId);
    const state = states[key];
    const derived = deriveBoardCardStatus(
      { source: 'prep', members: [], googleEventId: pb.googleEventId },
      { blockDoneEventIds, startedTaskIds, prepDone: pb.done }
    );
    cards.push({
      key,
      stateKey: key,
      source: 'prep',
      title: prepTitle(pb.meetingTitle),
      typeEmoji: '📖',
      typeLabel: 'Meeting prep',
      ...resolveStatus(state, derived),
      date: pb.date,
      start: pb.start,
      durationMinutes: pb.durationMinutes,
      googleEventId: pb.googleEventId,
      members: [],
    });
  }

  // --- Pinned Asana states (weekStart === W) with no block this week. ---
  for (const [k, st] of Object.entries(states)) {
    if (st.weekStart !== weekStart || !k.startsWith('asana:')) continue;
    const gid = k.slice('asana:'.length);
    if (shownGids.has(gid)) continue;
    const live = liveByGid.get(gid);
    const outcome = weeklyOutcomes[gid];
    const member: BoardCardMember = {
      key: gid,
      source: 'asana',
      title: live?.title ?? st.title ?? outcome?.title ?? 'Task',
      done: live ? !!live.completed : outcome?.outcome === 'done',
      ...(portalDoneGids.has(gid) ? { portalDone: true } : {}),
      gid,
      integrationId: st.integrationId ?? live?.integrationId,
      ...(live ? { typeLabel: asanaTypeLabel(live) } : outcome?.category ? { typeLabel: outcome.category } : st.typeLabel ? { typeLabel: st.typeLabel } : {}),
      ...(live?.projects?.[0]?.name ? { projectName: live.projects[0].name } : {}),
    };
    const typeLabel = member.typeLabel ?? st.typeLabel;
    cards.push({
      key: k,
      stateKey: k,
      source: 'unplanned',
      title: member.title,
      ...(typeLabel ? { typeLabel, typeEmoji: categoryEmoji(typeLabel) } : {}),
      status: st.status,
      statusSource: 'explicit',
      members: [member],
      ...(member.projectName ? { projectName: member.projectName } : {}),
      gid,
      ...(member.integrationId ? { integrationId: member.integrationId } : {}),
      ...(live?.dueOn ? { dueOn: live.dueOn } : {}),
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

// Order for a column: by date then start, undated last, then title.
function sortCards(cards: BoardCard[]): BoardCard[] {
  return [...cards].sort((a, b) => {
    if (a.date && b.date) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const byStart = (a.start ?? '').localeCompare(b.start ?? '');
      if (byStart !== 0) return byStart;
    } else if (a.date) {
      return -1;
    } else if (b.date) {
      return 1;
    }
    return a.title.localeCompare(b.title);
  });
}

// --- Day filtering ----------------------------------------------------------

// A card matches a day if its date equals it; 'unplanned' = no date; 'all'
// returns everything.
export function filterCardsForDay(
  cards: BoardCard[],
  day: string | 'all' | 'unplanned'
): BoardCard[] {
  if (day === 'all') return cards;
  if (day === 'unplanned') return cards.filter(c => !c.date);
  return cards.filter(c => c.date === day);
}
