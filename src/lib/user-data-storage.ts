// Barrel for the user-data storage layer.
//
// The implementation is split into per-domain modules under ./storage, all
// backed by a single SQLite database (see ./storage/db). This file re-exports
// every storage function and shared type so existing imports from
// '@/lib/user-data-storage' keep working unchanged.

export {
  getUserData,
  saveUserData,
  DEFAULT_ASANA_FILTERS,
} from './storage/core';
export type {
  UserData,
  GoogleEventAttribution,
  PrepBlock,
  RitualBlock,
  ReviewTitleVerdict,
} from './storage/core';

export * from './storage/templates';
export * from './storage/ad-hoc-tasks';
export * from './storage/schedule';
export * from './storage/classifications';
export * from './storage/ai-verdicts';
export * from './storage/weekly-stats';
export * from './storage/time-sync';
export * from './storage/exercise-sync';
export * from './storage/analysis-settings';
export * from './storage/delegation-queue';
export * from './storage/asana-filters';
export * from './storage/attributions';
export * from './storage/deferrals';
export * from './storage/carry-overs';
export * from './storage/daily-review';
export * from './storage/type-verdicts';
export * from './storage/reminder-verdicts';
export * from './storage/board';
export * from './storage/board-rollover';
