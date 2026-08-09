/**
 * @jest-environment jsdom
 *
 * The desktop Routine tab: it loads the routine, renders a card per day with
 * anchors and staples, keeps Save disabled until an edit is made, and sends the
 * whole routine on save.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { RoutineTab } from '@/components/sections/exercise/RoutineTab';
import type { WeeklyRoutineDay } from '@/types/life';

jest.mock('@/lib/api', () => ({
  api: {
    getWeeklyRoutine: jest.fn(),
    saveWeeklyRoutine: jest.fn(),
  },
}));

import { api } from '@/lib/api';

const mockGet = api.getWeeklyRoutine as jest.Mock;
const mockSave = api.saveWeeklyRoutine as jest.Mock;

const ROUTINE: WeeklyRoutineDay[] = [
  { dayOfWeek: 1, title: 'Push (chest & arms)', anchors: ['Incline dumbbell press'] },
  { dayOfWeek: 2, title: 'Run + core', anchors: [], staples: ['Dead bug'] },
  { dayOfWeek: 5, title: 'Rest', anchors: [], rest: true },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ routine: ROUTINE });
  mockSave.mockImplementation((routine: WeeklyRoutineDay[]) => Promise.resolve({ routine }));
});

async function renderTab() {
  await act(async () => {
    render(<RoutineTab />);
  });
}

describe('RoutineTab', () => {
  it('renders a card per day with its anchors and staples', async () => {
    await renderTab();
    expect(await screen.findByDisplayValue('Push (chest & arms)')).toBeInTheDocument();
    expect(screen.getByText('Incline dumbbell press')).toBeInTheDocument();
    expect(screen.getByText('Dead bug')).toBeInTheDocument();
    expect(screen.getByText('Rest day.')).toBeInTheDocument();
  });

  it('keeps Save disabled until an edit is made, then saves the routine', async () => {
    await renderTab();
    const saveButton = await screen.findByRole('button', { name: /save/i });
    expect(saveButton).toBeDisabled();

    const titleInput = screen.getByDisplayValue('Push (chest & arms)');
    fireEvent.change(titleInput, { target: { value: 'Push A' } });
    expect(saveButton).toBeEnabled();

    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const sent = mockSave.mock.calls[0][0] as WeeklyRoutineDay[];
    expect(sent.find(d => d.dayOfWeek === 1)?.title).toBe('Push A');
  });

  it('adds an anchor to a day', async () => {
    await renderTab();
    await screen.findByDisplayValue('Push (chest & arms)');

    const addInput = screen.getAllByPlaceholderText('Add anchor')[0];
    fireEvent.change(addInput, { target: { value: 'Flat dumbbell press' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });

    expect(screen.getByText('Flat dumbbell press')).toBeInTheDocument();
  });
});
