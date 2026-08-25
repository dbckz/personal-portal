'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';

import { pct } from '@/components/analysis/format';
import type { ExerciseWeekSummary } from '@/types/life';

// Adherence over recent weeks as a hand-rolled inline-SVG line chart — no chart
// library is installed, and this one component backs both the desktop and mobile
// Analysis views so the two can't drift.
//
// Two series share a single 0–100% y-axis: exercise adherence (of a session's
// planned exercises, how many were done) in emerald, and plan adherence
// (sessions done vs planned) in indigo. This exact pair is colourblind-
// validated. A week with no reading for a series produces a GAP in that line —
// never an interpolation and never a zero — and an isolated point still shows
// its marker. Only rendered once at least two weeks carry a reading.

// Colourblind-validated series pair — use these exact hexes.
const EXERCISE_COLOUR = '#059669'; // emerald
const PLAN_COLOUR = '#6366f1'; // indigo

interface Series {
  label: string;
  colour: string;
  // One entry per week in the window; null where that week has no reading.
  values: (number | null)[];
}

interface AdherenceTrendChartProps {
  weeks: ExerciseWeekSummary[];
  // How many trailing weeks to show (desktop 12, mobile 8).
  maxWeeks: number;
  // Plot height in px (the SVG renders 1:1 so text is never stretched).
  height?: number;
  // Mobile: smaller type and thinned x-axis labels.
  compact?: boolean;
}

