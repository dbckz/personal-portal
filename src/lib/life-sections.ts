// The section registry: the top level of the navigation hierarchy.
//
// The app started as a work planner, so everything it already had (Command
// Center, Daily Calendar, Rituals, Reminders, Analysis) is the 'work' section's
// sub-tabs, unchanged. Adding a life area means adding an entry here — no
// switch statements elsewhere.
//
// Deliberately free of React and lucide imports so API routes and storage can
// validate section ids against the same list the UI renders.

import type { LifeSectionId } from '@/types/life';

export interface LifeSubTab {
  id: string;
  label: string;
  // Name of a lucide-react icon; resolved to a component in the UI layer
  // (components/SectionBar.tsx and the section views).
  icon: string;
}

export interface LifeSection {
  id: LifeSectionId;
  label: string;
  icon: string;
  // Sections that own goals appear in the Goals section's section picker. The
  // 'goals' section itself is a cross-cutting view, not a life area, so it is
  // excluded.
  holdsGoals: boolean;
  subTabs: LifeSubTab[];
}

export const LIFE_SECTIONS: LifeSection[] = [
  {
    id: 'work',
    label: 'Work',
    icon: 'Briefcase',
    holdsGoals: true,
    subTabs: [
      { id: 'dashboard', label: 'Command Center', icon: 'LayoutDashboard' },
      { id: 'calendar', label: 'Daily Calendar', icon: 'Calendar' },
      { id: 'rituals', label: 'Rituals', icon: 'Repeat' },
      { id: 'reminders', label: 'Reminders', icon: 'Bell' },
      { id: 'projects', label: 'Projects', icon: 'FolderGit2' },
      { id: 'analysis', label: 'Analysis', icon: 'BarChart3' },
    ],
  },
  {
    id: 'exercise',
    label: 'Exercise',
    icon: 'Dumbbell',
    holdsGoals: true,
    subTabs: [
      { id: 'today', label: 'Today', icon: 'Calendar' },
      { id: 'routine', label: 'Routine', icon: 'CalendarRange' },
      { id: 'plan', label: 'Plan', icon: 'CalendarCheck' },
      { id: 'history', label: 'History', icon: 'History' },
      { id: 'progress', label: 'Progress', icon: 'TrendingUp' },
      { id: 'goals', label: 'Goals', icon: 'Target' },
      { id: 'analysis', label: 'Analysis', icon: 'BarChart3' },
    ],
  },
  {
    id: 'music',
    label: 'Music',
    icon: 'Music',
    holdsGoals: true,
    // Deliberately goals-only until the specifics land — see TODO.md.
    subTabs: [{ id: 'goals', label: 'Goals', icon: 'Target' }],
  },
  {
    id: 'wellbeing',
    label: 'Wellbeing',
    icon: 'HeartPulse',
    // Goals-free for now: the two habits are tracked day by day rather than
    // against a monthly target, and the experiments carry their own verdicts.
    holdsGoals: false,
    subTabs: [
      { id: 'analysis', label: 'Analysis', icon: 'BarChart3' },
      { id: 'experiments', label: 'Experiments', icon: 'FlaskConical' },
    ],
  },
  {
    id: 'goals',
    label: 'Goals',
    icon: 'Target',
    holdsGoals: false,
    subTabs: [
      { id: 'current', label: 'Current', icon: 'Gauge' },
      { id: 'history', label: 'History', icon: 'History' },
    ],
  },
];

export const DEFAULT_SECTION_ID: LifeSectionId = 'work';

export function getSection(id: string): LifeSection | undefined {
  return LIFE_SECTIONS.find(s => s.id === id);
}

export function isValidSectionId(id: string): boolean {
  return LIFE_SECTIONS.some(s => s.id === id);
}

// The life areas a goal may belong to. 'goals' is a view over these, never a
// home for a goal of its own.
export function goalSections(): LifeSection[] {
  return LIFE_SECTIONS.filter(s => s.holdsGoals);
}

export function sectionLabel(id: string): string {
  return getSection(id)?.label ?? id;
}

// First sub-tab of a section — the landing tab when switching sections.
export function defaultSubTab(sectionId: string): string {
  return getSection(sectionId)?.subTabs[0]?.id ?? '';
}

// Does this section have that sub-tab? Guards a stale persisted selection
// (e.g. a sub-tab that has since been removed) from rendering nothing.
export function hasSubTab(sectionId: string, subTabId: string): boolean {
  return !!getSection(sectionId)?.subTabs.some(t => t.id === subTabId);
}
