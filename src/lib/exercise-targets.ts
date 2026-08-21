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

import { type ExerciseProgression, type ProgressionPoint } from './exercise-progression';
import { isCardioName, isHoldName, isUnilateralName } from './exercise-parse';

// How an exercise sits in the programme:
//   core     — kept identical session to session so it can be driven up
//   rotation — an accessory swapped between sessions
//   cardio   — a run or treadmill piece, measured in time/distance
//   hold     — an isometric hold (plank, hang, wall sit), measured in seconds
// Set by the AI programmer; the deterministic builder infers 'cardio' and 'hold'
// from the last session's shape.
export type ExerciseKind = 'core' | 'rotation' | 'cardio' | 'hold';

// Reps in reserve: how many more reps were left at the end of a set.
// 0 means nothing left; 4+ means the weight was comfortably light.
export interface EffortReading {
  rir?: number;
  // The set was not completed as prescribed (dropped weight, missed reps).
  failed?: boolean;
  // The note explicitly says to go up or come down.
  explicit?: 'up' | 'down';
}

// The verbs an effort-to-spare note uses, widened past reps: a rep set "could
// have done 2 more", but a hold "could have held it 20 seconds longer" and a run
// "could have gone another 2 km". The unit word (more/seconds/minutes/km) lets
// the same shape read the spare capacity off any of them.
const EFFORT_VERB = String.raw`(?:done|do|held|hold|gone|run|ran|kept going|lasted)`;
const EFFORT_UNIT = String.raw`(?:more|seconds?|secs?|minutes?|mins?|km)`;
const RANGE = new RegExp(
  String.raw`could(?:'ve| have)?\s+${EFFORT_VERB}\s+(?:it\s+)?(?:another\s+|a\s+)?(\d+)\s*(?:-|to)\s*(\d+)\s*${EFFORT_UNIT}`,
  'i'
);
const SINGLE = new RegExp(
  String.raw`could(?:'ve| have)?\s+${EFFORT_VERB}\s+(?:it\s+)?(?:another\s+|a\s+)?(\d+)\s*${EFFORT_UNIT}`,
  'i'
);
// "had another 5 minutes in me", "got another 3 reps left" — capacity stated as
// a remainder rather than as "could have …".
const HAD_MORE = /\b(?:had|got)\s+another\s+(\d+)\s*(?:more\s+)?(?:reps?|seconds?|secs?|minutes?|mins?|km)?\s*(?:in me|left|in the tank)/i;
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
  const had = !range && !single ? text.match(HAD_MORE) : null;
  if (range) {
    out.rir = (Number(range[1]) + Number(range[2])) / 2;
  } else if (single) {
    out.rir = Number(single[1]);
  } else if (had) {
    out.rir = Number(had[1]);
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

// 'add-time' is the hold counterpart of 'add-reps': the recommender added
// seconds to a timed hold rather than reps to a rep set, so the badge reads
// "Hold longer" instead of "Add reps".
export type TargetAction = 'increase' | 'hold' | 'add-reps' | 'add-time' | 'reduce' | 'no-history';

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
  // Prescribed rep/hold RANGES ("3 × 8–12"). When set, the target reads as a
  // range and seeds the lower bound; the recommender does double progression
  // against the top. `reps`/`holdSeconds` still carry the concrete lower bound
  // so seeding and the deterministic path stay unchanged.
  repsMin?: number;
  repsMax?: number;
  holdSecondsMin?: number;
  holdSecondsMax?: number;
  // "each side" — the volume is per side, not a total. Set for unilateral work
  // so the aim and the log both read "3 × 8 each side".
  perSide?: boolean;
  durationMinutes?: number;
  distanceKm?: number;
  // Where the exercise sits in the programme (AI path), and whether it is the
  // one to take to failure. The UI shows both as subtle row tags.
  kind?: ExerciseKind;
  toFailure?: boolean;
  // Prescription provenance: the section the exercise was written under
  // ("Anchors", "Core"), and whether it is an anchor lift. Drives the sectioned
  // checklist and the "Anchor" badge. Absent on non-prescribed targets.
  section?: string;
  isAnchor?: boolean;
  // Routine provenance from the AI programme / deterministic fallback: whether
  // this is one of the day's FIXED lifts (an anchor driven up, or a staple
  // always present). Drives the "Anchor"/"Staple" checklist badge. Absent on
  // rotating accessories and ad-hoc rows.
  fixed?: 'anchor' | 'staple';
  // On a HOME session, the exact name of the routine anchor/staple this row is a
  // home stand-in for (e.g. "Band overhead press" stands in for "Seated DB
  // shoulder press"). Shown on the row so the substitution is legible. Absent on
  // gym sessions and on rows that are not substitutes.
  standsInFor?: string;
  // Last time out, for context.
  last?: ProgressionPoint;
  // "2 Aug · 3 × 8 · 40kg" — what was actually done last time, with numbers, so
  // the row never reads "repeat the same" with nothing to repeat.
  lastSummary?: string;
  // One sentence saying why — the recommendation has to be arguable with, not
  // just obeyed.
  rationale: string;
}

