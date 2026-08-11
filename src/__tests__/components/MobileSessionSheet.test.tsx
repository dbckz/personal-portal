/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { MobileSessionSheet } from '@/app/mobile/components/MobileSessionSheet';
import type { ExerciseSession } from '@/types/life';

jest.mock('@/lib/api', () => ({
  api: {
    createExerciseSession: jest.fn(),
    updateExerciseSession: jest.fn(),
    deleteExerciseSession: jest.fn(),
  },
}));

import { api } from '@/lib/api';

const mockCreate = api.createExerciseSession as jest.Mock;
const mockUpdate = api.updateExerciseSession as jest.Mock;

const SESSION: ExerciseSession = {
  id: 's1',
  date: '2026-08-09',
  type: 'gym',
  durationMinutes: 45,
  intensity: 'moderate',
  planned: true,
  completed: false,
  exercises: [{ id: 'e1', name: 'Bench press', sets: 3, reps: 8, weightKg: 40 }],
  createdAt: '',
  updatedAt: '',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({ session: SESSION });
  mockUpdate.mockResolvedValue({ session: SESSION });
});

describe('MobileSessionSheet', () => {
  it('creates a planned session from the type and date', async () => {
    const onSaved = jest.fn();
    render(<MobileSessionSheet mode="plan" onClose={jest.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByPlaceholderText('run, gym, climbing'), { target: { value: 'run' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'run', planned: true, completed: false })
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('offers the exercise list only in log mode and sends parsed entries', async () => {
    render(<MobileSessionSheet mode="log" onClose={jest.fn()} onSaved={jest.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('run, gym, climbing'), { target: { value: 'gym' } });
    fireEvent.click(screen.getByRole('button', { name: /add exercise/i }));
    fireEvent.change(screen.getByPlaceholderText('Exercise'), { target: { value: 'Squat' } });
    fireEvent.change(screen.getByPlaceholderText('3*8 · 2 km'), { target: { value: '3*5' } });
    fireEvent.change(screen.getByPlaceholderText('27kg'), { target: { value: '60kg' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.completed).toBe(true);
    expect(arg.exercises).toHaveLength(1);
    expect(arg.exercises[0]).toMatchObject({ name: 'Squat', sets: 3, reps: 5, weightKg: 60 });
  });

  it('blocks saving without a type', async () => {
    render(<MobileSessionSheet mode="plan" onClose={jest.fn()} onSaved={jest.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/give the session a type/i)).toBeInTheDocument();
  });

  it('edits an existing session via updateExerciseSession', async () => {
    render(
      <MobileSessionSheet mode="log" session={SESSION} onClose={jest.fn()} onSaved={jest.fn()} />
    );

    // Pre-filled from the session, and shows its exercises for context.
    expect(screen.getByDisplayValue('gym')).toBeInTheDocument();
    expect(screen.getByText('Bench press')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('gym'), { target: { value: 'climbing' } });
    fireEvent.click(screen.getByRole('button', { name: /mark as done/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ type: 'climbing', completed: true, planned: false })
    );
  });

  it('deletes only after a confirm step', async () => {
    const onDelete = jest.fn();
    const onClose = jest.fn();
    render(
      <MobileSessionSheet
        mode="log"
        session={SESSION}
        onClose={onClose}
        onSaved={jest.fn()}
        onDelete={onDelete}
      />
    );

    // First tap reveals the confirm, without deleting.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /delete session/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });
});
