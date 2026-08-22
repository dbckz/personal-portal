'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { buildBoardCards } from '@/lib/board';
import type {
  AdHocTask,
  BoardCard,
  BoardStatus,
  BoardTaskState,
  CalendarEvent,
  CustomTaskType,
  ScheduledAsanaTask,
  TaskMetadata,
  WeeklyTaskOutcomeKind,
} from '@/types';
import type { RitualBlock } from '@/lib/storage/core';

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
  const [portalDoneGids, setPortalDoneGids] = useState<string[]>([]);
  const [weeklyOutcomes, setWeeklyOutcomes] = useState<
    Record<string, { outcome: WeeklyTaskOutcomeKind; category?: string; title?: string }>
  >({});
  const [blockDoneEventIds, setBlockDoneEventIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const res = await api.getBoard(weekStart);
      if (!isMountedRef.current) return;
      setStates(res.states || {});
      setRouteScheduled(res.scheduledAsanaTasks || []);
      setRitualBlocks(res.ritualBlocks || []);
      setPortalDoneGids(res.portalDoneGids || []);
      setWeeklyOutcomes(res.weeklyOutcomes || {});
      setBlockDoneEventIds(res.blockDoneGoogleEventIds || []);
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

  const cards = useMemo(
    () =>
      buildBoardCards({
        weekStart,
        scheduledAsanaTasks: scheduledAsanaTasks ?? routeScheduled,
        adHocTasks,
        ritualBlocks,
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
      states,
      asanaTasks,
      effectiveMetadata,
      weeklyOutcomes,
      blockDoneEventIds,
      customTypes,
    ]
  );

  const setBusy = useCallback((key: string, busy: boolean) => {
    setBusyKeys(prev => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Perform the side effects a status change implies, through the callbacks (or
  // the api directly when a callback isn't supplied).
  const runSideEffects = useCallback(
    async (card: BoardCard, previous: BoardStatus, next: BoardStatus) => {
      const wasDone = previous === 'done';
      const wasWaiting = previous === 'waiting';

      if (next === 'done' && !wasDone) {
        if (card.source === 'adhoc') {
          if (onToggleAdhocComplete) await onToggleAdhocComplete(card, true);
          else if (card.adhocId) await api.updateAdHocTask(card.adhocId, { completed: true });
        } else if (card.source === 'asana' && card.gid && card.integrationId) {
          if (onCompleteAsana) await onCompleteAsana(card.gid, card.integrationId, true);
          else await api.completeAsanaTask(card.gid, card.integrationId, true);
        }
      } else if (wasDone && next !== 'done') {
        if (card.source === 'adhoc') {
          if (onToggleAdhocComplete) await onToggleAdhocComplete(card, false);
          else if (card.adhocId) await api.updateAdHocTask(card.adhocId, { completed: false });
        } else if (card.source === 'asana' && card.gid && card.integrationId) {
          if (onCompleteAsana) await onCompleteAsana(card.gid, card.integrationId, false);
          else await api.completeAsanaTask(card.gid, card.integrationId, false);
        }
      }

      if (card.source === 'asana' && card.gid && card.integrationId) {
        if (next === 'waiting' && !wasWaiting) {
          const now = new Date().toISOString();
          const updates = { portalDone: true, portalDoneAt: now, portalDoneTitle: card.title };
          if (saveMetadata) await saveMetadata(card.gid, card.integrationId, updates);
          else await api.upsertTaskMetadata(card.gid, card.integrationId, updates);
        } else if (wasWaiting && next !== 'waiting') {
          const updates = { portalDone: false };
          if (saveMetadata) await saveMetadata(card.gid, card.integrationId, updates);
          else await api.upsertTaskMetadata(card.gid, card.integrationId, updates);
        }
      }
    },
    [onCompleteAsana, onToggleAdhocComplete, saveMetadata]
  );

  const moveCard = useCallback(
    async (card: BoardCard, status: BoardStatus) => {
      if (status === card.status) return;
      const { stateKey } = card;
      const previousState = states[stateKey];
      const previousStatus = card.status;

      // Optimistic: cards derive from `states`, so writing the explicit state
      // moves the card immediately.
      const optimistic: BoardTaskState = {
        key: stateKey,
        status,
        ...(previousState?.weekStart
          ? { weekStart: previousState.weekStart }
          : card.source === 'ritual'
            ? { weekStart }
            : {}),
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
          ...(optimistic.weekStart ? { weekStart: optimistic.weekStart } : {}),
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

  return { cards, isLoading, error, reload, moveCard, pinToWeek, busyKeys };
}
