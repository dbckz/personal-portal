// Parsers for the two places exercise data already lives:
//
//   1. The training-log spreadsheet — one row per exercise, with free-text
//      volume ("3*8 each side") and load ("30kg (15 each side)") columns.
//   2. Planned sessions on the personal Google Calendar — all-day events like
//      "🏋️ Push (shoulders) + Run (2 km)".
//
// Both inputs are human-written and inconsistent by nature, so every parser
// keeps the ORIGINAL TEXT alongside whatever it managed to extract. A figure
// the parser can't read confidently is left undefined rather than guessed —
// a wrong weight in a training log is worse than a missing one.

import type { ExerciseEntry, ParsedPlannedSession, SheetSession } from '@/types/life';

// ---------------------------------------------------------------------------
// Volume: the "sets × reps" column
// ---------------------------------------------------------------------------

export interface ParsedVolume {
  sets?: number;
  reps?: number;
  holdSeconds?: number;
  perSide?: boolean;
  distanceKm?: number;
  durationMinutes?: number;
}

const NUM = String.raw`\d+(?:\.\d+)?`;

// "3*8", "3 * 10", "2*12"                     → sets × reps
// "3*30 secs", "1*60 secs"                    → sets × a timed hold
// "… each side"                               → doubles as a per-side marker
// "2km", "2.5 km"                             → a distance
// "10 mins", "9.5 for 10 mins on treadmill"   → a duration
export function parseVolume(raw: string | undefined): ParsedVolume {
  const text = (raw ?? '').trim();
  if (!text) return {};

  const out: ParsedVolume = {};
  if (/each\s+side/i.test(text)) out.perSide = true;

  const setsBy = text.match(new RegExp(String.raw`(${NUM})\s*\*\s*(${NUM})`));
  if (setsBy) {
    out.sets = Number(setsBy[1]);
    // "3*30 secs" is a hold, not 30 repetitions. The unit word decides.
    const afterCount = text.slice((setsBy.index ?? 0) + setsBy[0].length);
    if (/^\s*(secs?|seconds?)/i.test(afterCount)) {
      out.holdSeconds = Number(setsBy[2]);
    } else {
      out.reps = Number(setsBy[2]);
    }
  }

  // A distance only counts with an explicit km unit — a bare number here is
  // just as likely to be a treadmill speed.
  const distance = text.match(new RegExp(String.raw`(${NUM})\s*km\b`, 'i'));
  if (distance) out.distanceKm = Number(distance[1]);

  const minutes = text.match(new RegExp(String.raw`(${NUM})\s*(?:mins?|minutes?)\b`, 'i'));
  if (minutes) out.durationMinutes = Number(minutes[1]);

  return out;
}

// Words in an exercise NAME that mark it as a cardio piece — a run, a swim, a
// row on the erg — rather than a loaded lift. Used to decide which logging
// fields a row shows (distance/time vs sets/reps/kg) and reuses the same
// cardio vocabulary the plan parsers already lean on (run/cycle/bike/swim…),
// widened for the machines Dave logs by name (treadmill, erg, elliptical).
//
// Deliberately excludes a bare "row": on its own that is far more often a
// strength row (seated row, bent-over row) than the rowing machine, so only the
// unambiguous "rower"/"rowing"/"erg" catch the ergometer.
const CARDIO_NAME_WORDS =
  /\b(run|running|jog|jogging|parkrun|treadmill|walk|walking|hike|hiking|cycle|cycling|bike|biking|spin|swim|swimming|rowing|rower|erg|ergometer|elliptical|cross[-\s]?trainer|cardio|track)\b/i;

// "Walk" is the ambiguous one: a farmer's walk, walking lunge, suitcase/waiter
// carry are loaded strength movements, not cardio. When the name reads as one of
// those, "walk" must not win.
const LOADED_CARRY_WORDS = /\b(lunge|farmer|carry|suitcase|waiter)\b/i;

// True when an exercise NAME reads as cardio (a run, treadmill, swim, erg row).
export function isCardioName(name: string | undefined): boolean {
  const text = (name ?? '').trim();
  if (LOADED_CARRY_WORDS.test(text)) return false;
  return CARDIO_NAME_WORDS.test(text);
}

// Words in an exercise NAME that mark it as an isometric HOLD — a plank, a hang,
// a wall sit — progressed by seconds held per set, not reps or added load. Used
// (alongside a logged holdSeconds and the AI programmer's 'hold' kind) to decide
// which logging fields a row shows and how its progression reads.
//
// "hold" is included as a general catch ("dead hang hold", "chin-up hold"); the
// specific words come first so a "side plank" or "wall sit" is caught by name
// even when no seconds have been logged yet.
const HOLD_NAME_WORDS = /\b(plank|hang|wall\s?sit|l[-\s]?sit|hollow hold|hold)\b/i;

