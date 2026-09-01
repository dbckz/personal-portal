// Shared prep-candidate resolution for the wizard's prep step and the mid-week
// replan flow.
//
// Both flows need the same thing: given the week's meetings (plus the first
// working day(s) of NEXT week), decide which ones warrant a prep block — a user
// decision wins, a matching cached AI verdict is reused, otherwise the meeting is
// freshly classified (and the verdict persisted). Meetings that already have a
// prep block are dropped so prep is never double-offered, INCLUDING across the
// week boundary: a meeting prepped in a previous week (a done prep block) is not
// re-offered when that week arrives. Placement differs between the two callers
// (the wizard places against the calendar's busy time; replan places into the
// post-replan timeline), so this module resolves the WHICH and leaves the WHERE
// to proposePrepBlocks.

import {
  classifyPrep,
  normalizePrepKey,
  prepContentHash,
  PREP_PROMPT_VERSION,
  type PrepMeetingInput,
  type PrepResult,
} from '@/lib/prep-classifier';
import { getMeetingPrepDecisions, setMeetingPrepDecision, type PrepBlock } from '@/lib/user-data-storage';
import { buildExamplesBlock, isVerdictReusable } from '@/lib/classifier-learning';
import { isPrepTitle, prepMeetingTitleFromEvent } from '@/lib/scheduling/event-titles';
import { localDateStr, timeStr } from '@/lib/scheduling/engine';
import type { CalendarEvent, MeetingPrepDecision } from '@/types';

// One resolved prep candidate: a future, attended meeting THIS week that has no
// prep block yet, with its prep verdict decided.
export interface PrepCandidate {
  key: string;
  eventId: string;
  title: string;
  date: string; // meeting's local yyyy-MM-dd
  start: string; // meeting's local HH:mm
  startMs: number;
  needsPrep: boolean;
  decidedBy: 'user' | 'ai';
  reason: string;
}

export interface ResolvePrepInput {
  // This week's events (for candidates + the "Prep:" title dedupe). Prep is
  // confined to the current week — meetings from today onwards only.
  weekEvents: CalendarEvent[];
  nowMs: number;
  prepBlocks: PrepBlock[];
}

