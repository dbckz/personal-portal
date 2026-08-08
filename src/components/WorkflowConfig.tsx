'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { BUILT_IN_TASK_TYPE_LABELS, BuiltInTaskType, CustomTaskType } from '@/types';

interface TaskQuota {
  weeklyCount?: number;
  targetLength: string;
  preferredTimes: string[];
  autoSelect?: boolean;
  grouped?: boolean;
  maxSelection?: number;
}

interface WorkRunConfig {
  maxMinutes: number;
  bufferMinutes: number;
}

interface SchedulingConfig {
  workRun: WorkRunConfig;
  workingDays: string[];
  workingHours: {
    start: string;
    end: string;
  };
  ritualGoogleIntegrationId?: string;
  ritualCalendars?: {
    lunch?: string;
    emails?: string;
    exercise?: string;
    kindleNotes?: string;
    grooming?: string;
    retro?: string;
    walk?: string;
    consulting?: string;
    sideProjects?: string;
    newBookies?: string;
    reading?: string;
    learning?: string;
  };
  overflow?: {
    start: string;
    end: string;
  };
}

interface WorkflowConfig {
  taskQuotas: {
    [key: string]: TaskQuota;
  };
  scheduling: SchedulingConfig;
  typeMapping?: Record<string, string[]>;
  lastUpdated?: string;
}

const DEFAULT_CONFIG: WorkflowConfig = {
  taskQuotas: {
    'Writing/Deep Work': {
      weeklyCount: 3,
      targetLength: '2h',
      preferredTimes: ['09:00-11:00', '21:00-23:00']
    },
    'Blogs': {
      weeklyCount: 2,
      targetLength: '1.5h',
      preferredTimes: ['09:00-12:00']
    },
    'Batch': {
      weeklyCount: 2,
      targetLength: '1h',
      preferredTimes: []
    },
    'Engagement/Outreach': {
      weeklyCount: 1,
      targetLength: '45min',
      preferredTimes: []
    },
    'General Todos': {
      targetLength: '',
      preferredTimes: []
    }
  },
  scheduling: {
    workRun: { maxMinutes: 120, bufferMinutes: 15 },
    workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    workingHours: {
      start: '09:00',
      end: '17:00'
    }
  },
  typeMapping: {}
};

