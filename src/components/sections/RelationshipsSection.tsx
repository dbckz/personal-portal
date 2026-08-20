'use client';

import { SectionGoals } from '@/components/goals/SectionGoals';

// Goals-only, like Music: the section exists so relationship goals can be set
// and reflected on alongside everything else.
export function RelationshipsSection() {
  return (
    <SectionGoals
      sectionId="relationships"
      emptyHint="Relationships is goals-only. Set a monthly or quarterly relationship goal here."
    />
  );
}
