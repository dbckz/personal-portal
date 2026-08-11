/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { ExerciseTab } from '@/app/mobile/tabs/ExerciseTab';
import type { ExerciseSession } from '@/types/life';

// Stub the whole api: the child TodayChecklist/RoutineCard fetch on mount, and
// this suite drives the session-level write actions the tab owns.
jest.mock('@/lib/api', () => ({
  api: {
    getExerciseTargets: jest.fn().mockResolvedValue({ date: '2026-08-11', targets: [] }),
    getExerciseSessions: jest.fn().mockResolvedValue({ sessions: [] }),
    getExerciseProgressions: jest.fn().mockResolvedValue({ progressions: [] }),
    getWeeklyRoutine: jest.fn().mockResolvedValue({ routine: [] }),
    syncExerciseCalendar: jest.fn(),
    deleteExerciseSession: jest.fn(),
  },
}));

import { api } from '@/lib/api';

const mockSync = api.syncExerciseCalendar as jest.Mock;
const mockDelete = api.deleteExerciseSession as jest.Mock;

const PLANNED: ExerciseSession = {
  id: 'p1',
  date: '2026-08-20',
  type: 'run',
  planned: true,
  completed: false,
  createdAt: '',
  updatedAt: '',
};

function renderTab(over: Partial<React.ComponentProps<typeof ExerciseTab>> = {}) {
  return render(
    <ExerciseTab
      planned={[PLANNED]}
      recent={[]}
      analysis={null}
      isLoading={false}
      error={null}
      onSessionChanged={jest.fn()}
      {...over}
    />
  );
}

beforeEach(() => jest.clearAllMocks());

describe('ExerciseTab write parity', () => {
  it('syncs from the calendar and shows the result note', async () => {
    mockSync.mockResolvedValue({ scanned: 3, created: 2, updated: 1, removed: 0 });
    const onSessionChanged = jest.fn();
    await act(async () => {
      renderTab({ onSessionChanged });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync calendar' }));
    });

    await waitFor(() => expect(screen.getByText('2 new, 1 updated.')).toBeInTheDocument());
    expect(onSessionChanged).toHaveBeenCalled();
  });

  it('opens the plan sheet from the Planned group action', async () => {
    await act(async () => {
      renderTab();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Plan a session' }));
    expect(screen.getByRole('heading', { name: 'Plan a session' })).toBeInTheDocument();
  });

  it('optimistically removes a session on delete', async () => {
    mockDelete.mockResolvedValue({ success: true });
    await act(async () => {
      renderTab();
    });

    // Tap the planned row to edit, then delete through the confirm.
    fireEvent.click(screen.getByRole('button', { name: /edit run/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /delete session/i }));
    });

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('p1'));
    // The row is gone and the empty state shows.
    expect(screen.getByText('Nothing planned.')).toBeInTheDocument();
  });
});
