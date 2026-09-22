// Warm-up and cool-down guidance woven into today's checklist: plain lines
// written in the place they are done (a general warm-up at the top, ramp-up
// sets above the lift they lead into, a cool-down at the end), never rows to
// tick. Derived from the day's rows and plan, so every routine day gets them
// without a routine edit.
//
// The rules follow docs/full-body-routine-plan.md: two light warm-up sets on the
// first movement of each antagonist pair, the run after the lifts on Tue/Thu,
// parkrun before the lifts on Sat. Home fixed days are already mobility work, so
// they get no general warm-up; Monday's football gets its own.

import type { ExerciseKind } from './exercise-targets';

export type CueKind = 'warmup' | 'cooldown';

export interface SessionCue {
  kind: CueKind;
  text: string;
}

// The minimum a row needs for its cues. Structural, like SectionableRow, so the
// lib stays free of the Today hook's types.
export interface CueRow {
  key: string;
  name: string;
  kind?: ExerciseKind;
  weightKg?: number;
  pair?: { index: number; slot: 'a' | 'b' };
  distanceKm?: number;
  durationMinutes?: number;
}

export interface CuePlan {
  venue?: 'home';
  fixed?: boolean;
}

export interface SessionCues {
  // Above the whole list: the general warm-up.
  intro: SessionCue[];
  // Keyed by row key: lines shown directly above / below that row.
  before: Record<string, SessionCue[]>;
  after: Record<string, SessionCue[]>;
  // Below the whole list: the cool-down.
  outro: SessionCue[];
}

const GYM_WARMUP =
  '5 min easy on the bike or cross-trainer, then 10 leg swings per side, 10 arm circles each way and 5 slow cat-cows.';
const HOME_WARMUP = '3 min: cat-cow, 10 glute bridges and 10 arm circles each way.';
const PARKRUN_WARMUP =
  'Before the start: 5 min easy jog, 10 leg swings per side, then 2–3 short pick-ups to race pace.';
const FOOTBALL_WARMUP =
  'Before kick-off: 5 min light jog, leg swings and side shuffles, then a few short sprints building up to full pace.';
const FOOTBALL_COOLDOWN = 'Afterwards: couch stretch 60 s per side and a calf stretch 30 s per side.';
const RUN_COOLDOWN =
  'Walk 3–5 min to bring your heart rate down, then couch stretch 60 s per side and a calf stretch 30 s per side.';
const LIFT_COOLDOWN = '5 min easy walk, then couch stretch 60 s per side.';

function isCardio(row: CueRow): boolean {
  return (
    row.kind === 'cardio' ||
    row.distanceKm !== undefined ||
    row.durationMinutes !== undefined ||
    /\b(run|parkrun|football|jog|treadmill)\b/i.test(row.name)
  );
}

const isParkrun = (row: CueRow) => /\bparkrun\b/i.test(row.name);
const isFootball = (row: CueRow) => /\bfootball\b/i.test(row.name);

// Nearest 2.5 kg — the usual step on stacks and dumbbell racks.
function roundLoad(kg: number): number {
  return Math.round(kg / 2.5) * 2.5;
}

// Below this working weight a percentage ramp-up collapses into the working
// weight itself (a 6 kg lateral raise), so one easy set does the job instead.
const RAMP_MIN_KG = 10;

// The ramp-up line for the first movement of a pair: ~50% then ~75% of the
// working weight when there is a meaningful one, one easy set for a light lift,
// a bodyweight version for pull-ups, and a plain reminder otherwise. It names
// the exercise, and on a superset says the partner needs none, so it can't be
// read as "warm up both" (the plan warms up the first movement only).
export function rampUpCue(row: CueRow, partner?: CueRow): SessionCue {
  const who = partner ? `${row.name} only, before round 1` : `${row.name}, before your working sets`;
  const tail = partner ? ` ${partner.name} needs no warm-up sets.` : '';
  let what: string;
  if (row.weightKg && row.weightKg >= RAMP_MIN_KG) {
    const light = roundLoad(row.weightKg * 0.5);
    const mid = roundLoad(row.weightKg * 0.75);
    what = `10 reps at ~${light}kg, then 5 at ~${mid}kg.`;
  } else if (row.weightKg && row.weightKg > 0) {
    what = '1 easy set of 10 with a lighter weight.';
  } else if (/\b(pull|chin)-?ups?\b/i.test(row.name)) {
    what = '10 scapular pulls (hang and squeeze your shoulder blades down), then 3 easy pull-ups.';
  } else {
    what = '2 light sets of 5–10 easy reps.';
  }
  return { kind: 'warmup', text: `${who}: ${what}${tail}` };
}

function push(map: Record<string, SessionCue[]>, key: string, cue: SessionCue) {
  (map[key] ??= []).push(cue);
}

export function sessionCues(rows: CueRow[], plan?: CuePlan | null): SessionCues {
  const cues: SessionCues = { intro: [], before: {}, after: {}, outro: [] };
  if (!rows.length) return cues;

  // Football carries its own warm-up and cool-down wherever it sits.
  for (const row of rows.filter(isFootball)) {
    push(cues.before, row.key, { kind: 'warmup', text: FOOTBALL_WARMUP });
    push(cues.after, row.key, { kind: 'cooldown', text: FOOTBALL_COOLDOWN });
  }

  // A standing home day is itself mobility work: nothing else to add.
  if (plan?.fixed) return cues;

  const lifts = rows.filter(r => !isCardio(r));
  const first = rows[0];

  // General warm-up. A session that opens with a parkrun warms up for the run
  // instead, and the run then warms up the lifts.
  if (isParkrun(first)) push(cues.before, first.key, { kind: 'warmup', text: PARKRUN_WARMUP });
  else if (lifts.length) {
    cues.intro.push({ kind: 'warmup', text: plan?.venue === 'home' ? HOME_WARMUP : GYM_WARMUP });
  }

  // Ramp-up sets above the first movement of each pair (the lower-slot half,
  // whichever order the rows arrive in). A day without pairs ramps up once,
  // before its first lift.
  const pairLeads = new Map<number, CueRow>();
  for (const row of lifts) {
    if (!row.pair) continue;
    const lead = pairLeads.get(row.pair.index);
    if (!lead || row.pair.slot < lead.pair!.slot) pairLeads.set(row.pair.index, row);
  }
  if (pairLeads.size) {
    for (const lead of pairLeads.values()) {
      const partner = lifts.find(r => r !== lead && r.pair?.index === lead.pair!.index);
      push(cues.before, lead.key, rampUpCue(lead, partner));
    }
  } else if (lifts.length && plan?.venue !== 'home') {
    push(cues.before, lifts[0].key, rampUpCue(lifts[0]));
  }

  // Cool-down at the end: after a run if the session finishes on one, else after
  // the lifts. Football already has its own.
  const last = rows[rows.length - 1];
  if (!isFootball(last)) {
    cues.outro.push({ kind: 'cooldown', text: isCardio(last) ? RUN_COOLDOWN : LIFT_COOLDOWN });
  }
  return cues;
}
