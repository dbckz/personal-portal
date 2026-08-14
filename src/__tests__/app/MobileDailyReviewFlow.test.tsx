/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { format, subDays } from 'date-fns';

import { MobileDailyReviewFlow } from '@/app/mobile/components/MobileDailyReviewFlow';
import { MobileReviewCard } from '@/app/mobile/command-center/MobileReviewCard';
import { logicalToday } from '@/lib/date-utils';
import type { ReplanReviewBlock } from '@/lib/scheduling/replan';

// The habit panel asks for today plus any recent day whose habits were never
// answered. Most tests want the single-day case, so the default store has the
// six prior days already answered — only today is asked.
const TODAY = logicalToday();

function habitDay(date: string, habits: Array<{ habitId: string; done: boolean; reason?: string }>) {
  return { date, habits, notes: '', createdAt: '', updatedAt: '' };
}

function priorWeekAnswered() {
  return Array.from({ length: 6 }, (_, i) =>
    habitDay(format(subDays(new Date(`${TODAY}T12:00:00`), i + 1), 'yyyy-MM-dd'), [
      { habitId: 'meditate', done: true },
      { habitId: 'morning-pages', done: true },
    ])
  );
}

// The flow (and the step-2 replan hook / habit panel) reach the api layer at
// module load; mock every method they can touch so nothing hits the network.
jest.mock('@/lib/api', () => ({
  api: {
    analyzeReplan: jest.fn(),
    confirmReplan: jest.fn(),
    completeDailyReview: jest.fn(),
    getReviewMessage: jest.fn(),
    dismissReviewTitle: jest.fn(),
    getWellbeingDays: jest.fn(),
    saveWellbeingDay: jest.fn(),
    resetWeek: jest.fn(),
  },
}));

import { api } from '@/lib/api';

const WORKSPACES = [{ id: 'ws-om', name: 'OpenMined' }];

function reviewBlock(overrides: Partial<ReplanReviewBlock> = {}): ReplanReviewBlock {
  return {
    googleEventId: 'evt-1',
    googleIntegrationId: 'gcal-1',
    kind: 'task',
    category: 'Deep work',
    date: '2026-07-24',
    start: '09:00',
    durationMinutes: 90,
    startMs: Date.parse('2026-07-24T09:00:00Z'),
    endMs: Date.parse('2026-07-24T10:30:00Z'),
    done: false,
    titles: ['Write the policy brief'],
    tasks: [{ title: 'Write the policy brief', done: false, adhocId: 'adhoc-1' }],
    ...overrides,
  };
}

function analyzeResponse(overrides: Record<string, unknown> = {}) {
  return {
    weekStart: '2026-07-20',
    weekEnd: '2026-07-26',
    kept: [],
    moves: [],
    unplaceable: [],
    stale: [],
    additions: [],
    deletions: [],
    reviewBlocks: [],
    ...overrides,
  };
}

