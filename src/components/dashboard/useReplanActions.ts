'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type ReplanAnalyzeResponse, type ReplanConfirmResult, type ReplanAdditionResult, type ReplanBackfillResult, type ReplanTodoCandidate } from '@/lib/api';
import type { ProposedBlock } from '@/lib/scheduling/types';

// Per-missed-row action: reschedule to the proposed slot, or mark done.
export type MoveMode = 'reschedule' | 'done';
// Per-stale-row action: leave untouched, mark done, or dismiss (delete record).
export type StaleMode = 'leave' | 'done' | 'dismiss';
// Per-unplaceable-row action: defer to next week (default), leave unscheduled,
// move into the evening overflow slot (only when one was found), prioritise it
// tomorrow by displacing one of tomorrow's blocks (only when there is one to
// bump), or drop it outright — "I'm not doing this at all": the calendar block
// and the backing Asana task are both deleted.
export type UnplaceableMode = 'defer' | 'leave' | 'overflow' | 'prioritise' | 'drop';
// Per-row action in END-OF-WEEK mode (the last working day and the weekend after
// it): there is no week left to reschedule into, so each unfinished task is
// carried into next week's plan (default), dropped back to the backlog with no
// badge, or marked done. Keyed by block event id for single-task blocks, and by
// `${eventId}::${taskId}` for each member of a grouped block.
//
// A task that has already been carried two or more weeks running gets two extra
// options: 'mustDo' (carry it AND flag it must-do next week) and, when it is
// AI-runnable, 'delegate' (hand it to an agent instead of carrying it).
export type CarryMode = 'carry' | 'backlog' | 'done' | 'mustDo' | 'delegate';

// Per-task key for a grouped carry block's member row.
export const carryTaskKey = (googleEventId: string, taskId: string) =>
  `${googleEventId}::${taskId}`;

// Stable id for a General-Todos candidate (Asana gid or ad-hoc id).
export const todoCandidateKey = (t: Pick<ReplanTodoCandidate, 'gid' | 'adhocId'>) =>
  t.gid ?? t.adhocId ?? '';

