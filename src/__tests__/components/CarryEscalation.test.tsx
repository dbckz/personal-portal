/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ReplanSections } from '@/components/dashboard/ReplanSections';
import { useReplanActions } from '@/components/dashboard/useReplanActions';
import { TasksStep } from '@/components/dashboard/plan-week/TasksStep';
import type { ReplanAnalyzeResponse, WeekCandidate, WeekCandidateCategory } from '@/lib/api';
import type { ReplanCarryTask } from '@/lib/scheduling/replan';

jest.mock('@/lib/api', () => ({
  api: { confirmReplan: jest.fn() },
}));

import { api } from '@/lib/api';

// confirmReplan's positional arguments (see src/lib/api.ts).
const ARG_CARRY = 11;
const ARG_DELEGATE = 14;

beforeEach(() => {
  jest.clearAllMocks();
  (api.confirmReplan as jest.Mock).mockResolvedValue({ results: [], doneResults: [] });
});

// ---------------------------------------------------------------- TasksStep

function candidate(over: Partial<WeekCandidate> = {}): WeekCandidate {
  return { id: 't1', title: 'Write the brief', isPriority: false, ...over };
}

function tasksStep(candidates: WeekCandidate[], mustDoIds = new Set<string>()) {
  const cat: WeekCandidateCategory = {
    category: 'Writing',
    noQuota: false,
    remainingQuota: 5,
    autoSelect: false,
    targetLengthMinutes: 60,
    candidates,
  };
  return render(
    <TasksStep
      taskCats={[cat]}
      selections={{}}
      taskDurations={{}}
      setTaskDurations={jest.fn()}
      taskDurationOverrides={{}}
      setTaskDurationOverrides={jest.fn()}
      mustDoIds={mustDoIds}
      walkDays={new Set()}
      weekWorkingDays={[]}
      toggleWalkDay={jest.fn()}
      completingIds={new Set()}
      addMoreMode={false}
      spareCapacity={null}
      toggleSelection={jest.fn()}
      toggleMustDo={jest.fn()}
      completeAsana={jest.fn()}
      deletingIds={new Set()}
      deleteTask={jest.fn()}
      onOpenTask={jest.fn()}
    />
  );
}

describe('TasksStep carry badge', () => {
  it.each([
    [1, '↩ last week', false],
    [2, '↩ 2nd week', true],
    [3, '↩ 3rd week', true],
    [5, '↩ 5th week', true],
  ])('streak %i renders %s', (streak, label, escalated) => {
    tasksStep([candidate({ carriedOver: true, carryStreak: streak })]);

    const badge = screen.getByText(label);
    expect(badge).toBeInTheDocument();
    if (escalated) {
      expect(badge.className).toContain('bg-amber-100');
      expect(badge.className).toContain('text-amber-800');
      expect(badge).toHaveAttribute('title', `Carried over ${streak} weeks running`);
    } else {
      expect(badge.className).toContain('bg-orange-100');
      expect(badge.className).not.toContain('bg-amber-100');
    }
  });

  it('falls back to "last week" when no streak is recorded', () => {
    tasksStep([candidate({ carriedOver: true })]);
    expect(screen.getByText('↩ last week').className).toContain('bg-orange-100');
  });

  it('renders no badge for a task that was never carried', () => {
    tasksStep([candidate()]);
    expect(screen.queryByText(/↩/)).not.toBeInTheDocument();
  });

  it('reads a must-do candidate as flagged', () => {
    tasksStep([candidate({ mustDo: true })], new Set(['t1']));

    const flag = screen.getByRole('button', { name: /Must do/ });
    expect(flag).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});

// ----------------------------------------------------- end-of-week carry cards

function carryTask(over: Partial<ReplanCarryTask> = {}): ReplanCarryTask {
  return { id: 'task-1', title: 'Chase the invoice', done: false, ...over };
}

function analyze(tasks: ReplanCarryTask[]): ReplanAnalyzeResponse {
  return {
    weekStart: '2026-07-20',
    weekEnd: '2026-07-26',
    kept: [],
    moves: [],
    unplaceable: [],
    stale: [],
    additions: [],
    deletions: [],
    endOfWeek: true,
    carryBlocks: [
      {
        googleEventId: 'evt-1',
        category: 'Admin',
        titles: ['Admin'],
        date: '2026-07-24',
        start: '10:00',
        durationMinutes: 60,
        reason: 'missed',
        tasks,
        mergedEventIds: ['evt-1'],
      },
    ],
  };
}

function Harness({ data }: { data: ReplanAnalyzeResponse }) {
  const actions = useReplanActions(data);
  return (
    <>
      <ReplanSections data={data} actions={actions} />
      <button onClick={() => void actions.confirm()}>Apply</button>
    </>
  );
}

const apply = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  });
  await waitFor(() => expect(api.confirmReplan).toHaveBeenCalled());
  return (api.confirmReplan as jest.Mock).mock.calls[0];
};