// True when an exercise NAME reads as a timed hold (plank, hang, wall sit).
// Deliberately narrow: "Dead bug", "Bird dog" and other slow bodyweight work
// are NOT holds — they are rep-based, so they must not be swept in here.
export function isHoldName(name: string | undefined): boolean {
  const text = (name ?? '').trim();
  if (!text) return false;
  return HOLD_NAME_WORDS.test(text);
}

// Words in an exercise NAME that mark it as UNILATERAL — worked one side at a
// time, so its sets/reps (or seconds) are "each side" rather than a total.
// Kept sensible rather than exhaustive: it should catch the obvious single-limb
// and anti-rotation movements without mislabelling a plain squat or bench press.
const UNILATERAL_NAME_WORDS =
  /\b(side plank|shoulder taps?|single[-\s](?:arm|leg)|one[-\s](?:arm|leg)|split squat|bulgarian|step[-\s]?ups?|lunges?|pistol squat|pallof|paloff|each side|per side)\b/i;

// True when an exercise NAME reads as unilateral (side plank, single-arm row,
// Bulgarian split squat, Pallof press). Used to mark seeded entries and targets
// "each side" so the guidance and the log both say which it is.
export function isUnilateralName(name: string | undefined): boolean {
  const text = (name ?? '').trim();
  if (!text) return false;
  return UNILATERAL_NAME_WORDS.test(text);
}

// ---------------------------------------------------------------------------
// Load: the "weight" column
// ---------------------------------------------------------------------------

export interface ParsedLoad {
  weightKg?: number;
  bodyweight?: boolean;
}

// "27kg", "34.3kg"            → a weight
// "30kg (15 each side)"       → the TOTAL, which is what the log means
// "Bodyweight"                → no external load
// "NA", "", "9.2"             → nothing usable; a bare number is ambiguous
//                               (it was a treadmill speed at least once), so it
//                               is deliberately not read as a weight.
export function parseLoad(raw: string | undefined): ParsedLoad {
  const text = (raw ?? '').trim();
  if (!text) return {};
  if (/^bodyweight$/i.test(text)) return { bodyweight: true };

  const kg = text.match(new RegExp(String.raw`(${NUM})\s*kg\b`, 'i'));
  if (kg) return { weightKg: Number(kg[1]) };

  return {};
}

// ---------------------------------------------------------------------------
// The spreadsheet
// ---------------------------------------------------------------------------

// "11/07", "29/07/26", "2/8/26", "28/07/2026 Home workout"
//
// Always day-first. The year may be absent, two-digit or four-digit; a trailing
// word or two is a session label ("Home workout"), not part of the date.
export function parseSheetDate(
  raw: string,
  defaultYear: number
): { date: string; label?: string } | null {
  const text = raw.trim();
  const match = text.match(/^(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{4}|\d{2}))?\s*(.*)$/);
  if (!match) return null;

  const [, dayStr, monthStr, yearStr, rest] = match;
  const day = Number(dayStr);
  const month = Number(monthStr);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  let year = defaultYear;
  if (yearStr) year = yearStr.length === 2 ? 2000 + Number(yearStr) : Number(yearStr);

  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const label = rest.trim();
  return label ? { date, label } : { date };
}

export interface SheetRow {
  dateCell: string;
  name: string;
  volume: string;
  load: string;
  notes: string;
}

// Group the flat spreadsheet rows into sessions. The date cell is only filled on
// a session's FIRST row; blank means "same session as above", which is why this
// is a fold rather than a map.
//
// Rows before any date, and rows with no exercise name, are skipped — those are
// header rows and spacers.
export function parseSheetRows(rows: SheetRow[], defaultYear: number): SheetSession[] {
  const sessions: SheetSession[] = [];
  let current: SheetSession | null = null;

  for (const row of rows) {
    const dateCell = row.dateCell.trim();
    if (dateCell) {
      const parsed = parseSheetDate(dateCell, defaultYear);
      if (parsed) {
        current = {
          date: parsed.date,
          ...(parsed.label ? { label: parsed.label } : {}),
          exercises: [],
        };
        sessions.push(current);
      }
    }

    const name = row.name.trim();
    if (!current || !name) continue;
    current.exercises.push(buildEntry(row));
  }

  return sessions;
}

function buildEntry(row: SheetRow): Omit<ExerciseEntry, 'id'> {
  const volume = parseVolume(row.volume);
  const load = parseLoad(row.load);
  return {
    name: row.name.trim(),
    ...(row.volume.trim() ? { volumeText: row.volume.trim() } : {}),
    ...(row.load.trim() ? { loadText: row.load.trim() } : {}),
    ...volume,
    ...load,
    ...(row.notes.trim() ? { notes: row.notes.trim() } : {}),
  };
}

