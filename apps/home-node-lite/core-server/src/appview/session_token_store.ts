/**
 * Task 6.3 — PDS session tokens persisted in keystore.
 *
 * A Dina Core has a durable AT Protocol identity (did:plc + PDS
 * account). To talk to the PDS, it needs an `accessJwt` +
 * `refreshJwt` pair from `com.atproto.server.createSession` /
 * `refreshSession`. These tokens:
 *
 *   - MUST survive process restart — re-running `createSession` on
 *     every boot would require the user's password and spam the PDS.
 *   - MUST NOT live in plain files — the refreshJwt grants the
 *     bearer full account access until the user rotates it.
 *   - MUST refresh BEFORE expiry — serving an expired accessJwt to
 *     a PDS call produces a 401 that the caller has to handle
 *     separately, so we pre-empt.
 *
 * **This module is the persistence + refresh primitive.** It stores
 * tokens in an injected `KeystoreAdapter` (production wires to
 * Core's `identity.sqlite` kv table, which SQLCipher-encrypts; tests
 * pass `InMemoryKeystoreAdapter`) and exposes:
 *
 *   - `save(record)` — write the token set.
 *   - `load()` — read back the current record or null.
 *   - `clear()` — drop the record (logout / rotation).
 *   - `getActive(refreshFn)` — fetch the active record, triggering
 *     a refresh via `refreshFn` when the access token is within
 *     `refreshLeeway` of expiry.
 *
 * **Refresh coalescing**: concurrent `getActive` calls that see the
 * token as stale share ONE refresh via an in-flight promise. Avoids
 * hammering the PDS with duplicate refresh requests when multiple
 * handlers race to refresh simultaneously.
 *
 * **Error policy**: a failed refresh surfaces as `{ok: false,
 * reason: 'refresh_failed'}` + leaves the (stale) record in place.
 * The caller (SessionManager) can decide to force re-login or wait.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6a task 6.3.
 */

export interface SessionRecord {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  /** UTC ms when accessJwt expires. */
  accessExpiresAtMs: number;
  /** UTC ms when refreshJwt expires. Null when unknown. */
  refreshExpiresAtMs: number | null;
  /** UTC ms when the record was last persisted. */
  updatedAtMs: number;
}

export interface KeystoreAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const SESSION_TOKEN_KEY = 'pds:session';
/** Refresh when the access token is within this window of expiry. Default 5 min. */
export const DEFAULT_REFRESH_LEEWAY_MS = 5 * 60 * 1000;

export type RefreshFn = (
  currentRefreshJwt: string,
) => Promise<
  | { ok: true; record: Omit<SessionRecord, 'updatedAtMs'> }
  | { ok: false; error: string }
>;

export interface SessionTokenStoreOptions {
  keystore: KeystoreAdapter;
  /** Key used to store the record. Defaults to `'pds:session'`. */
  key?: string;
  /** Pre-expire refresh window. Defaults to 5 minutes. */
  refreshLeewayMs?: number;
  /** Injectable clock. */
  nowMsFn?: () => number;
  /** Diagnostic hook. */
  onEvent?: (event: SessionTokenStoreEvent) => void;
}

export type SessionTokenStoreEvent =
  | { kind: 'saved'; did: string }
  | { kind: 'loaded'; did: string; accessExpiresInMs: number }
  | { kind: 'cleared' }
  | { kind: 'parse_failed'; error: string }
  | { kind: 'refresh_started'; did: string }
  | { kind: 'refresh_succeeded'; did: string; newAccessExpiresAtMs: number }
  | { kind: 'refresh_failed'; did: string; error: string }
  | { kind: 'refresh_coalesced'; did: string };

export type GetActiveOutcome =
  | { ok: true; record: SessionRecord; refreshed: boolean }
  | { ok: false; reason: 'no_session' }
  | { ok: false; reason: 'refresh_failed'; error: string; staleRecord: SessionRecord };

/**
 * Token store — combines persistence (via KeystoreAdapter) with
 * refresh coalescing. Safe to share across concurrent callers.
 */
