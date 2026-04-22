/**
 * Living window — age-based data lifecycle zones.
 *
 * Zone 1 (0–365 days): Active zone
 *   - Data is synced from connectors
 *   - Indexed in FTS5 + HNSW
 *   - Searchable locally
 *   - Full tiered loading (L0→L1→L2)
 *
 * Zone 2 (>365 days): Archive zone
 *   - Data is NOT synced (stays in source)
 *   - NOT indexed locally
 *   - Searchable only via pass-through to source API
 *   - Results are ephemeral (not cached in vault)
 *
 * The boundary is configurable (default 365 days).
 * Items near the boundary (within 30 days) are flagged for
 * potential archival in the next sweep.
 *
 * Source: ARCHITECTURE.md Task 7.6
 */

const MS_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_BOUNDARY_DAYS = 365;
const NEAR_BOUNDARY_DAYS = 30;

/** Configurable zone boundary in days. */
let boundaryDays = DEFAULT_BOUNDARY_DAYS;

export type Zone = 'active' | 'archive';

export interface ZoneClassification {
  zone: Zone;
  ageDays: number;
  nearBoundary: boolean;
  shouldSync: boolean;
  shouldIndex: boolean;
  searchMode: 'local' | 'pass_through';
}

/**
 * Classify an item into a living window zone based on its age.
 *
 * @param itemTimestampMs — item's creation or source timestamp (ms)
 * @param now — current time (ms), defaults to Date.now()
 */
export function classifyZone(itemTimestampMs: number, now?: number): ZoneClassification {
  const currentTime = now ?? Date.now();
  const ageMs = currentTime - itemTimestampMs;
  const ageDays = Math.max(0, ageMs / MS_DAY);
  const boundaryMs = boundaryDays * MS_DAY;
  const nearBoundaryMs = (boundaryDays - NEAR_BOUNDARY_DAYS) * MS_DAY;

  if (ageMs <= boundaryMs) {
    return {
      zone: 'active',
      ageDays: Math.floor(ageDays),
      nearBoundary: ageMs >= nearBoundaryMs,
      shouldSync: true,
      shouldIndex: true,
      searchMode: 'local',
    };
  }

  return {
    zone: 'archive',
    ageDays: Math.floor(ageDays),
    nearBoundary: false,
    shouldSync: false,
    shouldIndex: false,
    searchMode: 'pass_through',
  };
}

/**
 * Check if an item is in the active zone (should be synced + indexed).
 */
export function isInActiveZone(itemTimestampMs: number, now?: number): boolean {
  return classifyZone(itemTimestampMs, now).zone === 'active';
}

/**
 * Check if an item is near the zone boundary (within 30 days of archival).
 * Useful for flagging items that will soon transition to archive.
 */
export function isNearBoundary(itemTimestampMs: number, now?: number): boolean {
  return classifyZone(itemTimestampMs, now).nearBoundary;
}

/**
 * Filter a list of items by zone, returning only active-zone items.
 *
 * @param items — array of items with a timestamp field
 * @param getTimestamp — function to extract timestamp from an item
 */
export function filterActiveZone<T>(
  items: T[],
  getTimestamp: (item: T) => number,
  now?: number,
): T[] {
  return items.filter((item) => isInActiveZone(getTimestamp(item), now));
}

/** Set the zone boundary in days. */
export function setBoundaryDays(days: number): void {
  boundaryDays = Math.max(1, Math.floor(days));
}

/** Get the current zone boundary in days. */
export function getBoundaryDays(): number {
  return boundaryDays;
}

/** Reset to default boundary (for testing). */
export function resetLivingWindowState(): void {
  boundaryDays = DEFAULT_BOUNDARY_DAYS;
}
