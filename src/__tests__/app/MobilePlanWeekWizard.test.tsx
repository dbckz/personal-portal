/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MobilePlanWeekWizard } from '@/app/mobile/plan-week/MobilePlanWeekWizard';

// The wizard's orchestration hook loads the api layer at module load; mock it so
// no real network calls happen. The mobile presentation is a thin shell over the
// same usePlanWeek hook the desktop modal uses, so these tests assert the shared
// API orchestration (order, week targeting, confirm payload) through the touch UI.
jest.mock('@/lib/api', () => ({
  api: {
    classifyTaskTypes: jest.fn(),
    updateAsanaTask: jest.fn(),
    // The wizard's first step (calendar review) fetches pending invites on open.
    getPendingInvites: jest.fn().mockResolvedValue({ invites: [] }),
    getPrepCandidates: jest.fn(),
    setPrepDecision: jest.fn(),
    getWeekCandidates: jest.fn(),
    matchPriorities: jest.fn(),
    getAsanaProjects: jest.fn(),
    createPriorityTasks: jest.fn(),
    completeAsanaTaskInWizard: jest.fn(),
    proposeWeeklyPlan: jest.fn(),
    confirmWeeklyPlan: jest.fn(),
    // Advisory panels rendered inside steps — quiet empty responses.
    getProjects: jest.fn().mockResolvedValue({ projects: [], dormantCount: 0 }),
    getReminders: jest.fn().mockResolvedValue({ reminders: [] }),
    getCalendarReminders: jest.fn().mockResolvedValue({ candidates: [] }),
    getGoals: jest.fn().mockResolvedValue({ goals: [] }),
    checkInGoal: jest.fn().mockResolvedValue({ ok: true }),
    getWorkflowConfig: jest.fn().mockResolvedValue({
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    }),
  },
}));

import { api } from '@/lib/api';

const WEEK = '2026-07-20'; // Monday

// The wizard now opens on the Calendar-review step, then Location; advance past
// both (calendar → location → priorities) to reach the priorities step the older
// assertions target.
async function advancePastLocation() {
  // Calendar step: only a Next button.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Next/i }));
  });
  const next = screen.queryByRole('button', { name: /^Next/i });
  if (next) {
    await act(async () => {
      fireEvent.click(next);
    });
  }
}

function setupMocks() {
  jest.clearAllMocks();
  (api.matchPriorities as jest.Mock).mockResolvedValue({
    results: [],
    asanaIntegrations: [],
    categories: [],
  });
  (api.getAsanaProjects as jest.Mock).mockResolvedValue({ projects: [] });
  (api.getPrepCandidates as jest.Mock).mockResolvedValue({
    meetings: [],
    unplaced: [],
    workingDays: ['2026-07-20', '2026-07-21'],
  });
  (api.getWeekCandidates as jest.Mock).mockResolvedValue({ categories: [] });
  (api.proposeWeeklyPlan as jest.Mock).mockResolvedValue({
    proposals: [],
    quotaSummary: [],
    weekStart: WEEK,
    weekEnd: '2026-07-26',
  });
}

// Page forward with Skip/Next until the review step (mirrors the desktop test).
async function skipThroughSteps() {
  for (let i = 0; i < 8; i++) {
    const next =
      screen.queryByRole('button', { name: 'Skip' }) ??
      screen.queryByRole('button', { name: /^Next/i });
    if (!next) break;
    await act(async () => {
      fireEvent.click(next);
    });
  }
}

