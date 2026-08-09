import { homedir } from 'node:os';
import path from 'node:path';
import { resolveClaudeBin } from '../config';

describe('resolveClaudeBin', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.CLAUDE_BIN_DBC;
    delete process.env.CLAUDE_BIN_OM;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('defaults to the ~/bin wrapper for each account', () => {
    expect(resolveClaudeBin('claude-dbc')).toBe(path.join(homedir(), 'bin', 'claude-dbc'));
    expect(resolveClaudeBin('claude-om')).toBe(path.join(homedir(), 'bin', 'claude-om'));
  });

  it('honours per-account env overrides', () => {
    process.env.CLAUDE_BIN_DBC = '/custom/dbc';
    process.env.CLAUDE_BIN_OM = '/custom/om';
    expect(resolveClaudeBin('claude-dbc')).toBe('/custom/dbc');
    expect(resolveClaudeBin('claude-om')).toBe('/custom/om');
  });

  it('applies an override only to its own account', () => {
    process.env.CLAUDE_BIN_OM = '/custom/om';
    expect(resolveClaudeBin('claude-dbc')).toBe(path.join(homedir(), 'bin', 'claude-dbc'));
    expect(resolveClaudeBin('claude-om')).toBe('/custom/om');
  });

  it('throws an actionable error for a missing account', () => {
    expect(() => resolveClaudeBin(undefined)).toThrow(/No Claude account set/i);
    expect(() => resolveClaudeBin(null)).toThrow(/No Claude account set/i);
  });

  it('throws for an unknown account value', () => {
    // @ts-expect-error deliberately passing an invalid account
    expect(() => resolveClaudeBin('claude-other')).toThrow(/No Claude account set/i);
  });
});
