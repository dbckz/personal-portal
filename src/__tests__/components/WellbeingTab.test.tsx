/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WellbeingTab } from '@/app/mobile/tabs/WellbeingTab';
import { ToastProvider } from '@/hooks/useToast';
import type { Experiment } from '@/types/wellbeing';

jest.mock('@/lib/api', () => ({
  api: {
    // Called by the embedded HabitCheckPanel when it seeds today's answers.
    getWellbeingDays: jest.fn().mockResolvedValue({ days: [] }),
    saveWellbeingDay: jest.fn().mockResolvedValue({ day: {} }),
    checkInExperiment: jest.fn().mockResolvedValue({ experiment: {} }),
    updateExperiment: jest.fn().mockResolvedValue({ experiment: {} }),
    deleteExperiment: jest.fn().mockResolvedValue({ success: true }),
    createExperiment: jest.fn().mockResolvedValue({ experiment: {} }),
  },
}));

import { api } from '@/lib/api';

beforeEach(() => jest.clearAllMocks());

function experiment(over: Partial<Experiment> = {}): Experiment {
  return {
    id: 'e1',
    title: 'No screens before 8am',
    status: 'running',
    checkIns: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function renderTab(experiments: Experiment[], onChanged = jest.fn()) {
  render(
    <ToastProvider>
      <WellbeingTab
        analysis={null}
        experiments={experiments}
        isLoading={false}
        error={null}
        onChanged={onChanged}
      />
    </ToastProvider>
  );
  return { onChanged };
}

describe('WellbeingTab (mobile, read/write)', () => {
  it('logs a one-tap check-in on a running experiment and refreshes', async () => {
    const { onChanged } = renderTab([experiment()]);

    fireEvent.click(screen.getByLabelText('Log 4 out of 5'));

    await waitFor(() => expect(api.checkInExperiment).toHaveBeenCalledWith('e1', { rating: 4 }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('offers a "Start it" action on a planned experiment', async () => {
    const { onChanged } = renderTab([experiment({ status: 'planned' })]);

    fireEvent.click(screen.getByText('Start it'));

    await waitFor(() =>
      expect(api.updateExperiment).toHaveBeenCalledWith('e1', { status: 'running' })
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('deletes only after a confirm step', async () => {
    renderTab([experiment()]);

    fireEvent.click(screen.getByLabelText('Delete experiment'));
    // Nothing deleted on the first tap — the confirm prompt appears instead.
    expect(api.deleteExperiment).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this experiment?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteExperiment).toHaveBeenCalledWith('e1'));
  });

  it('does not refresh when a check-in fails, leaving the card in place', async () => {
    (api.checkInExperiment as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const { onChanged } = renderTab([experiment()]);

    fireEvent.click(screen.getByLabelText('Log 3 out of 5'));

    await waitFor(() => expect(api.checkInExperiment).toHaveBeenCalled());
    // The refresh only fires on success; on failure the optimistic change is
    // rolled back and the card stays.
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByText('No screens before 8am')).toBeInTheDocument();
  });

  it('opens the create sheet from the New button', () => {
    renderTab([]);

    fireEvent.click(screen.getByRole('button', { name: /New/ }));

    expect(screen.getByText('New experiment')).toBeInTheDocument();
  });

  it('saves today’s habits from the standalone card', async () => {
    const { onChanged } = renderTab([]);

    // Wait for the panel to finish seeding (its loading note clears).
    await waitFor(() => expect(api.getWellbeingDays).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Save today's habits"));

    await waitFor(() => expect(api.saveWellbeingDay).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
  });
});
