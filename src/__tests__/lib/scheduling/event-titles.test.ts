/**
 * Tests for the shared event-title builder (emoji conventions + prep parsing).
 */
import { asanaTaskUrl } from '@/lib/asana-url';
import {
  blockEventDescription,
  categoryBlockTitle,
  categoryEmoji,
  colorIdForBlock,
  eventTitleForBlock,
  isPrepTitle,
  NON_WORK_COLOR_ID,
  prepMeetingTitleFromEvent,
  prepTitle,
  reservedBlockTitle,
  startsWithEmoji,
  taskBlockTitle,
  WORK_COLOR_ID,
} from '@/lib/scheduling/event-titles';
import type { ProposedBlock } from '@/lib/scheduling/types';

describe('categoryEmoji', () => {
  it('maps each known category to its emoji (whitespace-robust)', () => {
    expect(categoryEmoji('Writing/Deep Work')).toBe('✍️');
    expect(categoryEmoji('Writing / Deep Work')).toBe('✍️'); // spaced slash
    expect(categoryEmoji('Blogs')).toBe('📝');
    expect(categoryEmoji('Batch')).toBe('📦');
    expect(categoryEmoji('Engagement/Outreach')).toBe('🤝');
    expect(categoryEmoji('General Todos')).toBe('✅');
    expect(categoryEmoji('Meeting prep')).toBe('📖');
  });

  it('falls back to the unknown emoji for unmapped categories', () => {
    expect(categoryEmoji('Something else')).toBe('🗂️');
  });
});

describe('startsWithEmoji', () => {
  it('detects a leading pictographic emoji', () => {
    expect(startsWithEmoji('🎯 Focus time')).toBe(true);
    expect(startsWithEmoji('📖 Prep: X')).toBe(true);
  });
  it('is false for plain text', () => {
    expect(startsWithEmoji('Write the report')).toBe(false);
    expect(startsWithEmoji('1:1 with Alice')).toBe(false);
  });
});

describe('taskBlockTitle', () => {
  it('prefixes the category emoji for a plain task title', () => {
    expect(taskBlockTitle('Write the report', 'Blogs')).toBe('📝 Write the report');
  });
  it('does not double-prefix a task title that already leads with an emoji', () => {
    expect(taskBlockTitle('🎯 Focus time: deep work', 'Writing/Deep Work')).toBe(
      '🎯 Focus time: deep work'
    );
  });
});

describe('categoryBlockTitle / reservedBlockTitle', () => {
  it('emoji-prefixes a grouped block title', () => {
    expect(categoryBlockTitle('Engagement/Outreach')).toBe('🤝 Engagement/Outreach');
  });
  it('emoji-prefixes a reserved block title', () => {
    expect(reservedBlockTitle('Writing/Deep Work')).toBe('✍️ Writing/Deep Work block');
  });
});

describe('prep title helpers', () => {
  it('builds the emoji prep title', () => {
    expect(prepTitle('Board sync')).toBe('📖 Prep: Board sync');
  });
  it('isPrepTitle recognises both legacy and emoji forms', () => {
    expect(isPrepTitle('Prep: Board sync')).toBe(true);
    expect(isPrepTitle('📖 Prep: Board sync')).toBe(true);
    expect(isPrepTitle('Board sync')).toBe(false);
    expect(isPrepTitle('📝 Write the report')).toBe(false);
  });
  it('prepMeetingTitleFromEvent strips either prefix', () => {
    expect(prepMeetingTitleFromEvent('Prep: Board sync')).toBe('Board sync');
    expect(prepMeetingTitleFromEvent('📖 Prep: Board sync')).toBe('Board sync');
    expect(prepMeetingTitleFromEvent('Board sync')).toBe('Board sync'); // unchanged
  });
});

describe('eventTitleForBlock', () => {
  const base: ProposedBlock = {
    id: 'b1',
    category: 'Blogs',
    date: '2026-07-15',
    start: '09:00',
    durationMinutes: 30,
    reason: 'r',
  };

  it('titles a single-task block with the category emoji', () => {
    const block: ProposedBlock = { ...base, kind: 'task', task: { title: 'Draft post' } };
    expect(eventTitleForBlock(block)).toBe('📝 Draft post');
  });

  it('keeps a task title that already leads with an emoji', () => {
    const block: ProposedBlock = { ...base, kind: 'task', task: { title: '🎯 Focus time' } };
    expect(eventTitleForBlock(block)).toBe('🎯 Focus time');
  });

  it('titles a grouped block with the category emoji', () => {
    const block: ProposedBlock = {
      ...base,
      category: 'Engagement/Outreach',
      kind: 'task',
      tasks: [{ title: 'A' }, { title: 'B' }],
    };
    expect(eventTitleForBlock(block)).toBe('🤝 Engagement/Outreach');
  });

  it('titles a reserved block (no task) with "<emoji> <category> block"', () => {
    const block: ProposedBlock = { ...base, category: 'Blogs', kind: 'reserved' };
    expect(eventTitleForBlock(block)).toBe('📝 Blogs block');
  });

  it('titles a daily deep-work container "✍️ Deep work" (not the category label)', () => {
    const block: ProposedBlock = {
      ...base,
      category: 'Writing/Deep Work',
      kind: 'task',
      tasks: [{ title: 'Write memo' }, { title: 'Draft essay' }],
    };
    expect(eventTitleForBlock(block)).toBe('✍️ Deep work');
  });

  it('titles a reserved deep-work morning "✍️ Deep work" too', () => {
    const block: ProposedBlock = { ...base, category: 'Writing / Deep Work', kind: 'reserved' };
    expect(eventTitleForBlock(block)).toBe('✍️ Deep work');
  });

  it('titles a prep block "📖 Prep: <meeting>"', () => {
    const block: ProposedBlock = {
      ...base,
      category: 'Meeting prep',
      kind: 'prep',
      meeting: { eventId: 'e', title: 'Board sync', meetingStart: '2026-07-15T14:00:00.000Z' },
    };
    expect(eventTitleForBlock(block)).toBe('📖 Prep: Board sync');
  });

  it('passes a ritual title through unchanged (already emoji\'d)', () => {
    const block: ProposedBlock = { ...base, category: 'Lunch', kind: 'ritual', title: '🍽️ Lunch' };
    expect(eventTitleForBlock(block)).toBe('🍽️ Lunch');
  });

  it('passes a break title through unchanged', () => {
    const block: ProposedBlock = { ...base, category: 'Break', kind: 'break', title: '☕ Break' };
    expect(eventTitleForBlock(block)).toBe('☕ Break');
  });
});

