'use client';

import { useEffect, useRef } from 'react';

import { NOTIFICATIONS_STORAGE_KEY } from './useEventNotifications';
import { api } from '@/lib/api';
import { isReflectionDue } from '@/lib/goal-progress';
import { periodKeyFor, previousPeriodKey } from '@/lib/goal-periods';
import { reflectionNudgeContent, selectReflectionNudge } from '@/lib/reflection-nudge';
import { isWorkingDay } from '@/lib/scheduling/end-of-week';
import type { GoalPeriodKind, GoalStatus } from '@/types/life';

// Remembers the last period a reflection nudge fired for, per kind, so a reload
// doesn't re-nag and the nudge lands at most once per period.
const LAST_NUDGE_KEY = 'reflectionNudgeLastPeriod';

// The nudge is hour-granular, so a minute between checks is plenty.
const CHECK_INTERVAL_MS = 60_000;

const KINDS: readonly GoalPeriodKind[] = ['month', 'quarter'];

// A terminal verdict is only ever written when a period is reflected on, so any
// goal in a terminal state means the reflection has already happened.
const TERMINAL: readonly GoalStatus[] = ['hit', 'partial', 'missed', 'dropped'];

interface PeriodFacts {
  hasGoals: boolean;
  reflectionDone: boolean;
}

/**
 * Fires the month-end and quarter-end reflection reminders while the app is
 * open, through the same browser Notification path (and the same enable toggle)
 * as the event and planning notifications. At most one per period per browser;
 * the decision itself lives in lib/reflection-nudge.ts.
 */
export function useReflectionNudge(workingDays?: string[]): void {
  // Goal facts for each just-ended period we've resolved, keyed by
  // 'kind:periodKey'. Kept in a ref so scorecard fetches never re-render.
  const factsRef = useRef<Map<string, PeriodFacts | 'pending'>>(new Map());

  useEffect(() => {
    // Resolve (once) whether a just-ended period had goals and has been
    // reflected on. The scorecard already carries every goal's terminal status.
    const load = (kind: GoalPeriodKind, periodKey: string, cacheKey: string) => {
      factsRef.current.set(cacheKey, 'pending');
      api
        .getScorecard(kind, periodKey)
        .then(({ scorecard }) => {
          factsRef.current.set(cacheKey, {
            hasGoals: scorecard.rows.length > 0,
            reflectionDone: scorecard.rows.some(r => TERMINAL.includes(r.goal.status)),
          });
        })
        .catch(() => {
          // Don't wedge the slot as 'pending' forever, or the nudge could never
          // fire — drop it so a later tick retries the fetch.
          factsRef.current.delete(cacheKey);
        });
    };

    const check = () => {
      // The bell governs this too: no toggle, no nudge.
      const enabled = window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === 'true';
      if (!enabled) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

      const now = new Date();
      const working = isWorkingDay(now, workingDays);
      const stored = readLastNudged();

      for (const kind of KINDS) {
        const periodKey = previousPeriodKey(kind, periodKeyFor(kind, now));
        const cacheKey = `${kind}:${periodKey}`;
        const facts = factsRef.current.get(cacheKey);
        // First sighting of this period: kick off the fetch and wait for it.
        if (facts === undefined) {
          load(kind, periodKey, cacheKey);
          continue;
        }
        if (facts === 'pending') continue;

        const fire = selectReflectionNudge({
          periodKind: kind,
          periodKey,
          periodOver: isReflectionDue(kind, periodKey, now),
          hasGoals: facts.hasGoals,
          reflectionDone: facts.reflectionDone,
          lastNudgedPeriod: stored[kind],
          now,
          isWorkingDay: working,
        });
        if (!fire) continue;

        try {
          const { title, body } = reflectionNudgeContent(kind, periodKey);
          new Notification(title, { body, tag: `reflection-nudge-${cacheKey}`, icon: '/icon.svg' });
        } catch {
          // A failed notification (permission revoked mid-session) must not retry
          // in a loop, so the period is still recorded below.
        }
        writeLastNudged({ ...stored, [kind]: periodKey });
        // One notification per tick: on the rare day a month and a quarter end
        // together, the second fires on the next check rather than stacking.
        break;
      }
    };

    // Checked on a timer rather than in the effect body, so no state changes
    // synchronously during the effect.
    const first = setTimeout(check, 0);
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [workingDays]);
}

// The per-kind last-nudged record is one JSON object in localStorage:
// { month?: periodKey, quarter?: periodKey }.
function readLastNudged(): Partial<Record<GoalPeriodKind, string>> {
  try {
    const raw = window.localStorage.getItem(LAST_NUDGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<GoalPeriodKind, string>>) : {};
  } catch {
    return {};
  }
}

function writeLastNudged(value: Partial<Record<GoalPeriodKind, string>>): void {
  window.localStorage.setItem(LAST_NUDGE_KEY, JSON.stringify(value));
}