// The sheet is read as a markdown table. Splitting it here (rather than in the
// import route) keeps the whole sheet→sessions path testable without Drive.
export function parseSheetMarkdown(markdown: string, defaultYear: number): SheetSession[] {
  const rows: SheetRow[] = [];

  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    // The alignment row (| :-: | :-: |) carries no data.
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;

    const cells = line.split('|').slice(1, -1).map(c => c.replace(/\\/g, '').trim());
    if (cells.length < 2) continue;
    if (cells.every(c => c === '')) continue;

    rows.push({
      dateCell: cells[0] ?? '',
      name: cells[1] ?? '',
      volume: cells[2] ?? '',
      load: cells[3] ?? '',
      notes: cells[4] ?? '',
    });
  }

  return parseSheetRows(rows, defaultYear);
}

// ---------------------------------------------------------------------------
// Planned sessions on the calendar
// ---------------------------------------------------------------------------

// Words that mark a component as real training rather than an errand. A title
// must contain at least one of these to count — which is what keeps
// "🏋️ Change gym membership" out of the log even though it wears the emoji.
const TRAINING_WORDS = [
  'push',
  'pull',
  'legs',
  'leg',
  'core',
  'run',
  'parkrun',
  'chest',
  'back',
  'arms',
  'shoulders',
  'glutes',
  'abs',
  'cardio',
  'swim',
  'cycle',
  'bike',
  'yoga',
  'stretch',
  'mobility',
  'climb',
  'footy',
  'football',
  'track',
];

const PLANNED_PREFIXES = ['🏋️', '🏋', '🏃', '🚴', '🏊', '🧘'];

function stripPrefix(title: string): { body: string; hadPrefix: boolean } {
  let body = title.trim();
  let hadPrefix = false;
  for (const prefix of PLANNED_PREFIXES) {
    if (body.startsWith(prefix)) {
      body = body.slice(prefix.length).trim();
      hadPrefix = true;
      break;
    }
  }
  // Variation selectors and skin-tone modifiers can linger after the base glyph.
  return { body: body.replace(/^[️‍\s]+/, ''), hadPrefix };
}

// Parse "🏋️ Push (shoulders) + Run (2 km)" into its components, pulling out a
// target distance where one is given. Returns null when the title is not a
// training session (no emoji prefix, or no recognised training word).
export function parsePlannedTitle(title: string): ParsedPlannedSession | null {
  const { body, hadPrefix } = stripPrefix(title);
  if (!hadPrefix || !body) return null;

  const lower = body.toLowerCase();
  if (!TRAINING_WORDS.some(word => new RegExp(`\\b${word}\\b`).test(lower))) return null;

  const components = body
    .split('+')
    .map(part => part.trim())
    .filter(Boolean);

  const distance = body.match(new RegExp(String.raw`(${NUM})\s*km\b`, 'i'));

  // "Push (shoulders) + Run" is a strength session with a run bolted on, not a
  // run — so both halves are tested rather than letting the word "run" win.
  const hasCardio = /\b(run|parkrun|track|cycle|bike|swim)\b/i.test(body);
  const hasStrength = /\b(push|pull|legs?|core|chest|back|arms|shoulders|glutes|abs)\b/i.test(body);

  return {
    title: body,
    components,
    ...(distance ? { targetDistanceKm: Number(distance[1]) } : {}),
    type: hasCardio && hasStrength ? 'strength + cardio' : hasCardio ? 'run' : 'strength',
  };
}

// Generic words that only mark a TIMED slot as exercise, never a plan: "Gym",
// "Workout". Too vague to seed a session from, but fine for recognising the
// calendar slot a planned session was actually done in.
const TIMED_ONLY_WORDS = ['gym', 'workout', 'session', 'training', 'lift', 'weights'];

// Recognise a TIMED event ("🏋️ Gym", "🏃 Track @Southwark Park") as the slot an
// existing plan was done in, and classify it the same way parsePlannedTitle does.
//
// Deliberately looser than parsePlannedTitle: a bare "🏋️ Gym" carries no
// muscle-group word, so it is no good as a PLAN (it would be indistinguishable
// from "🏋️ Change gym membership"), but it is a perfectly good duration source
// for a plan that already exists that day — enrichment can only fill a blank on
// an existing session, never create one, so the weaker signal is safe here.
export function parseTimedExerciseTitle(title: string): { type: string } | null {
  const { body, hadPrefix } = stripPrefix(title);
  if (!hadPrefix || !body) return null;

  const lower = body.toLowerCase();
  const words = [...TRAINING_WORDS, ...TIMED_ONLY_WORDS];
  if (!words.some(word => new RegExp(`\\b${word}\\b`).test(lower))) return null;

  const hasCardio = /\b(run|parkrun|track|cycle|bike|swim)\b/i.test(body);
  const hasStrength =
    /\b(push|pull|legs?|core|chest|back|arms|shoulders|glutes|abs|gym|workout|lift|weights)\b/i.test(
      body
    );
  return { type: hasCardio && hasStrength ? 'strength + cardio' : hasCardio ? 'run' : 'strength' };
}
