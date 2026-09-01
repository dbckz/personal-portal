/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlanWeekModal } from '@/components/dashboard/PlanWeekModal';

// The modal imports the api layer at module load; mock it so no real network
// calls happen. The priorities input phase (the initial step with no untyped
// tasks) renders without invoking any api method.
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
    // The priorities step shows recently-touched projects as context. Advisory,
    // so an empty list is the normal quiet case.
    getProjects: jest.fn().mockResolvedValue({ projects: [], dormantCount: 0 }),
    getReminders: jest.fn().mockResolvedValue({ reminders: [] }),
    getCalendarReminders: jest.fn().mockResolvedValue({ candidates: [] }),
    // The Location step resolves the week's working-day dates from a light config
    // read on open.
    getWorkflowConfig: jest.fn().mockResolvedValue({
      scheduling: { workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    }),
  },
}));

import { api } from '@/lib/api';

// The wizard now opens on the Calendar-review step, then Location; advance past
// both (calendar → location → priorities) to reach the priorities step the older
// assertions target.
async function advancePastLocation() {
  // Calendar step: only a Next button.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Next/i }));
  });
  // Location step: Next (all days at home) → priorities.
  const next = screen.queryByRole('button', { name: /^Next/i });
  if (next) {
    await act(async () => {
      fireEvent.click(next);
    });
  }
}

// Walk the wizard forward with the footer's Skip/Next button until the review
// step is reached, so every per-step fetch fires.
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

describe('PlanWeekModal — next-week targeting', () => {
  const NEXT_MONDAY = '2026-07-20';

  beforeEach(() => {
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
      weekStart: NEXT_MONDAY,
      weekEnd: '2026-07-26',
    });
  });

  it('passes the target week to every wizard endpoint and shows its dates', async () => {
    render(<PlanWeekModal isOpen onClose={jest.fn()} weekStart={NEXT_MONDAY} />);
    await advancePastLocation();

    // Type a priority so the matching call fires, then walk on through
    // reminders/prep → tasks → review, which drives the remaining calls.
    const box = screen.getByPlaceholderText(/One priority per line/i);
    await act(async () => {
      fireEvent.change(box, { target: { value: 'Ship the report' } });
      fireEvent.click(screen.getByRole('button', { name: /^Next/i }));
    });
    await waitFor(() => expect(api.matchPriorities).toHaveBeenCalled());
    await skipThroughSteps();

    await waitFor(() => expect(api.proposeWeeklyPlan).toHaveBeenCalled());

    expect(api.matchPriorities).toHaveBeenCalledWith(expect.anything(), NEXT_MONDAY);
    expect(api.getPrepCandidates).toHaveBeenCalledWith(
      NEXT_MONDAY,
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(api.getWeekCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ weekStart: NEXT_MONDAY })
    );
    expect(api.proposeWeeklyPlan).toHaveBeenCalledWith(
      expect.objectContaining({ weekStart: NEXT_MONDAY })
    );
    // The header week range comes from the response, i.e. next week's dates.
    await waitFor(() => expect(screen.getByText(/Jul 20 – Jul 26/)).toBeInTheDocument());
  });

  it('sends the target week on confirm so the server plans the right week', async () => {
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
      weekStart: NEXT_MONDAY,
      weekEnd: '2026-07-26',
    });
    (api.confirmWeeklyPlan as jest.Mock).mockResolvedValue({ results: [{ id: 'p1', success: true }] });

    render(<PlanWeekModal isOpen onClose={jest.fn()} weekStart={NEXT_MONDAY} />);
    await skipThroughSteps();
    await waitFor(() => expect(api.proposeWeeklyPlan).toHaveBeenCalled());

    const apply = await screen.findByRole('button', { name: /to calendar/i });
    await act(async () => {
      fireEvent.click(apply);
    });

    await waitFor(() => expect(api.confirmWeeklyPlan).toHaveBeenCalled());
    expect(api.confirmWeeklyPlan).toHaveBeenCalledWith(expect.anything(), undefined, NEXT_MONDAY);
  });
});

