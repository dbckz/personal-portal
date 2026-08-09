import { ArrowUp, Equal, TrendingDown, Sparkles, Flame, type LucideIcon } from 'lucide-react';

import type { ExerciseKind, TargetAction } from '@/lib/exercise-targets';

// How each progression recommendation is labelled and coloured. Shared by the
// Plan tab's read-only targets and the Today checklist so a "Go up" looks the
// same wherever it appears. Deliberately tiny and self-contained — the mobile
// checklist imports it without pulling in a desktop section.
const ACTION_STYLE: Record<TargetAction, { label: string; className: string; Icon: LucideIcon }> = {
  increase: { label: 'Go up', className: 'text-emerald-700 bg-emerald-50', Icon: ArrowUp },
  'add-reps': { label: 'Add reps', className: 'text-emerald-700 bg-emerald-50', Icon: ArrowUp },
  'add-time': { label: 'Hold longer', className: 'text-emerald-700 bg-emerald-50', Icon: ArrowUp },
  hold: { label: 'Repeat', className: 'text-blue-700 bg-blue-50', Icon: Equal },
  reduce: { label: 'Ease off', className: 'text-amber-700 bg-amber-50', Icon: TrendingDown },
  'no-history': { label: 'New', className: 'text-gray-600 bg-gray-100', Icon: Sparkles },
};

export function ActionBadge({ action }: { action: TargetAction }) {
  const style = ACTION_STYLE[action];
  const Icon = style.Icon;
  return (
    <span
      className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${style.className}`}
    >
      <Icon className="h-3 w-3" />
      {style.label}
    </span>
  );
}

// How the AI programme labels an exercise's role. The 'core' lift is the one
// being driven up session to session; it is labelled "Staple" rather than
// "Core" so it doesn't read as an abs movement next to dead bugs and planks.
// 'rotation' and 'cardio' are quieter, greyer context.
const KIND_STYLE: Record<ExerciseKind, { label: string; className: string }> = {
  core: { label: 'Staple', className: 'text-indigo-700 bg-indigo-50' },
  rotation: { label: 'Rotating', className: 'text-gray-500 bg-gray-100' },
  cardio: { label: 'Cardio', className: 'text-sky-700 bg-sky-50' },
  hold: { label: 'Hold', className: 'text-teal-700 bg-teal-50' },
};

// A prescribed anchor lift wears the same indigo 'core' styling but reads
// "Anchor" — the word the plan uses for the lifts to drive up week to week.
export function KindTag({ kind, isAnchor }: { kind: ExerciseKind; isAnchor?: boolean }) {
  const style = KIND_STYLE[kind];
  const label = isAnchor && kind === 'core' ? 'Anchor' : style.label;
  return (
    <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${style.className}`}>
      {label}
    </span>
  );
}

// The final exercise, taken to failure. Deliberately loud — it's the one cue
// that changes how the last set is performed.
export function FailureTag() {
  return (
    <span className="flex items-center gap-1 rounded-md bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-700">
      <Flame className="h-3 w-3" />
      To failure
    </span>
  );
}
