'use client';

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Sparkles, Trash2, X } from 'lucide-react';

import { api } from '@/lib/api';
import { goalSections } from '@/lib/life-sections';
import { periodLabel, quarterKeyForMonth } from '@/lib/goal-periods';
import { milestoneDate } from '@/lib/goal-plan';
// Type-only: goal-inference itself is server-side, so nothing is bundled here.
import type { InferredEvidence, InferredGoal } from '@/lib/goal-inference';
import type { AsanaProject, AsanaTagWithIntegration } from '@/types';
import type { Goal, GoalEvidence, GoalEvidenceKind, GoalMilestone, GoalPeriodKind } from '@/types/life';

type EvidenceUnit = 'count' | 'minutes' | 'max-distance-km';

const EVIDENCE_OPTIONS: Array<{ kind: GoalEvidenceKind; label: string; hint: string }> = [
  { kind: 'manual', label: 'Self-reported', hint: 'You type the figure in at check-in time.' },
  {
    kind: 'asana-project',
    label: 'Asana project',
    hint: 'Counts tasks completed in the project during the period.',
  },
  {
    kind: 'asana-tag',
    label: 'Asana tag',
    hint: 'Counts tasks completed under the tag during the period.',
  },
  {
    kind: 'calendar-category',
    label: 'Calendar category',
    hint: 'Counts time booked against a time-tracking category.',
  },
  { kind: 'exercise', label: 'Exercise log', hint: 'Counts sessions, minutes, or your longest single distance.' },
];

// The 'count'/'minutes'/'max-distance-km' choices offered per evidence kind.
// A peak distance only makes sense for the exercise log.
const UNIT_OPTIONS: Record<'exercise' | 'calendar-category', Array<{ value: EvidenceUnit; label: string }>> = {
  exercise: [
    { value: 'count', label: 'Sessions' },
    { value: 'minutes', label: 'Minutes' },
    { value: 'max-distance-km', label: 'Longest distance (km)' },
  ],
  'calendar-category': [
    { value: 'count', label: 'Occurrences' },
    { value: 'minutes', label: 'Minutes' },
  ],
};

// A one-line, human-readable rendering of a suggested evidence source for the
// proposal card — the label of the kind, plus its ref/unit where they add meaning.
function describeEvidence(evidence: GoalEvidence): string {
  const base = EVIDENCE_OPTIONS.find(o => o.kind === evidence.kind)?.label ?? evidence.kind;
  const parts: string[] = [];
  if (evidence.kind === 'exercise') {
    const unit = UNIT_OPTIONS.exercise.find(u => u.value === evidence.unit)?.label;
    if (unit) parts.push(unit.toLowerCase());
    if (evidence.ref) parts.push(`matching "${evidence.ref}"`);
  } else if (evidence.kind === 'calendar-category') {
    if (evidence.ref) parts.push(`"${evidence.ref}"`);
    const unit = UNIT_OPTIONS['calendar-category'].find(u => u.value === evidence.unit)?.label;
    if (unit) parts.push(unit.toLowerCase());
  }
  return parts.length > 0 ? `${base} — ${parts.join(', ')}` : base;
}

interface GoalEditorModalProps {
  // Absent for a new goal.
  goal?: Goal | null;
  defaultSectionId: string;
  defaultPeriodKind: GoalPeriodKind;
  defaultPeriodKey: string;
  // Quarterly goals in the same section+quarter, offered as parents for a
  // monthly goal.
  parentCandidates: Goal[];
  onClose: () => void;
  onSaved: () => void;
}

