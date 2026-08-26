'use client';

import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { DateRange, MuscleLoad } from '@/lib/exercise-muscles';

// Fetches the per-muscle planned vs done load for a window ending at `anchor`,
// shared by the desktop Muscles tab and the mobile muscle view. Refetches when
// the window or anchor changes; keeps the previous data visible while a new range
// loads so the diagrams don't flash empty.
export function useMuscleLoad(
  windowDays: number,
  anchor: string
): {
  muscles: MuscleLoad[];
  range: DateRange | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [muscles, setMuscles] = useState<MuscleLoad[]>([]);
  const [range, setRange] = useState<DateRange | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!hasLoaded) setIsLoading(true);
    setError(null);
    try {
      const res = await api.getMuscleLoad(windowDays, anchor);
      setMuscles(res.muscles);
      setRange(res.range);
      setHasLoaded(true);
    } catch (err) {
      console.error('Failed to load muscle load:', err);
      setError('Could not load the muscle map.');
    } finally {
      setIsLoading(false);
    }
  }, [windowDays, anchor, hasLoaded]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { muscles, range, isLoading, error, refresh };
}