export class SessionTokenStore {
  private readonly keystore: KeystoreAdapter;
  private readonly key: string;
  private readonly refreshLeewayMs: number;
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: SessionTokenStoreEvent) => void;
  /** Coalesces concurrent refreshes for the same record. */
  private inFlightRefresh: Promise<GetActiveOutcome> | null = null;

  constructor(opts: SessionTokenStoreOptions) {
    if (!opts?.keystore) {
      throw new TypeError('SessionTokenStore: keystore is required');
    }
    this.keystore = opts.keystore;
    this.key = opts.key ?? SESSION_TOKEN_KEY;
    this.refreshLeewayMs = opts.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  /** Persist `record` to the keystore. Sets `updatedAtMs` to `now`. */
  async save(record: Omit<SessionRecord, 'updatedAtMs'>): Promise<void> {
    validateRecord(record);
    const stamped: SessionRecord = {
      ...record,
      updatedAtMs: this.nowMsFn(),
    };
    await this.keystore.set(this.key, JSON.stringify(stamped));
    this.onEvent?.({ kind: 'saved', did: stamped.did });
  }

  /** Read the stored record. Returns null when absent or malformed. */
  async load(): Promise<SessionRecord | null> {
    const raw = await this.keystore.get(this.key);
    if (raw === null || raw === undefined) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!isSessionRecord(parsed)) {
        this.onEvent?.({ kind: 'parse_failed', error: 'shape mismatch' });
        return null;
      }
      this.onEvent?.({
        kind: 'loaded',
        did: parsed.did,
        accessExpiresInMs: parsed.accessExpiresAtMs - this.nowMsFn(),
      });
      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ kind: 'parse_failed', error: msg });
      return null;
    }
  }

  /** Drop the record from the keystore. Idempotent. */
  async clear(): Promise<void> {
    await this.keystore.delete(this.key);
    this.onEvent?.({ kind: 'cleared' });
  }

  /** True when a session record is persisted (without loading it). */
  async has(): Promise<boolean> {
    const raw = await this.keystore.get(this.key);
    return raw !== null && raw !== undefined;
  }

  /**
   * Fetch the active session record. If the access token is within
   * `refreshLeeway` of expiry, calls `refreshFn` to get a new
   * record + persists it. Concurrent `getActive` calls coalesce to
   * a single refresh.
   *
   * **Outcome kinds**:
   *   - `{ok: true, record, refreshed: false}` — token still fresh.
   *   - `{ok: true, record, refreshed: true}` — refresh succeeded;
   *     `record` is the new one.
   *   - `{ok: false, reason: 'no_session'}` — no record persisted.
   *   - `{ok: false, reason: 'refresh_failed', staleRecord}` —
   *     refresh call failed; the stale record remains persisted.
   */
  async getActive(refreshFn: RefreshFn): Promise<GetActiveOutcome> {
    if (typeof refreshFn !== 'function') {
      throw new TypeError('getActive: refreshFn is required');
    }
    const current = await this.load();
    if (current === null) {
      return { ok: false, reason: 'no_session' };
    }
    const now = this.nowMsFn();
    const timeToExpiry = current.accessExpiresAtMs - now;
    if (timeToExpiry > this.refreshLeewayMs) {
      // Fresh enough — return as-is.
      return { ok: true, record: current, refreshed: false };
    }

    // Stale — refresh. Coalesce concurrent requests.
    if (this.inFlightRefresh !== null) {
      this.onEvent?.({ kind: 'refresh_coalesced', did: current.did });
      return this.inFlightRefresh;
    }
    this.onEvent?.({ kind: 'refresh_started', did: current.did });
    const refreshPromise = this.doRefresh(current, refreshFn);
    this.inFlightRefresh = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      this.inFlightRefresh = null;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async doRefresh(
    current: SessionRecord,
    refreshFn: RefreshFn,
  ): Promise<GetActiveOutcome> {
    let result: Awaited<ReturnType<RefreshFn>>;
    try {
      result = await refreshFn(current.refreshJwt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ kind: 'refresh_failed', did: current.did, error: msg });
      return {
        ok: false,
        reason: 'refresh_failed',
        error: msg,
        staleRecord: current,
      };
    }
    if (!result.ok) {
      this.onEvent?.({
        kind: 'refresh_failed',
        did: current.did,
        error: result.error,
      });
      return {
        ok: false,
        reason: 'refresh_failed',
        error: result.error,
        staleRecord: current,
      };
    }
    validateRecord(result.record);
    const stamped: SessionRecord = {
      ...result.record,
      updatedAtMs: this.nowMsFn(),
    };
    await this.keystore.set(this.key, JSON.stringify(stamped));
    this.onEvent?.({
      kind: 'refresh_succeeded',
      did: stamped.did,
      newAccessExpiresAtMs: stamped.accessExpiresAtMs,
    });
    return { ok: true, record: stamped, refreshed: true };
  }
}

/**
 * Reference keystore for tests + local dev. Production wires the
 * Core `identity.sqlite` kv-adapter.
 */
export class InMemoryKeystoreAdapter implements KeystoreAdapter {
  private readonly store: Map<string, string> = new Map();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Test-only: direct size inspection. */
  size(): number {
    return this.store.size;
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function validateRecord(record: Omit<SessionRecord, 'updatedAtMs'>): void {
  if (!record || typeof record !== 'object') {
    throw new TypeError('SessionRecord must be an object');
  }
  if (typeof record.did !== 'string' || record.did === '') {
    throw new TypeError('SessionRecord.did required');
  }
  if (typeof record.handle !== 'string' || record.handle === '') {
    throw new TypeError('SessionRecord.handle required');
  }
  if (typeof record.accessJwt !== 'string' || record.accessJwt === '') {
    throw new TypeError('SessionRecord.accessJwt required');
  }
  if (typeof record.refreshJwt !== 'string' || record.refreshJwt === '') {
    throw new TypeError('SessionRecord.refreshJwt required');
  }
  if (
    typeof record.accessExpiresAtMs !== 'number' ||
    !Number.isInteger(record.accessExpiresAtMs) ||
    record.accessExpiresAtMs <= 0
  ) {
    throw new TypeError('SessionRecord.accessExpiresAtMs required (positive integer)');
  }
  if (
    record.refreshExpiresAtMs !== null &&
    (typeof record.refreshExpiresAtMs !== 'number' ||
      !Number.isInteger(record.refreshExpiresAtMs) ||
      record.refreshExpiresAtMs <= 0)
  ) {
    throw new TypeError('SessionRecord.refreshExpiresAtMs must be null or a positive integer');
  }
}

function isSessionRecord(v: unknown): v is SessionRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.did === 'string' &&
    typeof r.handle === 'string' &&
    typeof r.accessJwt === 'string' &&
    typeof r.refreshJwt === 'string' &&
    typeof r.accessExpiresAtMs === 'number' &&
    Number.isInteger(r.accessExpiresAtMs) &&
    (r.refreshExpiresAtMs === null ||
      (typeof r.refreshExpiresAtMs === 'number' && Number.isInteger(r.refreshExpiresAtMs))) &&
    typeof r.updatedAtMs === 'number' &&
    Number.isInteger(r.updatedAtMs)
  );
}
