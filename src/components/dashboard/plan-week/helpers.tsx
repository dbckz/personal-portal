'use client';

import { format } from 'date-fns';

// Deterministic pastel-ish colour per category, so a category always reads the
// same across the modal.
const CATEGORY_COLORS = [
  { bg: 'bg-orange-100', text: 'text-orange-700', dot: 'bg-orange-400' },
  { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-400' },
  { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-400' },
  { bg: 'bg-purple-100', text: 'text-purple-700', dot: 'bg-purple-400' },
  { bg: 'bg-pink-100', text: 'text-pink-700', dot: 'bg-pink-400' },
  { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-400' },
];

export function categoryColor(category: string) {
  let hash = 0;
  for (let i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) | 0;
  return CATEGORY_COLORS[Math.abs(hash) % CATEGORY_COLORS.length];
}

export function timeRange(start: string, durationMinutes: number): string {
  const [h, m] = start.split(':').map(Number);
  const startDate = new Date(2000, 0, 1, h, m);
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
  return `${start}–${format(endDate, 'HH:mm')}`;
}

// Standard block-length options (minutes) for the tasks step.
const BLOCK_LENGTH_OPTIONS = [15, 30, 45, 60, 90, 120, 180];

// Human label for a block length in minutes: "15 mins", "1 hour", "1.5 hours".
function blockLengthLabel(mins: number): string {
  if (mins < 60) return `${mins} mins`;
  if (mins % 60 === 0) {
    const hours = mins / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  // Clean half-hour multiples read as "1.5 hours"; anything else as "1h 20m".
  if (mins % 30 === 0) return `${mins / 60} hours`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Build the ordered option list for a category, always including its default so
// a non-standard configured length stays selectable (labelled "… (default)").
export function blockLengthOptions(defaultMins: number): Array<{ value: number; label: string }> {
  const values = BLOCK_LENGTH_OPTIONS.includes(defaultMins)
    ? BLOCK_LENGTH_OPTIONS
    : [...BLOCK_LENGTH_OPTIONS, defaultMins].sort((a, b) => a - b);
  return values.map(v => ({
    value: v,
    label: v === defaultMins && !BLOCK_LENGTH_OPTIONS.includes(defaultMins)
      ? `${blockLengthLabel(v)} (default)`
      : blockLengthLabel(v),
  }));
}

// Rough, human-friendly duration for the spare-capacity line: minutes under an
// hour read as "45m"; an hour or more rounds to the nearest half hour ("2h",
// "4.5h").
export function roughDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const halves = Math.round(mins / 30) / 2;
  return `${Number.isInteger(halves) ? halves : halves.toFixed(1)}h`;
}

// Compact <select> shared by the per-row dropdowns (prep length, prep day, task
// block length). Those rows are themselves clickable (checkbox / expand), so
// clicks and changes stop propagation to keep a pick from toggling the row.
// Option values are strings over the wire; the caller converts as needed.
export function RowSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = '',
}: {
  value: string | number;
  options: Array<{ value: string | number; label: string }>;
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      value={value}
      onClick={e => e.stopPropagation()}
      onChange={e => {
        e.stopPropagation();
        onChange(e.target.value);
      }}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`shrink-0 text-xs border border-gray-300 rounded px-1.5 py-1 outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500 disabled:opacity-50 ${className}`}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// The 15/30/60-minute prep-length options, shared by every prep row.
export const PREP_LENGTH_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 15, label: '15 mins' },
  { value: 30, label: '30 mins' },
  { value: 60, label: '1 hour' },
];
