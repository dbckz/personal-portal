'use client';

import { useEffect, useRef, useState } from 'react';
import { ClipboardCheck, RefreshCw, Trash2, MoreVertical } from 'lucide-react';

// The Command Center's planning card on the phone: a primary "Daily review"
// action (badged when the week-state says a review is due), with replan / reset
// tucked behind a secondary menu. Mirrors DashboardContent's daily-review +
// adaptive-planning buttons; the actual flow lives in MobileDailyReviewFlow.
export function MobileReviewCard({
  reviewDue,
  onStartReview,
  onReplan,
  onResetWeek,
}: {
  reviewDue: boolean;
  onStartReview: () => void;
  onReplan: () => void;
  onResetWeek: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Tap outside the menu closes it.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const runAndClose = (fn: () => void) => {
    setMenuOpen(false);
    fn();
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900">Review &amp; plan</h2>
          <p className="text-xs text-gray-500">
            {reviewDue ? 'A daily review is ready.' : 'Wrap up your day and reschedule the rest.'}
          </p>
        </div>
        <div className="relative flex-shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen(v => !v)}
            aria-label="More planning actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-gray-200 text-gray-500 active:bg-gray-50"
          >
            <MoreVertical className="h-5 w-5" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-12 z-10 w-52 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => runAndClose(onReplan)}
                className="flex w-full items-center gap-2.5 px-3 py-3 text-left text-sm text-gray-700 active:bg-gray-50"
              >
                <RefreshCw className="h-4 w-4 text-orange-500" />
                Replan week
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => runAndClose(onResetWeek)}
                className="flex w-full items-center gap-2.5 border-t border-gray-100 px-3 py-3 text-left text-sm text-red-600 active:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
                Reset week
              </button>
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onStartReview}
        className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-orange-500 text-sm font-semibold text-white active:bg-orange-600"
      >
        <ClipboardCheck className="h-4 w-4" />
        Daily review
        {reviewDue && <span className="ml-0.5 h-2 w-2 rounded-full bg-white" aria-label="due" />}
      </button>
    </section>
  );
}
