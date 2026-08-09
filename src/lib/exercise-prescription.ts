// Parsing a planned session's full "prescription" out of its calendar event
// DESCRIPTION.
//
// A plan title ("🏋️ Pull (back & arms) + core") says which day it is; the
// event's DESCRIPTION says exactly what to do that day, written by hand as
// sectioned bullet lists:
//
//   Pull B — back width & arms.
//
//   Anchors (drive these up, log & beat last week):
//   - Seated cable row: 3 x 8–12
//   - Neutral-grip lat pulldown: 3 x 8–12
//
//   This week's accessories:
//   - Reverse pec deck (rear delts): 3 x 15
//   ...
//
//   Core (proper session, ~15–20 min):
//   - Side plank: 3 x 30–45 sec each side
//
// The parse is best-effort and NEVER destructive: a line whose scheme can't be
// read is still kept (as a name-only item), because a dropped exercise is worse
// than one with no numbers. The whole thing is pure — no I/O — so the sync can
// run it on every pull and the recommender can reason over its output.

// One prescribed exercise. Any of the volume measures may be absent (a line with
// no readable scheme keeps only its name). Rep and hold targets are RANGES —
// "3 x 8–12" — because the prescription is written that way and the recommender
// does double progression against the top of the range.
export interface PrescribedExercise {
  name: string;
  sets?: number;
  repsMin?: number;
  repsMax?: number;
  holdSecondsMin?: number;
  holdSecondsMax?: number;
  // "each side" — the volume is per side, not a total.
  perSide?: boolean;
  // A parenthetical aside on the line ("(rear delts)", "(rest 60s)").
  note?: string;
  // True when the exercise sits in an "Anchors" section — a lift to drive up and
  // beat week to week, as opposed to a rotating accessory.
  isAnchor?: boolean;
}

// One section of the prescription — "Anchors", "This week's accessories",
// "Core" — with its own optional aside and its exercises in written order.
export interface PrescribedSection {
  title: string;
  note?: string;
  isAnchor?: boolean;
  exercises: PrescribedExercise[];
}

export interface ParsedPrescription {
  // The leading free-text line ("Pull B — back width & arms."), kept as the
  // session's own note.
  sessionNote?: string;
  sections: PrescribedSection[];
}

// A bullet line: "- …", "• …", "* …".
const BULLET = /^[-•*]\s+/;

// The fallback section a bullet lands in when the description opens with
// exercises before any header. Real plans always lead with a header, so this is
// only a safety net.
const DEFAULT_SECTION_TITLE = 'Exercises';

// Split a trailing "(…)" aside off the end of a string: "Reverse pec deck (rear
// delts)" → { text: 'Reverse pec deck', note: 'rear delts' }.
function splitParenNote(s: string): { text: string; note?: string } {
  const m = s.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (m) return { text: m[1].trim(), note: m[2].trim() || undefined };
  return { text: s.trim() };
}

// Parse the "3 x 8–12" / "3 x 15" / "3 x 30–45 sec each side" scheme that
// follows the colon on an exercise line. Handles a rep range or a hold range
// (en dash OR hyphen), a single value, "sec" → hold, and "each side" → perSide.
function parseScheme(raw: string): Partial<PrescribedExercise> {
  const out: Partial<PrescribedExercise> = {};
  if (!raw.trim()) return out;

  if (/\b(?:each side|per side)\b/i.test(raw)) out.perSide = true;

  const setsBy = raw.match(/(\d+)\s*[x×]\s*(.+)/i);
  if (!setsBy) return out;
  out.sets = Number(setsBy[1]);
  const rest = setsBy[2];

  // A "sec"/"s" unit right after the count makes it a timed hold, not reps.
  const isHold = /\d\s*(?:secs?|seconds?|s)\b/i.test(rest);
  const range = rest.match(/(\d+)\s*[–—-]\s*(\d+)/);
  const single = rest.match(/(\d+)/);

  if (isHold) {
    if (range) {
      out.holdSecondsMin = Number(range[1]);
      out.holdSecondsMax = Number(range[2]);
    } else if (single) {
      out.holdSecondsMin = Number(single[1]);
      out.holdSecondsMax = Number(single[1]);
    }
  } else if (range) {
    out.repsMin = Number(range[1]);
    out.repsMax = Number(range[2]);
  } else if (single) {
    out.repsMin = Number(single[1]);
    out.repsMax = Number(single[1]);
  }

  return out;
}

// Parse one bullet line into an exercise. The name and its aside are before the
// first colon; the scheme is after it. A line with no colon (or no readable
// scheme) is kept as a name-only item rather than dropped.
function parseExerciseLine(content: string, sectionIsAnchor: boolean): PrescribedExercise {
  let namePart = content;
  let schemePart = '';

  const colon = content.indexOf(':');
  if (colon >= 0) {
    namePart = content.slice(0, colon).trim();
    schemePart = content.slice(colon + 1).trim();
  } else {
    // No colon: still try to peel a trailing "N x …" scheme off the end.
    const m = content.match(/^(.*?)[\s,]*(\d+\s*[x×]\s*\d.*)$/i);
    if (m) {
      namePart = m[1].trim();
      schemePart = m[2].trim();
    }
  }

  const { text: name, note } = splitParenNote(namePart);
  return {
    name,
    ...(note ? { note } : {}),
    ...parseScheme(schemePart),
    ...(sectionIsAnchor ? { isAnchor: true } : {}),
  };
}

// A non-bullet line ending in ':' starts a section. Its title may carry a
// trailing aside ("Anchors (drive these up …):"), and a title containing
// "anchor" marks the section (and its exercises) as anchors.
function parseSectionHeader(line: string): PrescribedSection {
  const { text, note } = splitParenNote(line.replace(/:\s*$/, '').trim());
  const title = text.trim();
  const isAnchor = /anchor/i.test(title);
  return {
    title: title || DEFAULT_SECTION_TITLE,
    ...(note ? { note } : {}),
    ...(isAnchor ? { isAnchor: true } : {}),
    exercises: [],
  };
}

// Parse a calendar event description into its prescription. Returns empty
// sections (and no session note) for an absent or blank description, so a plan
// with no prescription behaves exactly as one always has.
export function parsePrescription(description: string | undefined): ParsedPrescription {
  const lines = (description ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const sections: PrescribedSection[] = [];
  const preamble: string[] = [];
  let current: PrescribedSection | null = null;

  for (const line of lines) {
    if (BULLET.test(line)) {
      if (!current) {
        current = { title: DEFAULT_SECTION_TITLE, exercises: [] };
        sections.push(current);
      }
      current.exercises.push(parseExerciseLine(line.replace(BULLET, '').trim(), !!current.isAnchor));
      continue;
    }

    if (line.endsWith(':')) {
      current = parseSectionHeader(line);
      sections.push(current);
      continue;
    }

    // Free text: part of the leading preamble before any section, else a
    // name-only item kept inside the current section (never dropped).
    if (!current) {
      preamble.push(line);
    } else {
      current.exercises.push({ name: line, ...(current.isAnchor ? { isAnchor: true } : {}) });
    }
  }

  const sessionNote = preamble.join(' ').trim();
  return {
    ...(sessionNote ? { sessionNote } : {}),
    sections,
  };
}

// True when a parsed prescription actually carries something to prescribe. The
// sync and the recommender both key off this rather than testing array lengths.
export function hasPrescribedExercises(sections: PrescribedSection[] | undefined): boolean {
  return !!sections?.some(s => s.exercises.length > 0);
}
