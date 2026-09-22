import { Flame, Wind } from 'lucide-react';

import type { SessionCue } from '@/lib/exercise-cues';

// A warm-up or cool-down line in the checklist: guidance written where it is
// done, deliberately quiet and with nothing to tick, so it reads as part of the
// schedule rather than another exercise.
export function SessionCueLines({ cues }: { cues?: SessionCue[] }) {
  if (!cues?.length) return null;
  return (
    <>
      {cues.map(cue => {
        const Icon = cue.kind === 'warmup' ? Flame : Wind;
        return (
          <p key={cue.text} className="flex gap-1.5 px-1 text-xs text-gray-500">
            <Icon
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${cue.kind === 'warmup' ? 'text-amber-500' : 'text-sky-500'}`}
            />
            <span>
              <span className="font-semibold text-gray-600">
                {cue.kind === 'warmup' ? 'Warm-up' : 'Cool-down'}
              </span>{' '}
              · {cue.text}
            </span>
          </p>
        );
      })}
    </>
  );
}
