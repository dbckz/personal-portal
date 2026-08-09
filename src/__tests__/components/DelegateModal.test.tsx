/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { DelegateModal } from '@/components/DelegateModal';

jest.mock('@/lib/api', () => ({
  api: {
    runNowDelegation: jest.fn(),
    upsertDelegationEntry: jest.fn(),
  },
}));

import { api } from '@/lib/api';

const PROPS = {
  asanaTaskGid: 'gid-1',
  integrationId: 'int-1',
  taskTitle: 'Draft the memo',
  initialBrief: 'Write a one-pager',
};

beforeEach(() => {
  jest.clearAllMocks();
  (api.runNowDelegation as jest.Mock).mockResolvedValue({ started: true });
  (api.upsertDelegationEntry as jest.Mock).mockResolvedValue({ entry: {} });
});

describe('DelegateModal account selector', () => {
  it('keeps both submit buttons disabled until an account is chosen', () => {
    render(<DelegateModal {...PROPS} onClose={jest.fn()} />);

    // Brief is pre-filled, but no account picked yet — submit stays gated.
    expect(screen.getByRole('button', { name: /run now/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /queue for background/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /DBC/i }));

    expect(screen.getByRole('button', { name: /run now/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /queue for background/i })).toBeEnabled();
  });

  it('stays gated when a brief is present but no account is selected', () => {
    render(<DelegateModal {...PROPS} onClose={jest.fn()} />);
    // Never touch the account picker.
    expect(screen.getByRole('button', { name: /run now/i })).toBeDisabled();
    expect(api.runNowDelegation).not.toHaveBeenCalled();
  });

  it('passes the chosen account to runNowDelegation', async () => {
    render(<DelegateModal {...PROPS} onClose={jest.fn()} />);

    fireEvent.click(screen.getByRole('radio', { name: /OpenMined/i }));
    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    await waitFor(() => expect(api.runNowDelegation).toHaveBeenCalledTimes(1));
    expect(api.runNowDelegation).toHaveBeenCalledWith(
      'gid-1', 'int-1', 'Write a one-pager', 'Draft the memo', 'claude-om',
    );
  });

  it('passes the chosen account to the background queue upsert', async () => {
    render(<DelegateModal {...PROPS} onClose={jest.fn()} />);

    fireEvent.click(screen.getByRole('radio', { name: /DBC/i }));
    fireEvent.click(screen.getByRole('button', { name: /queue for background/i }));

    await waitFor(() => expect(api.upsertDelegationEntry).toHaveBeenCalledTimes(1));
    expect(api.upsertDelegationEntry).toHaveBeenCalledWith(
      'gid-1', 'int-1', expect.objectContaining({ claudeAccount: 'claude-dbc', state: 'queued' }),
    );
  });
});
