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
const toggleMember = jest.fn().mockResolvedValue(undefined);
const pinToWeek = jest.fn().mockResolvedValue(undefined);
let mockCards: BoardCard[] = [];

jest.mock('@/hooks/useBoard', () => ({
  useBoard: () => ({
    cards: mockCards,
    isLoading: false,
    error: null,
    reload: jest.fn(),
    moveCard,
    toggleMember,
    pinToWeek,
    busyKeys: new Set<string>(),
  }),
}));

const weekStart = weekStartFor(new Date());

function makeCard(overrides: Partial<BoardCard>): BoardCard {
  return {
    key: 'adhoc:x',
    stateKey: 'adhoc:x',
    source: 'unplanned',
    title: 'A task',
    status: 'todo',
    statusSource: 'derived',
    members: [],
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
    toggleMember.mockClear();
    pinToWeek.mockClear();
    // The day filter now persists in sessionStorage; clear it so a filter
    // selected in one test does not leak into the next.
    sessionStorage.clear();
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
      makeCard({ key: 'adhoc:planned', stateKey: 'adhoc:planned', source: 'task', title: 'Planned task', date: weekStart }),
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

  it('restores the persisted day filter on remount', () => {
    mockCards = [
      makeCard({ key: 'adhoc:planned', stateKey: 'adhoc:planned', source: 'task', title: 'Planned task', date: weekStart }),
      makeCard({ key: 'adhoc:floating', stateKey: 'adhoc:floating', title: 'Floating task' }),
    ];
    const { unmount } = renderTab();
    fireEvent.click(screen.getByRole('button', { name: /^Unplanned/ }));
    expect(screen.queryByText('Planned task')).not.toBeInTheDocument();
    unmount();

    // Remount: the 'unplanned' filter is restored, so the planned card stays hidden.
    renderTab();
    expect(screen.queryByText('Planned task')).not.toBeInTheDocument();
    expect(screen.getByText('Floating task')).toBeInTheDocument();
  });

  it('badges a rolled card with its original weekday', () => {
    mockCards = [
      makeCard({
        key: 'adhoc:rolled',
        stateKey: 'adhoc:rolled',
        source: 'task',
        title: 'Rolled task',
        date: '2026-08-26',
        originallyPlannedFor: '2026-08-24', // Mon
        rolls: 1,
      }),
    ];
    renderTab();
    expect(screen.getByText('from Mon')).toBeInTheDocument();
  });

  it('calls moveCard when a status button is tapped in the card sheet', async () => {
    const card = makeCard({ key: 'adhoc:go', stateKey: 'adhoc:go', source: 'task', title: 'Draft the report', status: 'todo', adhocId: 'go' });
    mockCards = [card];
    renderTab();

    // Open the card sheet.
    fireEvent.click(screen.getByRole('button', { name: /Draft the report/ }));

    // The sheet's "Done" button (exact name — the segment button reads "Done 0").
    const doneButton = screen.getByRole('button', { name: 'Done' });
    fireEvent.click(doneButton);

    await waitFor(() => expect(moveCard).toHaveBeenCalledWith(card, 'done'));
  });

  it('calls toggleMember when a member is tapped in a group card sheet', async () => {
    const card = makeCard({
      key: 'block:evg',
      stateKey: 'block:evg',
      source: 'group',
      title: '🤝 Engagement/Outreach',
      status: 'todo',
      members: [
        { key: 's1', source: 'asana', title: 'Email the funder', done: false, gid: 'g1', integrationId: 'om' },
        { key: 's2', source: 'asana', title: 'Call the partner', done: false, gid: 'g2', integrationId: 'om' },
      ],
    });
    mockCards = [card];
    renderTab();

    // Open the group card's sheet.
    fireEvent.click(screen.getByRole('button', { name: /Engagement\/Outreach/ }));

    // Tapping a member ticks it done through toggleMember.
    fireEvent.click(screen.getByRole('button', { name: /Email the funder/ }));
    await waitFor(() => expect(toggleMember).toHaveBeenCalledWith(card, card.members[0]));
  });
});
