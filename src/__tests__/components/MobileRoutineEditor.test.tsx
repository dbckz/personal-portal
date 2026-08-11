/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { MobileRoutineEditor } from '@/app/mobile/components/MobileRoutineEditor';
import type { WeeklyRoutineDay } from '@/types/life';

jest.mock('@/lib/api', () => ({
  api: { saveWeeklyRoutine: jest.fn() },
}));

import { api } from '@/lib/api';

const mockSave = api.saveWeeklyRoutine as jest.Mock;

const ROUTINE: WeeklyRoutineDay[] = [
  { dayOfWeek: 1, title: 'Push', anchors: ['Incline dumbbell press'] },
  { dayOfWeek: 5, title: 'Rest', anchors: [], rest: true },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockImplementation((routine: WeeklyRoutineDay[]) => Promise.resolve({ routine }));
});

describe('MobileRoutineEditor', () => {
  it('renders each day editable with its anchors', () => {
    render(<MobileRoutineEditor initial={ROUTINE} onClose={jest.fn()} onSaved={jest.fn()} />);
    expect(screen.getByDisplayValue('Push')).toBeInTheDocument();
    expect(screen.getByText('Incline dumbbell press')).toBeInTheDocument();
  });

  it('edits a title, adds an anchor, and saves the whole routine', async () => {
    const onSaved = jest.fn();
    render(<MobileRoutineEditor initial={ROUTINE} onClose={jest.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByDisplayValue('Push'), { target: { value: 'Push A' } });

    const addInput = screen.getAllByPlaceholderText('Add anchor')[0];
    fireEvent.change(addInput, { target: { value: 'Flat press' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });
    expect(screen.getByText('Flat press')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save routine/i }));
    });

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const sent = mockSave.mock.calls[0][0] as WeeklyRoutineDay[];
    const monday = sent.find(d => d.dayOfWeek === 1);
    expect(monday?.title).toBe('Push A');
    expect(monday?.anchors).toContain('Flat press');
    expect(onSaved).toHaveBeenCalled();
  });

  it('turning a training day into a rest day hides its exercise lists', () => {
    render(<MobileRoutineEditor initial={ROUTINE} onClose={jest.fn()} onSaved={jest.fn()} />);
    // Monday starts as a training day with an anchor list.
    expect(screen.getAllByPlaceholderText('Add anchor')).toHaveLength(1);

    const restButtons = screen.getAllByRole('button', { name: /rest/i });
    fireEvent.click(restButtons[0]);
    expect(screen.queryByPlaceholderText('Add anchor')).not.toBeInTheDocument();
  });
});
