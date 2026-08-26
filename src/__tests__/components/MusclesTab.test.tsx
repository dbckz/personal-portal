/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MUSCLES, aggregateMuscleLoad } from '@/lib/exercise-muscles';
import type { ExerciseSession } from '@/types/life';

const NOW = new Date('2026-08-25T12:00:00.000Z');

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

const muscleLoad = aggregateMuscleLoad(sampleSessions, [], 28, NOW);

jest.mock('@/lib/api', () => ({
  api: {
    getMuscleLoad: jest.fn().mockResolvedValue({ muscles: muscleLoad, windowDays: 28 }),
  },
}));

import { MusclesTab } from '@/components/sections/exercise/MusclesTab';

describe('MusclesTab', () => {
  it('renders both front and back figures', async () => {
    const { container } = render(<MusclesTab />);
    await waitFor(() => expect(container.querySelector('[data-muscle]')).not.toBeNull());
    expect(screen.getByLabelText('Front view muscle heatmap')).toBeInTheDocument();
    expect(screen.getByLabelText('Back view muscle heatmap')).toBeInTheDocument();
  });

  it('draws every muscle region', async () => {
    const { container } = render(<MusclesTab />);
    await waitFor(() => expect(container.querySelector('[data-muscle]')).not.toBeNull());
    for (const muscle of MUSCLES) {
      expect(container.querySelector(`[data-muscle="${muscle.id}"]`)).not.toBeNull();
    }
    expect(container.querySelectorAll('[data-muscle]')).toHaveLength(MUSCLES.length);
  });

  it('shows the muscle detail when a region is selected', async () => {
    const { container } = render(<MusclesTab />);
    await waitFor(() => expect(container.querySelector('[data-muscle="chest"]')).not.toBeNull());

    // Before selection, the panel prompts for a choice.
    expect(screen.getByText(/click one for the full breakdown/i)).toBeInTheDocument();

    fireEvent.click(container.querySelector('[data-muscle="chest"]')!);

    await waitFor(() =>
      expect(screen.getByText(/push the arms forward and across the body/i)).toBeInTheDocument()
    );
    // The chest was pressed 4 sets in the window, so its exercise appears.
    expect(screen.getByText('Incline DB press')).toBeInTheDocument();
  });

  it('lists the coolest muscles in the most-missed strip', async () => {
    const { container } = render(<MusclesTab />);
    await waitFor(() => expect(container.querySelector('[data-muscle]')).not.toBeNull());
    expect(screen.getByText('Most missed')).toBeInTheDocument();
  });
});
