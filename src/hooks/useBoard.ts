'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { buildBoardCards, deriveBoardCardStatus } from '@/lib/board';
import type {
  AdHocTask,
  BoardCard,
  BoardCardMember,
  BoardStatus,
  BoardTaskState,
  CalendarEvent,
  CustomTaskType,
  ScheduledAsanaTask,
  TaskMetadata,
  WeeklyTaskOutcomeKind,
} from '@/types';
import type { PrepBlock, RitualBlock } from '@/lib/storage/core';

const REFRESH_MS = 60_000;

export interface UseBoardOptions {
  weekStart: string; // yyyy-MM-dd Monday
  asanaTasks: CalendarEvent[]; // live incomplete Asana tasks (source 'asana')
  adHocTasks: AdHocTask[];
  // Optional: if omitted, the scheduled Asana blocks from the board route are
  // used. Pass the page's own list to avoid a second source of truth.
  scheduledAsanaTasks?: ScheduledAsanaTask[];
  metadataByGid: Record<string, TaskMetadata>;
  customTypes: CustomTaskType[];
  // Side-effect callbacks (so the page's own state stays in step). When a
  // callback is omitted the hook falls back to calling the api directly.
  onCompleteAsana?: (gid: string, integrationId: string, completed: boolean) => Promise<void>;
  onToggleAdhocComplete?: (task: BoardCard, completed: boolean) => Promise<void>;
  saveMetadata?: (
    gid: string,
    integrationId: string,
    updates: Partial<Omit<TaskMetadata, 'asanaTaskGid' | 'integrationId' | 'updatedAt'>>
  ) => Promise<void>;
}

export interface PinToWeekArgs {
  key: string;
  stateKey?: string; // defaults to key
  weekStart?: string; // defaults to the hook's current week
  title?: string;
  typeLabel?: string;
  integrationId?: string;
  status?: BoardStatus; // defaults to 'todo'
}

export interface UseBoardReturn {
  cards: BoardCard[];
  isLoading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  moveCard: (card: BoardCard, status: BoardStatus) => Promise<void>;
  // Tick a single member of a card done/undone (optimistic, per-row busy).
  toggleMember: (card: BoardCard, member: BoardCardMember) => Promise<void>;
  // Put a card on the week's board (Add task: new ad-hoc, or an existing Asana
  // task) by upserting a pinned BoardTaskState. Optimistic with rollback.
  pinToWeek: (args: PinToWeekArgs) => Promise<void>;
  busyKeys: Set<string>;
}

