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
}

export interface RowSection<T> {
  title: string;
  rows: T[];
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
