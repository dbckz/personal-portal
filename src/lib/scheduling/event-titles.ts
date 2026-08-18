// Single source of truth for the titles of app-created calendar events.
//
// Every event the planner creates (task / grouped / reserved / prep / ritual
// blocks) is titled here so the emoji conventions live in one place and the
// title-parsing helpers (prep dedupe, reset sweep, replan) all agree.
//
// Emoji conventions:
//  * task / grouped / reserved blocks → a category emoji prefix (a single-task
//    block whose title already leads with an emoji is left untouched).
//  * prep blocks → "📖 Prep: <meeting>". Legacy prep events (created before the
//    emoji convention) are titled "Prep: <meeting>"; matching accepts BOTH.
//  * rituals → already emoji'd in rituals.ts ("🍽️ Lunch" / "📧 Emails"); their
//    titles are routed through eventTitleForBlock so this stays the one path.

import { asanaTaskUrl } from '@/lib/asana-url';
import { normalize } from '@/lib/capacity';

import { isBreakTitle } from './rituals';
import type { ProposedBlock } from './types';

// Google Calendar colorIds for every app-created event. WORK time (task /
// grouped / reserved / prep / 📧 Emails / overflow blocks) is Banana (yellow);
// NON-WORK time (🍽️ Lunch, 🏋️ Exercise and ☕ Break) is Basil (green). The
// single place the WORK/NON-WORK colour decision is made — every creation path
// (weekly confirm, ritual-events, replan additions) routes through it.
export const WORK_COLOR_ID = '5'; // Banana / yellow
export const NON_WORK_COLOR_ID = '10'; // Basil / green

// The Google colorId a proposed block's event should use. A block is NON-WORK
// when it's a break block, or a ritual block whose title is a break ritual
// (lunch / exercise); everything else is WORK.
export function colorIdForBlock(block: ProposedBlock): string {
  if (block.kind === 'break') return NON_WORK_COLOR_ID;
  if (block.kind === 'ritual' && block.title && isBreakTitle(block.title)) {
    return NON_WORK_COLOR_ID;
  }
  return WORK_COLOR_ID;
}

// Prep-title prefixes. Legacy events predate the emoji; new events carry it.
export const LEGACY_PREP_TITLE_PREFIX = 'Prep: ';
export const PREP_TITLE_PREFIX = '📖 Prep: ';

// True for both legacy ("Prep: X") and emoji ("📖 Prep: X") prep titles.
export function isPrepTitle(title: string): boolean {
  return title.startsWith(PREP_TITLE_PREFIX) || title.startsWith(LEGACY_PREP_TITLE_PREFIX);
}

// Strip either prep prefix, returning the meeting title. Non-prep titles are
// returned unchanged.
export function prepMeetingTitleFromEvent(title: string): string {
  if (title.startsWith(PREP_TITLE_PREFIX)) return title.slice(PREP_TITLE_PREFIX.length);
  if (title.startsWith(LEGACY_PREP_TITLE_PREFIX)) return title.slice(LEGACY_PREP_TITLE_PREFIX.length);
  return title;
}

// Build the emoji prep title for a meeting.
export function prepTitle(meetingTitle: string): string {
  return `${PREP_TITLE_PREFIX}${meetingTitle}`;
}

// Category → emoji. Matched with the whitespace-robust normalize (so
// "Writing / Deep Work" and "Writing/Deep Work" map the same).
const CATEGORY_EMOJI: ReadonlyArray<readonly [string, string]> = [
  ['Writing/Deep Work', '✍️'],
  ['Blogs', '📝'],
  ['Batch', '📦'],
  ['Engagement/Outreach', '🤝'],
  ['General Todos', '✅'],
  ['Meeting prep', '📖'],
];
const UNKNOWN_CATEGORY_EMOJI = '🗂️';

// The deep-work category, matched with the whitespace-robust normalize (so
// "Writing / Deep Work" and "Writing/Deep Work" are treated the same). Its daily
// blocks are titled "Deep work" — not the raw category label, and not a member
// task name. Kept inline (rather than importing engine.isDeepWork) so this module
// stays free of the placement logic.
function isDeepWorkCategory(category: string): boolean {
  return normalize(category) === normalize('Writing/Deep Work');
}

