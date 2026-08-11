/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MobileScheduleSheet } from '@/app/mobile/components/MobileScheduleSheet';
import { createMockCalendarEvent } from '../mocks/data';

describe('MobileScheduleSheet', () => {
  it('shows existing events on the chosen day for context', () => {
    const existing = createMockCalendarEvent({ id: 'e1', title: 'Existing meeting' });
    render(
      <MobileScheduleSheet
        title="Write brief"
        initialDate="2024-01-15"
        initialTime="09:00"
        submitLabel="Schedule"
        eventsForDate={() => [existing]}
        onSubmit={jest.fn()}
        onClose={jest.fn()}
      />
    );
    expect(screen.getByText('Existing meeting')).toBeInTheDocument();
  });

  it('submits the chosen date and time', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(
      <MobileScheduleSheet
        title="Write brief"
        initialDate="2024-01-15"
        initialTime="09:00"
        submitLabel="Schedule"
        eventsForDate={() => []}
        onSubmit={onSubmit}
        onClose={jest.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:30' } });
    fireEvent.click(screen.getByRole('button', { name: /schedule/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('2024-01-15', '14:30'));
  });
});
