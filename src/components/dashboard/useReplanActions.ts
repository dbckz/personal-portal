'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type ReplanAnalyzeResponse, type ReplanConfirmResult, type ReplanAdditionResult, type ReplanBackfillResult, type ReplanTodoCandidate } from '@/lib/api';
import type { ProposedBlock } from '@/lib/scheduling/types';

// Per-missed-row action: reschedule to the proposed slot, or mark done.
export type MoveMode = 'reschedule' | 'done';
// Per-stale-row action: leave untouched, mark done, dismiss (delete record), or
// make room — displace a later block that ends before the meeting so the prep
// still fits (only offered while the meeting is still ahead).
export type StaleMode = 'leave' | 'done' | 'dismiss' | 'makeRoom';
// Per-unplaceable-row action: defer to next week (default), leave unscheduled,
// mark done (complete its tasks in Asana), move into the evening overflow slot
// (only when one was found), prioritise it tomorrow by displacing one of
// tomorrow's blocks (only when there is one to bump), make room by displacing a
// chosen block anywhere in the remaining week, or drop it outright — "I'm not
// doing this at all": the calendar block and the backing Asana task are deleted.
export type UnplaceableMode = 'defer' | 'leave' | 'done' | 'doneWaiting' | 'overflow' | 'prioritise' | 'makeRoom' | 'drop';
// Disposition of a displaced block's tasks when making room: defer them to next
// week (default) or leave them unscheduled.
export type MakeRoomDisposition = 'defer' | 'leave';
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

