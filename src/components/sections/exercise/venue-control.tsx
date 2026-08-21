import { Dumbbell, Home, Loader2 } from 'lucide-react';

// The "swap today to a home session" control, shared by the desktop Today tab and
// the mobile Exercise tab so the two never drift. When the day is a home session
// it shows a "🏠 Home session" badge and a "Back to gym session" action; on a gym
// day it shows a single "Swap to home session" action. The action is optimistic
// in the hook (useTodaySession.setVenue) — this is presentation only.
export function VenueControl({
  venue,
  busy,
  onSet,
}: {
  venue?: 'home';
  busy: boolean;
  onSet: (venue: 'home' | 'gym') => void;
}) {
  const isHome = venue === 'home';
  return (
    <div className="flex items-center gap-2">
      {isHome && (
        <span className="flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
          <Home className="h-3 w-3" />
          Home session
        </span>
      )}
      <button
        type="button"
        onClick={() => onSet(isHome ? 'gym' : 'home')}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : isHome ? (
          <Dumbbell className="h-3.5 w-3.5" />
        ) : (
          <Home className="h-3.5 w-3.5" />
        )}
        {isHome ? 'Back to gym session' : 'Swap to home session'}
      </button>
    </div>
  );
}