// Shared state + confirm logic for the replan "plan view" (moves / stale /
// additions / deletions / unplaceable / kept). Extracted from ReplanWeekModal so
// the daily-review flow can reuse the exact same review + confirm behaviour.
// Resets whenever `data` changes (a fresh analyze).
export function useReplanActions(data: ReplanAnalyzeResponse | null, onApplied?: () => void) {
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [moveMode, setMoveMode] = useState<Record<string, MoveMode>>({});
  const [staleMode, setStaleMode] = useState<Record<string, StaleMode>>({});
  const [unplaceableMode, setUnplaceableMode] = useState<Record<string, UnplaceableMode>>({});
  // For a 'prioritise' unplaceable row: the googleEventId of tomorrow's block the
  // user chose to displace (bump). Keyed by the unplaceable block's googleEventId.
  const [unplaceableVictim, setUnplaceableVictim] = useState<Record<string, string>>({});
  const [carryMode, setCarryMode] = useState<Record<string, CarryMode>>({});
  const [additionIncluded, setAdditionIncluded] = useState<Set<string>>(new Set());
  const [additionResults, setAdditionResults] = useState<Record<string, ReplanAdditionResult>>({});
  const [backfillIncluded, setBackfillIncluded] = useState<Set<string>>(new Set());
  const [backfillResults, setBackfillResults] = useState<Record<string, ReplanBackfillResult>>({});
  // General Todos the user TICKED to fill the free slots. Default empty — his
  // explicit selection is the whole point; the planner never auto-picks todos.
  const [selectedTodoIds, setSelectedTodoIds] = useState<Set<string>>(new Set());
  const [deletionIncluded, setDeletionIncluded] = useState<Set<string>>(new Set());
  // Retired-ritual / mis-placed-new-bookies blocks to remove. Handled server-side
  // exactly like deletions (delete the event + ritual record), so they ride the
  // same confirm payload; kept as a separate selection set for a distinct UI label.
  const [removalIncluded, setRemovalIncluded] = useState<Set<string>>(new Set());
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [results, setResults] = useState<Record<string, ReplanConfirmResult>>({});
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed defaults on each fresh analyze.
  useEffect(() => {
    if (!data) return;
    setIncluded(new Set(data.moves.map(m => m.googleEventId)));
    setMoveMode(Object.fromEntries(data.moves.map(m => [m.googleEventId, 'reschedule' as MoveMode])));
    setStaleMode(Object.fromEntries((data.stale ?? []).map(s => [s.googleEventId, 'leave' as StaleMode])));
    // Default every unplaceable row to "defer to next week" — except at the end
    // of the week, where the only rows left in that section (meeting prep) have
    // nowhere to go but "leave unscheduled".
    const unplaceableDefault: UnplaceableMode = data.endOfWeek ? 'leave' : 'defer';
    setUnplaceableMode(
      Object.fromEntries((data.unplaceable ?? []).map(u => [u.googleEventId, unplaceableDefault]))
    );
    setUnplaceableVictim({});
    // Every end-of-week row defaults to "carry over to next week" — block level
    // for single-task blocks, per incomplete member for grouped ones.
    setCarryMode(
      Object.fromEntries(
        (data.carryBlocks ?? []).flatMap(b =>
          b.tasks.length > 1
            ? b.tasks.filter(t => !t.done).map(t => [carryTaskKey(b.googleEventId, t.id), 'carry' as CarryMode])
            : [[b.googleEventId, 'carry' as CarryMode]]
        )
      )
    );
    setAdditionIncluded(new Set((data.additions ?? []).map(a => a.id)));
    setAdditionResults({});
    setBackfillIncluded(new Set((data.backfill ?? []).map(b => b.id)));
    setBackfillResults({});
    setSelectedTodoIds(new Set()); // nothing ticked by default — the user chooses
    setDeletionIncluded(new Set((data.deletions ?? []).map(d => d.googleEventId)));
    setRemovalIncluded(new Set((data.removals ?? []).map(r => r.googleEventId)));
    setShowUnchanged(false);
    setIsConfirming(false);
    setResults({});
    setDone(false);
    setError(null);
  }, [data]);

  const stale = useMemo(() => data?.stale ?? [], [data]);
  // End-of-week mode: these blocks replace their rows in the moves / couldn't-fit
  // sections with a single carry-over decision each.
  const carryBlocks = useMemo(() => (data?.endOfWeek ? data.carryBlocks ?? [] : []), [data]);
  // Every block folded into a carry card, not just each card's primary: a
  // grouped category's sibling blocks all belong to one card, and none of them
  // should still appear in the moves / couldn't-fit sections.
  const carriedEventIds = useMemo(
    () => new Set(carryBlocks.flatMap(b => b.mergedEventIds ?? [b.googleEventId])),
    [carryBlocks]
  );
  const additions = useMemo(() => data?.additions ?? [], [data]);
  const backfill = useMemo(() => data?.backfill ?? [], [data]);
  const freeSlots = useMemo(() => data?.freeSlots ?? [], [data]);
  const todoCandidates = useMemo(() => data?.todoCandidates ?? [], [data]);

  // Assign the ticked todos to the free slots, earliest slot first, in the order
  // the candidates are listed. More ticks than slots → the surplus stay unassigned
  // (nothing is scheduled for them); fewer → the spare slots stay free. Each pair
  // becomes a task block the confirm creates via the normal backfill path.
  const todoBackfillBlocks = useMemo<ProposedBlock[]>(() => {
    const picked = todoCandidates.filter(t => selectedTodoIds.has(todoCandidateKey(t)));
    return picked.slice(0, freeSlots.length).map((t, i) => {
      const slot = freeSlots[i];
      return {
        id: `todo-${slot.date}-${slot.start}-${todoCandidateKey(t)}`,
        category: t.category,
        task: { gid: t.gid, adhocId: t.adhocId, title: t.title, integrationId: t.integrationId },
        date: slot.date,
        start: slot.start,
        durationMinutes: slot.durationMinutes,
        reason: `${t.category} block — selected to fill free space.`,
      };
    });
  }, [todoCandidates, selectedTodoIds, freeSlots]);
  const deletions = useMemo(() => data?.deletions ?? [], [data]);
  const removals = useMemo(() => data?.removals ?? [], [data]);

  const hasResults =
    Object.keys(results).length > 0 ||
    Object.keys(additionResults).length > 0 ||
    Object.keys(backfillResults).length > 0;

  // Partition the confirm payload from the per-row choices.
  const payload = useMemo(() => {
    const moves: Array<{ googleEventId: string; googleIntegrationId?: string; date: string; start: string; durationMinutes: number }> = [];
    const doneIds: string[] = [];
    const dismissIds: string[] = [];
    const defer: Array<{ taskIds: string[]; googleEventId?: string }> = [];
    const leaveUnscheduled: string[] = [];
    // Unplaceable blocks the user chose to delete outright — the calendar block and
    // the backing Asana task both go, and a 'dropped' outcome is recorded.
    const drop: Array<{ googleEventId: string; googleIntegrationId?: string; taskIds: string[] }> = [];
    const carry: Array<{ blockId?: string; blockIds?: string[]; taskIds: string[]; quiet?: boolean; mustDo?: boolean }> = [];
    const delegate: Array<{ blockId?: string; gid: string; integrationId: string; title?: string }> = [];
    const completeAsana: Array<{ gid: string; integrationId: string }> = [];
    const displace: Array<{
      googleEventId: string;
      googleIntegrationId?: string;
      taskIds: string[];
      mode: 'defer' | 'leave';
      durationMinutes: number; // the victim's own slot length
      priorityDurationMinutes: number; // the prioritised block it must accommodate
    }> = [];
    if (data) {
      for (const m of data.moves) {
        // End-of-week: a missed block's decision is its carry row, not a move.
        if (carriedEventIds.has(m.googleEventId)) continue;
        if (!included.has(m.googleEventId)) continue;
        if (m.reason === 'missed' && moveMode[m.googleEventId] === 'done') {
          doneIds.push(m.googleEventId);
        } else {
          moves.push({
            googleEventId: m.googleEventId,
            googleIntegrationId: m.googleIntegrationId,
            date: m.newDate,
            start: m.newStart,
            durationMinutes: m.durationMinutes,
          });
        }
      }
      for (const s of stale) {
        const mode = staleMode[s.googleEventId];
        if (mode === 'done') doneIds.push(s.googleEventId);
        else if (mode === 'dismiss') dismissIds.push(s.googleEventId);
      }
      // Unplaceable rows: overflow → a move into the evening slot; prioritise →
      // displace tomorrow's chosen victim and move this block into its freed slot;
      // defer → park the tasks; leave → clear any override.
      const tomorrowBlocks = data.tomorrowBlocks ?? [];
      for (const u of data.unplaceable) {
        if (carriedEventIds.has(u.googleEventId)) continue;
        const mode = unplaceableMode[u.googleEventId] ?? 'defer';
        if (mode === 'overflow' && u.overflowOption) {
          moves.push({
            googleEventId: u.googleEventId,
            googleIntegrationId: u.googleIntegrationId,
            date: u.overflowOption.date,
            start: u.overflowOption.start,
            durationMinutes: u.overflowOption.durationMinutes,
          });
        } else if (mode === 'prioritise') {
          // Needs a chosen victim big enough to hold the prioritised block; without
          // one the row is a no-op (nothing queued) so the user is nudged to pick a
          // qualifying block before confirming.
          const victim = tomorrowBlocks.find(t => t.googleEventId === unplaceableVictim[u.googleEventId]);
          if (victim && victim.durationMinutes >= u.durationMinutes) {
            displace.push({
              googleEventId: victim.googleEventId,
              googleIntegrationId: victim.googleIntegrationId,
              taskIds: victim.taskIds,
              mode: 'defer',
              durationMinutes: victim.durationMinutes,
              priorityDurationMinutes: u.durationMinutes,
            });
            // The prioritised block takes the victim's freed slot tomorrow.
            moves.push({
              googleEventId: u.googleEventId,
              googleIntegrationId: u.googleIntegrationId,
              date: victim.date,
              start: victim.start,
              durationMinutes: u.durationMinutes,
            });
          }
        } else if (mode === 'drop') {
          drop.push({
            googleEventId: u.googleEventId,
            googleIntegrationId: u.googleIntegrationId,
            taskIds: u.deferTaskIds ?? [],
          });
        } else if (mode === 'leave') {
          leaveUnscheduled.push(u.googleEventId);
        } else {
          defer.push({ taskIds: u.deferTaskIds ?? [], googleEventId: u.googleEventId });
        }
      }
      // End-of-week carry rows. A grouped block asks per incomplete member; a
      // single-task block asks once. "Mark done" completes an Asana-backed task
      // in Asana, and marks the whole block done for planning once nothing
      // incomplete is left on it.
      for (const b of carryBlocks) {
        const incomplete = b.tasks.filter(t => !t.done);
        if (incomplete.length === 0) continue;
        const grouped = b.tasks.length > 1;
        const modeFor = (taskId: string) =>
          (grouped ? carryMode[carryTaskKey(b.googleEventId, taskId)] : carryMode[b.googleEventId]) ??
          'carry';
        const carryIds = incomplete.filter(t => modeFor(t.id) === 'carry').map(t => t.id);
        const mustDoIds = incomplete.filter(t => modeFor(t.id) === 'mustDo').map(t => t.id);
        const backlogIds = incomplete.filter(t => modeFor(t.id) === 'backlog').map(t => t.id);
        const doneTasks = incomplete.filter(t => modeFor(t.id) === 'done');
        // Delegated tasks go to an agent, so they are deliberately absent from
        // every carry entry — next-week Dave is not doing them.
        const delegateTasks = incomplete.filter(
          t => modeFor(t.id) === 'delegate' && t.gid && t.integrationId
        );
        const blockIds = b.mergedEventIds ?? [b.googleEventId];
        if (carryIds.length > 0)
          carry.push({ blockId: b.googleEventId, blockIds, taskIds: carryIds });
        if (mustDoIds.length > 0)
          carry.push({ blockId: b.googleEventId, blockIds, taskIds: mustDoIds, mustDo: true });
        if (backlogIds.length > 0)
          carry.push({ blockId: b.googleEventId, blockIds, taskIds: backlogIds, quiet: true });
        for (const t of delegateTasks) {
          delegate.push({
            blockId: b.googleEventId,
            gid: t.gid!,
            integrationId: t.integrationId!,
            title: t.title,
          });
        }
        for (const t of doneTasks) {
          if (t.gid && t.integrationId) completeAsana.push({ gid: t.gid, integrationId: t.integrationId });
        }
        // Nothing incomplete left once these are done → every block behind the
        // card reads done (a merged card covers several sibling blocks).
        if (doneTasks.length === incomplete.length) {
          doneIds.push(...(b.mergedEventIds ?? [b.googleEventId]));
        }
      }
    }
    const additionBlocks = additions.filter(a => additionIncluded.has(a.id));
    // Auto-backfill blocks the user kept, plus the todo blocks he assigned to the
    // free slots — both ride the same task-block confirm path.
    const backfillBlocks = [...backfill.filter(b => backfillIncluded.has(b.id)), ...todoBackfillBlocks];
    // Removals are applied via the same server path as deletions (delete the event
    // + its ritual record), so they are folded into the deletion payload.
    const deletionBlocks = [
      ...deletions.filter(d => deletionIncluded.has(d.googleEventId)),
      ...removals.filter(r => removalIncluded.has(r.googleEventId)),
    ].map(d => ({ googleEventId: d.googleEventId, googleIntegrationId: d.googleIntegrationId }));
    return { moves, doneIds, dismissIds, defer, leaveUnscheduled, drop, carry, delegate, completeAsana, displace, additionBlocks, backfillBlocks, deletionBlocks };
  }, [data, included, moveMode, stale, staleMode, unplaceableMode, unplaceableVictim, carryBlocks, carriedEventIds, carryMode, additions, additionIncluded, backfill, backfillIncluded, todoBackfillBlocks, deletions, deletionIncluded, removals, removalIncluded]);

  const actionCount =
    payload.moves.length +
    payload.doneIds.length +
    payload.dismissIds.length +
    payload.defer.length +
    payload.leaveUnscheduled.length +
    payload.drop.length +
    payload.carry.length +
    payload.delegate.length +
    payload.completeAsana.length +
    payload.displace.length +
    payload.additionBlocks.length +
    payload.backfillBlocks.length +
    payload.deletionBlocks.length;

  const toggle = useCallback((id: string) =>
    setIncluded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }), []);

  const toggleAddition = useCallback((id: string) =>
    setAdditionIncluded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }), []);

  const toggleBackfill = useCallback((id: string) =>
    setBackfillIncluded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }), []);

  const toggleTodo = useCallback((id: string) =>
    setSelectedTodoIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }), []);

  const toggleDeletion = useCallback((id: string) =>
    setDeletionIncluded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }), []);

  const toggleRemoval = useCallback((id: string) =>
    setRemovalIncluded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }), []);

  const confirm = useCallback(async () => {
    if (!data || actionCount === 0) return;
    setIsConfirming(true);
    setError(null);
    try {
      const { results: res, doneResults, deferResults, carryResults, displaceResults, dropResults, additionResults: addRes, backfillResults: bfRes } = await api.confirmReplan(
        payload.moves,
        payload.doneIds,
        payload.dismissIds,
        payload.additionBlocks,
        payload.deletionBlocks,
        undefined,
        payload.completeAsana.length > 0 ? payload.completeAsana : undefined,
        payload.defer,
        payload.leaveUnscheduled,
        undefined,
        payload.displace,
        payload.carry.length > 0 ? payload.carry : undefined,
        undefined, // started — daily-review only
        undefined, // replacements — daily-review only
        payload.delegate.length > 0 ? payload.delegate : undefined,
        payload.drop.length > 0 ? payload.drop : undefined,
        payload.backfillBlocks.length > 0 ? payload.backfillBlocks : undefined
      );
      const map: Record<string, ReplanConfirmResult> = {};
      for (const r of [...res, ...doneResults]) map[r.googleEventId] = r;
      // Fold defer / leave results (which carry an optional googleEventId) into
      // the same per-row map so unplaceable rows can show a status icon.
      for (const r of deferResults ?? []) {
        if (r.googleEventId) map[r.googleEventId] = { googleEventId: r.googleEventId, success: r.success, error: r.error };
      }
      // Fold carry results in so each end-of-week row shows a status icon. A
      // block with both a carried and a backlogged member reports the worst of
      // the two, so a failure is never hidden by a later success.
      for (const r of carryResults ?? []) {
        if (!r.blockId) continue;
        const prev = map[r.blockId];
        if (prev && !prev.success) continue;
        map[r.blockId] = { googleEventId: r.blockId, success: r.success, error: r.error };
      }
      // Fold displaced-victim results in too, so a bumped tomorrow block shows a
      // status icon on its picker row.
      for (const r of displaceResults ?? []) {
        map[r.googleEventId] = { googleEventId: r.googleEventId, success: r.success, error: r.error };
      }
      // Fold drop results in so a deleted unplaceable row shows a status icon.
      for (const r of dropResults ?? []) {
        map[r.googleEventId] = { googleEventId: r.googleEventId, success: r.success, error: r.error };
      }
      setResults(map);
      const addMap: Record<string, ReplanAdditionResult> = {};
      for (const r of addRes ?? []) addMap[r.id] = r;
      setAdditionResults(addMap);
      const bfMap: Record<string, ReplanBackfillResult> = {};
      for (const r of bfRes ?? []) bfMap[r.id] = r;
      setBackfillResults(bfMap);
      if ([...res, ...doneResults, ...(deferResults ?? []), ...(carryResults ?? []), ...(displaceResults ?? []), ...(dropResults ?? []), ...(addRes ?? []), ...(bfRes ?? [])].some(r => r.success)) onApplied?.();
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply changes');
    } finally {
      setIsConfirming(false);
    }
  }, [data, actionCount, payload, onApplied]);

  return {
    // per-row selection state
    included,
    moveMode,
    setMoveMode,
    staleMode,
    setStaleMode,
    unplaceableMode,
    setUnplaceableMode,
    unplaceableVictim,
    setUnplaceableVictim,
    carryBlocks,
    carriedEventIds,
    carryMode,
    setCarryMode,
    additionIncluded,
    additionResults,
    backfill,
    backfillIncluded,
    backfillResults,
    // Free space remaining: the slots, the todo pool, the user's ticks, and the
    // resulting slot assignments (for status + display).
    freeSlots,
    todoCandidates,
    selectedTodoIds,
    toggleTodo,
    todoBackfillBlocks,
    deletionIncluded,
    removalIncluded,
    showUnchanged,
    setShowUnchanged,
    toggle,
    toggleAddition,
    toggleBackfill,
    toggleDeletion,
    toggleRemoval,
    // results / status
    results,
    hasResults,
    actionCount,
    isConfirming,
    done,
    error,
    confirm,
  };
}

export type ReplanActions = ReturnType<typeof useReplanActions>;
