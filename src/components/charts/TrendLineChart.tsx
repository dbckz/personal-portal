'use client';

import { useLayoutEffect, useRef, useState } from 'react';

// A generic multi-series inline-SVG line chart — no chart library is installed,
// so this is hand-rolled. It is closely modelled on the exercise
// AdherenceTrendChart (measured pixel box so the viewBox is 1:1, manual x/y
// scales, series split into runs of non-null points so a missing value renders
// as a GAP rather than an interpolation or a zero, x-labels thinned to roughly
// one per 40px, and hover/tap hit-zones with a readout).
//
// It carries no domain knowledge: callers pass already-computed labels and
// series, so the same component backs the analysis completion trend and the
// per-habit consistency charts on both desktop and mobile.

export interface TrendSeries {
  label: string;
  color: string;
  // One entry per label; null where that point has no reading (a gap).
  values: (number | null)[];
}

export interface TrendLineChartProps {
  labels: string[]; // x labels, one per point
  series: TrendSeries[];
  // Plot height in px (the SVG renders 1:1 so text is never stretched).
  height?: number;
  yDomain?: [number, number]; // default [0, 100]
  formatValue?: (v: number) => string; // default v => `${Math.round(v)}%`
  // Mobile: smaller type and thinned x-axis labels.
  compact?: boolean;
}

export function TrendLineChart({
  labels,
  series,
  height = 168,
  yDomain = [0, 100],
  formatValue = v => `${Math.round(v)}%`,
  compact = false,
}: TrendLineChartProps) {
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

  const n = labels.length;
  if (n === 0) return null;

  const fontAxis = compact ? 9 : 10;
  const padL = 38; // room for y-tick labels
  const padR = compact ? 46 : 54; // room for last-point direct labels
  const padT = 10;
  const padB = 20; // room for x-tick labels
  const plotW = Math.max(1, width - padL - padR);
  const plotH = Math.max(1, height - padT - padB);

  const [yMin, yMax] = yDomain;
  const span = yMax - yMin || 1;

  // x by point slot (nulls still occupy their slot so gaps land correctly); a
  // lone point sits in the middle rather than dividing by zero.
  const x = (i: number) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const y = (v: number) => padT + (1 - (v - yMin) / span) * plotH;

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
  // the first and last point.
  const labelStep = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 40))));
  const showLabel = (i: number) => i === 0 || i === n - 1 || i % labelStep === 0;

  const tickY = [yMin, yMin + span / 2, yMax];
  const hitW = n === 1 ? plotW : plotW / (n - 1);

  return (
    <div ref={wrapRef} className="relative w-full">
      {/* Legend */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {series.map(s => (
          <span key={s.label} className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: s.color }}
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
          aria-label={series.map(s => s.label).join(', ')}
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
                {formatValue(t)}
              </text>
            </g>
          ))}

          {/* x tick labels */}
          {labels.map((label, i) =>
            showLabel(i) ? (
              <text
                key={`${label}-${i}`}
                x={x(i)}
                y={height - 6}
                textAnchor="middle"
                fontSize={fontAxis}
                fill="#9ca3af"
              >
                {label}
              </text>
            ) : null
          )}

          {/* Crosshair on the active point */}
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

          {/* Background: tapping the margins/axes dismisses the active point. */}
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
              <path d={pathFor(s.values)} fill="none" stroke={s.color} strokeWidth={2} />
              {s.values.map((v, i) =>
                v === null ? null : (
                  <circle key={i} cx={x(i)} cy={y(v)} r={compact ? 2 : 3} fill={s.color} />
                )
              )}
            </g>
          ))}

          {/* Hit rects: one per point, wider than the markers, spanning the plot
              height. Hover on desktop, tap on mobile (tap again to dismiss). */}
          {labels.map((label, i) => {
            const readout = series
              .map(s => {
                const v = s.values[i];
                return `${s.label}: ${v === null ? '—' : formatValue(v)}`;
              })
              .join(', ');
            return (
              <rect
                key={`${label}-${i}`}
                x={x(i) - hitW / 2}
                y={padT}
                width={hitW}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                role="img"
                aria-label={`${label}: ${readout}`}
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
                style={{ backgroundColor: s.color }}
                aria-hidden
              />
              {formatValue(v)}
            </div>
          );
        })}

        {/* Tooltip for the active point */}
        {active !== null && (
          <Tooltip
            label={labels[active]}
            series={series}
            index={active}
            formatValue={formatValue}
            left={x(active)}
            plotLeft={padL}
            plotRight={padL + plotW}
          />
        )}
      </div>
    </div>
  );
}

function Tooltip({
  label,
  series,
  index,
  formatValue,
  left,
  plotLeft,
  plotRight,
}: {
  label: string;
  series: TrendSeries[];
  index: number;
  formatValue: (v: number) => string;
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
      <div className="font-semibold text-gray-700">{label}</div>
      {series.map(s => {
        const v = s.values[index];
        return (
          <div key={s.label} className="mt-0.5 flex items-center gap-1 text-gray-500">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: s.color }}
              aria-hidden
            />
            {s.label}: {v === null ? '—' : formatValue(v)}
          </div>
        );
      })}
    </div>
  );
}

export default TrendLineChart;
