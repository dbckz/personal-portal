// Resolves the icon names held in the section registry (lib/life-sections.ts)
// to lucide components. The registry stays free of React imports so API routes
// and storage can share it; this is the UI-side half of that split.

import {
  BarChart3,
  Bell,
  Briefcase,
  Calendar,
  CalendarCheck,
  CalendarRange,
  Dumbbell,
  FlaskConical,
  FolderGit2,
  Gauge,
  HeartPulse,
  History,
  Kanban,
  LayoutDashboard,
  Music,
  PersonStanding,
  Repeat,
  Target,
  TrendingUp,
  Users,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  BarChart3,
  Bell,
  Briefcase,
  Calendar,
  CalendarCheck,
  CalendarRange,
  Dumbbell,
  FlaskConical,
  FolderGit2,
  Gauge,
  HeartPulse,
  History,
  Kanban,
  LayoutDashboard,
  Music,
  PersonStanding,
  Repeat,
  Target,
  TrendingUp,
  Users,
};

// Falls back to Target rather than throwing: a typo in the registry should cost
// a wrong glyph, not a blank page.
export function resolveIcon(name: string): LucideIcon {
  return ICONS[name] ?? Target;
}
