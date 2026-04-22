/**
 * Sync rhythm — scheduling logic for data connector sync cycles.
 *
 * Three sync modes:
 *   morning  — full sync, 30-day fast bootstrap (runs once at configured hour)
 *   hourly   — incremental from cursor (every ~60 min)
 *   on_demand — user-triggered pull (immediate, from cursor)
 *
 * Each source tracks its own cursor and last sync timestamps.
 * The scheduler decides which mode to run based on:
 *   - Time since last morning sync (daily)
 *   - Time since last incremental sync (hourly)
 *   - Explicit user trigger (on_demand)
 *
 * Source: ARCHITECTURE.md Task 7.5
 */

export type SyncMode = 'morning' | 'hourly' | 'on_demand' | 'none';

export interface SyncSchedule {
  mode: SyncMode;
  source: string;
  cursor?: string;
  lookbackDays?: number;
  reason: string;
}

export interface SourceState {
  source: string;
  cursor: string;
  lastMorningSync: number; // ms timestamp
  lastIncrementalSync: number;
  syncCount: number;
}

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;
const MORNING_LOOKBACK_DAYS = 30;
const INCREMENTAL_INTERVAL_MS = MS_HOUR;

/** Per-source sync state. */
const sourceStates = new Map<string, SourceState>();

/** Configurable morning sync hour (default 6 AM). */
let morningSyncHour = 6;

/**
 * Get or create source state.
 */
function getState(source: string): SourceState {
  let state = sourceStates.get(source);
  if (!state) {
    state = { source, cursor: '', lastMorningSync: 0, lastIncrementalSync: 0, syncCount: 0 };
    sourceStates.set(source, state);
  }
  return state;
}

/**
 * Determine which sync mode should run next for a source.
 *
 * Priority: morning (if not done today) > hourly (if interval elapsed) > none.
 */
export function decideSyncMode(source: string, currentHour?: number, now?: number): SyncSchedule {
  const state = getState(source);
  const currentTime = now ?? Date.now();
  const hour = currentHour ?? new Date().getHours();

  // Morning sync: runs once per day, at the configured hour
  if (hour === morningSyncHour && currentTime - state.lastMorningSync > MS_DAY) {
    return {
      mode: 'morning',
      source,
      lookbackDays: MORNING_LOOKBACK_DAYS,
      reason: 'Daily morning sync (30-day bootstrap)',
    };
  }

  // Hourly incremental: runs if interval has elapsed
  if (currentTime - state.lastIncrementalSync >= INCREMENTAL_INTERVAL_MS) {
    return {
      mode: 'hourly',
      source,
      cursor: state.cursor || undefined,
      reason: state.cursor
        ? `Incremental from cursor ${state.cursor.slice(0, 16)}...`
        : 'Initial incremental (no cursor yet)',
    };
  }

  return { mode: 'none', source, reason: 'No sync needed yet' };
}

/**
 * Trigger an on-demand sync (user-initiated).
 * Always returns a sync schedule regardless of timing.
 */
export function triggerOnDemand(source: string): SyncSchedule {
  const state = getState(source);
  return {
    mode: 'on_demand',
    source,
    cursor: state.cursor || undefined,
    reason: 'User-triggered manual sync',
  };
}

/**
 * Record that a sync completed. Updates cursor and timestamps.
 */
export function recordSyncComplete(
  source: string,
  mode: SyncMode,
  newCursor?: string,
  now?: number,
): void {
  const state = getState(source);
  const currentTime = now ?? Date.now();

  if (newCursor) state.cursor = newCursor;
  state.syncCount++;

  if (mode === 'morning') {
    state.lastMorningSync = currentTime;
    state.lastIncrementalSync = currentTime;
  } else {
    state.lastIncrementalSync = currentTime;
  }
}

/** Get the current cursor for a source. */
export function getCursor(source: string): string {
  return getState(source).cursor;
}

/** Get full state for a source. */
export function getSourceState(source: string): SourceState {
  return { ...getState(source) };
}

/** Set the morning sync hour (0-23). */
export function setMorningSyncHour(hour: number): void {
  morningSyncHour = Math.max(0, Math.min(23, Math.floor(hour)));
}

/** Get the morning sync hour. */
export function getMorningSyncHour(): number {
  return morningSyncHour;
}

/** Reset all sync rhythm state (for testing). */
export function resetRhythmState(): void {
  sourceStates.clear();
  morningSyncHour = 6;
}