// Inverse of categoryEmoji: the category an app-created event title's emoji
// prefix denotes, or null when the title carries no known category emoji. Time
// attribution uses this so the breakdown follows the SAME emoji conventions the
// planner writes, rather than a second mapping that could drift.
export function categoryForTitleEmoji(title: string): string | null {
  const trimmed = title.trim();
  for (const [cat, emoji] of CATEGORY_EMOJI) {
    if (trimmed.startsWith(emoji)) return cat;
  }
  return null;
}

export function categoryEmoji(category: string): string {
  const n = normalize(category);
  for (const [cat, emoji] of CATEGORY_EMOJI) {
    if (normalize(cat) === n) return emoji;
  }
  return UNKNOWN_CATEGORY_EMOJI;
}

// Whether a title already leads with an emoji (many ad-hoc task titles do, e.g.
// "🎯 Focus time: …"), so we don't double-prefix. Uses the unicode pictographic
// property; a leading space is tolerated.
const LEADING_EMOJI = /^\s*\p{Extended_Pictographic}/u;
export function startsWithEmoji(title: string): boolean {
  return LEADING_EMOJI.test(title);
}

// Title for a single-task block: keep an existing leading emoji, else prefix the
// category emoji.
export function taskBlockTitle(taskTitle: string, category: string): string {
  return startsWithEmoji(taskTitle) ? taskTitle : `${categoryEmoji(category)} ${taskTitle}`;
}

// Title for a grouped block (shared container, e.g. "🤝 Engagement / Outreach").
export function categoryBlockTitle(category: string): string {
  return `${categoryEmoji(category)} ${category}`;
}

// Title for a reserved block ("✍️ Writing/Deep Work block").
export function reservedBlockTitle(category: string): string {
  return `${categoryEmoji(category)} ${category} block`;
}

// The calendar-event description for a proposed block. The single place that
// turns a ProposedBlock into its event description, used by the confirm route so
// every Asana-backed event carries a direct link back to its task:
//  * grouped block → the reason, then a bulleted agenda; each Asana task in the
//    agenda is followed by its link (ad-hoc tasks have no gid, so no link).
//  * single Asana task block → the reason, then the task's link.
//  * everything else (reserved / prep / ritual / break / ad-hoc task) → just the
//    reason, unchanged.
export function blockEventDescription(block: ProposedBlock): string {
  if (Array.isArray(block.tasks) && block.tasks.length > 0) {
    const agenda = block.tasks
      .map(t => (t.gid ? `• ${t.title}\n  ${asanaTaskUrl(t.gid)}` : `• ${t.title}`))
      .join('\n');
    return `${block.reason}\n\n${agenda}`;
  }
  if (block.task?.gid) {
    return `${block.reason}\n\n${asanaTaskUrl(block.task.gid)}`;
  }
  return block.reason;
}

// The calendar-event title for any proposed block. The single place that turns a
// ProposedBlock into its event title, used by the confirm route.
export function eventTitleForBlock(block: ProposedBlock): string {
  if (block.kind === 'prep') {
    return prepTitle(block.meeting?.title ?? block.category);
  }
  if (block.kind === 'ritual' || block.kind === 'break') {
    // Rituals + breaks are already emoji'd in rituals.ts / breaks.ts; route
    // through here so titles have one source of truth.
    return block.title ?? block.category;
  }
  // Deep-work blocks (the daily generic container, its agenda listed in the
  // description, or a task-less reserved morning) always read "Deep work" — never
  // the raw "Writing/Deep Work" category label, and never a member task name.
  if (isDeepWorkCategory(block.category)) {
    return `${categoryEmoji(block.category)} Deep work`;
  }
  if (Array.isArray(block.tasks)) {
    return categoryBlockTitle(block.category);
  }
  if (!block.task) {
    return reservedBlockTitle(block.category);
  }
  return taskBlockTitle(block.task.title, block.category);
}