export default function WorkflowConfig() {
  const [config, setConfig] = useState<WorkflowConfig>(DEFAULT_CONFIG);
  const [customTypes, setCustomTypes] = useState<CustomTaskType[]>([]);
  const [googleIntegrations, setGoogleIntegrations] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{type: 'success' | 'error', text: string} | null>(null);

  useEffect(() => {
    loadConfig();
    api.getCustomTaskTypes()
      .then(({ customTypes }) => setCustomTypes(customTypes))
      .catch(err => console.error('Failed to load custom task types:', err));
    // Enabled + connected Google integrations feed the ritual-calendar picker.
    api.getSettings()
      .then(({ googleIntegrations }) =>
        setGoogleIntegrations(
          googleIntegrations
            .filter(g => g.enabled && g.connected)
            .map(g => ({ id: g.id, name: g.name }))
        )
      )
      .catch(err => console.error('Failed to load integrations:', err));
  }, []);

  // Known task types available for mapping: built-ins + user custom types.
  const typeOptions: { value: string; label: string }[] = [
    ...(Object.entries(BUILT_IN_TASK_TYPE_LABELS) as [BuiltInTaskType, string][]).map(
      ([value, label]) => ({ value, label })
    ),
    ...customTypes.map(c => ({ value: `custom:${c.id}`, label: `${c.emoji} ${c.label}` })),
  ];

  const toggleTypeMapping = (category: string, typeValue: string) => {
    setConfig(prev => {
      const current = prev.typeMapping?.[category] || [];
      const next = current.includes(typeValue)
        ? current.filter(t => t !== typeValue)
        : [...current, typeValue];
      return {
        ...prev,
        typeMapping: { ...(prev.typeMapping || {}), [category]: next },
      };
    });
  };

  const loadConfig = async () => {
    try {
      const response = await fetch('/api/workflow-config');
      const data = await response.json();
      
      if (data.success) {
        setConfig(data.config);
      } else {
        console.error('Failed to load config:', data.error);
        setMessage({type: 'error', text: 'Failed to load configuration'});
      }
    } catch (error) {
      console.error('Error loading config:', error);
      setMessage({type: 'error', text: 'Error loading configuration'});
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch('/api/workflow-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });

      const data = await response.json();

      if (data.success) {
        setMessage({type: 'success', text: 'Configuration saved successfully!'});
        setConfig(data.config);
      } else {
        setMessage({type: 'error', text: data.error || 'Failed to save configuration'});
      }
    } catch (error) {
      console.error('Error saving config:', error);
      setMessage({type: 'error', text: 'Error saving configuration'});
    } finally {
      setSaving(false);
    }
  };

  const updateTaskQuota = <K extends keyof TaskQuota>(taskType: string, field: K, value: TaskQuota[K]) => {
    setConfig(prev => ({
      ...prev,
      taskQuotas: {
        ...prev.taskQuotas,
        [taskType]: {
          ...prev.taskQuotas[taskType],
          [field]: value
        }
      }
    }));
  };

  const updateScheduling = <K extends keyof SchedulingConfig>(field: K, value: SchedulingConfig[K]) => {
    setConfig(prev => ({
      ...prev,
      scheduling: {
        ...prev.scheduling,
        [field]: value
      }
    }));
  };

  const addPreferredTime = (taskType: string) => {
    const newTime = '09:00-10:00';
    updateTaskQuota(taskType, 'preferredTimes', [
      ...config.taskQuotas[taskType].preferredTimes,
      newTime
    ]);
  };

  const removePreferredTime = (taskType: string, index: number) => {
    const times = config.taskQuotas[taskType].preferredTimes;
    updateTaskQuota(taskType, 'preferredTimes', times.filter((_, i) => i !== index));
  };

  const updatePreferredTime = (taskType: string, index: number, value: string) => {
    const times = [...config.taskQuotas[taskType].preferredTimes];
    times[index] = value;
    updateTaskQuota(taskType, 'preferredTimes', times);
  };

  if (loading) {
    return <div className="p-4">Loading configuration...</div>;
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-2">Workflow Configuration</h2>
        <p className="text-gray-600">Configure your weekly sprint planning preferences</p>
      </div>

      {message && (
        <div className={`mb-4 p-3 rounded ${
          message.type === 'success' 
            ? 'bg-green-100 text-green-700 border border-green-300' 
            : 'bg-red-100 text-red-700 border border-red-300'
        }`}>
          {message.text}
        </div>
      )}

      {/* Task Quotas Section */}
      <div className="mb-8">
        <h3 className="text-xl font-semibold mb-4">Task Quotas</h3>
        <div className="space-y-6">
          {Object.entries(config.taskQuotas).map(([taskType, quota]) => {
            // Determine the label based on task type
            const getCountLabel = (type: string) => {
              if (type === 'Writing/Deep Work' || type === 'Blogs') {
                return 'Tasks to work on per week';
              } else if (type === 'Batch' || type === 'Engagement/Outreach') {
                return 'Work sessions per week';
              }
              return 'Weekly Count';
            };

            const showWeeklyCount = taskType !== 'General Todos';

            return (
              <div key={taskType} className="border rounded-lg p-4 bg-gray-50">
                <h4 className="font-medium mb-3">{taskType}</h4>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  {showWeeklyCount && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {getCountLabel(taskType)}
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={quota.weeklyCount || 0}
                        onChange={(e) => updateTaskQuota(taskType, 'weeklyCount', parseInt(e.target.value))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                  )}
                  
                  {taskType !== 'General Todos' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Target Length
                      </label>
                      <input
                        type="text"
                        value={quota.targetLength}
                        onChange={(e) => updateTaskQuota(taskType, 'targetLength', e.target.value)}
                        placeholder="e.g., 2h, 90min"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      />
                    </div>
                  )}
                </div>

                {taskType !== 'General Todos' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Preferred Times
                    </label>
                    <div className="space-y-2">
                      {quota.preferredTimes.map((timeRange, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <input
                            type="text"
                            value={timeRange}
                            onChange={(e) => updatePreferredTime(taskType, index, e.target.value)}
                            placeholder="e.g., 09:00-11:00"
                            className="flex-1 px-3 py-2 border border-gray-300 rounded-md"
                          />
                          <button
                            onClick={() => removePreferredTime(taskType, index)}
                            className="px-3 py-2 bg-red-500 text-white rounded-md hover:bg-red-600"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => addPreferredTime(taskType)}
                        className="px-3 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
                      >
                        Add Time Range
                      </button>
                    </div>
                  </div>
                )}

                {showWeeklyCount && (
                  <label className="flex items-center mt-4 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={quota.autoSelect ?? false}
                      onChange={(e) => updateTaskQuota(taskType, 'autoSelect', e.target.checked)}
                      className="mr-2"
                    />
                    Auto-pick tasks (skip manual selection in Plan my week)
                  </label>
                )}

                {showWeeklyCount && (
                  <label className="flex items-center mt-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={quota.grouped ?? false}
                      onChange={(e) => updateTaskQuota(taskType, 'grouped', e.target.checked)}
                      className="mr-2"
                    />
                    Grouped blocks (place N container blocks sharing one agenda of all selected tasks)
                  </label>
                )}

                {showWeeklyCount && (
                  <div className="mt-3">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Max tasks to select (optional)
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={quota.maxSelection ?? ''}
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        const n = parseInt(v, 10);
                        updateTaskQuota(
                          taskType,
                          'maxSelection',
                          v === '' || Number.isNaN(n) || n <= 0 ? undefined : n
                        );
                      }}
                      placeholder="No cap"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Caps how many tasks you can pick in Plan my week — enforced even for grouped categories. Leave blank for no cap.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Type Mapping Section */}
      <div className="mb-8">
        <h3 className="text-xl font-semibold mb-2">Category → Task Type Mapping</h3>
        <p className="text-gray-600 text-sm mb-4">
          Choose which task types count toward each quota category. A category also
          matches any task whose type equals the category name.
        </p>
        <div className="space-y-4">
          {Object.keys(config.taskQuotas).map(category => {
            const mapped = config.typeMapping?.[category] || [];
            return (
              <div key={category} className="border rounded-lg p-4 bg-gray-50">
                <h4 className="font-medium mb-3">{category}</h4>
                <div className="flex flex-wrap gap-2">
                  {typeOptions.map(option => {
                    const selected = mapped.includes(option.value);
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => toggleTypeMapping(category, option.value)}
                        className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
                          selected
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Scheduling Section */}
      <div className="mb-8">
        <h3 className="text-xl font-semibold mb-4">Scheduling Settings</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Max Work-Run (minutes)
            </label>
            <input
              type="number"
              min={15}
              step={15}
              value={config.scheduling.workRun?.maxMinutes ?? 120}
              onChange={(e) => updateScheduling('workRun', {
                ...(config.scheduling.workRun ?? { maxMinutes: 120, bufferMinutes: 15 }),
                maxMinutes: Number(e.target.value),
              })}
              placeholder="e.g., 120"
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            />
            <p className="text-xs text-gray-400 mt-1">
              Longest continuous busy stretch before a break is required.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Break After a Run (minutes)
            </label>
            <input
              type="number"
              min={5}
              step={5}
              value={config.scheduling.workRun?.bufferMinutes ?? 15}
              onChange={(e) => updateScheduling('workRun', {
                ...(config.scheduling.workRun ?? { maxMinutes: 120, bufferMinutes: 15 }),
                bufferMinutes: Number(e.target.value),
              })}
              placeholder="e.g., 15"
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            />
            <p className="text-xs text-gray-400 mt-1">
              Minimum free gap that separates two work runs.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Working Hours Start
            </label>
            <input
              type="time"
              value={config.scheduling.workingHours.start}
              onChange={(e) => updateScheduling('workingHours', {
                ...config.scheduling.workingHours,
                start: e.target.value
              })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Working Hours End
            </label>
            <input
              type="time"
              value={config.scheduling.workingHours.end}
              onChange={(e) => updateScheduling('workingHours', {
                ...config.scheduling.workingHours,
                end: e.target.value
              })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Working Days
          </label>
          <div className="flex flex-wrap gap-2">
            {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(day => (
              <label key={day} className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.scheduling.workingDays.includes(day)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      updateScheduling('workingDays', [...config.scheduling.workingDays, day]);
                    } else {
                      updateScheduling('workingDays', config.scheduling.workingDays.filter(d => d !== day));
                    }
                  }}
                  className="mr-2"
                />
                {day}
              </label>
            ))}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Evening Overflow Start
            </label>
            <input
              type="time"
              value={config.scheduling.overflow?.start ?? ''}
              onChange={(e) =>
                updateScheduling(
                  'overflow',
                  e.target.value
                    ? { start: e.target.value, end: config.scheduling.overflow?.end ?? '23:00' }
                    : undefined
                )
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Evening Overflow End
            </label>
            <input
              type="time"
              value={config.scheduling.overflow?.end ?? ''}
              onChange={(e) =>
                updateScheduling(
                  'overflow',
                  e.target.value
                    ? { start: config.scheduling.overflow?.start ?? '21:00', end: e.target.value }
                    : undefined
                )
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            />
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          Optional window (outside working hours) where Plan my week can offer opt-in blocks for tasks
          that don&apos;t fit. Leave both blank to disable.
        </p>

        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Ritual calendars
          </label>
          <div className="space-y-2">
            {([
              { kind: 'lunch', label: 'Lunch' },
              { kind: 'emails', label: 'Emails' },
              { kind: 'exercise', label: 'Exercise' },
              { kind: 'kindleNotes', label: 'Kindle notes' },
              { kind: 'grooming', label: 'Grooming' },
              { kind: 'retro', label: 'Retro' },
              { kind: 'walk', label: 'Walk' },
              { kind: 'consulting', label: 'Consulting' },
              { kind: 'sideProjects', label: 'Side projects' },
              { kind: 'newBookies', label: 'New bookies' },
              { kind: 'reading', label: 'Reading' },
              { kind: 'learning', label: 'Learning' },
            ] as const).map(({ kind, label }) => {
              // Lunch/emails fall back to the legacy single id so an existing
              // config keeps showing the right calendar until it's re-saved. The
              // WORK rituals (kindle/grooming/retro) default to the emails
              // calendar setting (→ OM) until explicitly overridden.
              const legacy = config.scheduling.ritualGoogleIntegrationId;
              const cals = config.scheduling.ritualCalendars;
              const emailsDefault = cals?.emails ?? legacy ?? '';
              const value =
                cals?.[kind] ??
                (kind === 'exercise' || kind === 'walk'
                  ? ''
                  : kind === 'lunch' || kind === 'emails'
                    ? legacy ?? ''
                    : emailsDefault);
              return (
                <div key={kind} className="flex items-center gap-3">
                  <span className="w-20 text-sm text-gray-600">{label}</span>
                  <select
                    value={value}
                    onChange={(e) =>
                      updateScheduling('ritualCalendars', {
                        ...config.scheduling.ritualCalendars,
                        [kind]: e.target.value || undefined,
                      })
                    }
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md"
                  >
                    <option value="">Default calendar</option>
                    {googleIntegrations.map(g => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Which Google calendar each daily ritual is created on. Break events follow the
            Exercise calendar. Defaults to the primary calendar.
          </p>
        </div>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={saveConfig}
          disabled={saving}
          className="px-6 py-3 bg-green-600 text-white font-medium rounded-md hover:bg-green-700 disabled:bg-gray-400"
        >
          {saving ? 'Saving...' : 'Save Configuration'}
        </button>
      </div>

      {config.lastUpdated && (
        <p className="text-sm text-gray-500 mt-2 text-right">
          Last updated: {new Date(config.lastUpdated).toLocaleString()}
        </p>
      )}
    </div>
  );
}