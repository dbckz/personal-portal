/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { MobileAiClaimsSheet } from '@/app/mobile/command-center/MobileAiClaimsSheet';
import type { AiClaim } from '@/lib/api';

jest.mock('@/lib/api', () => ({
  api: {
    applyAiVerdicts: jest.fn(),
  },
}));

import { api } from '@/lib/api';

const mockApply = api.applyAiVerdicts as jest.Mock;

const CLAIMS: AiClaim[] = [
  { gid: 'a', integrationId: 'i1', title: 'Send the invoice', integrationName: 'Acme', dueOn: '2026-08-20', reason: 'Simple templated email' },
  { gid: 'b', integrationId: 'i1', title: 'Refactor the auth module', integrationName: 'Acme', reason: 'Needs judgement' },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockApply.mockResolvedValue({ accepted: 2, rejected: 0 });
});

describe('MobileAiClaimsSheet', () => {
  it('confirms every claim accepted by default', async () => {
    const onApplied = jest.fn();
    const onClose = jest.fn();
    render(<MobileAiClaimsSheet claims={CLAIMS} onClose={onClose} onApplied={onApplied} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });

    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply).toHaveBeenCalledWith(
      [{ gid: 'a', integrationId: 'i1' }, { gid: 'b', integrationId: 'i1' }],
      []
    );
    expect(onApplied).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('moves an unticked claim to the reject list', async () => {
    render(<MobileAiClaimsSheet claims={CLAIMS} onClose={jest.fn()} onApplied={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Refactor the auth module/ }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });

    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply).toHaveBeenCalledWith(
      [{ gid: 'a', integrationId: 'i1' }],
      [{ gid: 'b', integrationId: 'i1' }]
    );
  });

  it('shows an empty state with a Done button and applies nothing', () => {
    const onClose = jest.fn();
    render(<MobileAiClaimsSheet claims={[]} onClose={onClose} onApplied={jest.fn()} />);

    expect(screen.getByText(/No new AI-runnable tasks found/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });
});
