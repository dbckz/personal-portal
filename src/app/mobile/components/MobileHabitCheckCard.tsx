'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';

import {
  HabitCheckPanel,
  emptyHabitAnswers,
  habitLogsFrom,
  incompleteHabits,
  type HabitAnswers,
} from '@/components/dashboard/HabitCheckPanel';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/useToast';

// Today's habit check, on the phone. Desktop only asks these inside the daily
// review wizard; mobile gives them a standalone home so the day can be answered
// from a phone. The panel itself is self-contained — it seeds today's existing
// answers on mount — so this card only owns the draft state and the save.
export function MobileHabitCheckCard({ onSaved }: { onSaved?: () => void }) {
  const toast = useToast();
  const today = format(new Date(), 'yyyy-MM-dd');

  const [answers, setAnswers] = useState<HabitAnswers>(emptyHabitAnswers);
  const [notes, setNotes] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    // A "no" without a reason is the one thing the store rejects; surface it
    // here rather than letting the save fail.
    if (incompleteHabits(answers).length > 0) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      await api.saveWellbeingDay({ date: today, habits: habitLogsFrom(answers), notes });
      setShowErrors(false);
      toast.success('Habits saved for today');
      onSaved?.();
    } catch (err) {
      console.error('Failed to save wellbeing day:', err);
      toast.error('Could not save your habits — check your connection.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <HabitCheckPanel
        date={today}
        answers={answers}
        onChange={setAnswers}
        notes={notes}
        onNotesChange={setNotes}
        showErrors={showErrors}
      />
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="mt-3 flex h-12 w-full items-center justify-center gap-1.5 rounded-md bg-gray-900 text-sm font-semibold text-white disabled:opacity-50"
      >
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        {saving ? 'Saving…' : "Save today's habits"}
      </button>
    </div>
  );
}
