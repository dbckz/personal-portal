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
