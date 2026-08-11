'use client';

import type { AsanaProject } from '@/types';

// Touch replacement for the desktop ProjectCombobox (a custom typeahead popup
// that doesn't translate to touch). A plain native select is the phone-native
// picker: it opens the OS wheel/list, needs no keyboard, and can't get stranded
// half-open. Same value contract — '' means "no project".
export function MobileProjectSelect({
  value,
  onChange,
  projects,
  placeholder = 'Select project…',
  ariaLabel = 'Project',
  invalid = false,
}: {
  value: string;
  onChange: (gid: string) => void;
  projects: AsanaProject[];
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label={ariaLabel}
      className={`w-full rounded-lg border px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-orange-500 ${
        invalid ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white'
      } ${value ? 'text-gray-800' : 'text-gray-400'}`}
    >
      <option value="">{placeholder}</option>
      {projects.map(p => (
        <option key={p.gid} value={p.gid}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
