/**
 * @jest-environment jsdom
 *
 * The Analysis view: what it renders while loading, when the store is empty,
 * and once week summaries arrive — plus the stacked time bars, their
 * drill-downs, and the manual calendar sync. fetch is mocked; the view owns
 * its own load.
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { AnalysisView } from '@/components/analysis/AnalysisView';
import type { AnalysisResponse, WeekSummary } from '@/components/analysis/types';

// The completion trend chart measures its container; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(global as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

function week(overrides: Partial<WeekSummary> = {}): WeekSummary {
  return {
    weekStart: '2026-07-13',
    categories: [{ category: 'Policy', scheduled: 4, completed: 1, started: 0, carried: 2, dropped: 1 }],
    totalScheduled: 4,
    totalCompleted: 1,
    totalStarted: 0,
    completionRate: 0.25,
    totalMinutesWorked: 180,
    timeByIntegration: [
      {
        integrationId: 'om',
        integrationName: 'OM',
        totalMinutes: 150,
        segments: [
          { category: 'Meetings', minutes: 90, share: 0.6 },
          { category: 'Emails', minutes: 60, share: 0.4 },
        ],
      },
      {
        integrationId: 'dbc',
        integrationName: 'DBC',
        totalMinutes: 30,
        segments: [{ category: 'Meetings', minutes: 30, share: 1 }],
      },
    ],
    events: [
      { integrationId: 'om', category: 'Meetings', title: 'OM standup', date: '2026-07-14', durationMinutes: 30 },
      { integrationId: 'om', category: 'Meetings', title: 'OM board call', date: '2026-07-13', durationMinutes: 60 },
      { integrationId: 'om', category: 'Emails', title: 'Inbox sweep', date: '2026-07-15', durationMinutes: 60 },
      { integrationId: 'dbc', category: 'Meetings', title: 'DBC client call', date: '2026-07-16', durationMinutes: 30 },
    ],
    ...overrides,
  };
}

function response(overrides: Partial<AnalysisResponse> = {}): AnalysisResponse {
  return { weeks: [week()], lastSyncedAt: '2026-07-24T09:00:00.000Z', ...overrides };
}

// Resolves the analysis GET only when the caller says so, so the loading state
// is observable. Later calls (a re-fetch after syncing) resolve immediately.
function mockFetch(body: unknown, ok = true) {
  const deferred: { resolve: () => void } = { resolve: () => {} };
  const pending = new Promise<void>(res => { deferred.resolve = () => res(); });
  let call = 0;
  global.fetch = jest.fn(() => {
    call += 1;
    const gate = call === 1 ? pending : Promise.resolve();
    return gate.then(() => ({ ok, json: async () => body }));
  }) as unknown as typeof fetch;
  return deferred;
}

afterEach(() => {
  jest.restoreAllMocks();
});

async function renderLoaded(body: unknown = response()) {
  const deferred = mockFetch(body);
  const view = render(<AnalysisView />);
  await act(async () => { deferred.resolve(); });
  return view;
}

describe('AnalysisView', () => {
  it('shows a loading state, then the week summaries', async () => {
    const deferred = mockFetch(response());

    render(<AnalysisView />);
    expect(screen.queryByText(/Week of/)).not.toBeInTheDocument();

    await act(async () => { deferred.resolve(); });

    expect(screen.getByText('Week of 13 Jul 2026')).toBeInTheDocument();
    expect(screen.getByText('OM')).toBeInTheDocument();
    expect(screen.getByText('2h 30m')).toBeInTheDocument();
  });

  it('explains that analysis needs a week of data when the store is empty', async () => {
    await renderLoaded(response({ weeks: [] }));

    expect(screen.getByText(/needs at least a week of data/i)).toBeInTheDocument();
  });

  it('shows both scheduled and completed counts when a week was over-scheduled', async () => {
    await renderLoaded();

    expect(screen.getByText('1 / 4')).toBeInTheDocument();
    expect(screen.getByText(/1 of 4 scheduled tasks finished or started/)).toBeInTheDocument();
    expect(screen.getByText(/3 untouched/)).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  it('replaces the trend with a note when only one week has been recorded', async () => {
    await renderLoaded();

    expect(screen.getByText(/appears once a second week completes/i)).toBeInTheDocument();
  });

  it('renders a trend point per week once two weeks exist', async () => {
    await renderLoaded(
      response({ weeks: [week({ weekStart: '2026-07-20', completionRate: 0.9 }), week()] })
    );

    // Oldest first: 13 Jul (25%) then 20 Jul (90%), each a hover/tap hit-zone
    // on the line chart.
    expect(screen.getByLabelText('13 Jul: Finished or started: 25%')).toBeInTheDocument();
    expect(screen.getByLabelText('20 Jul: Finished or started: 90%')).toBeInTheDocument();
  });

  it('shows an error state when the request fails', async () => {
    const deferred = mockFetch({ error: 'store unavailable' }, false);
    render(<AnalysisView />);
    await act(async () => { deferred.resolve(); });

    expect(screen.getByText('store unavailable')).toBeInTheDocument();
  });

  describe('finished versus started', () => {
    it('counts started work in the category headline and splits the bar', async () => {
      const { container } = await renderLoaded(
        response({
          weeks: [
            week({
              categories: [
                { category: 'Policy', scheduled: 4, completed: 1, started: 2, carried: 0, dropped: 0 },
              ],
              totalCompleted: 1,
              totalStarted: 2,
              completionRate: 0.75,
            }),
          ],
        })
      );

      expect(screen.getByText('3 / 4')).toBeInTheDocument();
      expect(screen.getByText('(2 started)')).toBeInTheDocument();

      const done = container.querySelector('.bg-emerald-500') as HTMLElement;
      const inProgress = container.querySelector('.bg-amber-500') as HTMLElement;
      expect(done).toHaveStyle({ width: '25%' });
      expect(inProgress).toHaveStyle({ width: '50%' });
    });

    it('reports the week total as finished or started, naming the started count', async () => {
      await renderLoaded(
        response({
          weeks: [
            week({
              categories: [
                { category: 'Policy', scheduled: 4, completed: 1, started: 2, carried: 0, dropped: 0 },
              ],
              totalCompleted: 1,
              totalStarted: 2,
              completionRate: 0.75,
            }),
          ],
        })
      );

      expect(screen.getByText(/3 of 4 scheduled tasks finished or started/)).toBeInTheDocument();
      expect(screen.getByText('· 2 started')).toBeInTheDocument();
      expect(screen.getByText(/1 untouched/)).toBeInTheDocument();
      expect(screen.getByText('75%')).toBeInTheDocument();
    });

    it('treats a legacy record with no started field as zero started', async () => {
      const { container } = await renderLoaded(
        response({
          weeks: [
            week({
              categories: [{ category: 'Policy', scheduled: 4, completed: 3, carried: 1, dropped: 0 }],
              totalCompleted: 3,
              totalStarted: undefined,
              completionRate: 0.75,
            }),
          ],
        })
      );

      expect(screen.getByText('3 / 4')).toBeInTheDocument();
      expect(screen.queryByText(/started\)/)).not.toBeInTheDocument();
      expect(screen.queryByText(/· \d+ started/)).not.toBeInTheDocument();
      expect(container.querySelector('.bg-amber-500')).toHaveStyle({ width: '0%' });
    });

    it('never lets the started segment overflow the track', async () => {
      const { container } = await renderLoaded(
        response({
          weeks: [
            week({
              categories: [
                { category: 'Policy', scheduled: 2, completed: 1, started: 3, carried: 0, dropped: 0 },
              ],
              totalCompleted: 1,
              totalStarted: 3,
              completionRate: 1,
            }),
          ],
        })
      );

      expect(container.querySelector('.bg-emerald-500')).toHaveStyle({ width: '50%' });
      expect(container.querySelector('.bg-amber-500')).toHaveStyle({ width: '50%' });
    });
  });

  describe('stacked time bars', () => {
    it('sizes each segment by its share and labels it with category and duration', async () => {
      await renderLoaded();

      const meetings = screen.getByLabelText('OM, Meetings: 1h 30m, 60 per cent');
      const emails = screen.getByLabelText('OM, Emails: 1h, 40 per cent');
      expect(meetings).toHaveStyle({ width: '60.0%' });
      expect(emails).toHaveStyle({ width: '40.0%' });
      expect(meetings).toHaveAttribute('title', 'Meetings — 1h 30m (60%)');
    });

    it('shows each workspace total and the week total', async () => {
      await renderLoaded();

      expect(screen.getByText('2h 30m')).toBeInTheDocument(); // OM
      expect(screen.getByText('30m')).toBeInTheDocument(); // DBC
      expect(screen.getByText('3h total')).toBeInTheDocument();
    });

    it('renders a muted line for a workspace with no time recorded', async () => {
      await renderLoaded(
        response({
          weeks: [
            week({
              timeByIntegration: [
                {
                  integrationId: 'om',
                  integrationName: 'OM',
                  totalMinutes: 150,
                  segments: [{ category: 'Meetings', minutes: 150, share: 1 }],
                },
                { integrationId: 'dbc', integrationName: 'DBC', totalMinutes: 0, segments: [] },
              ],
            }),
          ],
        })
      );

      expect(screen.getByText('No time recorded.')).toBeInTheDocument();
      expect(screen.queryByLabelText(/^DBC,/)).not.toBeInTheDocument();
    });

    it('renders legacy "Unsplit" time as an ordinary segment', async () => {
      await renderLoaded(
        response({
          weeks: [
            week({
              timeByIntegration: [
                {
                  integrationId: 'om',
                  integrationName: 'OM',
                  totalMinutes: 120,
                  segments: [{ category: 'Unsplit', minutes: 120, share: 1 }],
                },
              ],
              events: [],
            }),
          ],
        })
      );

      const segment = screen.getByLabelText('OM, Unsplit: 2h, 100 per cent');
      expect(segment).toHaveStyle({ backgroundColor: '#d1d5db' });
    });

    it('skips the section entirely when no time was recorded all week', async () => {
      await renderLoaded(
        response({
          weeks: [week({ timeByIntegration: [], events: [], totalMinutesWorked: 0 })],
        })
      );

      expect(screen.queryByText('Time worked')).not.toBeInTheDocument();
    });
  });

  describe('drill-down', () => {
    it('lists only the events for the clicked workspace and category', async () => {
      await renderLoaded();

      await act(async () => {
        fireEvent.click(screen.getByLabelText('OM, Meetings: 1h 30m, 60 per cent'));
      });

      expect(screen.getByText('Meetings — OM')).toBeInTheDocument();
      expect(screen.getByText('OM board call')).toBeInTheDocument();
      expect(screen.getByText('OM standup')).toBeInTheDocument();
      expect(screen.queryByText('Inbox sweep')).not.toBeInTheDocument();
      expect(screen.queryByText('DBC client call')).not.toBeInTheDocument();
    });

    it('orders events by date, then by longest first', async () => {
      await renderLoaded(
        response({
          weeks: [
            week({
              events: [
                { integrationId: 'om', category: 'Meetings', title: 'Short', date: '2026-07-14', durationMinutes: 15 },
                { integrationId: 'om', category: 'Meetings', title: 'Long', date: '2026-07-14', durationMinutes: 75 },
                { integrationId: 'om', category: 'Meetings', title: 'Earlier', date: '2026-07-13', durationMinutes: 30 },
              ],
            }),
          ],
        })
      );

      await act(async () => {
        fireEvent.click(screen.getByLabelText('OM, Meetings: 1h 30m, 60 per cent'));
      });

      const titles = screen.getAllByRole('listitem')
        .map(li => li.querySelector('p')?.textContent)
        .filter((t): t is string => ['Earlier', 'Long', 'Short'].includes(t ?? ''));
      expect(titles).toEqual(['Earlier', 'Long', 'Short']);
    });

    it('closes on Escape', async () => {
      await renderLoaded();

      await act(async () => {
        fireEvent.click(screen.getByLabelText('DBC, Meetings: 30m, 100 per cent'));
      });
      expect(screen.getByText('Meetings — DBC')).toBeInTheDocument();

      await act(async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      expect(screen.queryByText('Meetings — DBC')).not.toBeInTheDocument();
    });
  });

  describe('calendar sync', () => {
    it('posts to the reconcile endpoint and re-fetches the analysis', async () => {
      await renderLoaded();
      const fetchMock = global.fetch as jest.Mock;
      fetchMock.mockClear();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /sync from calendar/i }));
      });

      expect(fetchMock).toHaveBeenCalledWith('/api/time-tracking/reconcile', { method: 'POST' });
      expect(fetchMock).toHaveBeenCalledWith('/api/analysis');
      expect(screen.getByText('Week of 13 Jul 2026')).toBeInTheDocument();
    });

    it('says never synced when the store has no sync timestamp', async () => {
      await renderLoaded(response({ lastSyncedAt: null }));

      expect(screen.getByText('Never synced')).toBeInTheDocument();
    });

    it('reports a sync failure inline without losing the summaries', async () => {
      await renderLoaded();

      (global.fetch as jest.Mock).mockImplementationOnce(async () => ({
        ok: false,
        json: async () => ({ error: 'calendar unreachable' }),
      }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /sync from calendar/i }));
      });

      expect(screen.getByText('calendar unreachable')).toBeInTheDocument();
      expect(screen.getByText('Week of 13 Jul 2026')).toBeInTheDocument();
    });
  });
});