export function AdherenceTrendChart({
  weeks,
  maxWeeks,
  height = 168,
  compact = false,
}: AdherenceTrendChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(compact ? 320 : 560);
  const [active, setActive] = useState<number | null>(null);

  // Measure the container so the SVG can render at true pixel size (viewBox ==
  // pixel box), which keeps axis text un-stretched at any width.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(200, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const recent = weeks.slice(-maxWeeks);
  const withData = recent.filter(
    w => w.exerciseAdherence !== null || w.sessionAdherence !== null
  );
  if (withData.length < 2) return null;

  const n = recent.length;
  const series: Series[] = [
    {
      label: 'Exercise adherence',
      colour: EXERCISE_COLOUR,
      values: recent.map(w => (w.exerciseAdherence === null ? null : pct(w.exerciseAdherence))),
    },
    {
      label: 'Plan adherence',
      colour: PLAN_COLOUR,
      values: recent.map(w => (w.sessionAdherence === null ? null : pct(w.sessionAdherence))),
    },
  ];

  const fontAxis = compact ? 9 : 10;
  const padL = 30; // room for "100%" y-tick labels
  const padR = compact ? 46 : 54; // room for last-point direct labels
  const padT = 10;
  const padB = 20; // room for x-tick labels
  const plotW = Math.max(1, width - padL - padR);
  const plotH = Math.max(1, height - padT - padB);

  // x by week slot (nulls still occupy their slot so gaps land correctly);
  // a lone week sits in the middle rather than dividing by zero.
  const x = (i: number) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const y = (v: number) => padT + (1 - v / 100) * plotH;

  // Split each series into runs of consecutive non-null points: runs of two or
  // more become a drawn line; a lone point contributes only its marker.
  function pathFor(values: (number | null)[]): string {
    let d = '';
    let run: string[] = [];
    const flush = () => {
      if (run.length >= 2) d += `M${run.join('L')} `;
      run = [];
    };
    values.forEach((v, i) => {
      if (v === null) flush();
      else run.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`);
    });
    flush();
    return d.trim();
  }

  // Thin x labels when they would crowd (roughly one per 40px), always keeping
  // the first and last week.
  const labelStep = plotW / n < 40 ? 2 : 1;
  const showLabel = (i: number) => i === 0 || i === n - 1 || i % labelStep === 0;

  const tickY = [0, 50, 100];
  const hitW = n === 1 ? plotW : plotW / (n - 1);

  return (
    <div ref={wrapRef} className="relative w-full">
      {/* Legend */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {series.map(s => (
          <span key={s.label} className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: s.colour }}
              aria-hidden
            />
            {s.label}
          </span>
        ))}
      </div>

      <div className="relative" style={{ height }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Weekly exercise and plan adherence"
          className="block"
        >
          {/* Gridlines + y ticks */}
          {tickY.map(t => (
            <g key={t}>
              <line
                x1={padL}
                x2={padL + plotW}
                y1={y(t)}
                y2={y(t)}
                stroke="#e5e7eb"
                strokeWidth={1}
              />
              <text
                x={padL - 6}
                y={y(t)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={fontAxis}
                fill="#9ca3af"
              >
                {t}%
              </text>
            </g>
          ))}

          {/* x tick labels */}
          {recent.map((w, i) =>
            showLabel(i) ? (
              <text
                key={w.weekStart}
                x={x(i)}
                y={height - 6}
                textAnchor="middle"
                fontSize={fontAxis}
                fill="#9ca3af"
              >
                {format(parseISO(w.weekStart), 'd MMM')}
              </text>
            ) : null
          )}

          {/* Crosshair on the active week */}
          {active !== null && (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={padT}
              y2={padT + plotH}
              stroke="#9ca3af"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          )}

          {/* Background: tapping the margins/axes dismisses the active week. */}
          <rect
            x={0}
            y={0}
            width={width}
            height={height}
            fill="transparent"
            onPointerDown={() => setActive(null)}
          />

          {/* Series lines + markers */}
          {series.map(s => (
            <g key={s.label}>
              <path d={pathFor(s.values)} fill="none" stroke={s.colour} strokeWidth={2} />
              {s.values.map((v, i) =>
                v === null ? null : (
                  <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={s.colour} />
                )
              )}
            </g>
          ))}

          {/* Hit rects: one per week, wider than the markers, spanning the plot
              height. Hover on desktop, tap on mobile (tap again to dismiss). */}
          {recent.map((w, i) => {
            const ex = w.exerciseAdherence;
            const sess = w.sessionAdherence;
            const label = `Week of ${format(parseISO(w.weekStart), 'd MMM')}: ${
              ex === null ? 'no exercise reading' : `${pct(ex)} per cent of planned exercises done`
            }${sess === null ? ', no plan reading' : `, ${pct(sess)} per cent plan adherence`}`;
            return (
              <rect
                key={w.weekStart}
                x={x(i) - hitW / 2}
                y={padT}
                width={hitW}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                role="img"
                aria-label={label}
                // Hover follows the mouse; a touch/pen tap toggles (tap again,
                // or tap the margin, to dismiss). Gating on pointerType keeps
                // the simulated mouse events a tap emits from fighting the tap.
                onPointerEnter={e => e.pointerType === 'mouse' && setActive(i)}
                onPointerLeave={e => e.pointerType === 'mouse' && setActive(null)}
                onPointerDown={e =>
                  e.pointerType !== 'mouse' && setActive(cur => (cur === i ? null : i))
                }
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                style={{ cursor: 'pointer' }}
              />
            );
          })}
        </svg>

        {/* Direct labels at each series' last non-null point */}
        {series.map(s => {
          let li = -1;
          for (let i = s.values.length - 1; i >= 0; i--) {
            if (s.values[i] !== null) {
              li = i;
              break;
            }
          }
          if (li < 0) return null;
          const v = s.values[li] as number;
          return (
            <div
              key={s.label}
              className="pointer-events-none absolute flex items-center gap-1 text-[10px] tabular-nums text-gray-500"
              style={{ left: x(li) + 6, top: y(v), transform: 'translateY(-50%)' }}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: s.colour }}
                aria-hidden
              />
              {v}%
            </div>
          );
        })}

        {/* Tooltip for the active week */}
        {active !== null && (
          <Tooltip week={recent[active]} left={x(active)} plotLeft={padL} plotRight={padL + plotW} />
        )}
      </div>
    </div>
  );
}

function Tooltip({
  week,
  left,
  plotLeft,
  plotRight,
}: {
  week: ExerciseWeekSummary;
  left: number;
  plotLeft: number;
  plotRight: number;
}) {
  // Flip to the left of the crosshair when close to the right edge.
  const flip = left > (plotLeft + plotRight) / 2;
  return (
    <div
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-gray-200 bg-white px-2 py-1 text-[10px] leading-tight shadow-sm"
      style={{
        left,
        top: 4,
        transform: `translateX(${flip ? 'calc(-100% - 8px)' : '8px'})`,
      }}
      role="status"
    >
      <div className="font-semibold text-gray-700">
        {format(parseISO(week.weekStart), 'd MMM yyyy')}
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-gray-500">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: EXERCISE_COLOUR }}
          aria-hidden
        />
        Exercise: {week.exerciseAdherence === null ? '—' : `${pct(week.exerciseAdherence)}%`}
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-gray-500">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: PLAN_COLOUR }}
          aria-hidden
        />
        Plan: {week.sessionAdherence === null ? '—' : `${pct(week.sessionAdherence)}%`}
      </div>
    </div>
  );
}
