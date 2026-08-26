'use client';

import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { MuscleLoad } from '@/lib/exercise-muscles';

// Fetches the per-muscle load for a window, shared by the desktop Muscles tab and
// the mobile muscle view. Refetches when the window changes; keeps the previous
// data visible while a new window loads so the diagram doesn't flash empty.
export function useMuscleLoad(windowDays: number): {
  muscles: MuscleLoad[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [muscles, setMuscles] = useState<MuscleLoad[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!hasLoaded) setIsLoading(true);
    setError(null);
    try {
      const res = await api.getMuscleLoad(windowDays);
      setMuscles(res.muscles);
      setHasLoaded(true);
    } catch (err) {
      console.error('Failed to load muscle load:', err);
      setError('Could not load the muscle map.');
    } finally {
      setIsLoading(false);
    }
  }, [windowDays, hasLoaded]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { muscles, isLoading, error, refresh };
}
