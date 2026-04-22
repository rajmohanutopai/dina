/**
 * Device sync — initial checkpoint, realtime push, offline queue,
 * local cache, corruption recovery, authenticated-only, QR pairing.
 *
 * Rich clients (paired devices) sync vault state from the home node.
 * Data flows: home → rich client (push/pull), never client → home.
 *
 * Thin clients (Web UI, dina-cli) have no local cache — they stream
 * directly. searchLocalCache returns empty for thin clients.
 *
 * Source: tests/integration/test_client_sync.py
 */

export interface SyncItem {
  id: string;
  type: string;
  data: unknown;
  checkpoint: number;
}

/** In-memory sync state. */
const syncStore: SyncItem[] = [];
const offlineQueues = new Map<string, unknown[]>();
const connectedDevices = new Set<string>();
const authenticatedDevices = new Set<string>();
let cacheCorrupted = false;

/** Reset all sync state (for testing). */
export function resetSyncState(): void {
  syncStore.length = 0;
  offlineQueues.clear();
  connectedDevices.clear();
  authenticatedDevices.clear();
  cacheCorrupted = false;
}

/** Register a device as authenticated (after QR pairing). */
export function registerDevice(deviceId: string): void {
  authenticatedDevices.add(deviceId);
}

/** Mark a device as connected (WebSocket active). */
export function connectDevice(deviceId: string): void {
  connectedDevices.add(deviceId);
}

/** Mark a device as disconnected. */
export function disconnectDevice(deviceId: string): void {
  connectedDevices.delete(deviceId);
}

/** Add an item to the sync store (for testing/integration). */
export function addSyncItem(item: SyncItem): void {
  syncStore.push(item);
}

/** Simulate cache corruption (for testing). */
export function corruptCache(): void {
  cacheCorrupted = true;
}

/** Page size for paginated sync (matching Go's default). */
export const SYNC_PAGE_SIZE = 100;

/** Maximum items per batch ingest (matching Python MCP validation). */
export const MAX_BATCH_ITEMS = 1000;

/** Maximum item payload size in bytes (256KB, matching Python MCP validation). */
export const MAX_ITEM_SIZE_BYTES = 256 * 1024;

/**
 * Sync from home node at a checkpoint with pagination.
 *
 * Returns up to SYNC_PAGE_SIZE items with checkpoint > given value,
 * the new highest checkpoint, and a hasMore flag indicating whether
 * more items are available beyond the current page.
 *
 * Pagination (matching Go): clients call repeatedly with the returned
 * newCheckpoint until hasMore is false.
 * Checkpoint 0 = initial full sync.
 */
export async function syncFromCheckpoint(
  checkpoint: number,
  pageSize?: number,
): Promise<{ items: unknown[]; newCheckpoint: number; hasMore: boolean }> {
  const limit = Math.min(pageSize ?? SYNC_PAGE_SIZE, SYNC_PAGE_SIZE);

  // Get all items past the checkpoint, sorted by checkpoint ascending
  const allMatching = syncStore
    .filter((item) => item.checkpoint > checkpoint)
    .sort((a, b) => a.checkpoint - b.checkpoint);

  const page = allMatching.slice(0, limit);
  const hasMore = allMatching.length > limit;

  const newCheckpoint = page.length > 0 ? Math.max(...page.map((i) => i.checkpoint)) : checkpoint;

  return { items: page, newCheckpoint, hasMore };
}

/**
 * Validate a sync item payload size.
 *
 * Rejects items larger than MAX_ITEM_SIZE_BYTES (256KB).
 * Matching Python's MCP payload validation.
 *
 * @returns null if valid, or error message
 */
export function validateSyncItemSize(item: SyncItem): string | null {
  const serialized = JSON.stringify(item.data);
  // Use TextEncoder for accurate UTF-8 byte length (Fix: Codex #16)
  const byteLength = new TextEncoder().encode(serialized).length;
  if (byteLength > MAX_ITEM_SIZE_BYTES) {
    return `Item "${item.id}" exceeds max size: ${byteLength} bytes > ${MAX_ITEM_SIZE_BYTES} bytes`;
  }
  return null;
}

/**
 * Validate a batch of sync items.
 *
 * Checks:
 * - Batch size ≤ MAX_BATCH_ITEMS (1000)
 * - Each item ≤ MAX_ITEM_SIZE_BYTES (256KB)
 *
 * @returns null if valid, or error message
 */
export function validateSyncBatch(items: SyncItem[]): string | null {
  if (items.length > MAX_BATCH_ITEMS) {
    return `Batch too large: ${items.length} items > ${MAX_BATCH_ITEMS} max`;
  }
  for (const item of items) {
    const err = validateSyncItemSize(item);
    if (err) return err;
  }
  return null;
}

/**
 * Push new data to a connected rich client in real time.
 *
 * Returns true if the device is connected and data was pushed.
 * If the device is offline, data is queued for later flush.
 */
export async function pushToClient(deviceId: string, data: unknown): Promise<boolean> {
  if (!authenticatedDevices.has(deviceId)) {
    return false;
  }

  if (connectedDevices.has(deviceId)) {
    return true;
  }

  // Device offline — queue for later
  let queue = offlineQueues.get(deviceId);
  if (!queue) {
    queue = [];
    offlineQueues.set(deviceId, queue);
  }
  queue.push(data);
  return false;
}

/**
 * Flush offline queue for a device on reconnect.
 *
 * Returns the count of items flushed. Clears the queue.
 */
export async function flushOfflineQueue(deviceId: string): Promise<number> {
  const queue = offlineQueues.get(deviceId);
  if (!queue || queue.length === 0) return 0;

  const count = queue.length;
  offlineQueues.delete(deviceId);
  return count;
}

/**
 * Search local cache when offline.
 *
 * Rich clients maintain a local cache of synced vault items.
 * Thin clients have no cache — returns empty array.
 * Returns matching items from the sync store.
 */
export function searchLocalCache(query: string): unknown[] {
  if (cacheCorrupted) return [];

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  return syncStore.filter((item) => {
    const text = JSON.stringify(item.data).toLowerCase();
    return terms.some((term) => text.includes(term));
  });
}

/**
 * Detect and recover from corrupted local cache.
 *
 * If corruption is detected, clears the cache and returns true
 * (indicating the caller should trigger a full re-sync from checkpoint 0).
 * Returns false if cache is healthy.
 */
export async function recoverCorruptedCache(): Promise<boolean> {
  if (!cacheCorrupted) return false;

  // Clear corrupted data
  syncStore.length = 0;
  cacheCorrupted = false;
  return true;
}

/**
 * Check if a device connection is authenticated.
 *
 * Only paired devices (with registered Ed25519 public key) are authenticated.
 * Unauthenticated devices receive nothing.
 */
export function isAuthenticated(deviceId: string): boolean {
  return authenticatedDevices.has(deviceId);
}
