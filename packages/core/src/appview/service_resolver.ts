/**
 * AppView service resolver — looks up whether a remote DID is a
 * discoverable provider service offering a given capability.
 *
 * Behaviour (matches main dina `core/internal/adapter/appview/service_resolver.go`):
 *   - Calls `{appViewURL}/xrpc/com.dina.service.isDiscoverable?did=<did>`
 *     (wire path renamed from `isPublic` in WM-CORE-12).
 *   - Caches the answer for `cacheTtlMs` (default 5 min) keyed by DID
 *   - Retries on transient failures (5xx / 408 / 429 / network) up to
 *     `maxRetries` times with exponential backoff (reuses the shared
 *     `transport/http_retry.backoff` helper). 4xx other than 408/429 are
 *     terminal — retrying a 404 or 401 wastes budget.
 *   - Fails closed: any network error, timeout, non-200, or parse failure
 *     returns `{ isDiscoverable: false }`. The contact gate never opens on doubt.
 *
 * This resolver is read by the Transport Service on egress for `service.query`
 * messages: when `isDiscoverableService(recipient, capability)` returns `true`, the
 * contact-gate check is bypassed.
 */

import { backoff as defaultBackoff } from '../transport/http_retry';

/** Configuration for `AppViewServiceResolver`. */
export interface AppViewServiceResolverOptions {
  /**
   * Base URL of the AppView (no trailing slash required — it is stripped).
   * Example: `https://appview.dina.dev`.
   */
  appViewURL: string;
  /** Cache TTL in milliseconds. Defaults to 5 minutes (matches main dina). */
  cacheTtlMs?: number;
  /** Per-request timeout in milliseconds. Defaults to 5 seconds. */
  timeoutMs?: number;
  /** Injectable `fetch` for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  nowFn?: () => number;
  /** Maximum cache entries before LRU eviction. Defaults to 1000. */
  maxCacheEntries?: number;
  /**
   * Maximum retries for transient failures (5xx / 408 / 429 / network).
   * Default 2 (total of up to 3 attempts). Set to 0 to disable retries.
   *
   * Non-retryable: 4xx other than 408/429 (bad request / auth / not found).
   */
  maxRetries?: number;
  /**
   * Injectable sleep used between retries. Default: `setTimeout` with
   * `BASE_RETRY_DELAY_MS * 2^attempt` (1s, 2s, 4s, …). Tests pass a no-op.
   */
  sleepFn?: (attemptZeroIndexed: number) => Promise<void>;
}

/** AppView response shape for `com.dina.service.isDiscoverable`. */
export interface IsDiscoverableResult {
  isDiscoverable: boolean;
  capabilities: string[];
}

interface CacheEntry extends IsDiscoverableResult {
  fetchedAtMs: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CACHE_ENTRIES = 1_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * HTTP statuses that are safe to retry. 5xx covers transient server faults;
 * 408 / 429 are explicit retry signals. Everything else (4xx) is terminal
 * from a correctness perspective — retrying a 404 won't magically find the
 * record, and retrying a 401 just wastes request budget.
 */
const RETRYABLE_STATUSES = new Set([408, 429]);
function isRetryableHttpStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_STATUSES.has(status);
}

/**
 * Bounded LRU cache. Insertion order in `Map` is iteration order, so we
 * re-insert on read to move an entry to the tail; eviction drops the head.
 */
class LruCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly maxSize: number) {
    if (maxSize <= 0) {
      throw new Error(`LruCache: maxSize must be > 0 (got ${maxSize})`);
    }
  }
  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      // Move-to-tail: refresh LRU ordering.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }
  set(key: string, value: CacheEntry): void {
    // If already present, re-insertion after delete moves it to the tail.
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, value);
  }
  delete(key: string): void {
    this.entries.delete(key);
  }
  size(): number {
    return this.entries.size;
  }
}

/**
 * Resolver instance. Safe to share across callers — the internal cache is
 * the only mutable state.
 */
export class AppViewServiceResolver {
  private readonly appViewURL: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly nowFn: () => number;
  private readonly cache: LruCache;
  private readonly maxRetries: number;
  private readonly sleepFn: (attempt: number) => Promise<void>;

