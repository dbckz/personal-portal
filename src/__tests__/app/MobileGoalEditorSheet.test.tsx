/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { MobileGoalEditorSheet } from '@/app/mobile/components/MobileGoalEditorSheet';
import { api } from '@/lib/api';
import type { Goal } from '@/types/life';

jest.mock('@/lib/api', () => ({
  api: {
    createGoal: jest.fn().mockResolvedValue({ goal: {} }),
    updateGoal: jest.fn().mockResolvedValue({ goal: {} }),
    inferGoal: jest.fn(),
    getAsanaProjects: jest.fn().mockResolvedValue({ projects: [] }),
    getAsanaTags: jest.fn().mockResolvedValue({ tags: [] }),
    getGoalCategories: jest.fn().mockResolvedValue({ categories: [] }),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const editorProps = {
  defaultSectionId: 'work',
  defaultPeriodKind: 'month' as const,
  parentCandidates: [],
  onClose: jest.fn(),
  onSaved: jest.fn(),
};

describe('MobileGoalEditorSheet', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a goal from the form and reports saved', async () => {
    const onSaved = jest.fn();
    render(<MobileGoalEditorSheet {...editorProps} onSaved={onSaved} />);

    fireEvent.change(screen.getByPlaceholderText('What are you aiming for?'), {
      target: { value: 'Publish 4 posts' },
    });
    fireEvent.change(screen.getByLabelText('Target number'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'posts' } });
    fireEvent.click(screen.getByRole('button', { name: /save goal/i }));

    await waitFor(() => expect(mockApi.createGoal).toHaveBeenCalled());
    const payload = mockApi.createGoal.mock.calls[0][0];
    expect(payload).toMatchObject({
      sectionId: 'work',
      periodKind: 'month',
      title: 'Publish 4 posts',
      target: { value: 4, unit: 'posts' },
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('prefills the form from an inferred proposal', async () => {
    mockApi.inferGoal.mockResolvedValue({
      proposal: {
        sectionId: 'work',
        periodKind: 'month',
        periodKey: '2026-08',
        title: 'Run 10K',
        detail: 'build up gradually',
        target: { value: 10, unit: 'km' },
        evidence: { kind: 'exercise', unit: 'max-distance-km' },
        milestones: [{ key: '2026-08-15', value: 6, label: '6 km long run' }],
      },
    });

    render(<MobileGoalEditorSheet {...editorProps} />);

    fireEvent.change(screen.getByPlaceholderText('Run 10K by the end of the quarter'), {
      target: { value: 'run a 10k' },
    });
    fireEvent.click(screen.getByRole('button', { name: /suggest/i }));

    await waitFor(() =>
      expect(screen.getByDisplayValue('Run 10K')).toBeInTheDocument()
    );
    // The inferred progression plan is carried into the form (read-only here).
    expect(screen.getByText('6 km long run')).toBeInTheDocument();
  });

  it('updates an existing goal and keeps its period fixed', async () => {
    const goal: Goal = {
      id: 'g9',
      sectionId: 'work',
      periodKind: 'month',
      periodKey: '2026-08',
      title: 'Old title',
      evidence: { kind: 'manual' },
      checkIns: [],
      status: 'active',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    render(<MobileGoalEditorSheet {...editorProps} goal={goal} />);

    // No inference fast path when editing.
    expect(screen.queryByText(/describe it, and i'll draft the rest/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Old title'), { target: { value: 'New title' } });
    fireEvent.click(screen.getByRole('button', { name: /save goal/i }));

    await waitFor(() => expect(mockApi.updateGoal).toHaveBeenCalled());
    expect(mockApi.updateGoal.mock.calls[0][0]).toBe('g9');
    expect(mockApi.updateGoal.mock.calls[0][1]).toMatchObject({ title: 'New title' });
  });
});
