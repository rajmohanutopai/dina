/**
 * Key-value store — simple persistent key-value service.
 *
 * Used for lightweight config, state flags, and metadata that doesn't
 * belong in a vault or persona. Namespace support allows per-persona
 * or per-feature isolation.
 *
 * In production, backed by the identity DB's `kv_store` table.
 * In-memory implementation for testing and early integration.
 *
 * **Phase 2.3 pilot (task 2.3).** Wrapper functions return `Promise<T>`
 * to match the `KVRepository` port's async contract. The in-memory
 * fallback path wraps its Map lookups in `Promise.resolve(…)` so the
 * API stays uniform regardless of backend. Call-sites must `await`.
 *
 * Source: ARCHITECTURE.md Task 2.49
 */

import type { KVRepository } from './repository';

export interface KVEntry {
  key: string;
  value: string;
  updatedAt: number;
}

/** SQL-backed repository (null = in-memory mode for tests). */
let repo: KVRepository | null = null;

/** Set the SQL repository for persistence. */
export function setKVRepository(r: KVRepository | null): void {
  repo = r;
}

/** In-memory KV store: namespace:key → value. */
const store = new Map<string, KVEntry>();

/** Build the internal composite key. */
function compositeKey(key: string, namespace?: string): string {
  return namespace ? `${namespace}:${key}` : key;
}

/**
 * Get a value by key. Returns null if not found.
 */
export async function kvGet(key: string, namespace?: string): Promise<string | null> {
  const ck = compositeKey(key, namespace);
  if (repo) {
    const entry = await repo.get(ck);
    return entry?.value ?? null;
  }
  const entry = store.get(ck);
  return entry?.value ?? null;
}

/**
 * Set a value. Creates or overwrites.
 */
export async function kvSet(key: string, value: string, namespace?: string): Promise<void> {
  const ck = compositeKey(key, namespace);
  if (repo) {
    await repo.set(ck, value);
    return;
  }
  store.set(ck, { key: ck, value, updatedAt: Date.now() });
}

/**
 * Delete a key. Returns true if it existed.
 */
export async function kvDelete(key: string, namespace?: string): Promise<boolean> {
  const ck = compositeKey(key, namespace);
  if (repo) return repo.delete(ck);
  return store.delete(ck);
}

/**
 * Check if a key exists.
 */
export async function kvHas(key: string, namespace?: string): Promise<boolean> {
  const ck = compositeKey(key, namespace);
  if (repo) return repo.has(ck);
  return store.has(ck);
}

/**
 * List all keys in a namespace (or all keys if no namespace).
 * Returns entries sorted by key.
 */
export async function kvList(namespace?: string): Promise<KVEntry[]> {
  const prefix = namespace ? `${namespace}:` : undefined;
  if (repo) return repo.list(prefix);

  const entries: KVEntry[] = [];
  for (const entry of store.values()) {
    if (!namespace || entry.key.startsWith(prefix!)) {
      entries.push(entry);
    }
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Get the count of entries in a namespace (or total).
 */
export async function kvCount(namespace?: string): Promise<number> {
  const prefix = namespace ? `${namespace}:` : undefined;
  if (repo) return repo.count(prefix);

  if (!namespace) return store.size;
  let count = 0;
  for (const entry of store.values()) {
    if (entry.key.startsWith(prefix!)) count++;
  }
  return count;
}

/** Reset all KV state (for testing). */
export function resetKVStore(): void {
  store.clear();
  repo = null;
}
