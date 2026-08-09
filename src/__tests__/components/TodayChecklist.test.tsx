/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';

import { TodayChecklist } from '@/app/mobile/components/TodayChecklist';
import { useTodaySession, type TodayRow } from '@/hooks/useTodaySession';

// Keep the real isCardioEntry (the component drives its form off it); only the
// data-fetching hook is stubbed so the rows are fully under the test's control.
jest.mock('@/hooks/useTodaySession', () => {
  const actual = jest.requireActual('@/hooks/useTodaySession');
  return { ...actual, useTodaySession: jest.fn() };
});

const mockUseTodaySession = useTodaySession as jest.MockedFunction<typeof useTodaySession>;

function row(over: Partial<TodayRow> & { key: string; name: string }): TodayRow {
  return { done: false, entryId: over.key, ...over };
}

function stubSession(rows: TodayRow[], over: Record<string, unknown> = {}) {
  mockUseTodaySession.mockReturnValue({
    date: '2026-08-08',
    plan: { label: 'Session', components: ['Session'] },
    rows,
    doneCount: 0,
    totalCount: rows.length,
    isLoading: false,
    generating: false,
    error: null,
    busyKey: null,
    knownNames: [],
    reload: jest.fn(),
    toggleDone: jest.fn(),
    commitField: jest.fn(),
    commitNote: jest.fn(),
    commitRir: jest.fn(),
    commitSwap: jest.fn(),
    restoreSwap: jest.fn(),
    addExercise: jest.fn(),
    removeRow: jest.fn(),
    ...over,
  } as unknown as ReturnType<typeof useTodaySession>);
}

// Expand the row card so its logging form renders.
function expandRow(name: string) {
  fireEvent.click(screen.getByRole('button', { expanded: false, name: new RegExp(name, 'i') }));
}

describe('TodayChecklist cardio-aware form', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows distance and time (not sets/reps/kg or RIR) for a cardio row', () => {
    stubSession([row({ key: 'r1', name: 'Treadmill run' })]);
    render(<TodayChecklist />);
    expandRow('Treadmill run');

    expect(screen.getByText('Distance (km)')).toBeInTheDocument();
    expect(screen.getByText('Time (min)')).toBeInTheDocument();
    expect(screen.queryByText('Sets')).not.toBeInTheDocument();
    expect(screen.queryByText('kg')).not.toBeInTheDocument();
    expect(screen.queryByText('Reps in reserve')).not.toBeInTheDocument();
    // The note relabels for cardio.
    expect(screen.getByText('Pace / how it went')).toBeInTheDocument();
  });

  it('keeps sets/reps/kg and RIR for a strength row', () => {
    stubSession([row({ key: 'r2', name: 'Bench press', sets: 3, reps: 8, weightKg: 40 })]);
    render(<TodayChecklist />);
    expandRow('Bench press');

    expect(screen.getByText('Sets')).toBeInTheDocument();
    expect(screen.getByText('Reps')).toBeInTheDocument();
    expect(screen.getByText('kg')).toBeInTheDocument();
    expect(screen.getByText('Reps in reserve')).toBeInTheDocument();
    expect(screen.queryByText('Distance (km)')).not.toBeInTheDocument();
    expect(screen.getByText('How did it feel?')).toBeInTheDocument();
  });

  it('keeps the timed-hold form (Secs, seconds-in-reserve) for a plank', () => {
    stubSession([row({ key: 'r3', name: 'Side plank', sets: 3, holdSeconds: 45 })]);
    render(<TodayChecklist />);
    expandRow('Side plank');

    expect(screen.getByText('Secs')).toBeInTheDocument();
    // The RIR control reframes for a hold: seconds, not reps, in reserve.
    expect(screen.getByText('Seconds in reserve')).toBeInTheDocument();
    expect(screen.queryByText('Reps in reserve')).not.toBeInTheDocument();
    expect(screen.queryByText('Reps')).not.toBeInTheDocument();
    expect(screen.queryByText('Distance (km)')).not.toBeInTheDocument();
  });

  it('shows the hold form (Secs) for a plank named but not yet timed', () => {
    // No holdSeconds logged yet — hold-ness comes from the name, so the form must
    // still ask for seconds rather than reverting to Reps.
    stubSession([row({ key: 'r5', name: 'Front plank', sets: 3 })]);
    render(<TodayChecklist />);
    expandRow('Front plank');

    expect(screen.getByText('Secs')).toBeInTheDocument();
    expect(screen.queryByText('Reps')).not.toBeInTheDocument();
    expect(screen.getByText('Seconds in reserve')).toBeInTheDocument();
  });

  it('renders prescription section headings and the Anchor badge, in order', () => {
    stubSession([
      row({ key: 'a1', name: 'Seated cable row', section: 'Anchors', isAnchor: true, kind: 'core', sets: 3, reps: 8 }),
      row({ key: 'c1', name: 'Side plank', section: 'Core', kind: 'hold', sets: 3, holdSeconds: 30 }),
    ]);
    render(<TodayChecklist />);

    expect(screen.getByRole('heading', { name: 'Anchors' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Core' })).toBeInTheDocument();
    // The anchor lift wears the "Anchor" badge, not "Staple".
    expect(screen.getByText('Anchor')).toBeInTheDocument();
    expect(screen.queryByText('Staple')).not.toBeInTheDocument();
  });

  it('offers a time field in the swap form once the replacement name is cardio', () => {
    const commitSwap = jest.fn();
    stubSession([row({ key: 'r4', name: 'Bench press', sets: 3, reps: 8, weightKg: 40 })], {
      commitSwap,
    });

    render(<TodayChecklist />);
    expandRow('Bench press');
    fireEvent.click(screen.getByText('Swap exercise'));

    const nameInput = screen.getByPlaceholderText('Replacement exercise');
    // Strength name: no time field yet.
    fireEvent.change(nameInput, { target: { value: 'Incline press' } });
    expect(screen.queryByPlaceholderText('Time min')).not.toBeInTheDocument();

    // Cardio name: time field appears alongside distance.
    fireEvent.change(nameInput, { target: { value: 'Treadmill run' } });
    const timeInput = screen.getByPlaceholderText('Time min');
    expect(timeInput).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Distance km'), { target: { value: '3' } });
    fireEvent.change(timeInput, { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));

    expect(commitSwap).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bench press' }), {
      name: 'Treadmill run',
      distanceKm: 3,
      durationMinutes: 20,
    });
  });
});
