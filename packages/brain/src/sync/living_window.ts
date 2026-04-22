/**
 * Living window — zone-based data lifecycle for sync and indexing.
 *
 * Zone 1 (0–365 days): Active window. Items are synced, indexed (FTS + HNSW),
 *   and fully searchable. All connector syncs target this window.
 *
 * Zone 2 (>365 days): Archive window. Items are NOT synced or indexed.
 *   Pass-through search only (direct connector query when user explicitly
 *   asks for old data). Saves storage and processing bandwidth.
 *
 * The window boundary is relative to now — it slides forward each day.
 * Items that age out of Zone 1 are not deleted (they remain in vault)
 * but their embeddings and HNSW index entries are eventually pruned.
 *
 * Sync strategies per zone:
 *   Zone 1: morning full sync (30-day bootstrap), hourly incremental
 *   Zone 2: on-demand only (user search triggers pass-through query)
 *
 * Source: ARCHITECTURE.md Task 7.6
 */

const MS_PER_DAY = 86_400_000;
const DEFAULT_ZONE1_DAYS = 365;

export type Zone = 1 | 2;

export interface WindowConfig {
  /** Zone 1 boundary in days (default: 365). */
  zone1Days?: number;
  /** Override "now" for testing. */
  nowMs?: number;
}

export interface ZoneClassification {
  zone: Zone;
  ageInDays: number;
  isIndexable: boolean;
  isSyncTarget: boolean;
  isPassThrough: boolean;
}

/**
 * Classify an item's zone based on its timestamp.
 *
 * @param timestampMs — item timestamp in milliseconds
 * @param config — optional window configuration
 */
export function classifyZone(timestampMs: number, config?: WindowConfig): ZoneClassification {
  const now = config?.nowMs ?? Date.now();
  const zone1Days = config?.zone1Days ?? DEFAULT_ZONE1_DAYS;
  const zone1BoundaryMs = now - zone1Days * MS_PER_DAY;

  const ageMs = now - timestampMs;
  const ageInDays = Math.floor(ageMs / MS_PER_DAY);

  if (timestampMs >= zone1BoundaryMs) {
    return {
      zone: 1,
      ageInDays,
      isIndexable: true,
      isSyncTarget: true,
      isPassThrough: false,
    };
  }

  return {
    zone: 2,
    ageInDays,
    isIndexable: false,
    isSyncTarget: false,
    isPassThrough: true,
  };
}

/**
 * Get the Zone 1 boundary timestamp (oldest date that's still Zone 1).
 */
export function getZone1Boundary(config?: WindowConfig): number {
  const now = config?.nowMs ?? Date.now();
  const zone1Days = config?.zone1Days ?? DEFAULT_ZONE1_DAYS;
  return now - zone1Days * MS_PER_DAY;
}

/**
 * Partition a batch of items by zone.
 *
 * @param items — items with timestamp field
 * @param config — optional window configuration
 * @returns { zone1: items in active window, zone2: items in archive }
 */
export function partitionByZone<T extends { timestamp: number }>(
  items: T[],
  config?: WindowConfig,
): { zone1: T[]; zone2: T[] } {
  const zone1: T[] = [];
  const zone2: T[] = [];
  const boundary = getZone1Boundary(config);

  for (const item of items) {
    if (item.timestamp >= boundary) {
      zone1.push(item);
    } else {
      zone2.push(item);
    }
  }

  return { zone1, zone2 };
}

/**
 * Determine the sync strategy for a time range.
 *
 * Returns whether the range falls in Zone 1 (sync + index),
 * Zone 2 (pass-through only), or spans both zones.
 */
export function getSyncStrategy(
  fromMs: number,
  toMs: number,
  config?: WindowConfig,
): { strategy: 'sync_and_index' | 'pass_through' | 'mixed'; zone1Cutoff: number } {
  const boundary = getZone1Boundary(config);

  if (fromMs >= boundary) {
    return { strategy: 'sync_and_index', zone1Cutoff: boundary };
  }

  if (toMs < boundary) {
    return { strategy: 'pass_through', zone1Cutoff: boundary };
  }

  return { strategy: 'mixed', zone1Cutoff: boundary };
}

/**
 * Check if an item should be indexed (FTS + embedding + HNSW).
 *
 * Only Zone 1 items are indexed. Zone 2 items rely on pass-through
 * search to the original data source.
 */
export function shouldIndex(timestampMs: number, config?: WindowConfig): boolean {
  return classifyZone(timestampMs, config).isIndexable;
}

/**
 * Check if a time range needs pass-through search.
 *
 * If the user's query spans Zone 2, we need to query the connector
 * directly (e.g., Gmail API search) for old items.
 */
export function needsPassThrough(queryFromMs: number, config?: WindowConfig): boolean {
  const boundary = getZone1Boundary(config);
  return queryFromMs < boundary;
}

/**
 * Get items that have aged out of Zone 1 (candidates for HNSW pruning).
 *
 * @param items — items with timestamp field
 * @param config — optional window configuration
 * @returns items that are now in Zone 2
 */
export function getAgedOutItems<T extends { timestamp: number }>(
  items: T[],
  config?: WindowConfig,
): T[] {
  const boundary = getZone1Boundary(config);
  return items.filter((item) => item.timestamp < boundary);
}
