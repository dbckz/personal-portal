/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { DayTab } from '@/app/mobile/tabs/DayTab';
import { createMockCalendarEvent } from '../mocks/data';

const NOW = new Date('2024-01-15T10:30:00');

function renderDay(
  events = [] as ReturnType<typeof createMockCalendarEvent>[],
  props: Partial<React.ComponentProps<typeof DayTab>> = {}
) {
  return render(
    <DayTab
      selectedDate={NOW}
      now={NOW}
      events={events}
      dueTodayTasks={[]}
      isLoading={false}
      onSelectEvent={jest.fn()}
      {...props}
    />
  );
}

describe('DayTab', () => {
  it('places the now indicator before the first event still in progress or upcoming', () => {
    const past = createMockCalendarEvent({
      id: 'past',
      title: 'Past meeting',
      startTime: new Date('2024-01-15T08:00:00'),
      endTime: new Date('2024-01-15T09:00:00'),
    });
    const upcoming = createMockCalendarEvent({
      id: 'upcoming',
      title: 'Upcoming meeting',
      startTime: new Date('2024-01-15T12:00:00'),
      endTime: new Date('2024-01-15T13:00:00'),
    });
    renderDay([upcoming, past]);

    const agenda = screen.getByText('Agenda').closest('section')!;
    const children = Array.from(agenda.querySelectorAll(':scope [aria-label="Current time"], :scope button'));
    const labels = children.map(el =>
      el.getAttribute('aria-label') === 'Current time' ? 'NOW' : el.textContent
    );

    const nowIdx = labels.indexOf('NOW');
    const pastIdx = labels.findIndex(l => l?.includes('Past meeting'));
    const upcomingIdx = labels.findIndex(l => l?.includes('Upcoming meeting'));
    expect(nowIdx).toBeGreaterThan(pastIdx);
    expect(nowIdx).toBeLessThan(upcomingIdx);
  });

  it('marks an in-progress event with the Now badge', () => {
    const current = createMockCalendarEvent({
      id: 'current',
      title: 'Current meeting',
      startTime: new Date('2024-01-15T10:00:00'),
      endTime: new Date('2024-01-15T11:00:00'),
    });
    renderDay([current]);

    expect(screen.getByText('Now')).toBeInTheDocument();
  });

  it('shows the empty state with a now indicator when today has no timed events', () => {
    renderDay([]);

    expect(screen.getByText('No timed events')).toBeInTheDocument();
    expect(screen.getByLabelText('Current time')).toBeInTheDocument();
  });

  it('fires onCreateEvent from the Add affordance', () => {
    const onCreateEvent = jest.fn();
    renderDay([], { onCreateEvent });

    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(onCreateEvent).toHaveBeenCalledTimes(1);
  });

  it('offers Schedule on an unscheduled Asana row', () => {
    const onScheduleTask = jest.fn();
    const task = createMockCalendarEvent({ id: 'due-1', title: 'Write brief', source: 'asana' });
    renderDay([], { dueTodayTasks: [task], onScheduleTask });

    fireEvent.click(screen.getByRole('button', { name: /schedule/i }));
    expect(onScheduleTask).toHaveBeenCalledWith(task);
  });

  it('offers Move and Unschedule on a scheduled Asana event', () => {
    const onMoveEvent = jest.fn();
    const onUnscheduleEvent = jest.fn();
    const scheduled = createMockCalendarEvent({
      id: 'schedule-1',
      title: 'Deep work',
      source: 'asana',
      linkedAsanaTaskId: 'asana-task-1',
    });
    renderDay([scheduled], { onMoveEvent, onUnscheduleEvent });

    fireEvent.click(screen.getByRole('button', { name: /move/i }));
    fireEvent.click(screen.getByRole('button', { name: /unschedule/i }));
    expect(onMoveEvent).toHaveBeenCalledWith(scheduled);
    expect(onUnscheduleEvent).toHaveBeenCalledWith(scheduled);
  });
});
