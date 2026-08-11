/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { RemindersTab } from '@/app/mobile/tabs/RemindersTab';
import { Reminder } from '@/types';

const reminders: Reminder[] = [
  { id: 'r1', text: 'Buy milk', completed: false, createdAt: '2024-01-01T00:00:00.000Z' },
  { id: 'r2', text: 'Old task', completed: true, createdAt: '2024-01-01T00:00:00.000Z' },
];

function renderTab(overrides: Partial<React.ComponentProps<typeof RemindersTab>> = {}) {
  const props = {
    reminders,
    updatingIds: new Set<string>(),
    hasUndo: false,
    isArchiving: false,
    error: null,
    onComplete: jest.fn(),
    onAdd: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    onArchive: jest.fn(),
    onUndo: jest.fn(),
    ...overrides,
  };
  return { props, ...render(<RemindersTab {...props} />) };
}

describe('RemindersTab', () => {
  it('shows only active reminders', () => {
    renderTab();
    expect(screen.getByText('Buy milk')).toBeInTheDocument();
    expect(screen.queryByText('Old task')).not.toBeInTheDocument();
  });

  it('adds a reminder on submit and clears the input', () => {
    const onAdd = jest.fn();
    renderTab({ onAdd });

    const input = screen.getByPlaceholderText('Add a reminder...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Water plants' } });
    fireEvent.submit(input.closest('form')!);

    expect(onAdd).toHaveBeenCalledWith('Water plants');
    expect(input.value).toBe('');
  });

  it('does not add blank reminders', () => {
    const onAdd = jest.fn();
    renderTab({ onAdd });

    const input = screen.getByPlaceholderText('Add a reminder...');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);

    expect(onAdd).not.toHaveBeenCalled();
  });

  it('completes a reminder', () => {
    const onComplete = jest.fn();
    renderTab({ onComplete });

    fireEvent.click(screen.getByLabelText('Mark Buy milk done'));
    expect(onComplete).toHaveBeenCalledWith(reminders[0]);
  });

  it('edits reminder text and commits on submit', () => {
    const onEdit = jest.fn();
    renderTab({ onEdit });

    fireEvent.click(screen.getByLabelText('Edit Buy milk'));
    const input = screen.getByDisplayValue('Buy milk');
    fireEvent.change(input, { target: { value: 'Buy oat milk' } });
    fireEvent.submit(input.closest('form')!);

    expect(onEdit).toHaveBeenCalledWith('r1', 'Buy oat milk');
  });

  it('deletes a reminder after confirmation', () => {
    const onDelete = jest.fn();
    renderTab({ onDelete });

    fireEvent.click(screen.getByLabelText('Delete Buy milk'));
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Delete'));
    expect(onDelete).toHaveBeenCalledWith('r1');
  });

  it('archives completed reminders', () => {
    const onArchive = jest.fn();
    renderTab({ onArchive });

    fireEvent.click(screen.getByText('Archive 1'));
    expect(onArchive).toHaveBeenCalled();
  });

  it('hides the archive control when nothing is completed', () => {
    renderTab({ reminders: [reminders[0]] });
    expect(screen.queryByText(/Archive/)).not.toBeInTheDocument();
  });
});
