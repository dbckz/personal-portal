// What to aim for in today's session, derived from what the log says about the
// last one.
//
// The model is DOUBLE PROGRESSION, not "add weight every time":
//
//   hit the rep target on every set, with effort to spare  → add weight, keep reps
//   hit the rep target but it was at the limit             → hold, consolidate
//   missed the rep target                                  → hold and complete it
//   failed badly / had to drop mid-session                 → reduce
//
// The signal for "effort to spare" comes from Dave's own notes, which already
// read as reps-in-reserve: "could have done 3-4 more per set", "couple in tank",
// "at limit", "only managed 8 in the second and third set". Parsing those is
// more honest than assuming a fixed weekly increment — his log has a lift going
// 27kg → struggled → 25.3kg, which a fixed increment would have made worse.

import { format, parseISO } from 'date-fns';

import type { ExerciseProgression, ProgressionPoint } from './exercise-progression';

// How an exercise sits in the programme:
//   core     — kept identical session to session so it can be driven up
//   rotation — an accessory swapped between sessions
//   cardio   — a run or treadmill piece, measured in time/distance
// Set by the AI programmer; the deterministic fallback only ever knows 'cardio'.
export type ExerciseKind = 'core' | 'rotation' | 'cardio';

// Reps in reserve: how many more reps were left at the end of a set.
// 0 means nothing left; 4+ means the weight was comfortably light.
export interface EffortReading {
  rir?: number;
  // The set was not completed as prescribed (dropped weight, missed reps).
  failed?: boolean;
  // The note explicitly says to go up or come down.
  explicit?: 'up' | 'down';
}

