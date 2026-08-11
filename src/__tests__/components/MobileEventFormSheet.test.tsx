/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MobileEventFormSheet } from '@/app/mobile/components/MobileEventFormSheet';

const integrations = [
  { id: 'g1', name: 'Life' },
  { id: 'g2', name: 'Work' },
];

const start = new Date('2024-01-15T09:00:00');
const end = new Date('2024-01-15T09:30:00');

describe('MobileEventFormSheet', () => {
  it('shows the calendar picker in create mode with more than one integration', () => {
    render(
      <MobileEventFormSheet
        mode="create"
        initialStart={start}
        initialEnd={end}
        googleIntegrations={integrations}
        onSubmit={jest.fn()}
        onClose={jest.fn()}
      />
    );
    expect(screen.getByLabelText('Calendar')).toBeInTheDocument();
  });

  it('submits the entered values', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(
      <MobileEventFormSheet
        mode="create"
        initialStart={start}
        initialEnd={end}
        googleIntegrations={integrations}
        onSubmit={onSubmit}
        onClose={jest.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Lunch' } });
    fireEvent.change(screen.getByLabelText('Calendar'), { target: { value: 'g2' } });
    fireEvent.click(screen.getByRole('button', { name: /add event/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const values = onSubmit.mock.calls[0][0];
    expect(values.title).toBe('Lunch');
    expect(values.integrationId).toBe('g2');
  });

  it('disables save until a title is entered', () => {
    render(
      <MobileEventFormSheet
        mode="create"
        initialTitle=""
        initialStart={start}
        initialEnd={end}
        googleIntegrations={integrations}
        onSubmit={jest.fn()}
        onClose={jest.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /add event/i })).toBeDisabled();
  });

  it('hides the picker and keeps the integration fixed in edit mode', () => {
    render(
      <MobileEventFormSheet
        mode="edit"
        initialTitle="Standup"
        initialStart={start}
        initialEnd={end}
        googleIntegrations={integrations}
        fixedIntegrationId="g1"
        onSubmit={jest.fn()}
        onClose={jest.fn()}
      />
    );
    expect(screen.queryByLabelText('Calendar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });
});
