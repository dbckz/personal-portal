// Pure decision logic for the month-end / quarter-end reflection nudge.
//
// The weekly review is nudged (see planning-nudge.ts); the monthly and quarterly
// reflections were not — the only prompt was the "due" badge on the Goals
// button, which you have to already be looking at to notice. This closes that
// gap with the same restraint: a reflection is worth interrupting for only once
// its period has actually ended and there were goals to reflect on, and never
// after the reflection has been done. At most one nudge per period per browser —
// a reminder, not an alarm.

import { periodLabel } from './goal-periods';
import type { GoalPeriodKind } from '@/types/life';

export interface ReflectionNudgeInput {
  periodKind: GoalPeriodKind;
  // The just-ended period the nudge is about (e.g. the previous month).
  periodKey: string;
  // Whether that period has actually ended. Mirrors isReflectionDue.
  periodOver: boolean;
  // Whether the period had any goals at all — nothing set, nothing to reflect
  // on, so no nudge.
  hasGoals: boolean;
  // Whether a reflection for the period has already been recorded. A terminal
  // verdict is only ever written at reflection time, so any goal carrying one is
  // proof the reflection happened.
  reflectionDone: boolean;
  // The period key a nudge was last fired for, if any (from localStorage).
  lastNudgedPeriod?: string;
  now: Date;
  // Whether today is a configured working day. A reflection is working-day work,
  // so the nudge doesn't nag on a weekend evening.
  isWorkingDay: boolean;
}

// The hour from which the nudge becomes due, matching the planning nudges.
export const REFLECTION_NUDGE_HOUR = 17;

export function selectReflectionNudge(input: ReflectionNudgeInput): boolean {
  // Once per period, whatever else is true.
  if (input.lastNudgedPeriod === input.periodKey) return false;
  // Every remaining reason the reflection isn't (yet) worth interrupting for.
  if (!input.periodOver) return false;
  if (!input.hasGoals) return false;
  if (input.reflectionDone) return false;
  if (!input.isWorkingDay) return false;
  return input.now.getHours() >= REFLECTION_NUDGE_HOUR;
}

export function reflectionNudgeContent(
  periodKind: GoalPeriodKind,
  periodKey: string
): { title: string; body: string } {
  const label = periodLabel(periodKind, periodKey);
  return {
    title: periodKind === 'month' ? '🪞 Monthly reflection due' : '🪞 Quarterly reflection due',
    body: `${label} has ended. Score how your goals went and close it out.`,
  };
}
