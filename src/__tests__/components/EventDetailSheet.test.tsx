/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EventDetailSheet } from '@/app/mobile/components/EventDetailSheet';
import type { BlockMember } from '@/lib/scheduling/block-members';
import { createMockCalendarEvent } from '../mocks/data';

const googleEvent = createMockCalendarEvent({ id: 'event-1', title: 'Standup', source: 'google', integrationId: 'g1' });

describe('EventDetailSheet', () => {
  it('fires onEdit for a Google event', () => {
    const onEdit = jest.fn();
    render(<EventDetailSheet event={googleEvent} onClose={jest.fn()} onEdit={onEdit} onDelete={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith(googleEvent);
  });

  it('requires a second tap to confirm delete', () => {
    const onDelete = jest.fn().mockResolvedValue(undefined);
    render(<EventDetailSheet event={googleEvent} onClose={jest.fn()} onEdit={jest.fn()} onDelete={onDelete} />);

    const deleteButton = screen.getByRole('button', { name: /^delete$/i });
    fireEvent.click(deleteButton);
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /tap to confirm/i }));
    expect(onDelete).toHaveBeenCalledWith(googleEvent);
  });

  it('sets attribution toward an Asana integration', async () => {
    const onSetAttribution = jest.fn().mockResolvedValue(undefined);
    render(
      <EventDetailSheet
        event={googleEvent}
        onClose={jest.fn()}
        asanaIntegrations={[{ id: 'a1', name: 'OpenMined' }]}
        onSetAttribution={onSetAttribution}
        onRemoveAttribution={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'OpenMined' }));
    await waitFor(() => expect(onSetAttribution).toHaveBeenCalledWith('a1'));
  });

  it('shows the current attribution with a remove control', async () => {
    const onRemoveAttribution = jest.fn().mockResolvedValue(undefined);
    render(
      <EventDetailSheet
        event={googleEvent}
        onClose={jest.fn()}
        attribution={{ asanaIntegrationId: 'a1' }}
        asanaIntegrations={[{ id: 'a1', name: 'OpenMined' }]}
        onSetAttribution={jest.fn()}
        onRemoveAttribution={onRemoveAttribution}
      />
    );

    expect(screen.getByText('OpenMined')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(onRemoveAttribution).toHaveBeenCalled());
  });

  it('lists batch-block members and marks one done', async () => {
    const members: BlockMember[] = [
      { key: 's1', source: 'asana', title: 'Task A', done: false, taskId: 'a', gid: 'a', scheduleId: 's1' },
      { key: 's2', source: 'asana', title: 'Task B', done: false, taskId: 'b', gid: 'b', scheduleId: 's2' },
    ];
    const onMemberDone = jest.fn().mockResolvedValue(undefined);
    render(
      <EventDetailSheet
        event={googleEvent}
        onClose={jest.fn()}
        members={members}
        onMemberDone={onMemberDone}
        onMemberRemove={jest.fn()}
      />
    );

    expect(screen.getByText('Task A')).toBeInTheDocument();
    expect(screen.getByText('Task B')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /mark done/i })[0]);
    await waitFor(() => expect(onMemberDone).toHaveBeenCalledWith(members[0]));
    // The optimistic tick settles to the done state after the await resolves.
    await waitFor(() => expect(screen.getByText('Task A')).toHaveClass('line-through'));
  });

  it('stays read-only when no edit/delete handlers are given', () => {
    render(<EventDetailSheet event={createMockCalendarEvent({ source: 'adhoc' })} onClose={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });
});
