'use client';

import { useMemo, useState } from 'react';

import { MUSCLES, type MuscleLoad, type MuscleView } from '@/lib/exercise-muscles';
import {
  BACK_REGIONS,
  FIGURE_HEIGHT,
  FIGURE_WIDTH,
  FRONT_REGIONS,
  FRONT_SHIN_DETAIL,
  MIRROR_TRANSFORM,
  SILHOUETTE_PATH,
  type MuscleRegionShape,
} from './bodymap-geometry';

// A hand-authored, anatomically styled human figure — front and back views side
// by side — with each muscle a separate <g data-muscle>. Controlled: the caller
// owns the selection and passes the per-muscle load, so desktop (hover + click)
// and mobile (tap) share one component. Fill comes from each muscle's 0–1 heat
// value; unhit muscles read visibly cool/grey. The figure geometry lives in
// bodymap-geometry so a preview harness can render the identical shapes.

const REGIONS: Record<MuscleView, MuscleRegionShape[]> = {
  front: FRONT_REGIONS,
  back: BACK_REGIONS,
};

// Heat colour ramp: cool grey when unhit, warming through amber to red as weekly
// volume climbs. Matches the app's warm-palette temperature.
const HEAT_STOPS: Array<[number, [number, number, number]]> = [
  [0, [226, 224, 220]], // warm grey
  [0.15, [253, 230, 138]], // amber-200
  [0.4, [251, 191, 36]], // amber-400
  [0.7, [249, 115, 22]], // orange-500
  [1, [220, 38, 38]], // red-600
];