describe('PlanWeekModal — walks (opt-in per day)', () => {
  const WEEK = '2026-07-20'; // Monday

  beforeEach(() => {
    jest.clearAllMocks();
    (api.getPrepCandidates as jest.Mock).mockResolvedValue({
      meetings: [],
      unplaced: [],
      workingDays: ['2026-07-20', '2026-07-21'], // Mon, Tue
    });
    (api.getWeekCandidates as jest.Mock).mockResolvedValue({ categories: [] });
    (api.proposeWeeklyPlan as jest.Mock).mockResolvedValue({
      proposals: [],
      quotaSummary: [],
      weekStart: WEEK,
      weekEnd: '2026-07-26',
    });
  });

  // Skip priorities (→ prep) then skip prep (→ tasks), where the Walks row shows.
  async function reachTasksStep() {
    render(<PlanWeekModal isOpen onClose={jest.fn()} weekStart={WEEK} />);
    // Calendar step first (Next), then Location (skip = all home), then priorities
    // (skip → prep).
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
    await act(async () => {
      fireEvent.click(
        screen.queryByRole('button', { name: 'Skip' }) ??
          screen.getByRole('button', { name: /^Next/i })
      );
    });
    await screen.findByText('🚶 Walks');
  }

  it('offers a chip per working day, none selected by default, and omits walkDays from propose', async () => {
    await reachTasksStep();

    // One chip per working day of the target week (Mon, Tue), none pressed.
    const mon = screen.getByRole('button', { name: 'Mon' });
    const tue = screen.getByRole('button', { name: 'Tue' });
    expect(mon).toHaveAttribute('aria-pressed', 'false');
    expect(tue).toHaveAttribute('aria-pressed', 'false');

    // Advance to review WITHOUT picking a walk → propose gets no walkDays.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Next/i }));
    });
    await waitFor(() => expect(api.proposeWeeklyPlan).toHaveBeenCalled());
    expect(api.proposeWeeklyPlan).toHaveBeenCalledWith(
      expect.not.objectContaining({ walkDays: expect.anything() })
    );
  });

  it('sends the picked day in walkDays when a chip is toggled on', async () => {
    await reachTasksStep();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
    });
    expect(screen.getByRole('button', { name: 'Mon' })).toHaveAttribute('aria-pressed', 'true');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Next/i }));
    });
    await waitFor(() => expect(api.proposeWeeklyPlan).toHaveBeenCalled());
    expect(api.proposeWeeklyPlan).toHaveBeenCalledWith(
      expect.objectContaining({ walkDays: ['2026-07-20'] })
    );
  });
});

describe('PlanWeekModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<PlanWeekModal isOpen={false} onClose={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('gives the priorities step two step dots (input + match-review screens)', async () => {
    const { container } = render(<PlanWeekModal isOpen onClose={jest.fn()} />);
    await advancePastLocation();

    // With no untyped tasks and no reminders, the screens the user pages through
    // are: calendar, location, priorities-input, priorities-review, prep, tasks,
    // review = 7 dots.
    const dots = container.querySelectorAll('span.rounded-full');
    expect(dots).toHaveLength(7);

    // The two priorities screens each get their own labelled dot.
    expect(screen.getByTitle('Priorities')).toBeInTheDocument();
    expect(screen.getByTitle('Review matches')).toBeInTheDocument();

    // After the location step, the first priorities dot is the active one.
    expect(screen.getByTitle('Priorities').querySelector('span')).toHaveClass('bg-orange-500');
    expect(screen.getByTitle('Review matches').querySelector('span')).toHaveClass('bg-gray-200');
  });

  it('renders the modal shell and the priorities step when open', async () => {
    render(<PlanWeekModal isOpen onClose={jest.fn()} />);
    await advancePastLocation();

    // Header
    expect(screen.getByRole('heading', { name: 'Plan my week' })).toBeInTheDocument();

    // Priorities step (after the location step, with no untyped tasks) is shown.
    expect(
      screen.getByText(/What matters most this week\?/i)
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/One priority per line/i)
    ).toBeInTheDocument();

    // Footer navigation is present.
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});

