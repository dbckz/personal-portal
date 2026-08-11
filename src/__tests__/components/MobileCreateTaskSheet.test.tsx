/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MobileCreateTaskSheet } from '@/app/mobile/components/MobileCreateTaskSheet';

const integrations = [{ id: 'integration-1', name: 'OM' }];
const projects = [
  { gid: 'p1', name: 'Policy', integrationId: 'integration-1', integrationName: 'OM' },
];

describe('MobileCreateTaskSheet', () => {
  it('creates an Asana task with the chosen name, project and due date', async () => {
    const onCreateAsanaTask = jest.fn().mockResolvedValue({});
    const onClose = jest.fn();
    render(
      <MobileCreateTaskSheet
        integrations={integrations}
        projects={projects}
        onClose={onClose}
        onCreateAsanaTask={onCreateAsanaTask}
        onCreateAdhoc={jest.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Enter task name'), {
      target: { value: 'Draft the brief' },
    });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: '2030-07-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Policy' }));
    fireEvent.click(screen.getByRole('button', { name: /create task/i }));

    await waitFor(() =>
      expect(onCreateAsanaTask).toHaveBeenCalledWith('integration-1', 'Draft the brief', {
        dueOn: '2030-07-01',
        projectGid: 'p1',
      })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('creates an ad-hoc task with an emoji-prefixed title', async () => {
    const onCreateAdhoc = jest.fn().mockResolvedValue({});
    const onClose = jest.fn();
    render(
      <MobileCreateTaskSheet
        integrations={integrations}
        projects={projects}
        onClose={onClose}
        onCreateAsanaTask={jest.fn()}
        onCreateAdhoc={onCreateAdhoc}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /quick task/i }));
    fireEvent.click(screen.getByRole('button', { name: /focus time/i }));
    fireEvent.change(screen.getByPlaceholderText(/defaults to/i), {
      target: { value: 'deep work' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create task/i }));

    await waitFor(() =>
      expect(onCreateAdhoc).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '🎯 Focus time: deep work',
          taskType: 'focus',
          priority: 'medium',
          completed: false,
        })
      )
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