function heatColour(heat: number): string {
  const h = Math.max(0, Math.min(1, heat));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [hiStop, hi] = HEAT_STOPS[i];
    if (h <= hiStop) {
      const [loStop, lo] = HEAT_STOPS[i - 1];
      const t = hiStop === loStop ? 0 : (h - loStop) / (hiStop - loStop);
      const c = lo.map((v, k) => Math.round(v + (hi[k] - v) * t));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  return 'rgb(220, 38, 38)';
}

// Subtle darker outline for muscle definition; a strong dark outline when the
// muscle is selected.
const DEFINITION_STROKE = 'rgba(70, 50, 40, 0.35)';
const DETAIL_STROKE = 'rgba(70, 50, 40, 0.3)';
const SELECTED_STROKE = '#1f2937';

interface HoverState {
  muscleId: string;
  x: number;
  y: number;
}

export function BodyMap({
  loads,
  heatKind = 'done',
  selectedMuscle,
  onSelect,
}: {
  loads: MuscleLoad[];
  // Which heat this figure colours by — 'planned' for the plan map, 'done' for
  // the actual map. Keeps the component dumb and controlled: same shapes, the
  // caller decides the temperature source.
  heatKind?: 'planned' | 'done';
  selectedMuscle: string | null;
  onSelect: (muscleId: string) => void;
}) {
  const [hover, setHover] = useState<HoverState | null>(null);

  const loadById = useMemo(() => {
    const map = new Map<string, MuscleLoad>();
    for (const load of loads) map.set(load.muscleId, load);
    return map;
  }, [loads]);

  const labelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of MUSCLES) map.set(m.id, m.label);
    return map;
  }, []);

  const hoveredLoad = hover ? loadById.get(hover.muscleId) : null;

  const renderRegion = (region: MuscleRegionShape) => {
    const load = loadById.get(region.id);
    const selected = selectedMuscle === region.id;
    const heat = load ? (heatKind === 'planned' ? load.plannedHeat : load.doneHeat) : 0;
    const fill = heatColour(heat);
    const fillProps = {
      fill,
      stroke: selected ? SELECTED_STROKE : DEFINITION_STROKE,
      strokeWidth: selected ? 1.6 : 0.8,
      style: {
        filter: selected ? 'brightness(1.06)' : undefined,
        transition: 'fill 150ms ease',
      } as React.CSSProperties,
    };
    return (
      <g
        key={region.id}
        data-muscle={region.id}
        role="button"
        tabIndex={0}
        aria-label={labelById.get(region.id) ?? region.id}
        className="cursor-pointer outline-none"
        onClick={() => onSelect(region.id)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(region.id);
          }
        }}
        onMouseEnter={e =>
          setHover({ muscleId: region.id, x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })
        }
        onMouseMove={e =>
          setHover({ muscleId: region.id, x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })
        }
        onMouseLeave={() => setHover(h => (h?.muscleId === region.id ? null : h))}
      >
        <path d={region.fill} {...fillProps} />
        {region.mirrored && <path d={region.fill} transform={MIRROR_TRANSFORM} {...fillProps} />}
        {region.detail && (
          <path
            d={region.detail}
            fill="none"
            stroke={DETAIL_STROKE}
            strokeWidth={0.7}
            strokeLinecap="round"
            style={{ pointerEvents: 'none' }}
          />
        )}
        {region.detail && region.mirrored && (
          <path
            d={region.detail}
            transform={MIRROR_TRANSFORM}
            fill="none"
            stroke={DETAIL_STROKE}
            strokeWidth={0.7}
            strokeLinecap="round"
            style={{ pointerEvents: 'none' }}
          />
        )}
      </g>
    );
  };

  const renderView = (view: MuscleView) => (
    <svg
      viewBox={`0 0 ${FIGURE_WIDTH} ${FIGURE_HEIGHT}`}
      className="h-auto w-full max-w-[230px]"
      role="img"
      aria-label={`${view === 'front' ? 'Front' : 'Back'} view muscle heatmap`}
    >
      <path d={SILHOUETTE_PATH} fill="#e9e7e3" stroke="#d3cfc8" strokeWidth={1} strokeLinejoin="round" />
      {view === 'front' && (
        <path
          d={FRONT_SHIN_DETAIL}
          fill="none"
          stroke="#d3cfc8"
          strokeWidth={1.1}
          strokeLinecap="round"
        />
      )}
      {REGIONS[view].map(renderRegion)}
    </svg>
  );

  return (
    <div className="relative">
      <div className="flex items-start justify-center gap-4">
        <figure className="flex flex-col items-center gap-1">
          {renderView('front')}
          <figcaption className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
            Front
          </figcaption>
        </figure>
        <figure className="flex flex-col items-center gap-1">
          {renderView('back')}
          <figcaption className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
            Back
          </figcaption>
        </figure>
      </div>

      {hover && hoveredLoad && (
        <MuscleTooltip
          label={labelById.get(hover.muscleId) ?? hover.muscleId}
          load={hoveredLoad}
          heatKind={heatKind}
        />
      )}
    </div>
  );
}

// A small non-interactive tooltip, pinned to the top of the figure so it never
// sits under the pointer. Touch devices don't fire hover, so this is desktop-only
// in practice; mobile relies on tap-to-select and the detail sheet.
function MuscleTooltip({
  label,
  load,
  heatKind,
}: {
  label: string;
  load: MuscleLoad;
  heatKind: 'planned' | 'done';
}) {
  const planned = heatKind === 'planned';
  const top = load.exercises
    .filter(e => (planned ? e.plannedSets > 0 : e.doneSets > 0))
    .slice(0, 2);
  return (
    <div className="pointer-events-none absolute left-1/2 top-0 z-10 hidden -translate-x-1/2 -translate-y-full rounded-md bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg sm:block">
      <p className="font-semibold">{label}</p>
      <p className="tabular-nums text-gray-300">
        {planned
          ? `${load.plannedSetsPerWeek} sets/wk planned`
          : `${load.doneSetsPerWeek} sets/wk done · ${load.plannedSetsPerWeek} planned`}
      </p>
      {top.length > 0 && <p className="text-gray-400">{top.map(e => e.name).join(', ')}</p>}
    </div>
  );
}
