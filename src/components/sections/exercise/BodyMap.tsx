'use client';

import { useMemo, useState } from 'react';

import { MUSCLES, type MuscleLoad, type MuscleView } from '@/lib/exercise-muscles';

// A hand-authored, stylised human figure — front and back views side by side —
// with each muscle a separate <g data-muscle>. Controlled: the caller owns the
// selection and passes the per-muscle load, so desktop (hover + click) and mobile
// (tap) share one component. Fill comes from each muscle's 0–1 heat value; unhit
// muscles read visibly cool/grey.

type Shape =
  | { t: 'rect'; x: number; y: number; w: number; h: number; rx: number }
  | { t: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { t: 'path'; d: string };

interface Region {
  id: string;
  shapes: Shape[];
}

// The silhouette underlay (same blocky figure for both views) and the muscle
// regions drawn over it. Coordinates are in a 120×216 viewBox per figure.
const SILHOUETTE: Shape[] = [
  { t: 'ellipse', cx: 60, cy: 18, rx: 13, ry: 14 },
  { t: 'rect', x: 55, y: 30, w: 10, h: 10, rx: 3 }, // neck
  { t: 'rect', x: 37, y: 40, w: 46, h: 74, rx: 15 }, // torso
  { t: 'rect', x: 19, y: 46, w: 16, h: 68, rx: 8 }, // left arm
  { t: 'rect', x: 85, y: 46, w: 16, h: 68, rx: 8 }, // right arm
  { t: 'rect', x: 39, y: 104, w: 42, h: 26, rx: 11 }, // hips
  { t: 'rect', x: 41, y: 122, w: 17, h: 90, rx: 8 }, // left leg
  { t: 'rect', x: 62, y: 122, w: 17, h: 90, rx: 8 }, // right leg
];

// Two symmetric copies of a shape, mirrored about x = 60.
function pair(shape: Extract<Shape, { t: 'rect' | 'ellipse' }>): Shape[] {
  if (shape.t === 'rect') {
    return [shape, { ...shape, x: 120 - shape.x - shape.w }];
  }
  return [shape, { ...shape, cx: 120 - shape.cx }];
}

const FRONT_REGIONS: Region[] = [
  { id: 'front-delts', shapes: pair({ t: 'ellipse', cx: 37, cy: 50, rx: 8, ry: 7 }) },
  { id: 'side-delts', shapes: pair({ t: 'ellipse', cx: 26, cy: 54, rx: 6, ry: 8 }) },
  { id: 'chest', shapes: pair({ t: 'rect', x: 41, y: 52, w: 17, h: 16, rx: 6 }) },
  { id: 'biceps', shapes: pair({ t: 'rect', x: 20, y: 64, w: 14, h: 20, rx: 6 }) },
  { id: 'forearms', shapes: pair({ t: 'rect', x: 20, y: 88, w: 14, h: 24, rx: 6 }) },
  { id: 'obliques', shapes: pair({ t: 'rect', x: 42, y: 74, w: 7, h: 26, rx: 3 }) },
  { id: 'abs', shapes: [{ t: 'rect', x: 50, y: 71, w: 20, h: 30, rx: 5 }] },
  { id: 'hip-flexors', shapes: pair({ t: 'rect', x: 44, y: 106, w: 14, h: 12, rx: 5 }) },
  { id: 'quads', shapes: pair({ t: 'rect', x: 42, y: 120, w: 16, h: 48, rx: 7 }) },
];

const BACK_REGIONS: Region[] = [
  { id: 'traps', shapes: [{ t: 'path', d: 'M48 44 L72 44 L66 62 L54 62 Z' }] },
  { id: 'rear-delts', shapes: pair({ t: 'ellipse', cx: 37, cy: 50, rx: 8, ry: 7 }) },
  { id: 'triceps', shapes: pair({ t: 'rect', x: 20, y: 64, w: 14, h: 22, rx: 6 }) },
  { id: 'upper-back', shapes: pair({ t: 'rect', x: 44, y: 62, w: 15, h: 16, rx: 4 }) },
  {
    id: 'lats',
    shapes: [
      { t: 'path', d: 'M43 78 L57 80 L55 100 L45 96 Z' },
      { t: 'path', d: 'M77 78 L63 80 L65 100 L75 96 Z' },
    ],
  },
  { id: 'lower-back', shapes: [{ t: 'rect', x: 50, y: 98, w: 20, h: 14, rx: 4 }] },
  { id: 'glutes', shapes: pair({ t: 'rect', x: 42, y: 114, w: 17, h: 22, rx: 8 }) },
  { id: 'hamstrings', shapes: pair({ t: 'rect', x: 42, y: 138, w: 16, h: 40, rx: 7 }) },
  { id: 'calves', shapes: pair({ t: 'rect', x: 43, y: 180, w: 14, h: 28, rx: 6 }) },
];

const REGIONS: Record<MuscleView, Region[]> = { front: FRONT_REGIONS, back: BACK_REGIONS };

// Heat colour ramp: cool grey when unhit, warming through amber to red as weekly
// volume climbs. Matches the app's warm-palette temperature.
const HEAT_STOPS: Array<[number, [number, number, number]]> = [
  [0, [229, 231, 235]], // gray-200
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

function ShapeEl({ shape, ...rest }: { shape: Shape } & React.SVGProps<SVGElement>) {
  if (shape.t === 'rect') {
    return <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={shape.rx} {...(rest as React.SVGProps<SVGRectElement>)} />;
  }
  if (shape.t === 'ellipse') {
    return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} {...(rest as React.SVGProps<SVGEllipseElement>)} />;
  }
  return <path d={shape.d} {...(rest as React.SVGProps<SVGPathElement>)} />;
}

interface HoverState {
  muscleId: string;
  x: number;
  y: number;
}

export function BodyMap({
  loads,
  selectedMuscle,
  onSelect,
}: {
  loads: MuscleLoad[];
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

  const renderView = (view: MuscleView) => (
    <svg
      viewBox="0 0 120 216"
      className="h-auto w-full max-w-[210px]"
      role="img"
      aria-label={`${view === 'front' ? 'Front' : 'Back'} view muscle heatmap`}
    >
      {SILHOUETTE.map((shape, i) => (
        <ShapeEl key={i} shape={shape} fill="#f3f4f6" stroke="#e5e7eb" strokeWidth={0.75} />
      ))}
      {REGIONS[view].map(region => {
        const load = loadById.get(region.id);
        const selected = selectedMuscle === region.id;
        const fill = heatColour(load?.heat ?? 0);
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
            {region.shapes.map((shape, i) => (
              <ShapeEl
                key={i}
                shape={shape}
                fill={fill}
                stroke={selected ? '#111827' : '#ffffff'}
                strokeWidth={selected ? 2 : 1}
                style={{
                  filter: selected ? 'brightness(1.08)' : undefined,
                  transition: 'fill 150ms ease',
                }}
              />
            ))}
          </g>
        );
      })}
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
        />
      )}
    </div>
  );
}

// A small non-interactive tooltip, pinned to the top of the figure so it never
// sits under the pointer. Touch devices don't fire hover, so this is desktop-only
// in practice; mobile relies on tap-to-select and the detail sheet.
function MuscleTooltip({ label, load }: { label: string; load: MuscleLoad }) {
  const top = load.exercises.filter(e => e.doneSets > 0).slice(0, 2);
  return (
    <div className="pointer-events-none absolute left-1/2 top-0 z-10 hidden -translate-x-1/2 -translate-y-full rounded-md bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg sm:block">
      <p className="font-semibold">{label}</p>
      <p className="tabular-nums text-gray-300">
        {load.doneSetsPerWeek} sets/wk done
        {load.plannedSetsPerWeek > 0 ? ` · ${load.plannedSetsPerWeek} planned` : ''}
      </p>
      {top.length > 0 && (
        <p className="text-gray-400">{top.map(e => e.name).join(', ')}</p>
      )}
    </div>
  );
}