const RANGE = /could(?:'ve| have)?\s+(?:done|do)\s+(?:a\s+)?(\d+)\s*(?:-|to)\s*(\d+)\s*more/i;
const SINGLE = /could(?:'ve| have)?\s+(?:done|do)\s+(?:a\s+)?(\d+)\s*more/i;
const ONLY_MANAGED = /only\s+managed\s+\d+/i;

// Read an effort estimate out of a free-text note. Returns {} when the note says
// nothing about effort — silence must not be read as "easy".
export function readEffort(note: string | undefined): EffortReading {
  const text = (note ?? '').trim();
  if (!text) return {};

  const out: EffortReading = {};

  // Explicit instructions to himself win over everything else.
  if (/\b(up the weight|add weight|increase the weight|go heavier)\b/i.test(text)) {
    out.explicit = 'up';
  }
  if (/\b(make lighter|go lighter|too heavy|reduce\b)|switch to \d/i.test(text)) {
    out.explicit = 'down';
  }

  // Signs the set was not completed as prescribed.
  if (
    ONLY_MANAGED.test(text) ||
    /\b(struggled|failed|couldn'?t (?:do any|complete)|had to (?:drop|reduce))\b/i.test(text)
  ) {
    out.failed = true;
  }

  const range = text.match(RANGE);
  const single = !range ? text.match(SINGLE) : null;
  if (range) {
    out.rir = (Number(range[1]) + Number(range[2])) / 2;
  } else if (single) {
    out.rir = Number(single[1]);
  } else if (/\bquite a few more\b/i.test(text)) {
    out.rir = 4;
  } else if (/\ba few more\b/i.test(text)) {
    out.rir = 3;
  } else if (/\b(a )?couple (?:of )?(?:more|in (?:the )?tank)\b/i.test(text)) {
    out.rir = 2;
  } else if (/\b(easy|comfortable|felt light)\b/i.test(text)) {
    out.rir = 4;
  } else if (/\b(at (?:my |the )?limit|incredibly hard|maxed|nothing left)\b/i.test(text)) {
    out.rir = 0;
  } else if (/\b(about right|perfect weight|felt (?:good|fine|ok))\b/i.test(text)) {
    // "About right" is the middle of the road: a rep or two left.
    out.rir = 2;
  }

  if (out.failed && out.rir === undefined) out.rir = 0;
  return out;
}

export type TargetAction = 'increase' | 'hold' | 'add-reps' | 'reduce' | 'no-history';

export interface ExerciseTarget {
  name: string;
  key: string;
  // The deterministic builder always sets one; AI programme rows lead with a
  // `kind`/`toFailure` tag instead, so it is optional.
  action?: TargetAction;
  // What to aim for. Weight is absent for bodyweight work; duration/distance
  // carry cardio pieces.
  weightKg?: number;
  sets?: number;
  reps?: number;
  holdSeconds?: number;
  durationMinutes?: number;
  distanceKm?: number;
  // Where the exercise sits in the programme (AI path), and whether it is the
  // one to take to failure. The UI shows both as subtle row tags.
  kind?: ExerciseKind;
  toFailure?: boolean;
  // Last time out, for context.
  last?: ProgressionPoint;
  // "2 Aug · 3 × 8 · 40kg" — what was actually done last time, with numbers, so
  // the row never reads "repeat the same" with nothing to repeat.
  lastSummary?: string;
  // One sentence saying why — the recommendation has to be arguable with, not
  // just obeyed.
  rationale: string;
}

// How a target (or a logged row's actuals) reads on screen, e.g. "3 × 8 · 40kg".
// Empty when neither volume nor load is known. Shared by the Plan tab's targets
// and both Today checklists so an aim and what was logged always look alike.
export function describeVolumeLoad(t: {
  sets?: number;
  reps?: number;
  holdSeconds?: number;
  weightKg?: number;
  durationMinutes?: number;
  distanceKm?: number;
}): string {
  let volume = '';
  if (t.sets && t.reps) volume = `${t.sets} × ${t.reps}`;
  else if (t.sets && t.holdSeconds) volume = `${t.sets} × ${t.holdSeconds}s`;
  const load = t.weightKg !== undefined ? `${t.weightKg}kg` : '';
  const cardio = [
    t.durationMinutes !== undefined ? `${t.durationMinutes} min` : '',
    t.distanceKm !== undefined ? `${t.distanceKm} km` : '',
  ].filter(Boolean);
  return [volume, load, ...cardio].filter(Boolean).join(' · ');
}

// "2 Aug · 3 × 8 · 40kg" (or "· 15 min · 3.5 km" for cardio) — the concrete
// record of last time, so a row never says "repeat the same" with no numbers.
export function describeLast(point: ProgressionPoint): string {
  const detail = describeVolumeLoad(point);
  const date = format(parseISO(point.date), 'd MMM');
  return detail ? `${date} · ${detail}` : date;
}

// Round to something you can actually load. Below 10kg the smallest dumbbells
// and plates jump by roughly a kilo, so half-kilo targets there are fiction;
// heavier, a microplate makes a half-kilo step real. The AI programmer reasons
// about specific equipment — this is only the offline fallback's rule of thumb.
function roundLoad(kg: number): number {
  const step = kg < 10 ? 1 : 0.5;
  return Math.round(kg / step) * step;
}

// How big a jump the effort justifies. Deliberately conservative: a jump that is
// too small costs one session, a jump that is too large costs three.
function increment(weightKg: number, rir: number): number {
  if (rir >= 3) return roundLoad(weightKg * 0.1);
  if (rir >= 2) return roundLoad(weightKg * 0.05);
  return 0;
}

// Build the target for one exercise from its history.
export function buildTarget(progression: ExerciseProgression): ExerciseTarget {
  const last = progression.latest;
  const base = { name: progression.name, key: progression.key };

  if (!last) {
    return { ...base, action: 'no-history', rationale: 'No history for this exercise yet.' };
  }

  // An explicit RIR rating is decisive: it stands in for the whole effort read,
  // so a tapped "2 in reserve" beats whatever the free-text note happens to say.
  // Silence in the rating still falls back to reading effort out of the note.
  const effort: EffortReading = last.rir !== undefined ? { rir: last.rir } : readEffort(last.notes);
  const sets = last.sets;
  const reps = last.reps;
  const context = {
    ...base,
    last,
    lastSummary: describeLast(last),
    sets,
    reps,
    ...(last.holdSeconds ? { holdSeconds: last.holdSeconds } : {}),
  };

  // Cardio: a run or treadmill piece has time and/or distance but no load or
  // reps. Repeat it with the actual numbers — "the same" told Dave nothing.
  if (last.weightKg === undefined && (last.durationMinutes !== undefined || last.distanceKm !== undefined)) {
    const detail = describeVolumeLoad({
      durationMinutes: last.durationMinutes,
      distanceKm: last.distanceKm,
    });
    return {
      ...context,
      action: 'hold',
      kind: 'cardio',
      ...(last.durationMinutes !== undefined ? { durationMinutes: last.durationMinutes } : {}),
      ...(last.distanceKm !== undefined ? { distanceKm: last.distanceKm } : {}),
      rationale: `Last time was ${detail} — match or beat it.`,
    };
  }

  // Bodyweight or unloaded work: progress by reps or time, never by weight.
  if (last.weightKg === undefined) {
    if (effort.failed) {
      return {
        ...context,
        action: 'hold',
        rationale: `Last time was a struggle — repeat ${describeVolume(last)} before adding anything.`,
      };
    }
    if ((effort.rir ?? 0) >= 2) {
      const target = last.holdSeconds
        ? { holdSeconds: last.holdSeconds + 10 }
        : { reps: (reps ?? 8) + 2 };
      return {
        ...context,
        ...target,
        action: 'add-reps',
        rationale: last.holdSeconds
          ? `Had ${effort.rir} in reserve — add 10 seconds a set.`
          : `Had about ${effort.rir} reps in reserve — add a couple of reps a set.`,
      };
    }
    return {
      ...context,
      action: 'hold',
      rationale: `Repeat ${describeVolume(last)} — no clear sign it was easy.`,
    };
  }

  // Loaded work.
  // Only an explicit "too heavy" earns a cut. Missing a rep or two is a reason
  // to repeat the weight until it is completed, not to go backwards.
  if (effort.explicit === 'down') {
    const reduced = roundLoad(last.weightKg * 0.9);
    return {
      ...context,
      action: 'reduce',
      weightKg: reduced,
      rationale: `You noted it was too heavy — drop to about ${reduced}kg and rebuild.`,
    };
  }

  if (effort.failed) {
    return {
      ...context,
      action: 'hold',
      weightKg: last.weightKg,
      rationale: `Stay at ${last.weightKg}kg until you complete all ${sets ?? 3} sets of ${reps ?? 8}.`,
    };
  }

  const rir = effort.explicit === 'up' ? Math.max(effort.rir ?? 0, 4) : (effort.rir ?? 0);
  const step = increment(last.weightKg, rir);

  if (step > 0) {
    const next = roundLoad(last.weightKg + step);
    return {
      ...context,
      action: 'increase',
      weightKg: next,
      rationale:
        effort.explicit === 'up'
          ? `You said to go up — try ${next}kg for ${sets ?? 3}×${reps ?? 8}.`
          : `About ${rir} reps left in reserve at ${last.weightKg}kg — try ${next}kg for the same reps.`,
    };
  }

  return {
    ...context,
    action: 'hold',
    weightKg: last.weightKg,
    rationale:
      effort.rir === 0
        ? `You were at your limit at ${last.weightKg}kg — repeat it and aim to make it feel easier.`
        : `Repeat ${last.weightKg}kg — the last note doesn't say there was anything left over.`,
  };
}

function describeVolume(point: ProgressionPoint): string {
  if (point.sets && point.reps) return `${point.sets}×${point.reps}`;
  if (point.sets && point.holdSeconds) return `${point.sets}×${point.holdSeconds}s`;
  return 'the same';
}

// Targets for a session, most-relevant first.
//
// `components` is the plan for the day ("Push (chest & arms)", "Run (2 km)"):
// exercises are matched to it so a push day suggests presses, not leg work. With
// no plan, the most-trained exercises are offered instead.
export function buildSessionTargets(
  progressions: ExerciseProgression[],
  components: string[] = [],
  limit = 8
): ExerciseTarget[] {
  return orderTargets(selectPlanProgressions(progressions, components, limit).map(buildTarget));
}

// The exercises a session's plan implies, most-relevant first and capped. Shared
// by the deterministic targets and the AI programmer's input so both reason over
// the same set of lifts.
export function selectPlanProgressions(
  progressions: ExerciseProgression[],
  components: string[] = [],
  limit = 8
): ExerciseProgression[] {
  const relevant = components.length > 0 ? filterToPlan(progressions, components) : progressions;
  return relevant.slice(0, limit);
}

// Run/treadmill first, everything else in its original order — a warm-up run
// leads the session, not a chest press. A stable partition, so the relative
// order within each group is preserved.
function orderTargets(targets: ExerciseTarget[]): ExerciseTarget[] {
  const isCardio = (t: ExerciseTarget) => t.kind === 'cardio';
  return [...targets.filter(isCardio), ...targets.filter(t => !isCardio(t))];
}

// Which muscle groups a plan component implies, and the words that identify an
// exercise as belonging to one. Deliberately coarse — the aim is to keep leg day
// off a push day, not to classify perfectly.
const GROUPS: Record<string, RegExp> = {
  push: /\b(press|push|fly|flye|dip|tricep|pushdown|lateral raise|crossover|shoulder|chest|pec)\b/i,
  pull: /\b(row|pulldown|pullup|pull-up|chin|curl|shrug|rear delt|pec deck|lat|y raise|dead hang)\b/i,
  legs: /\b(squat|leg|lunge|glute|calf|hamstring|quad|deadlift)\b/i,
  core: /\b(plank|dead bug|core|ab|knee raise|paloff|shoulder tap)\b/i,
  run: /\b(run|treadmill|parkrun|jog)\b/i,
};

function filterToPlan(
  progressions: ExerciseProgression[],
  components: string[]
): ExerciseProgression[] {
  const text = components.join(' ').toLowerCase();
  const wanted = Object.keys(GROUPS).filter(group => {
    if (group === 'push') return /\bpush|chest|shoulders?|arms\b/.test(text);
    if (group === 'pull') return /\bpull|back|arms\b/.test(text);
    if (group === 'legs') return /\blegs?\b/.test(text);
    if (group === 'core') return /\bcore|abs?\b/.test(text);
    return /\brun|parkrun|track\b/.test(text);
  });

  if (wanted.length === 0) return progressions;

  const matches = progressions.filter(p => wanted.some(group => GROUPS[group].test(p.name)));
  // Never return an empty list because the plan used unfamiliar words — falling
  // back to the full list is more useful than showing nothing.
  return matches.length > 0 ? matches : progressions;
}
