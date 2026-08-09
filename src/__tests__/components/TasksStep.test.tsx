/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

import { TasksStep } from '@/components/dashboard/plan-week/TasksStep';
import type { WeekCandidate, WeekCandidateCategory } from '@/lib/api';

function candidate(over: Partial<WeekCandidate> = {}): WeekCandidate {
  return { id: 't1', title: 'Write the brief', isPriority: false, ...over };
}

function renderStep(
  candidates: WeekCandidate[],
  handlers: Partial<{
    deleteTask: jest.Mock;
    onOpenTask: jest.Mock;
    toggleSelection: jest.Mock;
    deletingIds: Set<string>;
  }> = {},
  catOver: Partial<WeekCandidateCategory> = {}
) {
  const cat: WeekCandidateCategory = {
    category: 'Writing',
    noQuota: false,
    remainingQuota: 5,
    autoSelect: false,
    targetLengthMinutes: 60,
    candidates,
    ...catOver,
  };
  const props = {
    deleteTask: handlers.deleteTask ?? jest.fn(),
    onOpenTask: handlers.onOpenTask ?? jest.fn(),
    toggleSelection: handlers.toggleSelection ?? jest.fn(),
    deletingIds: handlers.deletingIds ?? new Set<string>(),
  };
  render(
    <TasksStep
      taskCats={[cat]}
      selections={{}}
      taskDurations={{}}
      setTaskDurations={jest.fn()}
      taskDurationOverrides={{}}
      setTaskDurationOverrides={jest.fn()}
      mustDoIds={new Set()}
      walkDays={new Set()}
      weekWorkingDays={[]}
      toggleWalkDay={jest.fn()}
      completingIds={new Set()}
      addMoreMode={false}
      spareCapacity={null}
      toggleSelection={props.toggleSelection}
      toggleMustDo={jest.fn()}
      completeAsana={jest.fn()}
      deletingIds={props.deletingIds}
      deleteTask={props.deleteTask}
      onOpenTask={props.onOpenTask}
    />
  );
  return props;
}

describe('TasksStep delete', () => {
  it('requires a two-step confirm: first click arms, second click deletes', () => {
    const deleteTask = jest.fn();
    renderStep([candidate({ id: 'g1', gid: 'gid-1', integrationId: 'om' })], { deleteTask });

    // First click arms the confirm — the API/list mutation is NOT called yet.
    fireEvent.click(screen.getByLabelText('Delete "Write the brief"'));
    expect(deleteTask).not.toHaveBeenCalled();

    // The armed control exposes a confirm affordance; clicking it executes.
    const confirm = screen.getByLabelText('Confirm delete "Write the brief"');
    expect(confirm).toHaveTextContent(/Delete\?/);
    fireEvent.click(confirm);
    expect(deleteTask).toHaveBeenCalledTimes(1);
    expect(deleteTask).toHaveBeenCalledWith(
      'Writing',
      expect.objectContaining({ id: 'g1', gid: 'gid-1' })
    );
  });

  it('shows a spinner (no button) while a row is deleting', () => {
    renderStep([candidate({ id: 'g1' })], { deletingIds: new Set(['g1']) });
    expect(screen.getByLabelText('Deleting "Write the brief"')).toBeInTheDocument();
    expect(screen.queryByLabelText('Delete "Write the brief"')).not.toBeInTheDocument();
  });
});

describe('TasksStep calibration hints', () => {
  it('shows the quota + block-size hints when there is enough history', () => {
    renderStep([candidate({ id: 'g1' })], {}, {
      calibration: {
        weeksOfData: 6,
        avgCompletionRate: 0.58,
        currentQuota: 5,
        suggestedQuota: 4,
        reason: 'x',
        blockSamples: 8,
        suggestedBlockMinutes: 60,
        blockReason: 'y',
      },
    });
    expect(screen.getByText(/Completed 58% of scheduled over 6 wks/)).toBeInTheDocument();
    expect(screen.getByText(/suggest 4\/wk instead of 5/)).toBeInTheDocument();
    expect(screen.getByText(/Done tasks here usually got 60m/)).toBeInTheDocument();
  });

  it('suppresses the quota line below three weeks of data', () => {
    renderStep([candidate({ id: 'g1' })], {}, {
      calibration: { weeksOfData: 2, avgCompletionRate: 0.4, currentQuota: 5, blockSamples: 0 },
    });
    expect(screen.queryByText(/of scheduled over/)).not.toBeInTheDocument();
  });

  it('suppresses the block hint below five samples', () => {
    renderStep([candidate({ id: 'g1' })], {}, {
      calibration: {
        weeksOfData: 6,
        avgCompletionRate: 0.9,
        currentQuota: 5,
        blockSamples: 3,
        suggestedBlockMinutes: 60,
      },
    });
    expect(screen.queryByText(/Done tasks here usually got/)).not.toBeInTheDocument();
  });
});

describe('TasksStep double-click', () => {
  it('opens the task modal without toggling selection', () => {
    const onOpenTask = jest.fn();
    const toggleSelection = jest.fn();
    renderStep([candidate({ id: 'g1' })], { onOpenTask, toggleSelection });

    fireEvent.doubleClick(screen.getByText('Write the brief'));
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }));
    // Double-clicking the name must not flip the row's selection checkbox.
    expect(toggleSelection).not.toHaveBeenCalled();
  });
});