// Resolve every prep candidate across this week and early next week, with its
// prep verdict. AI verdicts for newly-classified meetings are persisted as a
// side effect (mirrors the previous inline logic in the prep-candidates route).
export async function resolvePrepCandidates(input: ResolvePrepInput): Promise<PrepCandidate[]> {
  const { weekEvents, nowMs, prepBlocks } = input;

  // Meetings already prepped, from two angles:
  //  * preppedTitles — a "Prep:" event on the calendar (covers preps made outside
  //    this app, or whose record was lost), plus a stored prep whose OWN event is
  //    still present this week (dedupe on a wizard re-run).
  //  * preppedMeetingEventIds — the exact meeting instances a stored prep block
  //    prepares for, when that prep is DONE or its own event is still present.
  //    Keying on the meeting's event id (not title) makes the cross-week guard
  //    precise: a prep DONE last week suppresses re-offering that same meeting
  //    when its week arrives, without suppressing other instances of a recurring
  //    title. A stored prep whose event was DELETED (and isn't done) is NOT a
  //    suppressor — that is the user's "re-suggest it" case (gather's reconcile
  //    has usually already purged such a record before we run).
  const preppedTitles = new Set<string>();
  const preppedMeetingEventIds = new Set<string>();
  for (const e of weekEvents) {
    if (isPrepTitle(e.title)) {
      preppedTitles.add(normalizePrepKey(prepMeetingTitleFromEvent(e.title)));
    }
  }
  const presentEventIds = new Set(weekEvents.map(e => e.id));
  for (const p of prepBlocks) {
    const present = presentEventIds.has(p.googleEventId);
    if (present) preppedTitles.add(normalizePrepKey(p.meetingTitle));
    if (present || p.done) preppedMeetingEventIds.add(p.meetingEventId);
  }

  // Candidate meetings: future (from now onwards, this week only), timed, not
  // declined, not a prep block, not already prepped.
  const isCandidate = (e: CalendarEvent): boolean => {
    if (e.allDay) return false;
    if (e.selfResponseStatus === 'declined') return false;
    if (e.startTime.getTime() <= nowMs) return false;
    if (isPrepTitle(e.title)) return false;
    if (preppedMeetingEventIds.has(e.id)) return false;
    return !preppedTitles.has(normalizePrepKey(e.title));
  };

  const candidates = weekEvents.filter(isCandidate).map(e => ({ event: e }));

  const decisions = await getMeetingPrepDecisions();

  // One PrepMeetingInput per unique title, so duplicates classify once.
  const inputByKey = new Map<string, PrepMeetingInput>();
  for (const { event: e } of candidates) {
    const key = normalizePrepKey(e.title);
    if (inputByKey.has(key)) continue;
    const durationMinutes = Math.max(0, Math.round((e.endTime.getTime() - e.startTime.getTime()) / 60000));
    inputByKey.set(key, {
      key,
      title: e.title,
      description: e.description,
      durationMinutes,
      isRecurring: !!e.recurringEventId,
      attendeeCount: e.attendeeCount,
    });
  }

  // Resolve each title: user decision wins; a matching cached AI verdict is
  // reused; otherwise it needs (re)classification.
  const verdicts = new Map<string, { needsPrep: boolean; decidedBy: 'user' | 'ai'; reason: string }>();
  const toClassify: PrepMeetingInput[] = [];
  for (const [key, meetingInput] of inputByKey) {
    const decision = decisions[key];
    if (decision?.decidedBy === 'user') {
      verdicts.set(key, { needsPrep: decision.needsPrep, decidedBy: 'user', reason: 'Your choice' });
      continue;
    }
    if (isVerdictReusable(decision, prepContentHash(meetingInput), PREP_PROMPT_VERSION)) {
      verdicts.set(key, { needsPrep: decision!.needsPrep, decidedBy: 'ai', reason: '' });
      continue;
    }
    toClassify.push(meetingInput);
  }

  if (toClassify.length > 0) {
    // Feed Dave's own prep decisions back as few-shot examples (keyed by meeting
    // title), so the classifier follows his precedent. Empty → prompt unchanged.
    const examples = buildExamplesBlock(
      Object.entries(decisions)
        .filter(([, d]) => d.decidedBy === 'user')
        .map(([key, d]) => ({ key, label: d.needsPrep ? 'yes' : 'no', at: d.updatedAt })),
      {
        heading:
          'The person has already decided prep for these meetings themselves — treat as ground truth and apply the same standard:',
        render: label => (label === 'yes' ? 'needs prep' : 'no prep needed'),
      }
    );
    let results: PrepResult[];
    try {
      results = await classifyPrep(toClassify, 120, examples);
    } catch (error) {
      console.error('[Scheduling Prep Candidates] classifier failed:', error);
      results = [];
    }
    const byKey = new Map(results.map(r => [r.key, r]));
    const updatedAt = new Date().toISOString();
    for (const meetingInput of toClassify) {
      const r = byKey.get(meetingInput.key);
      // Conservative default: a meeting the model omitted → needsPrep=false.
      const needsPrep = r?.needsPrep ?? false;
      const reason = r?.reason ?? '';
      verdicts.set(meetingInput.key, { needsPrep, decidedBy: 'ai', reason });
      const entry: MeetingPrepDecision = {
        needsPrep,
        decidedBy: 'ai',
        contentHash: prepContentHash(meetingInput),
        promptVersion: PREP_PROMPT_VERSION,
        updatedAt,
      };
      await setMeetingPrepDecision(meetingInput.key, entry);
    }
  }

  return candidates.map(({ event: e }) => {
    const key = normalizePrepKey(e.title);
    const verdict = verdicts.get(key) ?? { needsPrep: false, decidedBy: 'ai' as const, reason: '' };
    return {
      key,
      eventId: e.id,
      title: e.title,
      date: localDateStr(e.startTime),
      start: timeStr(e.startTime.getTime()),
      startMs: e.startTime.getTime(),
      needsPrep: verdict.needsPrep,
      decidedBy: verdict.decidedBy,
      reason: verdict.reason,
    };
  });
}