export function useBoard(options: UseBoardOptions): UseBoardReturn {
  const {
    weekStart,
    asanaTasks,
    adHocTasks,
    scheduledAsanaTasks,
    metadataByGid,
    customTypes,
    onCompleteAsana,
    onToggleAdhocComplete,
    saveMetadata,
  } = options;

  const [states, setStates] = useState<Record<string, BoardTaskState>>({});
  const [routeScheduled, setRouteScheduled] = useState<ScheduledAsanaTask[]>([]);
  const [ritualBlocks, setRitualBlocks] = useState<RitualBlock[]>([]);
  const [prepBlocks, setPrepBlocks] = useState<PrepBlock[]>([]);
  const [portalDoneGids, setPortalDoneGids] = useState<string[]>([]);
  const [weeklyOutcomes, setWeeklyOutcomes] = useState<
    Record<string, { outcome: WeeklyTaskOutcomeKind; category?: string; title?: string }>
  >({});
  const [blockDoneEventIds, setBlockDoneEventIds] = useState<string[]>([]);
  const [needsRollover, setNeedsRollover] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  // Optimistic per-member done overrides, keyed by member.key. Pruned once the
  // rebuilt card reflects the same value (the page's props catch up).
  const [memberOverrides, setMemberOverrides] = useState<Record<string, boolean>>({});

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Guards the once-per-mount rollover trigger: a fetch may report needsRollover
  // again if two clients race, but this client fires the POST at most once.
  const rolloverFiredRef = useRef(false);

  const reload = useCallback(async () => {
    try {
      const res = await api.getBoard(weekStart);
      if (!isMountedRef.current) return;
      setStates(res.states || {});
      setRouteScheduled(res.scheduledAsanaTasks || []);
      setRitualBlocks(res.ritualBlocks || []);
      setPrepBlocks(res.prepBlocks || []);
      setPortalDoneGids(res.portalDoneGids || []);
      setWeeklyOutcomes(res.weeklyOutcomes || {});
      setBlockDoneEventIds(res.blockDoneGoogleEventIds || []);
      setNeedsRollover(!!res.needsRollover);
      setError(null);
    } catch (err) {
      console.error('Failed to load board:', err);
      if (isMountedRef.current) setError('Could not load the board.');
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    setIsLoading(true);
    reload();
  }, [reload]);

  // Visibility-gated refresh, like WaitingWidget: only when the tab is visible.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  // When a fetch reports the daily rollover is due, fire it once, then reload so
  // the moved cards land on their new day. Guarded so it can't loop.
  useEffect(() => {
    if (!needsRollover || rolloverFiredRef.current) return;
    rolloverFiredRef.current = true;
    let cancelled = false;
    api
      .rollOverBoard()
      .then(() => {
        if (!cancelled) reload();
      })
      .catch(err => console.error('Board rollover failed:', err));
    return () => {
      cancelled = true;
    };
  }, [needsRollover, reload]);

  // portalDone is read from the metadata prop; merge the route's portalDoneGids
  // so a flag set server-side is honoured even before the metadata hook catches up.
  const effectiveMetadata = useMemo(() => {
    if (portalDoneGids.length === 0) return metadataByGid;
    const merged: Record<string, TaskMetadata> = { ...metadataByGid };
    for (const gid of portalDoneGids) {
      const existing = merged[gid];
      if (existing?.portalDone) continue;
      merged[gid] = {
        ...existing,
        asanaTaskGid: existing?.asanaTaskGid ?? gid,
        integrationId: existing?.integrationId ?? '',
        portalDone: true,
        updatedAt: existing?.updatedAt ?? '',
      };
    }
    return merged;
  }, [metadataByGid, portalDoneGids]);

  const rawCards = useMemo(
    () =>
      buildBoardCards({
        weekStart,
        scheduledAsanaTasks: scheduledAsanaTasks ?? routeScheduled,
        adHocTasks,
        ritualBlocks,
        prepBlocks,
        states,
        asanaTasks,
        metadataByGid: effectiveMetadata,
        weeklyOutcomes,
        blockDoneEventIds: new Set(blockDoneEventIds),
        customTypes,
      }),
    [
      weekStart,
      scheduledAsanaTasks,
      routeScheduled,
      adHocTasks,
      ritualBlocks,
      prepBlocks,
      states,
      asanaTasks,
      effectiveMetadata,
      weeklyOutcomes,
      blockDoneEventIds,
      customTypes,
    ]
  );

  // Apply optimistic member overrides, recomputing derived status from the
  // overridden members so a group flips to Done as its last member is ticked.
  const cards = useMemo(() => {
    if (Object.keys(memberOverrides).length === 0) return rawCards;
    const blockDoneSet = new Set(blockDoneEventIds);
    const startedTaskIds = new Set(
      Object.entries(weeklyOutcomes)
        .filter(([, o]) => o.outcome === 'started')
        .map(([taskId]) => taskId)
    );
    return rawCards.map(card => {
      if (card.members.length === 0) return card;
      let changed = false;
      const members = card.members.map(m => {
        const ov = memberOverrides[m.key];
        if (ov !== undefined && ov !== m.done) {
          changed = true;
          return { ...m, done: ov };
        }
        return m;
      });
      if (!changed) return card;
      const status =
        card.statusSource === 'explicit'
          ? card.status
          : deriveBoardCardStatus(
              { source: card.source, members, googleEventId: card.googleEventId },
              { blockDoneEventIds: blockDoneSet, startedTaskIds }
            );
      return { ...card, members, status };
    });
  }, [rawCards, memberOverrides, blockDoneEventIds, weeklyOutcomes]);

  // Prune an override once the rebuilt card already reflects it.
  useEffect(() => {
    if (Object.keys(memberOverrides).length === 0) return;
    const rawDone = new Map<string, boolean>();
    for (const c of rawCards) for (const m of c.members) rawDone.set(m.key, m.done);
    setMemberOverrides(prev => {
      let changed = false;
      const next = { ...prev };
      for (const [k, v] of Object.entries(prev)) {
        if (rawDone.get(k) === v) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rawCards, memberOverrides]);

  const setBusy = useCallback((key: string, busy: boolean) => {
    setBusyKeys(prev => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Complete (or un-complete) one member through the callbacks, falling back to
  // the api. The ad-hoc callback is per-card, so it is used only for a single-
  // task ad-hoc card; group ad-hoc members go straight to the api.
  const completeMember = useCallback(
    async (card: BoardCard, member: BoardCardMember, completed: boolean) => {
      if (member.source === 'asana' && member.gid && member.integrationId) {
        if (onCompleteAsana) await onCompleteAsana(member.gid, member.integrationId, completed);
        else await api.completeAsanaTask(member.gid, member.integrationId, completed);
      } else if (member.source === 'adhoc' && member.adhocId) {
        if (onToggleAdhocComplete && member.adhocId === card.adhocId) {
          await onToggleAdhocComplete(card, completed);
        } else {
          await api.updateAdHocTask(member.adhocId, { completed });
        }
      }
    },
    [onCompleteAsana, onToggleAdhocComplete]
  );

  // The members a status → done (or done → other) implies completing:
  //  * task   → its single member;
  //  * group  → every member not already in the target state (continue on error);
  //  * unplanned → its ad-hoc member only (a pinned Asana task is state-only);
  //  * ritual / prep → none.
  const completeCardMembers = useCallback(
    async (card: BoardCard, completed: boolean) => {
      if (card.source === 'ritual' || card.source === 'prep') return;
      const targets =
        card.source === 'group'
          ? card.members.filter(m => (completed ? !m.done : m.done))
          : card.source === 'unplanned'
            ? card.members.filter(m => m.source === 'adhoc')
            : card.members;
      let firstError: unknown;
      for (const m of targets) {
        try {
          await completeMember(card, m, completed);
        } catch (err) {
          if (!firstError) firstError = err;
        }
      }
      if (firstError) throw firstError;
    },
    [completeMember]
  );

  // Perform the side effects a status change implies.
  const runSideEffects = useCallback(
    async (card: BoardCard, previous: BoardStatus, next: BoardStatus) => {
      const wasDone = previous === 'done';
      const wasWaiting = previous === 'waiting';

      if (next === 'done' && !wasDone) {
        await completeCardMembers(card, true);
      } else if (wasDone && next !== 'done') {
        await completeCardMembers(card, false);
      }

      // Portal-done ("waiting on others") only toggles for a single-Asana-member
      // task / pinned card; groups are state-only.
      const single =
        (card.source === 'task' || card.source === 'unplanned') &&
        card.members.length === 1 &&
        card.members[0].source === 'asana'
          ? card.members[0]
          : null;
      if (single && single.gid && single.integrationId) {
        if (next === 'waiting' && !wasWaiting) {
          const now = new Date().toISOString();
          const updates = { portalDone: true, portalDoneAt: now, portalDoneTitle: card.title };
          if (saveMetadata) await saveMetadata(single.gid, single.integrationId, updates);
          else await api.upsertTaskMetadata(single.gid, single.integrationId, updates);
        } else if (wasWaiting && next !== 'waiting') {
          const updates = { portalDone: false };
          if (saveMetadata) await saveMetadata(single.gid, single.integrationId, updates);
          else await api.upsertTaskMetadata(single.gid, single.integrationId, updates);
        }
      }
    },
    [completeCardMembers, saveMetadata]
  );

  const moveCard = useCallback(
    async (card: BoardCard, status: BoardStatus) => {
      if (status === card.status) return;
      const { stateKey } = card;
      const previousState = states[stateKey];
      const previousStatus = card.status;

      // Optimistic: cards derive from `states`, so writing the explicit state
      // moves the card immediately.
      const pinnedWeek = previousState?.weekStart ?? weekStart;
      const optimistic: BoardTaskState = {
        key: stateKey,
        status,
        weekStart: pinnedWeek,
        ...(card.title ? { title: card.title } : {}),
        ...(card.typeLabel ? { typeLabel: card.typeLabel } : {}),
        ...(card.integrationId ? { integrationId: card.integrationId } : {}),
        updatedAt: new Date().toISOString(),
      };
      setStates(prev => ({ ...prev, [stateKey]: optimistic }));
      setBusy(card.key, true);
      setError(null);

      try {
        await runSideEffects(card, previousStatus, status);
        const { state } = await api.setBoardStatus({
          stateKey,
          key: card.key,
          status,
          weekStart: pinnedWeek,
          ...(card.title ? { title: card.title } : {}),
          ...(card.typeLabel ? { typeLabel: card.typeLabel } : {}),
          ...(card.integrationId ? { integrationId: card.integrationId } : {}),
        });
        if (isMountedRef.current) setStates(prev => ({ ...prev, [stateKey]: state }));
      } catch (err) {
        console.error('Board move failed:', err);
        if (isMountedRef.current) {
          setError('Could not move that card — check your connection.');
          setStates(prev => {
            const next = { ...prev };
            if (previousState) next[stateKey] = previousState;
            else delete next[stateKey];
            return next;
          });
        }
      } finally {
        if (isMountedRef.current) setBusy(card.key, false);
      }
    },
    [states, weekStart, runSideEffects, setBusy]
  );

  const toggleMember = useCallback(
    async (card: BoardCard, member: BoardCardMember) => {
      const next = !member.done;
      setMemberOverrides(prev => ({ ...prev, [member.key]: next }));
      setBusy(member.key, true);
      setError(null);
      try {
        await completeMember(card, member, next);
      } catch (err) {
        console.error('Board member toggle failed:', err);
        if (isMountedRef.current) {
          setError('Could not update that task — check your connection.');
          setMemberOverrides(prev => {
            const n = { ...prev };
            delete n[member.key];
            return n;
          });
        }
      } finally {
        if (isMountedRef.current) setBusy(member.key, false);
      }
    },
    [completeMember, setBusy]
  );

  const pinToWeek = useCallback(
    async (args: PinToWeekArgs) => {
      const stateKey = args.stateKey ?? args.key;
      const status: BoardStatus = args.status ?? 'todo';
      const pinnedWeek = args.weekStart ?? weekStart;
      const previousState = states[stateKey];

      const optimistic: BoardTaskState = {
        key: stateKey,
        status,
        weekStart: pinnedWeek,
        ...(args.title ? { title: args.title } : {}),
        ...(args.typeLabel ? { typeLabel: args.typeLabel } : {}),
        ...(args.integrationId ? { integrationId: args.integrationId } : {}),
        updatedAt: new Date().toISOString(),
      };
      setStates(prev => ({ ...prev, [stateKey]: optimistic }));
      setBusy(args.key, true);
      setError(null);

      try {
        const { state } = await api.setBoardStatus({
          stateKey,
          key: args.key,
          status,
          weekStart: pinnedWeek,
          ...(args.title ? { title: args.title } : {}),
          ...(args.typeLabel ? { typeLabel: args.typeLabel } : {}),
          ...(args.integrationId ? { integrationId: args.integrationId } : {}),
        });
        if (isMountedRef.current) setStates(prev => ({ ...prev, [stateKey]: state }));
      } catch (err) {
        console.error('Board pin failed:', err);
        if (isMountedRef.current) {
          setError('Could not add that card — check your connection.');
          setStates(prev => {
            const next = { ...prev };
            if (previousState) next[stateKey] = previousState;
            else delete next[stateKey];
            return next;
          });
        }
      } finally {
        if (isMountedRef.current) setBusy(args.key, false);
      }
    },
    [states, weekStart, setBusy]
  );

  return { cards, isLoading, error, reload, moveCard, toggleMember, pinToWeek, busyKeys };
}
