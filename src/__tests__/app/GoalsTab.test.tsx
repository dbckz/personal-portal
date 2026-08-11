/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { GoalsTab } from '@/app/mobile/tabs/GoalsTab';
import { api } from '@/lib/api';
import type { Goal, GoalProgress, GoalWithProgress } from '@/types/life';

jest.mock('@/lib/api', () => ({
  api: {
    checkInGoal: jest.fn().mockResolvedValue({}),
    deleteGoal: jest.fn().mockResolvedValue({ success: true }),
    // Editor sheet lazy-loads these when its evidence pickers open; stub so a
    // stray call can't throw.
    getAsanaProjects: jest.fn().mockResolvedValue({ projects: [] }),
    getAsanaTags: jest.fn().mockResolvedValue({ tags: [] }),
    getGoalCategories: jest.fn().mockResolvedValue({ categories: [] }),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

function makeProgress(over: Partial<GoalProgress> = {}): GoalProgress {
  return {
    goalId: 'g1',
    periodElapsed: 0.5,
    expected: 3,
    actual: 2,
    completion: 0.4,
    pace: 'behind',
    evidenceLabel: '2 done',
    noEvidence: false,
    ...over,
  };
}

function makeGoal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    sectionId: 'work',
    periodKind: 'month',
    periodKey: '2026-08',
    title: 'Ship the mobile goals editor',
    evidence: { kind: 'manual' },
    checkIns: [],
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function item(over: Partial<Goal> = {}, progressOver: Partial<GoalProgress> = {}): GoalWithProgress {
  const goal = makeGoal(over);
  return { goal, progress: makeProgress({ goalId: goal.id, ...progressOver }) };
}

const baseProps = {
  quarterItems: [],
  nudges: [],
  isLoading: false,
  error: null,
};

describe('GoalsTab (mobile, read/write)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records a check-in optimistically and refreshes', async () => {
    const onChanged = jest.fn();
    render(<GoalsTab {...baseProps} monthItems={[item()]} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: /check in/i }));
    fireEvent.change(screen.getByPlaceholderText("What's the state of this?"), {
      target: { value: 'steady' },
    });
    fireEvent.click(screen.getByRole('button', { name: /slipping/i }));

    await waitFor(() =>
      expect(mockApi.checkInGoal).toHaveBeenCalledWith('g1', {
        status: 'slipping',
        note: 'steady',
        value: undefined,
        source: 'goals-tab',
      })
    );
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByText(/checked in — slipping/i)).toBeInTheDocument();
  });

  it('deletes only after the inline confirm and hides the goal optimistically', async () => {
    const onChanged = jest.fn();
    render(<GoalsTab {...baseProps} monthItems={[item()]} onChanged={onChanged} />);

    // First tap only reveals the confirm; nothing is deleted yet.
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(mockApi.deleteGoal).not.toHaveBeenCalled();
    expect(screen.getByText(/its history goes with it/i)).toBeInTheDocument();

    // The confirm's Delete button is the second matching control.
    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => expect(mockApi.deleteGoal).toHaveBeenCalledWith('g1'));
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByText('Ship the mobile goals editor')).not.toBeInTheDocument();
  });

  it('opens the editor sheet for a new goal', () => {
    render(<GoalsTab {...baseProps} monthItems={[]} onChanged={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /new goal/i }));
    expect(screen.getByText(/describe it, and i'll draft the rest/i)).toBeInTheDocument();
  });

  it('opens the editor sheet to edit an existing goal', () => {
    render(<GoalsTab {...baseProps} monthItems={[item()]} onChanged={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByRole('heading', { name: /edit goal/i })).toBeInTheDocument();
  });
});
