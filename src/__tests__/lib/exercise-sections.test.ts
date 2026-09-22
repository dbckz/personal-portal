/**
 * @jest-environment node
 *
 * Grouping the checklist rows into sections: from a prescription's own sections
 * (order preserved, anchors leading, added-on-the-spot rows in "Other"), or —
 * with no prescription — by classifying each exercise into Run / Pull / Push /
 * Legs / Core with the staples first within each.
 */
import { groupRowsIntoSections, type SectionableRow } from '@/lib/exercise-sections';

function row(over: Partial<SectionableRow> & { name: string }): SectionableRow {
  return { ...over };
}

describe('groupRowsIntoSections — with a prescription', () => {
  it('keeps the prescription’s sections in order and trails added rows in "Other"', () => {
    const sections = groupRowsIntoSections([
      row({ name: 'Seated cable row', section: 'Anchors', isAnchor: true, kind: 'core' }),
      row({ name: 'Cable shrugs', section: "This week's accessories" }),
      row({ name: 'Side plank', section: 'Core', kind: 'hold' }),
      // Added on the spot mid-session: no section.
      row({ name: 'Face pull' }),
    ]);
    expect(sections.map(s => s.title)).toEqual([
      'Anchors',
      "This week's accessories",
      'Core',
      'Other',
    ]);
    expect(sections[0].rows.map(r => r.name)).toEqual(['Seated cable row']);
    expect(sections[3].rows.map(r => r.name)).toEqual(['Face pull']);
  });
});

describe('groupRowsIntoSections — without a prescription', () => {
  it('classifies by name into non-empty Run/Pull/Push/Legs/Core, cardio first', () => {
    const sections = groupRowsIntoSections([
      row({ name: 'Bench press' }), // push
      row({ name: 'Seated cable row' }), // pull
      row({ name: 'Treadmill run' }), // run
      row({ name: 'Plank', kind: 'hold' }), // core
    ]);
    // Run leads; no Legs section because nothing classified there.
    expect(sections.map(s => s.title)).toEqual(['Run', 'Pull', 'Push', 'Core']);
  });

  it('puts staples (kind core) at the top of their section', () => {
    const [pushSection] = groupRowsIntoSections([
      row({ name: 'Cable fly' }), // push, accessory
      row({ name: 'Chest press machine', kind: 'core' }), // push, staple
    ]);
    expect(pushSection.title).toBe('Push');
    expect(pushSection.rows.map(r => r.name)).toEqual(['Chest press machine', 'Cable fly']);
  });

  it('drops an unclassifiable exercise into "Other"', () => {
    const sections = groupRowsIntoSections([row({ name: 'Something odd' })]);
    expect(sections.map(s => s.title)).toEqual(['Other']);
  });
});

describe('groupRowsIntoSections — the finisher', () => {
  it('lifts a to-failure row into its own trailing "Finisher" section (classified)', () => {
    const sections = groupRowsIntoSections([
      row({ name: 'Treadmill run' }), // run
      // A pull-classified accessory that, without the finisher rule, would sit
      // mid-list in the Pull section — Dave's complaint.
      row({ name: 'Reverse pec deck', toFailure: true }),
      row({ name: 'Seated cable row' }), // pull
    ]);
    expect(sections.map(s => s.title)).toEqual(['Run', 'Pull', 'Finisher']);
    expect(sections[sections.length - 1].rows.map(r => r.name)).toEqual(['Reverse pec deck']);
    // The finisher is not left in the Pull section it would classify into.
    expect(sections.find(s => s.title === 'Pull')!.rows.map(r => r.name)).toEqual([
      'Seated cable row',
    ]);
  });

  it('trails the finisher after "Other" in prescription mode', () => {
    const sections = groupRowsIntoSections([
      row({ name: 'Seated cable row', section: 'Anchors', isAnchor: true, kind: 'core' }),
      row({ name: 'Reverse pec deck', section: "This week's accessories", toFailure: true }),
      row({ name: 'Face pull' }), // added on the spot → Other
    ]);
    expect(sections.map(s => s.title)).toEqual(['Anchors', 'Other', 'Finisher']);
    expect(sections[sections.length - 1].rows.map(r => r.name)).toEqual(['Reverse pec deck']);
  });

  it('adds no Finisher section when no row is to failure', () => {
    const sections = groupRowsIntoSections([
      row({ name: 'Seated cable row' }),
      row({ name: 'Bench press' }),
    ]);
    expect(sections.some(s => s.title === 'Finisher')).toBe(false);
  });
});

describe('groupRowsIntoSections — a superset day', () => {
  const pair = (index: number, slot: 'a' | 'b') => ({ pair: { index, slot } });

  it('keeps programme order with each pair together, a before b, and the run where it is done', () => {
    const sections = groupRowsIntoSections([
      row({ name: 'Leg press', kind: 'core', ...pair(1, 'a') }),
      row({ name: 'Seated leg curl', kind: 'core', ...pair(1, 'b') }),
      row({ name: 'Incline DB press', kind: 'core', ...pair(2, 'a') }),
      row({ name: 'Chest-supported DB row', kind: 'core', ...pair(2, 'b') }),
      row({ name: 'Calf press', toFailure: true }),
      row({ name: 'Treadmill run', kind: 'cardio' }),
    ]);
    expect(sections.map(s => s.title)).toEqual(['Superset 1', 'Superset 2', 'Then']);
    expect(sections[0].superset).toBe(true);
    expect(sections[0].rows.map(r => r.name)).toEqual(['Leg press', 'Seated leg curl']);
    expect(sections[1].rows.map(r => r.name)).toEqual(['Incline DB press', 'Chest-supported DB row']);
    expect(sections[2].superset).toBeUndefined();
    expect(sections[2].rows.map(r => r.name)).toEqual(['Calf press', 'Treadmill run']);
  });

  it('pulls a stray half up beside its partner and puts a run done first ahead of the lifts', () => {
    const sections = groupRowsIntoSections([
      row({ name: 'Parkrun', kind: 'cardio' }),
      row({ name: 'Chest-supported DB row', ...pair(1, 'b') }),
      row({ name: 'DB bicep curl', ...pair(2, 'a') }),
      row({ name: 'Incline DB press', ...pair(1, 'a') }),
      row({ name: 'Overhead DB tricep extension', ...pair(2, 'b') }),
    ]);
    expect(sections.map(s => [s.title, s.rows.map(r => r.name)])).toEqual([
      ['First', ['Parkrun']],
      ['Superset 1', ['Incline DB press', 'Chest-supported DB row']],
      ['Superset 2', ['DB bicep curl', 'Overhead DB tricep extension']],
    ]);
  });

  it('gives a second block of unpaired rows a distinct title', () => {
    const sections = groupRowsIntoSections([
      row({ name: 'A', ...pair(1, 'a') }),
      row({ name: 'B', ...pair(1, 'b') }),
      row({ name: 'Calf press' }),
      row({ name: 'C', ...pair(2, 'a') }),
      row({ name: 'D', ...pair(2, 'b') }),
      row({ name: 'Added on the spot' }),
    ]);
    expect(sections.map(s => s.title)).toEqual(['Superset 1', 'Then', 'Superset 2', 'Then (2)']);
  });
});
