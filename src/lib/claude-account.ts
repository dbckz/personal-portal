import { ClaudeAccount } from '@/types';

// Human-readable labels for the machine's two Claude Code accounts. Shared by
// the delegate modal (the picker) and the queue/detail views (the badge) so a
// task always reads the same account name everywhere.
export const CLAUDE_ACCOUNT_LABELS: Record<ClaudeAccount, string> = {
  'claude-dbc': 'DBC',
  'claude-om': 'OpenMined',
};

// Short label for a possibly-unset account (legacy or skeleton entries).
export function claudeAccountLabel(account: ClaudeAccount | undefined | null): string | null {
  return account ? CLAUDE_ACCOUNT_LABELS[account] : null;
}