// A logged duration, read for humans: whole minutes stay "20 min", but a
// sub-minute piece (a 0.75-minute plank) reads "45 secs" rather than "0.75 min",
// and a fractional one over a minute splits into "1 min 30 secs". Seconds are
// rounded, so a stored 0.75 min is exactly 45 secs.
export function formatEntryDuration(minutes: number): string {
  const totalSeconds = Math.round(minutes * 60);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins === 0) return `${secs} secs`;
  if (secs === 0) return `${mins} min`;
  return `${mins} min ${secs} secs`;
}

// How a target (or a logged row's actuals) reads on screen, e.g. "3 × 8 · 40kg".
// Empty when neither volume nor load is known. Shared by the Plan tab's targets
// and both Today checklists so an aim and what was logged always look alike.
export function describeVolumeLoad(t: {
  sets?: number;
  reps?: number;
  holdSeconds?: number;
  repsMin?: number;
  repsMax?: number;
  holdSecondsMin?: number;
  holdSecondsMax?: number;
  perSide?: boolean;
  weightKg?: number;
  durationMinutes?: number;
  distanceKm?: number;
}): string {
  // A prescribed range reads as a range ("3 × 8–12", "3 × 30–45s"); a single
  // value falls through to the plain reps/hold rendering below.
  const repRange = t.repsMin !== undefined && t.repsMax !== undefined && t.repsMin !== t.repsMax;
  const holdRange =
    t.holdSecondsMin !== undefined &&
    t.holdSecondsMax !== undefined &&
    t.holdSecondsMin !== t.holdSecondsMax;

  let volume = '';
  if (t.sets && repRange) volume = `${t.sets} × ${t.repsMin}–${t.repsMax}`;
  else if (t.sets && holdRange) volume = `${t.sets} × ${t.holdSecondsMin}–${t.holdSecondsMax}s`;
  else if (t.sets && t.reps) volume = `${t.sets} × ${t.reps}`;
  else if (t.sets && t.holdSeconds) volume = `${t.sets} × ${t.holdSeconds}s`;
  // A single hold with no set count — a lone "90s plank", as it often arrives.
  else if (t.holdSeconds) volume = `${t.holdSeconds}s`;
  if (volume && t.perSide) volume += ' each side';
  const load = t.weightKg !== undefined ? `${t.weightKg}kg` : '';
  const cardio = [
    t.durationMinutes !== undefined ? formatEntryDuration(t.durationMinutes) : '',
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
  // Unilateral either because the log said so last time or because the name
  // reads that way ("side plank", "Bulgarian split squat") even if the "each
  // side" was left off the sheet.
  const perSide = !!last.perSide || isUnilateralName(base.name);
  const context = {
    ...base,
    last,
    lastSummary: describeLast(last),
    sets,
    reps,
    ...(last.holdSeconds ? { holdSeconds: last.holdSeconds } : {}),
    ...(perSide ? { perSide: true } : {}),
  };

  // Cardio: a run or treadmill piece, recognised by its logged measures OR by
  // its name. Checked BEFORE the bodyweight path so a run logged with no numbers
  // (and a spare-effort note) isn't told to "add a couple of reps" — it's asked
  // for the distance and time instead.
  const isCardio =
    last.weightKg === undefined &&
    (last.durationMinutes !== undefined || last.distanceKm !== undefined || isCardioName(base.name));
  if (isCardio) {
    // A treadmill piece is targeted in MINUTES, never distance — a logged
    // "9.2" is a speed, not a distance, so distance would be fiction here.
    const treadmill = /treadmill/i.test(base.name);
    const detail = describeVolumeLoad({
      durationMinutes: last.durationMinutes,
      ...(treadmill ? {} : { distanceKm: last.distanceKm }),
    });
    return {
      ...context,
      action: 'hold',
      kind: 'cardio',
      ...(last.durationMinutes !== undefined ? { durationMinutes: last.durationMinutes } : {}),
      ...(!treadmill && last.distanceKm !== undefined ? { distanceKm: last.distanceKm } : {}),
      rationale: detail
        ? `Last time was ${detail} — match or beat it.`
        : 'No distance or time logged last time — record them today.',
    };
  }

  // Bodyweight or unloaded work: progress by reps or seconds held, never weight.
  if (last.weightKg === undefined) {
    // A hold either logged seconds last time or reads as one by name (a plank
    // with no seconds yet). Tagged so the row shows the Secs field and its
    // progression reads in seconds, not reps.
    const isHold = last.holdSeconds !== undefined || isHoldName(base.name);
    const holdTag = isHold ? { kind: 'hold' as const } : {};
    const eachSide = perSide ? ' each side' : '';
    if (effort.failed) {
      return {
        ...context,
        ...holdTag,
        action: 'hold',
        rationale: `Last time was a struggle — repeat ${describeVolume(last)} before adding anything.`,
      };
    }
    if ((effort.rir ?? 0) >= 2) {
      // A timed hold gains seconds; a rep movement gains reps.
      if (last.holdSeconds !== undefined) {
        return {
          ...context,
          ...holdTag,
          holdSeconds: last.holdSeconds + 10,
          action: 'add-time',
          rationale: `Had more in reserve — add 10 seconds a set${eachSide}.`,
        };
      }
      return {
        ...context,
        ...holdTag,
        reps: (reps ?? 8) + 2,
        action: 'add-reps',
        rationale: `Had about ${effort.rir} reps in reserve — add a couple of reps a set${eachSide}.`,
      };
    }
    return {
      ...context,
      ...holdTag,
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

  // The volume clause in words, built from what was actually logged — never a
  // fabricated "3 × 8". Omitted entirely when neither reps nor a hold is known
  // (a weighted carry, say), so the rationale doesn't invent one.
  const volumeWords = describeVolumeWords(last);

  if (effort.failed) {
    return {
      ...context,
      action: 'hold',
      weightKg: last.weightKg,
      rationale: volumeWords
        ? `Stay at ${last.weightKg}kg until you complete all ${volumeWords}.`
        : `Stay at ${last.weightKg}kg until every set is complete.`,
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
          ? `You said to go up — try ${next}kg${volumeWords ? ` for ${volumeWords}` : ''}.`
          : `About ${rir} reps left in reserve at ${last.weightKg}kg — try ${next}kg${volumeWords ? ` for ${volumeWords}` : ' for the same'}.`,
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
  const side = point.perSide ? ' each side' : '';
  if (point.sets && point.reps) return `${point.sets}×${point.reps}${side}`;
  if (point.sets && point.holdSeconds) return `${point.sets}×${point.holdSeconds}s${side}`;
  if (point.holdSeconds) return `${point.holdSeconds}s`;
  return 'the same';
}

// The volume clause in prose ("3 sets of 8", "3 × 30s", "45s"), with "each side"
// appended for unilateral work. Null when there is no set/rep/hold detail to
// state — the caller then omits the clause rather than inventing "3 × 8".
function describeVolumeWords(point: {
  sets?: number;
  reps?: number;
  holdSeconds?: number;
  perSide?: boolean;
}): string | null {
  let words: string | null = null;
  if (point.sets && point.reps) words = `${point.sets} sets of ${point.reps}`;
  else if (point.sets && point.holdSeconds) words = `${point.sets} × ${point.holdSeconds}s`;
  else if (point.holdSeconds) words = `${point.holdSeconds}s`;
  if (words && point.perSide) words += ' each side';
  return words;
}

// Targets for a session, most-relevant first.
//
// `components` is the plan for the day ("Push (chest & arms)", "Run (2 km)"):
// exercises are matched to it so a push day suggests presses, not leg work. With
// no plan, the most-trained exercises are offered instead.
export function buildSessionTargets(
  progressions: ExerciseProgression[],
  components: string[] = [],
  limit = 8,
  options: SelectOptions = {}
): ExerciseTarget[] {
  return orderTargets(
    selectPlanProgressions(progressions, components, limit, options).map(buildTarget),
    components
  );
}

// Resistance-band exercises are a home-workout tool: never part of a planned GYM
// session (they only appear in the log from the occasional home fallback), but
// they are the PRIMARY tool of a HOME session. The word boundary keeps "Band
// rows"/"band-assisted pull-ups" in while leaving "broadband" (no boundary) out.
export function isBandExercise(name: string): boolean {
  return /\bband\b/i.test(name);
}

// Names that read as GYM-ONLY equipment — a loaded machine, cable, barbell or
// dumbbell lift that can't be done at home with bands, a pull-up bar and
// bodyweight. Used to strip a home session's vocabulary down to what the
// equipment can actually make; the AI programmer substitutes a band/bodyweight
// stand-in for each gym-only routine anchor instead. Cardio (a run) is NOT
// gym-only — running needs no equipment — so "Treadmill run" is deliberately
// left in: a home session keeps the same run, done outdoors.
export function isGymOnlyExercise(name: string): boolean {
  return /\b(machine|cable|barbell|dumbbell|db|smith|leg press|leg extension|leg curl|hack squat|pulldown|pull-?down|pec deck|pec-deck|pec fly|chest fly|fly|flye|chest press|converging|hammer strength|lat raise machine)\b/i.test(
    name
  );
}

// Whether an exercise can be done in a home session — bands, a pull-up bar and
// bodyweight. Two signals combine: the NAME must not read as gym-only equipment,
// and the HISTORY must not be loaded (any logged weightKg means it needs plates,
// a stack or dumbbells). Band and bodyweight work never carries an external
// weight, so the loaded signal is a robust catch for gym lifts a name misses
// (a "Pec fly" logged at 27kg). Cardio is judged separately by the caller.
export function isHomeStrengthExercise(name: string, points: ProgressionPoint[] = []): boolean {
  if (isGymOnlyExercise(name)) return false;
  return !points.some(p => p.weightKg !== undefined);
}

// Options shared by the plan-selection paths: which venue the session is done at.
// Absent venue (the default) is the gym; 'home' keeps band/bodyweight work and
// strips gym-only equipment out of the vocabulary.
export interface SelectOptions {
  venue?: 'home';
}

// The exercises a session's plan implies, most-relevant first and capped. Shared
// by the deterministic targets and the AI programmer's input so both reason over
// the same set of lifts.
export function selectPlanProgressions(
  progressions: ExerciseProgression[],
  components: string[] = [],
  limit = 8,
  options: SelectOptions = {}
): ExerciseProgression[] {
  // Gym vs home decides the eligible vocabulary. A GYM session drops band
  // exercises (a home-workout last resort, never programmed into the gym). A
  // HOME session does the opposite: it KEEPS band and bodyweight work and drops
  // gym-only equipment (machines, cables, barbells, dumbbells) that can't be done
  // at home — cardio is kept either way, running needs no equipment. The
  // routine's fixed anchors/staples are added by callers separately and stay
  // unfiltered (the model needs them to know what to substitute for).
  const eligible =
    options.venue === 'home'
      ? // Home: cardio done OUTDOORS (a treadmill is gym kit — dropped), plus band
        // and bodyweight strength (never gym-only by name, never loaded).
        progressions.filter(
          p =>
            (isCardioName(p.name) && !/treadmill/i.test(p.name)) ||
            isHomeStrengthExercise(p.name, p.points)
        )
      : progressions.filter(p => !isBandExercise(p.name));
  if (components.length === 0) return eligible.slice(0, limit);
  const relevant = filterToPlan(eligible, components);
  const groups = activeGroups(components);
  // A single-group day (or an unfamiliar plan with no recognised group) keeps the
  // caller's flat limit — today's behaviour. A COMBINED day (Pull + Legs) treats
  // each group as its own mini-session: every group gets its own budget and the
  // day's total is their sum, so a combined day is deliberately longer than a
  // single-group day rather than squeezing both groups into one shared cap.
  if (groups.length <= 1) return relevant.slice(0, limit);
  return selectPerGroup(relevant, groups);
}

// The groups the day's components activate, in first-seen order, de-duplicated.
export function activeGroups(components: string[]): Group[] {
  const groups: Group[] = [];
  for (const component of components) {
    for (const group of componentGroups(component)) {
      if (!groups.includes(group)) groups.push(group);
    }
  }
  return groups;
}

// Per-group candidate budgets for a combined day. Each strength group gets the
// fuller budget so it is programmed as a proper mini-session; core is capped
// lower — it is accessory work, not a group to fill out, so it never balloons.
const STRENGTH_GROUP_BUDGET = 6;
const CORE_GROUP_BUDGET = 4;

function groupBudget(group: Group): number {
  return group === 'core' ? CORE_GROUP_BUDGET : STRENGTH_GROUP_BUDGET;
}

// Select each active group's most-trained exercises up to that group's own
// budget, independently — no shared cap, so no group crowds another out and the
// total grows with the number of groups. The result keeps overall-frequency
// order so downstream ordering (cardio first, then the rest) is unchanged.
function selectPerGroup(
  relevant: ExerciseProgression[],
  groups: Group[]
): ExerciseProgression[] {
  const byGroup = new Map<Group, ExerciseProgression[]>();
  for (const group of groups) byGroup.set(group, []);
  for (const p of relevant) {
    const group = classifyExercise(p.name);
    if (group && byGroup.has(group)) byGroup.get(group)!.push(p);
  }

  const taken = new Set<string>();
  for (const group of groups) {
    for (const p of byGroup.get(group)!.slice(0, groupBudget(group))) taken.add(p.key);
  }
  return relevant.filter(p => taken.has(p.key));
}

// The cardio words a plan/routine component can use to name which piece the
// session wants, most-specific first so "treadmill" wins over the bare "run"
// both a treadmill and an outdoor run share.
const CARDIO_MATCH_WORDS = [
  'treadmill',
  'parkrun',
  'outdoor',
  'track',
  'elliptical',
  'erg',
  'rower',
  'rowing',
  'bike',
  'cycle',
  'swim',
  'run',
];

// At most ONE cardio piece leads the session. Prefer the cardio whose name
// echoes the plan/routine wording (components say "treadmill" → Treadmill run);
// with no such steer, keep the most-trained — which, since progressions arrive
// most-trained first, is simply the first cardio.
function pickCardio(cardio: ExerciseTarget[], components: string[]): ExerciseTarget {
  const text = components.join(' ').toLowerCase();
  for (const word of CARDIO_MATCH_WORDS) {
    if (!text.includes(word)) continue;
    const hit = cardio.find(t => t.name.toLowerCase().includes(word));
    if (hit) return hit;
  }
  return cardio[0];
}

// Run/treadmill first, everything else in its original order — a warm-up run
// leads the session, not a chest press. A stable partition, so the relative
// order within each group is preserved. Only ONE cardio piece survives (see
// pickCardio): the rest are dropped so a session never carries two runs.
function orderTargets(targets: ExerciseTarget[], components: string[] = []): ExerciseTarget[] {
  const isCardio = (t: ExerciseTarget) => t.kind === 'cardio';
  const cardio = targets.filter(isCardio);
  const rest = targets.filter(t => !isCardio(t));
  const lead = cardio.length > 0 ? [pickCardio(cardio, components)] : [];
  return [...lead, ...rest];
}

// A muscle group a plan day can call for.
export type Group = 'run' | 'core' | 'legs' | 'pull' | 'push';

// The words in an exercise NAME that classify it into a group. Ordered
// most-specific first: an exercise is assigned to the FIRST group whose words it
// matches, so "Leg press" lands in legs (not push's \bpress\b), "Reverse pec
// deck" in pull (not push's \bpec\b), and "High plank shoulder taps" in core
// (not push's \bshoulder\b). push is the catch-all and must come last.
const CLASSIFY: Array<[Group, RegExp]> = [
  ['run', /\b(run|treadmill|parkrun|jog|cardio)\b/i],
  ['core', /\b(plank|dead ?bug|core|abs?|knee raise|pallof|paloff|shoulder taps?|sit-?ups?|crunch|hollow|hanging leg)\b/i],
  // A glute BRIDGE is core work in Dave's book (single-leg glute bridge too),
  // even though the rest of the glute work — hip thrust, kickbacks — is legs.
  // Must precede the legs entry, whose \bglute\b would otherwise claim it.
  ['core', /\bglute bridge\b/i],
  ['legs', /\b(squat|legs?|lunge|glute|calf|calves|hamstring|quad|deadlift|hip thrust|step-?up|leg press|leg extension|leg curl)\b/i],
  ['pull', /\b(row|pulldown|pull-?ups?|pullups?|chin|curl|shrug|rear delt|pec deck|lats?|face pull|y raise|dead hang)\b/i],
  ['push', /\b(press|push|fly|flye|dip|tricep|pushdown|lateral raise|crossover|shoulders?|chest|pec)\b/i],
];

// The words in a plan COMPONENT that activate a group. Unambiguous by design:
// "arms" is dropped from both push and pull because "Pull (back & arms)" and
// "Push (chest & arms)" both contain it, so it can't disambiguate a day.
// Evaluated per component (not on the joined text) so one component's words
// can't leak into another's activation.
const ACTIVATE: Array<[Group, RegExp]> = [
  ['pull', /\b(pull|back|rows?|lats?)\b/i],
  ['push', /\b(push|chest|shoulders?|press)\b/i],
  ['legs', /\b(legs?|lower body)\b/i],
  ['core', /\b(core|abs?)\b/i],
  ['run', /\b(run|parkrun|track|cardio)\b/i],
];

// The single group an exercise name belongs to, by CLASSIFY precedence, or null
// when nothing matches (an unfamiliar name — kept only via the empty-set
// fallback, never force-fitted into a group).
export function classifyExercise(name: string): Group | null {
  for (const [group, re] of CLASSIFY) {
    if (re.test(name)) return group;
  }
  return null;
}

// The groups a plan COMPONENT ("Push (shoulders)", "Pull (back)") activates by
// its words — the component side of classifyExercise. Exported for the
// completed-label derivation, which needs to know which logged exercises answer
// to which planned component. Empty for a component with no recognised group
// word (yoga, climb, footy), which the caller reads as "unmappable, keep as-is".
export function componentGroups(component: string): Group[] {
  const groups: Group[] = [];
  for (const [group, re] of ACTIVATE) {
    if (re.test(component)) groups.push(group);
  }
  return groups;
}

function filterToPlan(
  progressions: ExerciseProgression[],
  components: string[]
): ExerciseProgression[] {
  const wanted = new Set<Group>();
  for (const component of components) {
    for (const [group, re] of ACTIVATE) {
      if (re.test(component)) wanted.add(group);
    }
  }

  if (wanted.size === 0) return progressions;

  // An exercise is kept only when its OWN group is one the plan wants — so a
  // "Leg press" on a pull day is excluded, not swept in on a shared word.
  const matches = progressions.filter(p => {
    const group = classifyExercise(p.name);
    return group !== null && wanted.has(group);
  });
  // Never return an empty list because the plan used unfamiliar words — falling
  // back to the full list is more useful than showing nothing.
  return matches.length > 0 ? matches : progressions;
}
