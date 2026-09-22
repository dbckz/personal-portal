// Grouping today's checklist rows into sections, so the workout reads as the
// coach wrote it rather than one flat list.
//
// Two modes, one shape out:
//   - With a PRESCRIPTION, the rows already carry their section ("Anchors",
//     "This week's accessories", "Core"); they are grouped by it, in first-seen
//     order, with anchors leading by construction. Rows with no section (added
//     on the spot) fall to an "Other" section at the end.
//   - WITHOUT one, rows are classified by name into Run / Pull / Push / Legs /
//     Core (only the non-empty ones, cardio first), and within each section the
//     staples (the driven-up lifts, kind 'core') sit at the top.
//   - On a SUPERSET day (any row carries a pair tag) neither applies: the rows
//     keep the programme's order — the order to do them in — and each pair's two
//     halves sit together in its own "Superset N" section, a before b. Unpaired
//     rows (calves, the run, anything added on the spot) keep their place.
//
// Both checklists (mobile and desktop) render from this, so the layout can't
// drift between them.

import { classifyExercise, type ExerciseKind } from './exercise-targets';

// The minimum a row needs to be placed. Kept structural (not tied to the Today
// hook's TodayRow) so this stays a pure lib the components share.
export interface SectionableRow {
  name: string;
  kind?: ExerciseKind;
  section?: string;
  isAnchor?: boolean;
  // The one accessory taken to failure. Rendered in its own trailing "Finisher"
  // section so it always reads last, never buried in the muscle-group section its
  // name would otherwise sort it into.
  toFailure?: boolean;
  // Antagonist-superset membership (1-based index, a/b half).
  pair?: { index: number; slot: 'a' | 'b' };
}

export interface RowSection<T> {
  title: string;
  rows: T[];
  // A superset: the rows are done back-to-back, so the checklist binds them.
  superset?: boolean;
}

const OTHER = 'Other';
const FINISHER = 'Finisher';

// Classify-group → section heading, in the order the sections are shown.
const CLASSIFY_SECTIONS: Array<{ group: ReturnType<typeof classifyExercise>; title: string }> = [
  { group: 'run', title: 'Run' },
  { group: 'pull', title: 'Pull' },
  { group: 'push', title: 'Push' },
  { group: 'legs', title: 'Legs' },
  { group: 'core', title: 'Core' },
];

export function groupRowsIntoSections<T extends SectionableRow>(rows: T[]): RowSection<T>[] {
  if (rows.some(r => r.pair)) return groupBySuperset(rows);
  // The finisher (a to-failure accessory) is lifted out of the muscle-group /
  // prescription grouping and rendered in its own section that always trails the
  // rest, so it reads last however its name would otherwise classify.
  const finishers = rows.filter(r => r.toFailure);
  const rest = rows.filter(r => !r.toFailure);
  const sections = rest.some(r => r.section)
    ? groupByPrescription(rest)
    : groupByClassification(rest);
  if (finishers.length) sections.push({ title: FINISHER, rows: finishers });
  return sections;
}

// Staples (kind 'core') first, everything else after, order otherwise preserved.
function staplesFirst<T extends SectionableRow>(rows: T[]): T[] {
  return [...rows.filter(r => r.kind === 'core'), ...rows.filter(r => r.kind !== 'core')];
}

function groupByPrescription<T extends SectionableRow>(rows: T[]): RowSection<T>[] {
  const order: string[] = [];
  const byTitle = new Map<string, T[]>();
  for (const row of rows) {
    const title = row.section ?? OTHER;
    if (!byTitle.has(title)) {
      byTitle.set(title, []);
      order.push(title);
    }
    byTitle.get(title)!.push(row);
  }
  // "Other" (rows added on the spot) always trails the prescribed sections.
  const titles = order.filter(t => t !== OTHER);
  if (byTitle.has(OTHER)) titles.push(OTHER);
  return titles.map(title => ({ title, rows: byTitle.get(title)! }));
}

function groupByClassification<T extends SectionableRow>(rows: T[]): RowSection<T>[] {
  const byGroup = new Map<string, T[]>();
  const other: T[] = [];
  for (const row of rows) {
    const group = classifyExercise(row.name);
    if (group) (byGroup.get(group) ?? byGroup.set(group, []).get(group)!).push(row);
    else other.push(row);
  }

  const sections: RowSection<T>[] = [];
  for (const { group, title } of CLASSIFY_SECTIONS) {
    const bucket = group ? byGroup.get(group) : undefined;
    if (bucket?.length) sections.push({ title, rows: staplesFirst(bucket) });
  }
  if (other.length) sections.push({ title: OTHER, rows: staplesFirst(other) });
  return sections;
}

// A superset day, in the order to do it. Each pair becomes one section, placed
// where its first half appears, with a before b even if they arrived apart.
// Consecutive unpaired rows form a block titled by position: "First" ahead of
// the first superset (a parkrun before the lifts), "Then" after one. The
// finisher stays in place here — it is a pair half or the calf row, and the
// order already puts it where it is done.
function groupBySuperset<T extends SectionableRow>(rows: T[]): RowSection<T>[] {
  const sections: RowSection<T>[] = [];
  const emitted = new Set<number>();
  let loose: T[] = [];
  const flushLoose = () => {
    if (!loose.length) return;
    sections.push({ title: emitted.size ? 'Then' : 'First', rows: loose });
    loose = [];
  };
  for (const row of rows) {
    if (!row.pair) {
      loose.push(row);
      continue;
    }
    const { index } = row.pair;
    if (emitted.has(index)) continue;
    flushLoose();
    emitted.add(index);
    const halves = rows
      .filter(r => r.pair?.index === index)
      .sort((x, y) => x.pair!.slot.localeCompare(y.pair!.slot));
    sections.push({ title: `Superset ${index}`, rows: halves, superset: true });
  }
  flushLoose();
  // Section titles double as React keys: a second "Then" block (unpaired rows
  // both between supersets and after them) needs a distinct title.
  const seen = new Map<string, number>();
  for (const section of sections) {
    const n = (seen.get(section.title) ?? 0) + 1;
    seen.set(section.title, n);
    if (n > 1) section.title = `${section.title} (${n})`;
  }
  return sections;
}
