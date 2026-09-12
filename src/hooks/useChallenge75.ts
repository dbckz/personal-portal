'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { logicalToday } from '@/lib/date-utils';
import { evaluateAttempt, type Challenge75Summary } from '@/lib/challenge75';
import type { Challenge75Rule, Challenge75State } from '@/types/life';

// The 75 Hard tracker's data layer, shared by the desktop tab and the mobile
// card. Loads the state once, evaluates the active attempt against the app's
// logical "today", and writes each tick/note per action — optimistically, with
// a per-key busy flag and rollback on failure — so a flaky phone connection can
// only ever lose the one change in flight. The same pattern as the exercise
// Today checklist (useTodaySession's runWrite) and the rehab block.
export function useChallenge75() {
  const [state, setState] = useState<Challenge75State | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Keys mid-write (`${date}:${rule}` or `${date}:note`), so a double-tap can't
  // fire a second write for the same thing.
  const [busyKeys, setBusyKeys] = useState<string[]>([]);
  const today = logicalToday();

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.getChallenge75();
      setState(res.state);
    } catch {
      setError('Could not load the 75 Hard tracker.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The evaluated view of the active (last) attempt, and the archived ones for
  // history. Recomputed whenever the state changes.
  const summary: Challenge75Summary | null = useMemo(() => {
    if (!state || state.attempts.length === 0) return null;
    return evaluateAttempt(state.attempts[state.attempts.length - 1], today);
  }, [state, today]);

  const archived = useMemo(
    () => (state ? state.attempts.slice(0, -1) : []),
    [state]
  );

  const isBusy = useCallback((key: string) => busyKeys.includes(key), [busyKeys]);

  // Run one optimistic write against the active attempt: apply locally, call the
  // server, reconcile with the returned state, roll back on failure.
  const runWrite = useCallback(
    async (
      key: string,
      optimistic: (s: Challenge75State) => Challenge75State,
      write: () => Promise<{ state: Challenge75State }>
    ) => {
      if (busyKeys.includes(key)) return;
      setBusyKeys(keys => [...keys, key]);
      setError(null);
      const before = state;
      setState(prev => (prev ? optimistic(prev) : prev));
      try {
        const res = await write();
        setState(res.state);
      } catch {
        setError('Could not save that. Try again.');
        setState(before);
      } finally {
        setBusyKeys(keys => keys.filter(k => k !== key));
      }
    },
    [busyKeys, state]
  );

  const toggleRule = useCallback(
    (date: string, rule: Challenge75Rule, value: boolean) =>
      runWrite(
        `${date}:${rule}`,
        s => applyTick(s, date, rule, value),
        () => api.setChallenge75Tick(date, rule, value)
      ),
    [runWrite]
  );

  const setNote = useCallback(
    (date: string, note: string) =>
      runWrite(
        `${date}:note`,
        s => applyNote(s, date, note),
        () => api.setChallenge75Note(date, note)
      ),
    [runWrite]
  );

  // Start-date and restart are rarer, deliberate actions: no optimistic apply,
  // just reload from the server's returned state.
  const setStartDate = useCallback(async (startDate: string) => {
    setError(null);
    try {
      const res = await api.setChallenge75StartDate(startDate);
      setState(res.state);
    } catch {
      setError('Could not change the start date. Try again.');
    }
  }, []);

  const restart = useCallback(async (startDate: string) => {
    setError(null);
    try {
      const res = await api.restartChallenge75(startDate);
      setState(res.state);
    } catch {
      setError('Could not restart. Try again.');
    }
  }, []);

  return {
    summary,
    archived,
    today,
    isLoading,
    error,
    isBusy,
    toggleRule,
    setNote,
    setStartDate,
    restart,
    reload: load,
  };
}

// Return a copy of the state with one rule's tick set on one date of the active
// attempt. Pure, so it drives both the optimistic apply and its rollback.
function applyTick(
  state: Challenge75State,
  date: string,
  rule: Challenge75Rule,
  value: boolean
): Challenge75State {
  return replaceActiveDay(state, date, day => {
    const next = { ...day };
    if (value) next[rule] = true;
    else delete next[rule];
    return next;
  });
}

function applyNote(state: Challenge75State, date: string, note: string): Challenge75State {
  const trimmed = note.trim();
  return replaceActiveDay(state, date, day => {
    const next = { ...day };
    if (trimmed) next.note = trimmed;
    else delete next.note;
    return next;
  });
}

function replaceActiveDay(
  state: Challenge75State,
  date: string,
  update: (day: Challenge75State['attempts'][number]['days'][string]) => Challenge75State['attempts'][number]['days'][string]
): Challenge75State {
  const attempts = [...state.attempts];
  const active = { ...attempts[attempts.length - 1] };
  const nextDay = update({ ...(active.days[date] ?? {}) });
  const days = { ...active.days };
  if (Object.keys(nextDay).length) days[date] = nextDay;
  else delete days[date];
  active.days = days;
  attempts[attempts.length - 1] = active;
  return { attempts };
}
