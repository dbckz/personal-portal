/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MobileEventCard } from '@/app/mobile/components/MobileEventCard';
import { createMockCalendarEvent } from '../mocks/data';

describe('MobileEventCard', () => {
  it('shows Move/Unschedule only for a scheduled Asana event', () => {
    const scheduled = createMockCalendarEvent({ source: 'asana', linkedAsanaTaskId: 'asana-task-1' });
    const onMove = jest.fn();
    const onUnschedule = jest.fn();
    render(
      <MobileEventCard event={scheduled} onSelect={jest.fn()} isPast={false} isCurrent={false} onMove={onMove} onUnschedule={onUnschedule} />
    );

    fireEvent.click(screen.getByRole('button', { name: /move/i }));
    fireEvent.click(screen.getByRole('button', { name: /unschedule/i }));
    expect(onMove).toHaveBeenCalledWith(scheduled);
    expect(onUnschedule).toHaveBeenCalledWith(scheduled);
  });

  it('hides scheduling actions for a plain Google event', () => {
    const plain = createMockCalendarEvent({ source: 'google' });
    render(
      <MobileEventCard event={plain} onSelect={jest.fn()} isPast={false} isCurrent={false} onMove={jest.fn()} onUnschedule={jest.fn()} />
    );

    expect(screen.queryByRole('button', { name: /move/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unschedule/i })).not.toBeInTheDocument();
  });

  it('opens the event when the card body is tapped', () => {
    const scheduled = createMockCalendarEvent({ title: 'Deep work', source: 'asana', linkedAsanaTaskId: 'asana-task-1' });
    const onSelect = jest.fn();
    render(
      <MobileEventCard event={scheduled} onSelect={onSelect} isPast={false} isCurrent={false} onMove={jest.fn()} onUnschedule={jest.fn()} />
    );

    fireEvent.click(screen.getByText('Deep work'));
    expect(onSelect).toHaveBeenCalledWith(scheduled);
  });
});
