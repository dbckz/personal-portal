/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  MUSCLES,
  aggregateMuscleLoad,
  rangeFromAnchor,
} from '@/lib/exercise-muscles';
import type { ExerciseSession } from '@/types/life';

const sampleSessions: ExerciseSession[] = [
  {
    id: 's1',
    date: '2026-08-20',
    type: 'gym',
    planned: false,
    completed: true,
    exercises: [
      { id: 'e1', name: 'Incline DB press', sets: 4, done: true },
      { id: 'e2', name: 'Seated cable row', sets: 3, done: true },
    ],
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  },
];

const getMuscleLoad = jest.fn((windowDays: number, anchor?: string) => {
  const resolvedAnchor = anchor ?? '2026-08-25';
  const range = rangeFromAnchor(resolvedAnchor, windowDays);
  return Promise.resolve({
    muscles: aggregateMuscleLoad(sampleSessions, [], range),
    range,
    anchor: resolvedAnchor,
    windowDays,
  });
});

jest.mock('@/lib/api', () => ({
  api: {
    getMuscleLoad: (windowDays: number, anchor?: string) => getMuscleLoad(windowDays, anchor),
  },
}));

import { MusclesTab } from '@/components/sections/exercise/MusclesTab';

beforeEach(() => getMuscleLoad.mockClear());

describe('MusclesTab', () => {
  it('renders a Planned figure beside an Actual figure', async () => {
    render(<MusclesTab />);
    await waitFor(() => expect(getMuscleLoad).toHaveBeenCalled());
    expect(screen.getByText('Planned')).toBeInTheDocument();
    expect(screen.getByText('Actual')).toBeInTheDocument();
    // Two figures, each with a front and back view.
    expect(screen.getAllByLabelText('Front view muscle heatmap')).toHaveLength(2);
    expect(screen.getAllByLabelText('Back view muscle heatmap')).toHaveLength(2);
  });

  it('draws every muscle region on both figures', async () => {
    const { container } = render(<MusclesTab />);
    await waitFor(() => expect(container.querySelector('[data-muscle]')).not.toBeNull());
    for (const muscle of MUSCLES) {
      expect(container.querySelector(`[data-muscle="${muscle.id}"]`)).not.toBeNull();
    }
    // Two figures × 18 muscles.
    expect(container.querySelectorAll('[data-muscle]')).toHaveLength(MUSCLES.length * 2);
  });

  it('shows the muscle detail when a region is selected on either figure', async () => {
    const { container } = render(<MusclesTab />);
    await waitFor(() => expect(container.querySelector('[data-muscle="chest"]')).not.toBeNull());
    expect(screen.getByText(/click one on either figure/i)).toBeInTheDocument();

    fireEvent.click(container.querySelector('[data-muscle="chest"]')!);

    await waitFor(() =>
      expect(screen.getByText(/push the arms forward and across the body/i)).toBeInTheDocument()
    );
    expect(screen.getByText('Incline DB press')).toBeInTheDocument();
  });

  it('scrubs the period with the slider, debounces the fetch, and offers a Today reset', async () => {
    const todayIso = new Date().toISOString().slice(0, 10);
    render(<MusclesTab />);
    await waitFor(() => expect(getMuscleLoad).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();

    // Drag the scrubber back four weeks.
    fireEvent.change(screen.getByRole('slider', { name: /scrub the period/i }), {
      target: { value: '-4' },
    });

    // The Today reset appears immediately (live), before any refetch.
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();

    // The fetch is debounced, then fires with a new (non-today) anchor.
    await waitFor(() =>
      expect(getMuscleLoad.mock.calls.some(c => c[1] && c[1] !== todayIso)).toBe(true)
    );

    // Reset recentres the slider and hides the Today button.
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();
    expect((screen.getByRole('slider', { name: /scrub the period/i }) as HTMLInputElement).value).toBe('0');
  });

  it('lists the coolest muscles in the most-missed strip', async () => {
    const { container } = render(<MusclesTab />);
    await waitFor(() => expect(container.querySelector('[data-muscle]')).not.toBeNull());
    const missed = screen.getByText('Most missed').closest('section')!;
    expect(within(missed).getAllByRole('button').length).toBeGreaterThan(0);
  });
});
