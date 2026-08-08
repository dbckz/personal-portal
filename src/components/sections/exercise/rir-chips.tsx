'use client';

// Reps-in-reserve rating: how many more reps were left at the end of the set.
// A compact row of chips, tapped one-handed in the gym. 0 = nothing left, 4 =
// comfortably light (the top chip reads "4+"). Tapping the selected chip again
// clears the rating, so an accidental tap is one tap to undo. When set, this
// drives the next session's target directly, ahead of anything read from the
// note (see exercise-targets).
//
// Shared by the mobile and desktop Today checklists so the control looks and
// behaves the same on both.

const CHOICES: Array<{ value: number; label: string }> = [
  { value: 0, label: '0' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4+' },
];

export function RirChips({
  value,
  onChange,
}: {
  value?: number;
  onChange: (rir: number | null) => void;
}) {
  return (
    <div className="mt-3">
      <span className="mb-1 block text-xs font-semibold text-gray-600">Reps in reserve</span>
      <div className="flex gap-1.5" role="group" aria-label="Reps in reserve">
        {CHOICES.map(choice => {
          const selected = value === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(selected ? null : choice.value)}
              className={`h-9 min-w-9 flex-1 rounded-md border text-sm font-medium tabular-nums transition-colors ${
                selected
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-gray-300 bg-white text-gray-700 active:bg-gray-50 hover:bg-gray-50'
              }`}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