describe('end-of-week carry escalation', () => {
  it('shows the escalated options and a streak note at two carries', () => {
    render(<Harness data={analyze([carryTask({ carryStreak: 2 })])} />);

    expect(screen.getByText('carried 2 weeks running')).toBeInTheDocument();
    for (const label of ['Must do next week', 'Carry again', 'Drop to backlog', 'Mark done']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Carry over to next week' })).not.toBeInTheDocument();
  });

  it('keeps the plain three options for a first-time carry', () => {
    render(<Harness data={analyze([carryTask({ carryStreak: 1 })])} />);

    expect(screen.queryByText(/weeks running/)).not.toBeInTheDocument();
    for (const label of ['Carry over to next week', 'Back to backlog', 'Mark done']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Must do next week' })).not.toBeInTheDocument();
  });

  it('keeps the plain three options when no streak is recorded', () => {
    render(<Harness data={analyze([carryTask()])} />);
    expect(screen.getByRole('button', { name: 'Carry over to next week' })).toBeInTheDocument();
    expect(screen.queryByText(/weeks running/)).not.toBeInTheDocument();
  });

  it('sends "must do next week" as a carry entry flagged mustDo', async () => {
    render(<Harness data={analyze([carryTask({ carryStreak: 3 })])} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Must do next week' }));
    });
    const call = await apply();

    expect(call[ARG_CARRY]).toEqual([
      { blockId: 'evt-1', blockIds: ['evt-1'], taskIds: ['task-1'], mustDo: true },
    ]);
    expect(call[ARG_DELEGATE]).toBeUndefined();
  });

  it('sends a delegate entry and no carry entry when delegating', async () => {
    render(
      <Harness
        data={analyze([
          carryTask({ carryStreak: 2, aiDelegable: true, gid: 'g1', integrationId: 'i1' }),
        ])}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    });
    const call = await apply();

    expect(call[ARG_DELEGATE]).toEqual([
      { blockId: 'evt-1', gid: 'g1', integrationId: 'i1', title: 'Chase the invoice' },
    ]);
    expect(call[ARG_CARRY]).toBeUndefined();
  });

  it('offers Delegate only for an AI-runnable task with Asana details', () => {
    const { unmount } = render(
      <Harness data={analyze([carryTask({ carryStreak: 2, gid: 'g1', integrationId: 'i1' })])} />
    );
    expect(screen.queryByRole('button', { name: 'Delegate' })).not.toBeInTheDocument();
    unmount();

    render(<Harness data={analyze([carryTask({ carryStreak: 2, aiDelegable: true })])} />);
    expect(screen.queryByRole('button', { name: 'Delegate' })).not.toBeInTheDocument();
  });

  it('marks only AI-runnable tasks with the robot indicator', () => {
    const data = analyze([
      carryTask({ id: 'a', title: 'Chase the invoice', aiDelegable: true, gid: 'g1', integrationId: 'i1' }),
      carryTask({ id: 'b', title: 'Book the venue' }),
    ]);
    render(<Harness data={data} />);

    expect(screen.getAllByLabelText('AI-runnable')).toHaveLength(1);
  });
});
