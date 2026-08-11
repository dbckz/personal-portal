'use client';

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Sparkles, X } from 'lucide-react';

import { api } from '@/lib/api';
import { goalSections } from '@/lib/life-sections';
import { periodKeyFor, periodLabel, quarterKeyForMonth } from '@/lib/goal-periods';
import { milestoneDate } from '@/lib/goal-plan';
// Type-only: goal-inference itself is server-side, so nothing is bundled here.
import type { InferredGoal } from '@/lib/goal-inference';
import type { AsanaProject, AsanaTagWithIntegration } from '@/types';
import type { Goal, GoalEvidenceKind, GoalMilestone, GoalPeriodKind } from '@/types/life';
import { MobileSheet } from './MobileSheet';

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

interface MobileGoalEditorSheetProps {
  // Absent (undefined) or null for a new goal.
  goal?: Goal | null;
  defaultSectionId: string;
  defaultPeriodKind: GoalPeriodKind;
  // Quarterly goals offered as parents for a monthly goal (the current quarter's,
  // supplied by the overview so the sheet needs no extra fetch).
  parentCandidates: Goal[];
  onClose: () => void;
  onSaved: () => void;
}

// The mobile create/edit flow: the same structure the desktop GoalEditorModal
// writes, laid out as a bottom sheet with phone-sized controls. Offers the
// natural-language "describe it" fast path first, then the full form as review /
// fallback. Inferred progression plans are carried through the save untouched
// (shown read-only here — editing individual milestones stays on the desktop).
export function MobileGoalEditorSheet({
  goal,
  defaultSectionId,
  defaultPeriodKind,
  parentCandidates,
  onClose,
  onSaved,
}: MobileGoalEditorSheetProps) {
  const now = new Date();

  const [sectionId, setSectionId] = useState(goal?.sectionId ?? defaultSectionId);
  const [title, setTitle] = useState(goal?.title ?? '');
  const [detail, setDetail] = useState(goal?.detail ?? '');
  const [targetValue, setTargetValue] = useState(goal?.target ? String(goal.target.value) : '');
  const [targetUnit, setTargetUnit] = useState(goal?.target?.unit ?? '');
  const [evidenceKind, setEvidenceKind] = useState<GoalEvidenceKind>(goal?.evidence.kind ?? 'manual');
  const [evidenceRef, setEvidenceRef] = useState(goal?.evidence.ref ?? '');
  const [evidenceUnit, setEvidenceUnit] = useState<EvidenceUnit>(goal?.evidence.unit ?? 'count');
  const [evidenceIntegrationId, setEvidenceIntegrationId] = useState(goal?.evidence.integrationId ?? '');
  const [parentGoalId, setParentGoalId] = useState(goal?.parentGoalId ?? '');
  const [projects, setProjects] = useState<AsanaProject[]>([]);
  const [tags, setTags] = useState<AsanaTagWithIntegration[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Period is fixed for an existing goal — moving a goal between months would
  // rewrite history rather than edit it. For a new goal the toggle (or the
  // inference) may set it.
  const [periodKind, setPeriodKind] = useState<GoalPeriodKind>(goal?.periodKind ?? defaultPeriodKind);
  const [periodKey, setPeriodKey] = useState(goal?.periodKey ?? periodKeyFor(defaultPeriodKind, now));

  // The AI phase, offered only for a new goal.
  const [draftText, setDraftText] = useState('');
  const [inferring, setInferring] = useState(false);
  const [inferNote, setInferNote] = useState<string | null>(null);
  const [milestones, setMilestones] = useState<GoalMilestone[]>(goal?.plan ?? []);
  const [planSource, setPlanSource] = useState<Goal['planSource']>(goal?.planSource);

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
    // quarter key, so don't even ask for a quarterly goal.
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

  // New goals let the user choose month vs quarter; the key follows to the
  // equivalent current period.
  const changePeriodKind = (kind: GoalPeriodKind) => {
    setPeriodKind(kind);
    setPeriodKey(periodKeyFor(kind, now));
  };

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
    <MobileSheet onClose={onClose}>
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 pb-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-6 text-gray-950">
            {goal ? 'Edit goal' : `New ${periodKind === 'month' ? 'monthly' : 'quarterly'} goal`}
          </h2>
          <p className="mt-0.5 text-sm text-gray-500">{periodLabel(periodKind, periodKey)}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors active:bg-gray-100"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
        {!goal && (
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-3">
            <label htmlFor="mobile-goal-draft" className="mb-1 block text-xs font-semibold text-indigo-900">
              Describe it, and I&apos;ll draft the rest
            </label>
            <textarea
              id="mobile-goal-draft"
              value={draftText}
              onChange={e => setDraftText(e.target.value)}
              rows={2}
              placeholder="Run 10K by the end of the quarter"
              className="w-full rounded-md border border-indigo-200 bg-white px-3 py-2 text-base"
            />
            <button
              type="button"
              onClick={suggest}
              disabled={inferring || !draftText.trim()}
              className="mt-2 flex h-11 items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white active:bg-indigo-700 disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              {inferring ? 'Drafting…' : milestones.length > 0 || title ? 'Redraft' : 'Suggest'}
            </button>
            <p className="mt-1.5 text-[11px] text-indigo-800/70">
              Fills in the fields below, including a progression plan. Edit anything before saving.
            </p>
            {inferNote && <p className="mt-2 text-xs text-amber-700">{inferNote}</p>}
          </div>
        )}

        {!goal && (
          <Field label="Timeframe">
            <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
              {(['month', 'quarter'] as const).map(kind => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => changePeriodKind(kind)}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
                    periodKind === kind ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'
                  }`}
                >
                  {kind === 'month' ? 'Monthly' : 'Quarterly'}
                </button>
              ))}
            </div>
          </Field>
        )}

        {!goal && (
          <Field label="Life area" htmlFor="mobile-goal-section">
            <select
              id="mobile-goal-section"
              value={sectionId}
              onChange={e => setSectionId(e.target.value)}
              className="h-11 w-full rounded-md border border-gray-300 px-3 text-base"
            >
              {goalSections().map(s => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Goal" htmlFor="mobile-goal-title">
          <input
            id="mobile-goal-title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="What are you aiming for?"
            className="h-11 w-full rounded-md border border-gray-300 px-3 text-base"
          />
        </Field>

        <Field label="Detail (optional)" htmlFor="mobile-goal-detail">
          <textarea
            id="mobile-goal-detail"
            value={detail}
            onChange={e => setDetail(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-base"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Target number" htmlFor="mobile-goal-target">
            <input
              id="mobile-goal-target"
              type="number"
              inputMode="numeric"
              min="0"
              value={targetValue}
              onChange={e => setTargetValue(e.target.value)}
              className="h-11 w-full rounded-md border border-gray-300 px-3 text-base"
            />
          </Field>
          <Field label="Unit" htmlFor="mobile-goal-unit">
            <input
              id="mobile-goal-unit"
              value={targetUnit}
              onChange={e => setTargetUnit(e.target.value)}
              placeholder="sessions, posts"
              className="h-11 w-full rounded-md border border-gray-300 px-3 text-base"
            />
          </Field>
        </div>
        <p className="-mt-2 text-xs text-gray-500">
          A target is what makes pacing possible. Without one the goal is tracked by check-ins alone.
        </p>

        <Field label="Progress comes from" htmlFor="mobile-goal-evidence">
          <select
            id="mobile-goal-evidence"
            value={evidenceKind}
            onChange={e => {
              setEvidenceKind(e.target.value as GoalEvidenceKind);
              setEvidenceRef('');
              setEvidenceUnit('count');
              setEvidenceIntegrationId('');
            }}
            className="h-11 w-full rounded-md border border-gray-300 px-3 text-base"
          >
            {EVIDENCE_OPTIONS.map(o => (
              <option key={o.kind} value={o.kind}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {evidenceHint && <p className="-mt-2 text-xs text-gray-500">{evidenceHint}</p>}

        {evidenceKind === 'asana-project' && (
          <Field label="Project" htmlFor="mobile-goal-project">
            <select
              id="mobile-goal-project"
              value={evidenceRef}
              onChange={e => setEvidenceRef(e.target.value)}
              className="h-11 w-full rounded-md border border-gray-300 px-3 text-base"
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
          <Field label="Tag" htmlFor="mobile-goal-tag">
            <select
              id="mobile-goal-tag"
              value={evidenceRef}
              onChange={e => {
                const gid = e.target.value;
                setEvidenceRef(gid);
                setEvidenceIntegrationId(tags.find(t => t.gid === gid)?.integrationId ?? '');
              }}
              className="h-11 w-full rounded-md border border-gray-300 px-3 text-base"
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
              htmlFor="mobile-goal-ref"
            >
              <input
                id="mobile-goal-ref"
                value={evidenceRef}
                onChange={e => setEvidenceRef(e.target.value)}
                placeholder={evidenceKind === 'exercise' ? 'run' : 'Deep work'}
                list={evidenceKind === 'calendar-category' ? 'mobile-goal-category-options' : undefined}
                className="h-11 w-full rounded-md border border-gray-300 px-3 text-base"
              />
              {evidenceKind === 'calendar-category' && (
                <datalist id="mobile-goal-category-options">
                  {categories.map(c => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              )}
            </Field>
            <Field label="Count" htmlFor="mobile-goal-evidence-unit">
              <select
                id="mobile-goal-evidence-unit"
                value={evidenceUnit}
                onChange={e => setEvidenceUnit(e.target.value as EvidenceUnit)}
                className="h-11 w-full rounded-md border border-gray-300 px-3 text-base"
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
            <div className="mb-1 flex items-center justify-between">
              <span className="block text-xs font-semibold text-gray-600">
                Progression plan
                {planSource === 'ai' && <span className="ml-1.5 font-normal text-indigo-500">drafted</span>}
              </span>
              <span className="text-[11px] text-gray-400">
                {milestones.length} milestone{milestones.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="space-y-1.5">
              {milestones.map((m, i) => {
                const at = milestoneDate(m.key);
                return (
                  <div
                    key={`${m.key}-${i}`}
                    className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-2"
                  >
                    <span className="w-14 shrink-0 text-[11px] font-medium tabular-nums text-gray-500">
                      {at ? format(at, 'd MMM') : m.key}
                    </span>
                    {typeof m.value === 'number' && (
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-gray-700">
                        {m.value}
                        {targetUnit ? ` ${targetUnit}` : ''}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm text-gray-700">{m.label}</span>
                  </div>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              Edit the individual milestones on the desktop.
            </p>
          </div>
        )}

        {periodKind === 'month' && (
          <Field label="Sits under quarterly goal (optional)" htmlFor="mobile-goal-parent">
            <select
              id="mobile-goal-parent"
              value={parentGoalId}
              onChange={e => setParentGoalId(e.target.value)}
              className="h-11 w-full rounded-md border border-gray-300 px-3 text-base"
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

      <div className="flex flex-shrink-0 gap-2 border-t border-gray-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={onClose}
          className="h-12 flex-1 rounded-lg border border-gray-300 font-medium text-gray-700 transition-colors active:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="h-12 flex-1 rounded-lg bg-gray-900 font-medium text-white transition-colors active:bg-gray-800 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save goal'}
        </button>
      </div>
    </MobileSheet>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-semibold text-gray-600">
        {label}
      </label>
      {children}
    </div>
  );
}