describe('PlanWeekModal — prep step optimistic toggling', () => {
  const WEEK = '2026-07-20';

  // One placed suggestion (has a proposed block) and one non-prep meeting the
  // user can toggle ON.
  const prepResponse = () => ({
    meetings: [
      {
        key: 'k1',
        eventId: 'e1',
        title: 'Board sync',
        date: '2026-07-22',
        start: '14:00',
        needsPrep: true,
        decidedBy: 'ai',
        reason: 'external attendees',
        block: { date: '2026-07-21', start: '10:00', durationMinutes: 15 },
      },
      {
        key: 'k2',
        eventId: 'e2',
        title: 'Standup',
        date: '2026-07-21',
        start: '09:00',
        needsPrep: false,
        decidedBy: 'ai',
        reason: '',
      },
    ],
    unplaced: [],
    workingDays: ['2026-07-20', '2026-07-21', '2026-07-22'],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (api.getPrepCandidates as jest.Mock).mockResolvedValue(prepResponse());
    (api.setPrepDecision as jest.Mock).mockResolvedValue({ ok: true });
    (api.getWeekCandidates as jest.Mock).mockResolvedValue({ categories: [] });
  });

  // Skip the priorities step (no reminders/type steps in this setup) to land on
  // the prep step, then wait for its candidates to render.
  async function reachPrepStep() {
    render(<PlanWeekModal isOpen onClose={jest.fn()} weekStart={WEEK} />);
    // Calendar step first (Next), then Location (skip = all home), then priorities
    // (skip → prep).
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
    await screen.findByText('Board sync');
  }

  it('unticks a suggestion locally and does not refetch candidates', async () => {
    await reachPrepStep();
    const callsAfterLoad = (api.getPrepCandidates as jest.Mock).mock.calls.length;

    // Only the suggested (checked) checkbox is on screen; others are collapsed.
    const tick = screen.getByRole('checkbox');
    expect(tick).toBeChecked();
    await act(async () => {
      fireEvent.click(tick);
    });

    // Persist fires with the user's verdict; NO candidates refetch on toggle.
    expect(api.setPrepDecision).toHaveBeenCalledWith('Board sync', false);
    expect((api.getPrepCandidates as jest.Mock).mock.calls.length).toBe(callsAfterLoad);

    // The meeting has left the Suggested list optimistically.
    await waitFor(() =>
      expect(screen.getByText(/No meetings this week look like they need prep/i)).toBeInTheDocument()
    );
  });

  it('shows a pending slot for a meeting toggled on, without a refetch', async () => {
    await reachPrepStep();
    const callsAfterLoad = (api.getPrepCandidates as jest.Mock).mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Other meetings/i }));
    });
    const unchecked = screen
      .getAllByRole('checkbox')
      .find(c => !(c as HTMLInputElement).checked)!;
    await act(async () => {
      fireEvent.click(unchecked);
    });

    expect(api.setPrepDecision).toHaveBeenCalledWith('Standup', true);
    expect(await screen.findByText('Slot proposed at next step')).toBeInTheDocument();
    expect((api.getPrepCandidates as jest.Mock).mock.calls.length).toBe(callsAfterLoad);
  });

  it('rolls back the flip and surfaces an error when the persist fails', async () => {
    (api.setPrepDecision as jest.Mock).mockRejectedValue(new Error('persist boom'));
    await reachPrepStep();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Other meetings/i }));
    });
    const unchecked = screen
      .getAllByRole('checkbox')
      .find(c => !(c as HTMLInputElement).checked)!;
    await act(async () => {
      fireEvent.click(unchecked);
    });

    // The optimistic pending slot is rolled back once the persist rejects.
    await waitFor(() =>
      expect(screen.queryByText('Slot proposed at next step')).not.toBeInTheDocument()
    );
    expect(screen.getByText('persist boom')).toBeInTheDocument();
  });

  it('re-proposes prep slots when Next is pressed off the step', async () => {
    await reachPrepStep();
    const callsAfterLoad = (api.getPrepCandidates as jest.Mock).mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Next/i }));
    });

    await waitFor(() =>
      expect((api.getPrepCandidates as jest.Mock).mock.calls.length).toBe(callsAfterLoad + 1)
    );
  });
});