describe('blockEventDescription', () => {
  const base: ProposedBlock = {
    id: 'b1',
    category: 'Blogs',
    date: '2026-07-15',
    start: '09:00',
    durationMinutes: 30,
    reason: 'Because reasons',
  };

  it('appends the Asana task link for a single Asana task block', () => {
    const block: ProposedBlock = { ...base, kind: 'task', task: { gid: '12345', title: 'Draft post' } };
    expect(blockEventDescription(block)).toBe(`Because reasons\n\n${asanaTaskUrl('12345')}`);
  });

  it('leaves an ad-hoc single-task block (no gid) as just the reason', () => {
    const block: ProposedBlock = { ...base, kind: 'task', task: { adhocId: 'a1', title: 'Draft post' } };
    expect(blockEventDescription(block)).toBe('Because reasons');
  });

  it('lists a grouped block agenda with a link under each Asana task', () => {
    const block: ProposedBlock = {
      ...base,
      category: 'Engagement/Outreach',
      tasks: [
        { gid: '111', title: 'Email Alice' },
        { gid: '222', title: 'Call Bob' },
      ],
    };
    expect(blockEventDescription(block)).toBe(
      `Because reasons\n\n` +
        `• Email Alice\n  ${asanaTaskUrl('111')}\n` +
        `• Call Bob\n  ${asanaTaskUrl('222')}`
    );
  });

  it('omits the link for ad-hoc tasks inside a grouped agenda', () => {
    const block: ProposedBlock = {
      ...base,
      category: 'Engagement/Outreach',
      tasks: [
        { gid: '111', title: 'Email Alice' },
        { adhocId: 'a1', title: 'Tidy inbox' },
      ],
    };
    expect(blockEventDescription(block)).toBe(
      `Because reasons\n\n` + `• Email Alice\n  ${asanaTaskUrl('111')}\n` + `• Tidy inbox`
    );
  });

  it('falls back to just the reason for reserved / prep / ritual / break blocks', () => {
    expect(blockEventDescription({ ...base, kind: 'reserved' })).toBe('Because reasons');
    expect(blockEventDescription({ ...base, kind: 'prep' })).toBe('Because reasons');
    expect(blockEventDescription({ ...base, kind: 'ritual', title: '🍽️ Lunch' })).toBe('Because reasons');
    expect(blockEventDescription({ ...base, tasks: [] })).toBe('Because reasons'); // empty grouped
  });
});

describe('asanaTaskUrl', () => {
  it('builds the canonical Asana task permalink from a gid', () => {
    expect(asanaTaskUrl('1209876543210')).toBe('https://app.asana.com/0/0/1209876543210/f');
  });
});

describe('colorIdForBlock', () => {
  const base: ProposedBlock = {
    id: 'b',
    category: 'X',
    date: '2026-07-15',
    start: '09:00',
    durationMinutes: 60,
    reason: 'r',
  };

  it('colours WORK blocks yellow (task / grouped / reserved / prep / emails / overflow)', () => {
    expect(colorIdForBlock({ ...base, task: { title: 'T' } })).toBe(WORK_COLOR_ID);
    expect(colorIdForBlock({ ...base, tasks: [{ title: 'T' }] })).toBe(WORK_COLOR_ID); // grouped
    expect(colorIdForBlock({ ...base })).toBe(WORK_COLOR_ID); // reserved
    expect(colorIdForBlock({ ...base, kind: 'prep' })).toBe(WORK_COLOR_ID);
    expect(colorIdForBlock({ ...base, kind: 'ritual', title: '📧 Emails' })).toBe(WORK_COLOR_ID);
    // The new WORK-type rituals are yellow too (they count toward work runs).
    expect(colorIdForBlock({ ...base, kind: 'ritual', title: '📚 Kindle notes' })).toBe(WORK_COLOR_ID);
    expect(colorIdForBlock({ ...base, kind: 'ritual', title: '🧹 Backlog grooming' })).toBe(
      WORK_COLOR_ID
    );
    expect(colorIdForBlock({ ...base, kind: 'ritual', title: '🔄 Retrospective' })).toBe(
      WORK_COLOR_ID
    );
    expect(colorIdForBlock({ ...base, kind: 'task', overflow: true, task: { title: 'T' } })).toBe(
      WORK_COLOR_ID
    );
  });

  it('colours NON-WORK blocks green (lunch / exercise / break)', () => {
    expect(colorIdForBlock({ ...base, kind: 'ritual', title: '🍽️ Lunch' })).toBe(NON_WORK_COLOR_ID);
    expect(colorIdForBlock({ ...base, kind: 'ritual', title: '🏋️ Exercise' })).toBe(
      NON_WORK_COLOR_ID
    );
    expect(colorIdForBlock({ ...base, kind: 'break', title: '☕ Break' })).toBe(NON_WORK_COLOR_ID);
  });
});
