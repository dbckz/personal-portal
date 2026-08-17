// LEGACY prescription types.
//
// Planned sessions used to inherit their content from hand-written Google
// Calendar event descriptions, parsed into these sectioned shapes. The calendar
// is timing-only now (see exercise-calendar.ts): descriptions are ignored and
// session content is generated from the weekly routine plus history (see
// exercise-programmer.ts). The PARSING is gone, but the TYPES remain because
// past/completed sessions in storage still carry a `prescription` on their
// record (harmless history), and `types/life.ts` types that field against
// `PrescribedSection`.

// One prescribed exercise. Any of the volume measures may be absent. Rep and
// hold targets are RANGES — "3 x 8–12".
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
  // True when the exercise sat in an "Anchors" section.
  isAnchor?: boolean;
}

// One section of a stored prescription — "Anchors", "Core" — with its exercises
// in written order.
export interface PrescribedSection {
  title: string;
  note?: string;
  isAnchor?: boolean;
  exercises: PrescribedExercise[];
}
