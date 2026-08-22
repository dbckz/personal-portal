/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BoardCard } from '@/types';
import { weekStartFor } from '@/lib/board';
import { MobileBoardTab } from '@/app/mobile/tabs/MobileBoardTab';

// Control the board contents by mocking the hook; buildBoardCards is covered by
// its own lib tests.
const moveCard = jest.fn().mockResolvedValue(undefined);
const pinToWeek = jest.fn().mockResolvedValue(undefined);
let mockCards: BoardCard[] = [];

jest.mock('@/hooks/useBoard', () => ({
  useBoard: () => ({
    cards: mockCards,
    isLoading: false,
    error: null,
    reload: jest.fn(),
    moveCard,
    pinToWeek,
    busyKeys: new Set<string>(),
  }),
}));

const weekStart = weekStartFor(new Date());

function makeCard(overrides: Partial<BoardCard>): BoardCard {
  return {
    key: 'adhoc:x',
    stateKey: 'adhoc:x',
    source: 'adhoc',
    title: 'A task',
    status: 'todo',
    statusSource: 'derived',
    recurring: false,
    blocks: [],
    plannedDates: [],
    totalMinutes: 0,
    ...overrides,
  };
}

function renderTab() {
  return render(
    <MobileBoardTab
      asanaTasks={[]}
      adHocTasks={[]}
      scheduledAsanaTasks={[]}
      metadataByGid={{}}
      customTypes={[]}
      saveMetadata={jest.fn().mockResolvedValue(undefined)}
      onCompleteAsana={jest.fn().mockResolvedValue(undefined)}
      onUpdateAdhoc={jest.fn().mockResolvedValue(null)}
      onCreateAdhoc={jest.fn().mockResolvedValue(null)}
    />
  );
}

describe('MobileBoardTab', () => {
  beforeEach(() => {
    moveCard.mockClear();
    pinToWeek.mockClear();
  });

  it('renders the four status segments', () => {
    mockCards = [];
    renderTab();
    for (const label of ['To start', 'In progress', 'Waiting', 'Done']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('narrows the visible cards when the day filter changes', () => {
    mockCards = [
      makeCard({ key: 'adhoc:planned', stateKey: 'adhoc:planned', title: 'Planned task', plannedDates: [weekStart], blocks: [{ date: weekStart }] }),
      makeCard({ key: 'adhoc:floating', stateKey: 'adhoc:floating', title: 'Floating task' }),
    ];
    renderTab();

    // All: both todo cards visible.
    expect(screen.getByText('Planned task')).toBeInTheDocument();
    expect(screen.getByText('Floating task')).toBeInTheDocument();

    // Unplanned: only the card with no blocks.
    fireEvent.click(screen.getByRole('button', { name: /^Unplanned/ }));
    expect(screen.queryByText('Planned task')).not.toBeInTheDocument();
    expect(screen.getByText('Floating task')).toBeInTheDocument();
  });

  it('calls moveCard when a status button is tapped in the card sheet', async () => {
    const card = makeCard({ key: 'adhoc:go', stateKey: 'adhoc:go', title: 'Draft the report', status: 'todo', adhocId: 'go' });
    mockCards = [card];
    renderTab();

    // Open the card sheet.
    fireEvent.click(screen.getByRole('button', { name: /Draft the report/ }));

    // The sheet's "Done" button (exact name — the segment button reads "Done 0").
    const doneButton = screen.getByRole('button', { name: 'Done' });
    fireEvent.click(doneButton);

    await waitFor(() => expect(moveCard).toHaveBeenCalledWith(card, 'done'));
  });
});