export function GoalEditorModal({
  goal,
  defaultSectionId,
  defaultPeriodKind,
  defaultPeriodKey,
  parentCandidates,
  onClose,
  onSaved,
}: GoalEditorModalProps) {
  const [sectionId, setSectionId] = useState(goal?.sectionId ?? defaultSectionId);
  const [title, setTitle] = useState(goal?.title ?? '');
  const [detail, setDetail] = useState(goal?.detail ?? '');
  const [targetValue, setTargetValue] = useState(goal?.target ? String(goal.target.value) : '');
  const [targetUnit, setTargetUnit] = useState(goal?.target?.unit ?? '');
  const [evidenceKind, setEvidenceKind] = useState<GoalEvidenceKind>(goal?.evidence.kind ?? 'manual');
  const [evidenceRef, setEvidenceRef] = useState(goal?.evidence.ref ?? '');
  const [evidenceUnit, setEvidenceUnit] = useState<EvidenceUnit>(goal?.evidence.unit ?? 'count');
  // The workspace a chosen Asana tag lives in — stored so the resolver reads
  // exactly one workspace rather than probing all of them.
  const [evidenceIntegrationId, setEvidenceIntegrationId] = useState(goal?.evidence.integrationId ?? '');
  const [parentGoalId, setParentGoalId] = useState(goal?.parentGoalId ?? '');
  const [projects, setProjects] = useState<AsanaProject[]>([]);
  const [tags, setTags] = useState<AsanaTagWithIntegration[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Period is fixed for an existing goal — moving a goal between months would
  // rewrite history rather than edit it. For a new goal the inference may set it.
  const [periodKind, setPeriodKind] = useState<GoalPeriodKind>(goal?.periodKind ?? defaultPeriodKind);
  const [periodKey, setPeriodKey] = useState(goal?.periodKey ?? defaultPeriodKey);

  // The AI phase, offered only for a new goal: describe it in free text, let the
  // model draft the structure and a progression plan, then confirm and edit.
  const [draftText, setDraftText] = useState('');
  const [inferring, setInferring] = useState(false);
  const [inferNote, setInferNote] = useState<string | null>(null);
  const [milestones, setMilestones] = useState<GoalMilestone[]>(goal?.plan ?? []);
  const [planSource, setPlanSource] = useState<Goal['planSource']>(goal?.planSource);

  // "Suggest tracking source", offered for an existing manual goal: ask the model
  // to map it onto an auto-derived source, then apply straight to the saved goal.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<InferredEvidence | null>(null);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [applyingSuggestion, setApplyingSuggestion] = useState(false);

  useEffect(() => {
    if (evidenceKind !== 'asana-project' || projects.length > 0) return;
    api
      .getAsanaProjects()
      .then(res => setProjects(res.projects))
      .catch(err => console.error('Failed to load Asana projects:', err));
  }, [evidenceKind, projects.length]);

  useEffect(() => {
    if (evidenceKind !== 'asana-tag' || tags.length > 0) return;
    api
      .getAsanaTags()
      .then(res => setTags(res.tags))
      .catch(err => console.error('Failed to load Asana tags:', err));
  }, [evidenceKind, tags.length]);

  useEffect(() => {
    if (evidenceKind !== 'calendar-category' || categories.length > 0) return;
    api
      .getGoalCategories()
      .then(res => setCategories(res.categories))
      .catch(err => console.error('Failed to load goal categories:', err));
  }, [evidenceKind, categories.length]);

  const eligibleParents = useMemo(() => {
    // Parents only apply to monthly goals; quarterKeyForMonth would choke on a
    // quarter key ("2026-Q3"), so don't even ask for a quarterly goal.
    if (periodKind !== 'month') return [];
    const parentQuarter = quarterKeyForMonth(periodKey);
    return parentCandidates.filter(
      p => p.periodKind === 'quarter' && p.sectionId === sectionId && p.periodKey === parentQuarter
    );
  }, [parentCandidates, sectionId, periodKey, periodKind]);

  // Switching section can strip the selected parent of its validity.
  useEffect(() => {
    if (parentGoalId && !eligibleParents.some(p => p.id === parentGoalId)) setParentGoalId('');
  }, [eligibleParents, parentGoalId]);

  // Prefill every form field from an accepted proposal. The user then reviews and
  // edits before anything is saved.
  const applyProposal = (proposal: InferredGoal) => {
    setSectionId(proposal.sectionId);
    setPeriodKind(proposal.periodKind);
    setPeriodKey(proposal.periodKey);
    setTitle(proposal.title);
    setDetail(proposal.detail ?? '');
    setTargetValue(proposal.target ? String(proposal.target.value) : '');
    setTargetUnit(proposal.target?.unit ?? '');
    setEvidenceKind(proposal.evidence.kind);
    setEvidenceRef(proposal.evidence.ref ?? '');
    setEvidenceUnit((proposal.evidence.unit as EvidenceUnit) ?? 'count');
    setEvidenceIntegrationId(proposal.evidence.integrationId ?? '');
    setMilestones(proposal.milestones);
    setPlanSource('ai');
  };

  const suggest = async () => {
    if (!draftText.trim()) return;
    setInferring(true);
    setInferNote(null);
    setError(null);
    try {
      const { proposal } = await api.inferGoal({ text: draftText.trim(), sectionId });
      if (!proposal) {
        setInferNote("Couldn't draft that one — fill it in below and it'll still save.");
        return;
      }
      applyProposal(proposal);
    } catch {
      setInferNote("Couldn't reach the drafting model — fill it in below.");
    } finally {
      setInferring(false);
    }
  };

  const suggestEvidence = async () => {
    if (!goal) return;
    setSuggesting(true);
    setSuggestNote(null);
    setSuggestion(null);
    try {
      const { proposal } = await api.suggestGoalEvidence(goal.id);
      if (!proposal) {
        setSuggestNote("Couldn't find an automatic source for this one — keep self-reporting it.");
        return;
      }
      setSuggestion(proposal);
    } catch {
      setSuggestNote("Couldn't reach the model — try again in a moment.");
    } finally {
      setSuggesting(false);
    }
  };

  // Apply a suggested source to the saved goal straight away, then close: the
  // proposal card is the review step, so there's nothing more to confirm.
  const applySuggestion = async () => {
    if (!goal || !suggestion) return;
    setApplyingSuggestion(true);
    setError(null);
    try {
      await api.updateGoal(goal.id, {
        evidence: suggestion.evidence,
        ...(suggestion.target ? { target: suggestion.target } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply the tracking source.');
      setApplyingSuggestion(false);
    }
  };

  const updateMilestone = (index: number, patch: Partial<GoalMilestone>) => {
    setMilestones(list => list.map((m, i) => (i === index ? { ...m, ...patch } : m)));
    setPlanSource('manual');
  };

  const removeMilestone = (index: number) => {
    setMilestones(list => list.filter((_, i) => i !== index));
    setPlanSource('manual');
  };

  const save = async () => {
    if (!title.trim()) {
      setError('Give the goal a title.');
      return;
    }
    setSaving(true);
    setError(null);

    const parsedTarget = Number(targetValue);
    const cleanMilestones = milestones
      .filter(m => m.label.trim() || typeof m.value === 'number')
      .map(m => ({
        key: m.key,
        label: m.label.trim() || (m.value !== undefined ? `${m.value}` : ''),
        ...(typeof m.value === 'number' ? { value: m.value } : {}),
        ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      }));

    const payload = {
      title: title.trim(),
      detail: detail.trim() || undefined,
      target:
        targetValue.trim() && Number.isFinite(parsedTarget) && parsedTarget > 0
          ? { value: parsedTarget, unit: targetUnit.trim() || undefined }
          : undefined,
      evidence: {
        kind: evidenceKind,
        ...(evidenceKind !== 'manual' && evidenceRef.trim() ? { ref: evidenceRef.trim() } : {}),
        ...(evidenceKind === 'calendar-category' || evidenceKind === 'exercise'
          ? { unit: evidenceUnit }
          : {}),
        // A tag gid is workspace-specific, so pin the resolver to its workspace.
        ...(evidenceKind === 'asana-tag' && evidenceIntegrationId
          ? { integrationId: evidenceIntegrationId }
          : {}),
      },
      plan: cleanMilestones,
      planSource,
    };

    try {
      if (goal) {
        await api.updateGoal(goal.id, {
          ...payload,
          // '' clears the parent server-side.
          parentGoalId: periodKind === 'month' ? parentGoalId : '',
        });
      } else {
        await api.createGoal({
          sectionId,
          periodKind,
          periodKey,
          ...payload,
          ...(periodKind === 'month' && parentGoalId ? { parentGoalId } : {}),
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the goal.');
    } finally {
      setSaving(false);
    }
  };

  const evidenceHint = EVIDENCE_OPTIONS.find(o => o.kind === evidenceKind)?.hint;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">
            {goal ? 'Edit goal' : `New ${periodKind === 'month' ? 'monthly' : 'quarterly'} goal`}
            <span className="ml-2 text-sm font-normal text-gray-500">
              {periodLabel(periodKind, periodKey)}
            </span>
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100" aria-label="Close">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {!goal && (
            <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-3">
              <label htmlFor="goal-draft" className="block text-xs font-semibold text-indigo-900 mb-1">
                Describe it, and I&apos;ll draft the rest
              </label>
              <textarea
                id="goal-draft"
                value={draftText}
                onChange={e => setDraftText(e.target.value)}
                rows={2}
                placeholder="Run 10K by the end of the quarter"
                className="w-full px-3 py-2 text-sm border border-indigo-200 rounded-md bg-white"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={suggest}
                  disabled={inferring || !draftText.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {inferring ? 'Drafting…' : milestones.length > 0 || title ? 'Redraft' : 'Suggest'}
                </button>
                <span className="text-[11px] text-indigo-800/70">
                  Fills in the fields below, including a progression plan. Edit anything before saving.
                </span>
              </div>
              {inferNote && <p className="mt-2 text-xs text-amber-700">{inferNote}</p>}
            </div>
          )}

          {!goal && (
            <Field label="Life area" htmlFor="goal-section">
              <select
                id="goal-section"
                value={sectionId}
                onChange={e => setSectionId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
              >
                {goalSections().map(s => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Goal" htmlFor="goal-title">
            <input
              id="goal-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="What are you aiming for?"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
            />
          </Field>

          <Field label="Detail (optional)" htmlFor="goal-detail">
            <textarea
              id="goal-detail"
              value={detail}
              onChange={e => setDetail(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Target number (optional)" htmlFor="goal-target">
              <input
                id="goal-target"
                type="number"
                min="0"
                value={targetValue}
                onChange={e => setTargetValue(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
              />
            </Field>
            <Field label="Unit" htmlFor="goal-unit">
              <input
                id="goal-unit"
                value={targetUnit}
                onChange={e => setTargetUnit(e.target.value)}
                placeholder="sessions, posts, hours"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
              />
            </Field>
          </div>
          <p className="-mt-2 text-xs text-gray-500">
            A target is what makes pacing possible. Without one the goal is tracked by check-ins alone.
          </p>

          <Field label="Progress comes from" htmlFor="goal-evidence">
            <select
              id="goal-evidence"
              value={evidenceKind}
              onChange={e => {
                setEvidenceKind(e.target.value as GoalEvidenceKind);
                setEvidenceRef('');
                setEvidenceUnit('count');
                setEvidenceIntegrationId('');
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
            >
              {EVIDENCE_OPTIONS.map(o => (
                <option key={o.kind} value={o.kind}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          {evidenceHint && <p className="-mt-2 text-xs text-gray-500">{evidenceHint}</p>}

          {goal && evidenceKind === 'manual' && (
            <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-3">
              {!suggestion ? (
                <>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={suggestEvidence}
                      disabled={suggesting}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {suggesting ? 'Looking…' : 'Suggest tracking source'}
                    </button>
                    <span className="text-[11px] text-indigo-800/70">
                      Track this goal automatically from data you already keep.
                    </span>
                  </div>
                  {suggestNote && <p className="mt-2 text-xs text-amber-700">{suggestNote}</p>}
                </>
              ) : (
                <div>
                  <p className="text-xs font-semibold text-indigo-900">Suggested tracking source</p>
                  <p className="mt-1 text-sm text-gray-800">{describeEvidence(suggestion.evidence)}</p>
                  {suggestion.target && (
                    <p className="mt-0.5 text-xs text-gray-600">
                      Target: {suggestion.target.value}
                      {suggestion.target.unit ? ` ${suggestion.target.unit}` : ''}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-gray-500">{suggestion.rationale}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={applySuggestion}
                      disabled={applyingSuggestion}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {applyingSuggestion ? 'Applying…' : 'Apply'}
                    </button>
                    <button
                      onClick={() => setSuggestion(null)}
                      className="px-3 py-1.5 text-xs font-medium text-gray-600 rounded-md hover:bg-gray-100"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {evidenceKind === 'asana-project' && (
            <Field label="Project" htmlFor="goal-project">
              <select
                id="goal-project"
                value={evidenceRef}
                onChange={e => setEvidenceRef(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
              >
                <option value="">Choose a project…</option>
                {projects.map(p => (
                  <option key={p.gid} value={p.gid}>
                    {p.name} ({p.integrationName})
                  </option>
                ))}
              </select>
            </Field>
          )}

          {evidenceKind === 'asana-tag' && (
            <Field label="Tag" htmlFor="goal-tag">
              <select
                id="goal-tag"
                value={evidenceRef}
                onChange={e => {
                  const gid = e.target.value;
                  setEvidenceRef(gid);
                  setEvidenceIntegrationId(tags.find(t => t.gid === gid)?.integrationId ?? '');
                }}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
              >
                <option value="">Choose a tag…</option>
                {tags.map(t => (
                  <option key={`${t.integrationId}-${t.gid}`} value={t.gid}>
                    {t.name} ({t.integrationName})
                  </option>
                ))}
              </select>
            </Field>
          )}

          {(evidenceKind === 'calendar-category' || evidenceKind === 'exercise') && (
            <div className="grid grid-cols-2 gap-3">
              <Field
                label={evidenceKind === 'exercise' ? 'Session type (blank = all)' : 'Category'}
                htmlFor="goal-ref"
              >
                <input
                  id="goal-ref"
                  value={evidenceRef}
                  onChange={e => setEvidenceRef(e.target.value)}
                  placeholder={evidenceKind === 'exercise' ? 'run' : 'Deep work'}
                  list={evidenceKind === 'calendar-category' ? 'goal-category-options' : undefined}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                />
                {evidenceKind === 'calendar-category' && (
                  <datalist id="goal-category-options">
                    {categories.map(c => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                )}
              </Field>
              <Field label="Count" htmlFor="goal-evidence-unit">
                <select
                  id="goal-evidence-unit"
                  value={evidenceUnit}
                  onChange={e => setEvidenceUnit(e.target.value as EvidenceUnit)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                >
                  {UNIT_OPTIONS[evidenceKind].map(o => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}

          {milestones.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="block text-xs font-semibold text-gray-600">
                  Progression plan
                  {planSource === 'ai' && (
                    <span className="ml-1.5 font-normal text-indigo-500">drafted</span>
                  )}
                </span>
                <span className="text-[11px] text-gray-400">
                  {milestones.length} milestone{milestones.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="space-y-1.5">
                {milestones.map((m, i) => (
                  <MilestoneRow
                    key={`${m.key}-${i}`}
                    milestone={m}
                    unit={targetUnit}
                    onChange={patch => updateMilestone(i, patch)}
                    onRemove={() => removeMilestone(i)}
                  />
                ))}
              </div>
            </div>
          )}

          {periodKind === 'month' && (
            <Field label="Sits under quarterly goal (optional)" htmlFor="goal-parent">
              <select
                id="goal-parent"
                value={parentGoalId}
                onChange={e => setParentGoalId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                disabled={eligibleParents.length === 0}
              >
                <option value="">
                  {eligibleParents.length === 0
                    ? 'No quarterly goals in this area yet'
                    : 'Not linked to a quarterly goal'}
                </option>
                {eligibleParents.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 rounded-md hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-gray-900 rounded-md hover:bg-gray-800 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save goal'}
          </button>
        </div>
      </div>
    </div>
  );
}

// One editable milestone: its date (read-only, set by the plan), a numeric figure
// and a label, with a delete. Editing anything flips the plan to hand-edited.
function MilestoneRow({
  milestone,
  unit,
  onChange,
  onRemove,
}: {
  milestone: GoalMilestone;
  unit: string;
  onChange: (patch: Partial<GoalMilestone>) => void;
  onRemove: () => void;
}) {
  const at = milestoneDate(milestone.key);
  return (
    <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
      <span className="w-14 shrink-0 text-[11px] font-medium text-gray-500 tabular-nums">
        {at ? format(at, 'd MMM') : milestone.key}
      </span>
      <input
        type="number"
        value={milestone.value ?? ''}
        onChange={e => {
          const v = e.target.value.trim();
          onChange({ value: v === '' ? undefined : Number(v) });
        }}
        className="w-16 px-1.5 py-1 text-sm border border-gray-300 rounded-md bg-white"
        aria-label={`Milestone figure${unit ? ` in ${unit}` : ''}`}
      />
      {unit && <span className="text-[11px] text-gray-400">{unit}</span>}
      <input
        value={milestone.label}
        onChange={e => onChange({ label: e.target.value })}
        className="flex-1 min-w-0 px-2 py-1 text-sm border border-gray-300 rounded-md bg-white"
        placeholder="What this step is"
        aria-label="Milestone label"
      />
      <button
        onClick={onRemove}
        className="p-1 rounded shrink-0 text-gray-400 hover:bg-red-50 hover:text-red-600"
        aria-label="Remove milestone"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-semibold text-gray-600 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}
