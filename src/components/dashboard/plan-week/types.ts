import type { PriorityMatchRow } from '@/lib/api';
import type { ProposedBlock } from '@/lib/scheduling/types';

export type Step = 'type' | 'location' | 'priorities' | 'reminders' | 'prep' | 'tasks' | 'review' | 'done';

export const STEP_LABELS: Record<Exclude<Step, 'done'>, string> = {
  type: 'Type',
  location: 'Location',
  priorities: 'Priorities',
  reminders: 'Reminders',
  prep: 'Prep',
  tasks: 'Tasks',
  review: 'Review',
};

// The 'priorities' step is really two screens the user pages through: an input
// phase (type your priorities) and a match-review phase. The header step dots
// give each its own dot, so the review phase needs its own label.
export const PRIORITIES_MATCH_LABEL = 'Review matches';

// Row state for the reminders-triage step: one Google Tasks reminder plus the
// user's (AI-seeded, fully editable) decision about whether to keep it as a
// reminder or convert it into an Asana task, and — when converting — the
// destination workspace/project/type/due and the editable name & notes.
export interface ReminderTriageRow {
  // Google Task id, or `cal:<title>` for one derived from a recurring calendar
  // event. The prefix matters: a calendar-derived row has no Google Task behind
  // it, so it must never be sent to the Tasks API.
  id: string;
  name: string; // editable task name (prefilled from the reminder text)
  notes: string; // editable notes (prefilled from the reminder's notes)
  action: 'keep' | 'convert' | 'done' | 'delete';
  integrationId: string; // chosen Asana integration/workspace
  projectGid: string; // '' = no project
  taskType: string; // '' = no type / not applicable for this workspace
  dueOn: string; // yyyy-MM-dd, '' = no due date
  // Where the row came from. 'calendar' rows are standing reminders parked on
  // the calendar as a daily recurring event; they can only be kept or converted
  // (there is no reminder to complete or delete), and the source event is left
  // alone either way.
  source?: 'google-tasks' | 'calendar';
  // For a calendar row: how many days of the week it appears on, shown so the
  // pattern that makes it a nag is visible.
  occurrences?: number;
}

// A single untyped task, resolved with the Type labels we can write for it.
export interface UntypedTask {
  gid: string;
  integrationId: string;
  title: string;
  description?: string;
  integrationName?: string;
  allowedTypes: string[]; // exact labels we can write (Asana enum, or the local union)
  // Where a chosen label is written: 'asana' updates the task's Asana Type field;
  // 'local' saves it to the app-local Type store (for integrations with no
  // writable Asana Type field, e.g. DBC). Absent on older code paths → 'asana'.
  writeTarget?: 'asana' | 'local';
}

// Row state for the type-review step: an untyped task plus the currently chosen
// label ('' = leave untyped, i.e. don't write). `suggested` is the AI's original
// proposal, kept so applying can tell an override from an accepted suggestion
// (the override is the stronger learning signal).
export interface TypeRow extends UntypedTask {
  chosen: string;
  suggested?: string;
}

export interface EditableProposal extends ProposedBlock {
  accepted: boolean;
}

// Step-1 row state: one per typed priority line.
export interface MatchRow {
  text: string;
  match: PriorityMatchRow['match'];
  createIntegrationId: string; // unmatched rows: which Asana integration to create in
  createProjectGid: string; // unmatched rows: which Asana project to create in (required)
  category: string; // unmatched, or matched-without-category: chosen quota category
  include: boolean; // unmatched rows: create + pin this one
}

// Metadata resolved alongside the priority match, shared by the priorities step.
export interface MatchMeta {
  asanaIntegrations: Array<{ id: string; name: string }>;
  categories: string[];
  projects: import('@/types').AsanaProject[];
  aiUnavailable: boolean;
}