  constructor(options: AppViewServiceResolverOptions) {
    if (!options.appViewURL) {
      throw new Error('AppViewServiceResolver: appViewURL is required');
    }
    this.appViewURL = options.appViewURL.replace(/\/$/, '');
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.nowFn = options.nowFn ?? Date.now;
    this.cache = new LruCache(options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES);
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleepFn = options.sleepFn ?? defaultBackoff;
    if (this.cacheTtlMs <= 0) {
      throw new Error(`AppViewServiceResolver: cacheTtlMs must be > 0 (got ${this.cacheTtlMs})`);
    }
    if (this.timeoutMs <= 0) {
      throw new Error(`AppViewServiceResolver: timeoutMs must be > 0 (got ${this.timeoutMs})`);
    }
    if (this.maxRetries < 0 || !Number.isInteger(this.maxRetries)) {
      throw new Error(
        `AppViewServiceResolver: maxRetries must be a non-negative integer (got ${this.maxRetries})`,
      );
    }
  }

  /**
   * Return `true` iff the DID has a published public-service profile AND
   * advertises the given capability. Fails closed on any error — returns
   * `false` (not throwing) so callers can safely treat this as a boolean gate.
   */
  async isDiscoverableService(did: string, capability: string): Promise<boolean> {
    if (capability === '') return false;
    const result = await this.lookup(did);
    if (result === null) return false;
    return result.isDiscoverable && result.capabilities.includes(capability);
  }

  /**
   * Fetch the raw `IsDiscoverable` record (capability list included). Exposes the
   * cache for callers that need the full list, e.g. diagnostics. Returns
   * `null` on failure — fail-closed for every call path in this resolver.
   */
  async lookup(did: string): Promise<IsDiscoverableResult | null> {
    if (did === '') return null;

    const cached = this.getCached(did);
    if (cached !== undefined) {
      return { isDiscoverable: cached.isDiscoverable, capabilities: cached.capabilities };
    }
    const fetched = await this.fetch(did);
    if (fetched === null) return null; // do not cache failures
    this.putCached(did, fetched);
    return fetched;
  }

  /** Invalidate a DID's cache entry. Used after config-change events. */
  invalidate(did: string): void {
    this.cache.delete(did);
  }

  /** Number of live (non-expired) cache entries. Useful for tests / metrics. */
  cacheSize(): number {
    return this.cache.size();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private getCached(did: string): CacheEntry | undefined {
    const entry = this.cache.get(did);
    if (entry === undefined) return undefined;
    if (this.nowFn() - entry.fetchedAtMs > this.cacheTtlMs) {
      this.cache.delete(did);
      return undefined;
    }
    return entry;
  }

  private putCached(did: string, result: IsDiscoverableResult): void {
    this.cache.set(did, {
      isDiscoverable: result.isDiscoverable,
      capabilities: [...result.capabilities],
      fetchedAtMs: this.nowFn(),
    });
  }

  private async fetch(did: string): Promise<IsDiscoverableResult | null> {
    const url = `${this.appViewURL}/xrpc/com.dina.service.isDiscoverable?did=${encodeURIComponent(did)}`;

    // `attempt` is 0-indexed. We run at most `maxRetries + 1` attempts total.
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.fetchOnce(url);

      if (outcome.kind === 'ok') {
        return outcome.result;
      }
      if (outcome.kind === 'terminal') {
        return null; // non-retryable — fail closed, do not cache
      }

      // outcome.kind === 'retryable'
      if (attempt >= this.maxRetries) {
        return null;
      }
      await this.sleepFn(attempt);
    }
  }

  /**
   * One request attempt. Returns:
   *   - `ok`        — 200 with a parseable body.
   *   - `terminal`  — 4xx (not 408/429) or malformed body. No retry.
   *   - `retryable` — 5xx, 408, 429, network error, timeout. Caller retries.
   */
  private async fetchOnce(
    url: string,
  ): Promise<
    { kind: 'ok'; result: IsDiscoverableResult } | { kind: 'terminal' } | { kind: 'retryable' }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } catch {
      // Network error, timeout, abort — treat as retryable.
      return { kind: 'retryable' };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 200) {
      try {
        const raw = (await response.json()) as unknown;
        if (!raw || typeof raw !== 'object') return { kind: 'terminal' };
        const r = raw as Record<string, unknown>;
        const isDiscoverable = typeof r.isDiscoverable === 'boolean' ? r.isDiscoverable : false;
        const capabilities = Array.isArray(r.capabilities)
          ? r.capabilities.filter((c): c is string => typeof c === 'string')
          : [];
        return { kind: 'ok', result: { isDiscoverable, capabilities } };
      } catch {
        // Malformed body — terminal; retrying won't fix a broken response.
        return { kind: 'terminal' };
      }
    }

    return isRetryableHttpStatus(response.status) ? { kind: 'retryable' } : { kind: 'terminal' };
  }
}