// Per-row action in the end-of-week "Waiting on others" section: complete the
// task in Asana too, leave it waiting (default), or reopen it (needs more work —
// clears the portal-done flag so the planner schedules it again). Keyed by gid.
export type WaitingMode = 'complete' | 'leave' | 'reopen';

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
  // "Make room" selections, keyed by the couldn't-fit / stale-prep block's
  // googleEventId: the chosen victim block to displace, an optional day filter
  // (yyyy-MM-dd) and "before HH:mm" cap narrowing the victim list (unplaceable
  // only — stale rows constrain automatically to before the meeting), and whether
  // the victim's tasks defer to next week (default) or are left unscheduled.
  const [makeRoomVictim, setMakeRoomVictim] = useState<Record<string, string>>({});
  const [makeRoomDay, setMakeRoomDay] = useState<Record<string, string>>({});
  const [makeRoomBefore, setMakeRoomBefore] = useState<Record<string, string>>({});
  const [makeRoomDisposition, setMakeRoomDisposition] = useState<Record<string, MakeRoomDisposition>>({});
  const [carryMode, setCarryMode] = useState<Record<string, CarryMode>>({});
  // End-of-week "Waiting on others" per-row choice, keyed by task gid.
  const [waitingMode, setWaitingMode] = useState<Record<string, WaitingMode>>({});
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
  // Legacy single-task deep-work blocks to convert in place to generic "Deep work"
  // containers. Default all included — pressing Replan should convert this week's
  // already-planned deep-work blocks in one go.
  const [conversionIncluded, setConversionIncluded] = useState<Set<string>>(new Set());
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
    setMakeRoomVictim({});
    setMakeRoomDay({});
    setMakeRoomBefore({});
    setMakeRoomDisposition({});
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
    // Every waiting row defaults to "leave waiting" — no action unless chosen.
    setWaitingMode(
      Object.fromEntries((data.waiting ?? []).map(w => [w.gid, 'leave' as WaitingMode]))
    );
    setAdditionIncluded(new Set((data.additions ?? []).map(a => a.id)));
    setAdditionResults({});
    setBackfillIncluded(new Set((data.backfill ?? []).map(b => b.id)));
    setBackfillResults({});
    setSelectedTodoIds(new Set()); // nothing ticked by default — the user chooses
    setDeletionIncluded(new Set((data.deletions ?? []).map(d => d.googleEventId)));
    setRemovalIncluded(new Set((data.removals ?? []).map(r => r.googleEventId)));
    setConversionIncluded(new Set((data.conversions ?? []).map(c => c.googleEventId)));
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
  // End-of-week "Waiting on others" tasks (portal-done, awaiting someone else).
  const waiting = useMemo(() => (data?.endOfWeek ? data.waiting ?? [] : []), [data]);
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
  const conversions = useMemo(() => data?.conversions ?? [], [data]);

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
    // Portal-done ("waiting on others") flags to set (couldn't-fit "Done (waiting)")
    // and to clear (end-of-week complete / reopen).
    const portalDone: Array<{ gid: string; integrationId: string; title?: string; googleEventId?: string }> = [];
    const clearPortalDone: Array<{ gid: string; integrationId: string; outcome?: 'scheduled' }> = [];
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
      // Victim event ids already claimed by an earlier prioritise / make-room
      // resolution in this batch — a block can only be displaced once.
      const claimedVictims = new Set<string>();
      const moveCandidates = data.moveCandidates ?? [];
      // Displace `victim` and move `item` (a couldn't-fit or stale-prep block) into
      // the freed slot — the prioritise flow generalised. No-op if the victim is
      // gone, too short, or already claimed by another resolution this batch.
      const pushMakeRoom = (
        item: { googleEventId: string; googleIntegrationId?: string; durationMinutes: number },
        victim:
          | {
              googleEventId: string;
              googleIntegrationId?: string;
              taskIds: string[];
              date: string;
              start: string;
              durationMinutes: number;
            }
          | undefined,
        disposition: MakeRoomDisposition
      ) => {
        if (!victim) return;
        if (victim.durationMinutes < item.durationMinutes) return;
        if (claimedVictims.has(victim.googleEventId)) return;
        claimedVictims.add(victim.googleEventId);
        displace.push({
          googleEventId: victim.googleEventId,
          googleIntegrationId: victim.googleIntegrationId,
          taskIds: victim.taskIds,
          mode: disposition,
          durationMinutes: victim.durationMinutes,
          priorityDurationMinutes: item.durationMinutes,
        });
        moves.push({
          googleEventId: item.googleEventId,
          googleIntegrationId: item.googleIntegrationId,
          date: victim.date,
          start: victim.start,
          durationMinutes: item.durationMinutes,
        });
      };

      for (const s of stale) {
        const mode = staleMode[s.googleEventId];
        if (mode === 'done') doneIds.push(s.googleEventId);
        else if (mode === 'dismiss') dismissIds.push(s.googleEventId);
        else if (mode === 'makeRoom') {
          pushMakeRoom(
            s,
            moveCandidates.find(c => c.googleEventId === makeRoomVictim[s.googleEventId]),
            makeRoomDisposition[s.googleEventId] ?? 'defer'
          );
        }
      }
      // Unplaceable rows: done → mark done + complete tasks in Asana; overflow → a
      // move into the evening slot; prioritise → displace tomorrow's chosen victim
      // and move this block into its freed slot; makeRoom → the same over any
      // remaining-week victim; defer → park the tasks; leave → clear any override.
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
        } else if (mode === 'done') {
          // Mark the block done and complete each Asana-backed task in Asana. Both
          // are handled by the existing confirm-route done / completeAsana paths.
          doneIds.push(u.googleEventId);
          for (const t of u.tasks ?? []) {
            if (t.integrationId) completeAsana.push({ gid: t.gid, integrationId: t.integrationId });
          }
        } else if (mode === 'doneWaiting') {
          // Done in the portal only — flag each Asana-backed task portal-done
          // (Asana untouched) and let the confirm route settle the block (it marks
          // the block done for planning via the googleEventId so it stops nagging).
          for (const t of u.tasks ?? []) {
            if (t.integrationId)
              portalDone.push({
                gid: t.gid,
                integrationId: t.integrationId,
                googleEventId: u.googleEventId,
              });
          }
        } else if (mode === 'prioritise') {
          // Needs a chosen victim big enough to hold the prioritised block; without
          // one the row is a no-op (nothing queued) so the user is nudged to pick a
          // qualifying block before confirming.
          pushMakeRoom(
            u,
            tomorrowBlocks.find(t => t.googleEventId === unplaceableVictim[u.googleEventId]),
            'defer'
          );
        } else if (mode === 'makeRoom') {
          pushMakeRoom(
            u,
            moveCandidates.find(c => c.googleEventId === makeRoomVictim[u.googleEventId]),
            makeRoomDisposition[u.googleEventId] ?? 'defer'
          );
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
      // End-of-week "Waiting on others" rows. Complete → finish it in Asana too
      // (records 'done') and clear the flag; reopen → clear the flag and record
      // 'scheduled' so it schedules again; leave → nothing.
      for (const w of waiting) {
        const mode = waitingMode[w.gid] ?? 'leave';
        if (mode === 'complete') {
          completeAsana.push({ gid: w.gid, integrationId: w.integrationId });
          clearPortalDone.push({ gid: w.gid, integrationId: w.integrationId });
        } else if (mode === 'reopen') {
          clearPortalDone.push({ gid: w.gid, integrationId: w.integrationId, outcome: 'scheduled' });
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
    // Legacy deep-work blocks the user kept ticked, converted in place to generic
    // "Deep work" containers (event retitled + re-described, membership recorded).
    const conversionBlocks = conversions.filter(c => conversionIncluded.has(c.googleEventId));
    return { moves, doneIds, dismissIds, defer, leaveUnscheduled, drop, carry, delegate, completeAsana, portalDone, clearPortalDone, displace, additionBlocks, backfillBlocks, deletionBlocks, conversionBlocks };
  }, [data, included, moveMode, stale, staleMode, unplaceableMode, unplaceableVictim, makeRoomVictim, makeRoomDisposition, carryBlocks, carriedEventIds, carryMode, waiting, waitingMode, additions, additionIncluded, backfill, backfillIncluded, todoBackfillBlocks, deletions, deletionIncluded, removals, removalIncluded, conversions, conversionIncluded]);

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
    payload.portalDone.length +
    payload.clearPortalDone.length +
    payload.displace.length +
    payload.additionBlocks.length +
    payload.backfillBlocks.length +
    payload.deletionBlocks.length +
    payload.conversionBlocks.length;

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

  const toggleConversion = useCallback((id: string) =>
    setConversionIncluded(prev => {
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
      const { results: res, doneResults, deferResults, carryResults, displaceResults, dropResults, portalDoneResults, clearPortalDoneResults, additionResults: addRes, backfillResults: bfRes, conversionResults: convRes } = await api.confirmReplan(
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
        payload.backfillBlocks.length > 0 ? payload.backfillBlocks : undefined,
        payload.conversionBlocks.length > 0 ? payload.conversionBlocks : undefined,
        payload.portalDone.length > 0 ? payload.portalDone : undefined,
        payload.clearPortalDone.length > 0 ? payload.clearPortalDone : undefined
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
      // Portal-done "Done (waiting)" rows show status on their couldn't-fit block
      // (keyed by event id); the end-of-week "Waiting on others" rows key by gid.
      for (const r of portalDoneResults ?? []) {
        if (r.googleEventId) map[r.googleEventId] = { googleEventId: r.googleEventId, success: r.success, error: r.error };
      }
      for (const r of clearPortalDoneResults ?? []) {
        map[r.gid] = { googleEventId: r.gid, success: r.success, error: r.error };
      }
      // Fold conversion results in so a converted deep-work row shows a status icon.
      for (const r of convRes ?? []) {
        map[r.googleEventId] = { googleEventId: r.googleEventId, success: r.success, error: r.error };
      }
      setResults(map);
      const addMap: Record<string, ReplanAdditionResult> = {};
      for (const r of addRes ?? []) addMap[r.id] = r;
      setAdditionResults(addMap);
      const bfMap: Record<string, ReplanBackfillResult> = {};
      for (const r of bfRes ?? []) bfMap[r.id] = r;
      setBackfillResults(bfMap);
      if ([...res, ...doneResults, ...(deferResults ?? []), ...(carryResults ?? []), ...(displaceResults ?? []), ...(dropResults ?? []), ...(portalDoneResults ?? []), ...(clearPortalDoneResults ?? []), ...(addRes ?? []), ...(bfRes ?? []), ...(convRes ?? [])].some(r => r.success)) onApplied?.();
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
    makeRoomVictim,
    setMakeRoomVictim,
    makeRoomDay,
    setMakeRoomDay,
    makeRoomBefore,
    setMakeRoomBefore,
    makeRoomDisposition,
    setMakeRoomDisposition,
    moveCandidates: data?.moveCandidates ?? [],
    carryBlocks,
    carriedEventIds,
    carryMode,
    setCarryMode,
    waiting,
    waitingMode,
    setWaitingMode,
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
    conversions,
    conversionIncluded,
    showUnchanged,
    setShowUnchanged,
    toggle,
    toggleAddition,
    toggleBackfill,
    toggleDeletion,
    toggleRemoval,
    toggleConversion,
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