describe('MobilePlanWeekWizard — rendering & progress', () => {
  beforeEach(setupMocks);

  it('renders nothing when closed', () => {
    const { container } = render(<MobilePlanWeekWizard isOpen={false} onClose={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens on the calendar step, then reaches priorities (step 3 of 7, no type/reminders steps)', async () => {
    render(<MobilePlanWeekWizard isOpen onClose={jest.fn()} weekStart={WEEK} />);

    expect(screen.getByRole('heading', { name: 'Plan my week' })).toBeInTheDocument();
    // Screens paged through: calendar, location, priorities-input, priorities-review,
    // prep, tasks, review.
    expect(screen.getByText(/Step 1 of 7/)).toBeInTheDocument();
    // Calendar step has Next (no Skip) and Close.
    expect(screen.getByRole('button', { name: /^Next/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();

    await advancePastLocation();
    expect(screen.getByPlaceholderText(/One priority per line/i)).toBeInTheDocument();
    expect(screen.getByText(/Step 3 of 7/)).toBeInTheDocument();
  });
});

describe('MobilePlanWeekWizard — step progression & skip conditions', () => {
  beforeEach(setupMocks);

  it('skips priorities → prep → tasks, firing each step fetch in order', async () => {
    render(<MobilePlanWeekWizard isOpen onClose={jest.fn()} weekStart={WEEK} />);

    // Calendar step (Next), then skip location → priorities, then skip priorities
    // → prep (candidates fetch).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Next/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    });
    await waitFor(() => expect(api.getPrepCandidates).toHaveBeenCalled());
    expect(api.getPrepCandidates).toHaveBeenCalledWith(
      WEEK,
      expect.anything(),
      expect.anything(),
      expect.anything()
    );

    // Skip/Next off prep → tasks (candidates fetch fires).
    await act(async () => {
      fireEvent.click(
        screen.queryByRole('button', { name: 'Skip' }) ??
          screen.getByRole('button', { name: /^Next/i })
      );
    });
    await waitFor(() => expect(api.getWeekCandidates).toHaveBeenCalled());
    // The Walks row (tasks step) is on screen.
    expect(await screen.findByText('🚶 Walks')).toBeInTheDocument();
  });

  it('passes the target week to every wizard endpoint through the touch UI', async () => {
    render(<MobilePlanWeekWizard isOpen onClose={jest.fn()} weekStart={WEEK} />);
    await advancePastLocation();

    // Type a priority so matching fires, then page through to review.
    const box = screen.getByPlaceholderText(/One priority per line/i);
    await act(async () => {
      fireEvent.change(box, { target: { value: 'Ship the report' } });
      fireEvent.click(screen.getByRole('button', { name: /^Next/i }));
    });
    await waitFor(() => expect(api.matchPriorities).toHaveBeenCalled());
    await skipThroughSteps();
    await waitFor(() => expect(api.proposeWeeklyPlan).toHaveBeenCalled());

    expect(api.matchPriorities).toHaveBeenCalledWith(expect.anything(), WEEK);
    expect(api.getWeekCandidates).toHaveBeenCalledWith(expect.objectContaining({ weekStart: WEEK }));
    expect(api.proposeWeeklyPlan).toHaveBeenCalledWith(expect.objectContaining({ weekStart: WEEK }));
    // The week label shows in the header subtitle from the propose response.
    await waitFor(() => expect(screen.getByText(/Jul 20 – Jul 26/)).toBeInTheDocument());
  });
});

describe('MobilePlanWeekWizard — confirm orchestration', () => {
  beforeEach(() => {
    setupMocks();
    (api.proposeWeeklyPlan as jest.Mock).mockResolvedValue({
      proposals: [
        {
          id: 'p1',
          category: 'Writing',
          date: '2026-07-21',
          start: '09:00',
          durationMinutes: 60,
          reason: 'quota',
          task: { gid: 'g1', title: 'Draft', integrationId: 'ai1' },
        },
      ],
      quotaSummary: [],
      weekStart: WEEK,
      weekEnd: '2026-07-26',
    });
    (api.confirmWeeklyPlan as jest.Mock).mockResolvedValue({
      results: [{ id: 'p1', success: true }],
    });
  });

  it('confirms the accepted blocks with the target week and reaches the done state', async () => {
    const onApplied = jest.fn();
    render(<MobilePlanWeekWizard isOpen onClose={jest.fn()} weekStart={WEEK} onApplied={onApplied} />);

    await skipThroughSteps();
    await waitFor(() => expect(api.proposeWeeklyPlan).toHaveBeenCalled());

    const apply = await screen.findByRole('button', { name: /to calendar/i });
    await act(async () => {
      fireEvent.click(apply);
    });

    await waitFor(() => expect(api.confirmWeeklyPlan).toHaveBeenCalled());
    expect(api.confirmWeeklyPlan).toHaveBeenCalledWith(expect.anything(), undefined, WEEK);
    // onApplied fires so the shell can refresh; the footer flips to Done.
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument();
  });
});
