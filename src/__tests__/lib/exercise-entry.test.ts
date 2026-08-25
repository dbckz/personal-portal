/**
 * @jest-environment node
 *
 * The single shared rule for "was this exercise actually performed". Only an
 * explicit done:false (a seeded-but-unticked target) is a skip; done:true and
 * legacy undefined both count as performed.
 */
import { entryWasPerformed } from '@/lib/exercise-entry';

describe('entryWasPerformed', () => {
  it('counts a ticked entry as performed', () => {
    expect(entryWasPerformed({ done: true })).toBe(true);
  });

  it('treats an explicit done:false as not performed', () => {
    // A target seeded at the start of the session and never ticked, or one
    // un-ticked afterwards.
    expect(entryWasPerformed({ done: false })).toBe(false);
  });

  it('treats an undefined done as performed', () => {
    // Legacy data and the desktop "Log a session" form write no done flag, but
    // those rows ARE a record of what was done — so undefined must count.
    expect(entryWasPerformed({ done: undefined })).toBe(true);
    expect(entryWasPerformed({})).toBe(true);
  });
});
