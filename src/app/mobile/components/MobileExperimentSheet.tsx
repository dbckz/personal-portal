'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';

import { MobileSheet } from './MobileSheet';
import { api } from '@/lib/api';
import type { Experiment, ExperimentStatus, ExperimentVerdict } from '@/types/wellbeing';

// The full experiment editor on the phone, in a bottom sheet. Create mode is a
// plain form; edit mode adds the status control and — once it's being called —
// the verdict and reflection, so concluding, abandoning and reopening all live
// here rather than needing their own inline forms on the card.

const FIELD_CLASS =
  'w-full rounded-md border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-orange-400';

const STATUSES: { value: ExperimentStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'running', label: 'Running' },
  { value: 'complete', label: 'Complete' },
  { value: 'abandoned', label: 'Abandoned' },
];

const VERDICTS: { value: ExperimentVerdict; label: string }[] = [
  { value: 'worked', label: 'Worked' },
  { value: 'mixed', label: 'Mixed' },
  { value: 'no-effect', label: 'No effect' },
  { value: 'inconclusive', label: 'Inconclusive' },
];

export function MobileExperimentSheet({
  experiment,
  onClose,
  onSaved,
}: {
  // Present in edit mode; absent when creating a new experiment.
  experiment?: Experiment;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!experiment;

  const [title, setTitle] = useState(experiment?.title ?? '');
  const [hypothesis, setHypothesis] = useState(experiment?.hypothesis ?? '');
  const [protocol, setProtocol] = useState(experiment?.protocol ?? '');
  const [measure, setMeasure] = useState(experiment?.measure ?? '');
  const [startDate, setStartDate] = useState(
    experiment?.startDate ?? format(new Date(), 'yyyy-MM-dd')
  );
  const [endDate, setEndDate] = useState(experiment?.endDate ?? '');
  const [status, setStatus] = useState<ExperimentStatus>(experiment?.status ?? 'planned');
  const [verdict, setVerdict] = useState<ExperimentVerdict | ''>(experiment?.verdict ?? '');
  const [reflection, setReflection] = useState(experiment?.reflection ?? '');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await api.updateExperiment(experiment.id, {
          title,
          hypothesis,
          protocol,
          measure,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          status,
          // Verdict and reflection only make sense once it's concluded; a blank
          // verdict clears it (that is how reopening drops the old one).
          verdict: status === 'complete' ? (verdict || undefined) : '',
          reflection: status === 'complete' ? reflection : '',
        });
      } else {
        await api.createExperiment({
          title,
          hypothesis,
          protocol,
          measure,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          // Dated today or earlier it is already under way — saying so saves a
          // "start it" tap (matches desktop).
          status:
            startDate && startDate <= format(new Date(), 'yyyy-MM-dd') ? 'running' : 'planned',
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the experiment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <MobileSheet onClose={onClose}>
      <div className="overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <h2 className="mb-3 text-base font-semibold text-gray-900">
          {editing ? 'Edit experiment' : 'New experiment'}
        </h2>

        <div className="space-y-3">
          <Field label="What are you trying?">
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="No screens for the first hour after waking"
              className={FIELD_CLASS}
              autoFocus={!editing}
            />
          </Field>
          <Field label="What do you expect to change?" hint="The hypothesis, in one line.">
            <input
              type="text"
              value={hypothesis}
              onChange={e => setHypothesis(e.target.value)}
              placeholder="Mornings feel less scattered and the pages get written"
              className={FIELD_CLASS}
            />
          </Field>
          <Field label="Exactly what will you do?" hint="Concrete enough to follow on a bad day.">
            <textarea
              value={protocol}
              onChange={e => setProtocol(e.target.value)}
              rows={2}
              placeholder="Phone stays in the kitchen overnight. No laptop before 8am."
              className={FIELD_CLASS}
            />
          </Field>
          <Field label="How will you judge it?" hint="Decide now, not at the end.">
            <input
              type="text"
              value={measure}
              onChange={e => setMeasure(e.target.value)}
              placeholder="Morning-pages rate over the four weeks"
              className={FIELD_CLASS}
            />
          </Field>
          <div className="flex gap-3">
            <Field label="Start">
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className={FIELD_CLASS}
              />
            </Field>
            <Field label="End" hint="A fixed end date is what makes it an experiment.">
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className={FIELD_CLASS}
              />
            </Field>
          </div>

          {editing && (
            <Field label="Status">
              <div className="grid grid-cols-2 gap-1.5">
                {STATUSES.map(s => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setStatus(s.value)}
                    aria-pressed={status === s.value}
                    className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      status === s.value
                        ? 'border-transparent bg-gray-900 text-white'
                        : 'border-gray-200 bg-white text-gray-600'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {editing && status === 'complete' && (
            <>
              <Field label="Did it work?">
                <div className="flex flex-wrap gap-1.5">
                  {VERDICTS.map(v => (
                    <button
                      key={v.value}
                      type="button"
                      onClick={() => setVerdict(v.value)}
                      aria-pressed={verdict === v.value}
                      className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                        verdict === v.value
                          ? 'border-transparent bg-orange-500 text-white'
                          : 'border-gray-200 bg-white text-gray-600'
                      }`}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="What you concluded">
                <textarea
                  value={reflection}
                  onChange={e => setReflection(e.target.value)}
                  rows={2}
                  placeholder="What actually happened, and would you keep it?"
                  className={FIELD_CLASS}
                />
              </Field>
            </>
          )}
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-12 flex-1 rounded-md border border-gray-300 text-sm font-medium text-gray-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!title.trim() || saving}
            className="flex h-12 flex-[2] items-center justify-center gap-1.5 rounded-md bg-orange-500 text-sm font-semibold text-white disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </MobileSheet>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block flex-1">
      <span className="block text-xs font-medium text-gray-700">{label}</span>
      {hint && <span className="block text-[11px] text-gray-400">{hint}</span>}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
