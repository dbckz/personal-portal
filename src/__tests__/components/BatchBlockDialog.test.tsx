/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { BatchBlockDialog } from '@/components/home/BatchBlockDialog';
import type { BlockMember } from '@/lib/scheduling/block-members';
import type { CalendarEvent } from '@/types';

const EVENT: CalendarEvent = {
  id: 'evt-batch',
  title: '📦 Batch',
  startTime: new Date('2026-08-10T09:00:00'),
  endTime: new Date('2026-08-10T10:00:00'),
  source: 'google',
};

function asanaMember(overrides: Partial<BlockMember> = {}): BlockMember {
  return {
    key: 's1',
    source: 'asana',
    title: 'First task',
    done: false,
    taskId: 'g1',
    gid: 'g1',
    integrationId: 'int-1',
    scheduleId: 's1',
    ...overrides,
  };
}

function renderDialog(members: BlockMember[], props: Partial<React.ComponentProps<typeof BatchBlockDialog>> = {}) {
  const onMemberDone = jest.fn().mockResolvedValue(undefined);
  const onMemberRemove = jest.fn().mockResolvedValue(undefined);
  const onOpenTask = jest.fn();
  const onClose = jest.fn();
  render(
    <BatchBlockDialog
      event={EVENT}
      members={members}
      onMemberDone={onMemberDone}
      onMemberRemove={onMemberRemove}
      onOpenTask={onOpenTask}
      onClose={onClose}
      {...props}
    />
  );
  return { onMemberDone, onMemberRemove, onOpenTask, onClose };
}

describe('BatchBlockDialog', () => {
  it('lists the block title and each member task', () => {
    renderDialog([
      asanaMember({ key: 's1', title: 'First task' }),
      asanaMember({ key: 's2', title: 'Second task', gid: 'g2', scheduleId: 's2', taskId: 'g2' }),
    ]);
    expect(screen.getByText('📦 Batch')).toBeInTheDocument();
    expect(screen.getByText('First task')).toBeInTheDocument();
    expect(screen.getByText('Second task')).toBeInTheDocument();
  });

  it('ticking a member calls onMemberDone with that member', async () => {
    const member = asanaMember();
    const { onMemberDone } = renderDialog([member]);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Mark done'));
    });
    expect(onMemberDone).toHaveBeenCalledTimes(1);
    expect(onMemberDone).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'g1', gid: 'g1' }));
    // Optimistically shown done (strikethrough title present).
    expect(screen.getByText('First task').closest('button')).toHaveClass('line-through');
  });

  it('removing a member calls onMemberRemove and drops the row', async () => {
    const { onMemberRemove } = renderDialog([
      asanaMember({ key: 's1', title: 'Keep me', gid: 'g1', scheduleId: 's1', taskId: 'g1' }),
      asanaMember({ key: 's2', title: 'Remove me', gid: 'g2', scheduleId: 's2', taskId: 'g2' }),
    ]);
    await act(async () => {
      fireEvent.click(within(screen.getByText('Remove me').closest('li')!).getByLabelText('Remove from block'));
    });
    expect(onMemberRemove).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'g2' }));
    expect(screen.queryByText('Remove me')).not.toBeInTheDocument();
    expect(screen.getByText('Keep me')).toBeInTheDocument();
  });

  it('clicking an Asana member row title clicks through to its detail', () => {
    const member = asanaMember();
    const { onOpenTask } = renderDialog([member]);
    fireEvent.click(screen.getByText('First task'));
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ gid: 'g1' }));
  });

  it('ad-hoc members are not clickable for detail', () => {
    const { onOpenTask } = renderDialog([
      { key: 'a1', source: 'adhoc', title: 'Ad-hoc row', done: false, taskId: 'a1', adhocId: 'a1' },
    ]);
    fireEvent.click(screen.getByText('Ad-hoc row'));
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it('rolls the row back and shows a failure when an action rejects', async () => {
    const onMemberDone = jest.fn().mockRejectedValue(new Error('nope'));
    render(
      <BatchBlockDialog
        event={EVENT}
        members={[asanaMember()]}
        onMemberDone={onMemberDone}
        onMemberRemove={jest.fn()}
        onOpenTask={jest.fn()}
        onClose={jest.fn()}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Mark done'));
    });
    expect(screen.getByText('First task').closest('button')).not.toHaveClass('line-through');
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});