async function renderFlow(props: Partial<React.ComponentProps<typeof MobileDailyReviewFlow>>) {
  await act(async () => {
    render(
      <MobileDailyReviewFlow
        entry="review"
        workspaceOptions={WORKSPACES}
        onClose={() => {}}
        onApplied={() => {}}
        {...props}
      />
    );
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (api.confirmReplan as jest.Mock).mockResolvedValue({
    results: [],
    doneResults: [],
    additionResults: [],
  });
  (api.completeDailyReview as jest.Mock).mockResolvedValue({});
  (api.getReviewMessage as jest.Mock).mockResolvedValue({ message: 'Good day.' });
  (api.getWellbeingDays as jest.Mock).mockResolvedValue({ days: priorWeekAnswered() });
  (api.saveWellbeingDay as jest.Mock).mockResolvedValue({ day: null });
  (api.resetWeek as jest.Mock).mockResolvedValue({});
});

describe('MobileDailyReviewFlow — review step', () => {
  it('offers three outcomes and records Started on apply', async () => {
    (api.analyzeReplan as jest.Mock).mockResolvedValue(analyzeResponse({ reviewBlocks: [reviewBlock()] }));
    await renderFlow({ entry: 'review' });

    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Started' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Didn’t do' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Started' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save & continue/i }));
    });

    const call = (api.confirmReplan as jest.Mock).mock.calls[0];
    // Positional signature: started is arg 12, replacements arg 13.
    expect(call[12]).toEqual([{ googleEventId: 'evt-1', taskIds: ['adhoc-1'] }]);
    expect(call[1]).toEqual([]); // done
  });

  it('advances to the replan step after applying the review', async () => {
    (api.analyzeReplan as jest.Mock).mockResolvedValue(analyzeResponse({ reviewBlocks: [reviewBlock()] }));
    await renderFlow({ entry: 'review' });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save & continue/i }));
    });

    // The plan view's close/apply footer is now showing; nothing to replan here.
    expect(screen.getByRole('button', { name: /Done/i })).toBeInTheDocument();
    // A second analyze runs to gather the post-review replan state.
    expect((api.analyzeReplan as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('asks and saves a missed day alongside today', async () => {
    const yesterday = format(subDays(new Date(`${TODAY}T12:00:00`), 1), 'yyyy-MM-dd');
    // Yesterday never answered → the review asks for yesterday and today.
    (api.getWellbeingDays as jest.Mock).mockResolvedValue({
      days: priorWeekAnswered().filter(d => d.date !== yesterday),
    });
    (api.analyzeReplan as jest.Mock).mockResolvedValue(analyzeResponse({ reviewBlocks: [reviewBlock()] }));
    await renderFlow({ entry: 'review' });

    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Did you meditate today?' })).getByRole('button', {
          name: /^Yes$/,
        })
      );
    });
    await act(async () => {
      fireEvent.click(
        within(
          screen.getByRole('group', { name: 'Did you meditate today? (Yesterday)' })
        ).getByRole('button', { name: /^Yes$/ })
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save & continue/i }));
    });

    const calls = (api.saveWellbeingDay as jest.Mock).mock.calls.map(c => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.date).sort()).toEqual([yesterday, TODAY].sort());
  });
});

describe('MobileDailyReviewFlow — replan step confirm', () => {
  it('confirms the selected moves', async () => {
    const move = {
      googleEventId: 'evt-move',
      googleIntegrationId: 'gcal-1',
      category: 'Deep work',
      titles: ['Reschedule me'],
      reason: 'conflict' as const,
      oldDate: '2026-07-24',
      oldStart: '09:00',
      newDate: '2026-07-25',
      newStart: '11:00',
      durationMinutes: 60,
    };
    (api.analyzeReplan as jest.Mock).mockResolvedValue(analyzeResponse({ moves: [move] }));
    await renderFlow({ entry: 'replan' });

    const applyBtn = await screen.findByRole('button', { name: /Apply .*change/i });
    await act(async () => {
      fireEvent.click(applyBtn);
    });

    const call = (api.confirmReplan as jest.Mock).mock.calls[0];
    expect(call[0]).toEqual([
      {
        googleEventId: 'evt-move',
        googleIntegrationId: 'gcal-1',
        date: '2026-07-25',
        start: '11:00',
        durationMinutes: 60,
      },
    ]);
  });
});

describe('MobileDailyReviewFlow — reset week', () => {
  it('does not reset until the destructive button is pressed', async () => {
    const onApplied = jest.fn();
    const onClose = jest.fn();
    await renderFlow({ entry: 'reset', onApplied, onClose });

    // The confirm copy is shown but nothing has fired yet.
    expect(screen.getByText(/Start this week from scratch\?/i)).toBeInTheDocument();
    expect(api.resetWeek).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Reset week/i }));
    });

    expect(api.resetWeek).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('MobileReviewCard', () => {
  it('gates reset behind the secondary menu', () => {
    const onResetWeek = jest.fn();
    render(
      <MobileReviewCard
        reviewDue={false}
        onStartReview={() => {}}
        onReplan={() => {}}
        onResetWeek={onResetWeek}
      />
    );

    // Reset isn't reachable until the menu is opened.
    expect(screen.queryByRole('menuitem', { name: /Reset week/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /More planning actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Reset week/i }));
    expect(onResetWeek).toHaveBeenCalledTimes(1);
  });

  it('surfaces the review-due prompt', () => {
    render(
      <MobileReviewCard
        reviewDue
        onStartReview={() => {}}
        onReplan={() => {}}
        onResetWeek={() => {}}
      />
    );
    expect(screen.getByText(/A daily review is ready\./i)).toBeInTheDocument();
  });
});
