/**
 * Task 4.79 support — session registry for PII rehydration.
 *
 * The session-based rehydrate flow keeps raw PII values server-side
 * after a scrub, so callers can rehydrate an LLM-processed response
 * without the wire ever carrying the original values back and forth.
 * Flow:
 *
 *   1. Caller scrubs text → `{scrubbed, entities}` (entities include
 *      raw values).
 *   2. Caller stores entities in this registry → receives `session_id`.
 *   3. Caller sends `scrubbed` to the LLM / downstream.
 *   4. Caller POSTs `{session_id, text}` to `/v1/pii/rehydrate` → gets
 *      rehydrated text back; entities never re-enter the wire.
 *
 * **TTL**: 10 minutes default — long enough for an LLM round-trip,
 * short enough that abandoned sessions don't leak PII-in-memory
 * indefinitely. Configurable per-registry + per-session.
 *
 * **Storage**: in-memory `Map`. Same pattern as
 * `PairingCodeRegistry` / `SessionGrantRegistry` / `ApprovalRegistry`.
 * SQLCipher-backed variant can swap in later; the persistence
 * tradeoff is specifically that we don't want raw PII on disk
 * unless it's encrypted, so keeping this ephemeral-by-design is
 * arguably correct.
 *
 * **Session id**: defaults to `session-<counter>` via injected `idFn`.
 * Production wiring passes a UUIDv4 generator.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4k task 4.79.
 */

/** One entity as carried into the registry. */
export interface RehydrationEntity {
  /** `[EMAIL_1]` style token — must match what was substituted into `scrubbed`. */
  token: string;
  /** Original PII value to restore. */
  value: string;
}

interface SessionRecord {
  readonly id: string;
  readonly entities: ReadonlyArray<RehydrationEntity>;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface RehydrationSessionOptions {
  /** Default TTL in ms. Default 10 minutes. */
  defaultTtlMs?: number;
  /** Injectable clock. Default `Date.now`. */
  nowMsFn?: () => number;
  /** Id generator. Default `session-<counter>`. */
  idFn?: () => string;
  /** Diagnostic hook. Fires on state transitions. */
  onEvent?: (event: RehydrationSessionEvent) => void;
}

export type RehydrationSessionEvent =
  | { kind: 'created'; id: string; entityCount: number; expiresAtMs: number }
  | { kind: 'consumed'; id: string }
  | { kind: 'destroyed'; id: string }
  | { kind: 'expired'; id: string };

export const DEFAULT_REHYDRATION_TTL_MS = 10 * 60 * 1000;

export class RehydrationSessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly defaultTtlMs: number;
  private readonly nowMsFn: () => number;
  private readonly idFn: () => string;
  private readonly onEvent?: (event: RehydrationSessionEvent) => void;
  private idCounter = 0;

  constructor(opts: RehydrationSessionOptions = {}) {
    const ttl = opts.defaultTtlMs ?? DEFAULT_REHYDRATION_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(
        `RehydrationSessionRegistry: defaultTtlMs must be > 0 (got ${ttl})`,
      );
    }
    this.defaultTtlMs = ttl;
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.idFn =
      opts.idFn ??
      (() => {
        this.idCounter += 1;
        return `session-${this.idCounter}`;
      });
    this.onEvent = opts.onEvent;
  }

  /**
   * Store entities for later rehydration. Returns the fresh session
   * id + expiry. Caller is responsible for avoiding double-insertion
   * of the same entity map — this registry does not de-duplicate.
   */
  create(
    entities: ReadonlyArray<RehydrationEntity>,
    opts: { ttlMs?: number } = {},
  ): { sessionId: string; expiresAtMs: number } {
    if (!Array.isArray(entities)) {
      throw new Error('RehydrationSessionRegistry.create: entities must be an array');
    }
    const ttl = opts.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(
        `RehydrationSessionRegistry.create: ttlMs must be > 0 (got ${ttl})`,
      );
    }
    for (const e of entities) {
      if (
        typeof e.token !== 'string' ||
        typeof e.value !== 'string' ||
        e.token.length === 0
      ) {
        throw new Error(
          'RehydrationSessionRegistry.create: every entity must have {token, value} strings',
        );
      }
    }

    const id = this.idFn();
    const now = this.nowMsFn();
    const expiresAtMs = now + ttl;
    // Defensive copy so caller-side mutation doesn't corrupt the session.
    const frozenEntities = entities.map((e) => ({ token: e.token, value: e.value }));
    const record: SessionRecord = {
      id,
      entities: frozenEntities,
      createdAtMs: now,
      expiresAtMs,
    };
    this.sessions.set(id, record);
    this.onEvent?.({
      kind: 'created',
      id,
      entityCount: frozenEntities.length,
      expiresAtMs,
    });
    return { sessionId: id, expiresAtMs };
  }

  /**
   * Fetch entities by session id. Returns `undefined` when the id is
   * unknown OR past expiry. Expired entries are auto-removed so
   * `get(same-id)` subsequently returns undefined without the caller
   * having to sweep first.
   */
  get(sessionId: string): ReadonlyArray<RehydrationEntity> | undefined {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return undefined;
    if (record.expiresAtMs <= this.nowMsFn()) {
      this.sessions.delete(sessionId);
      this.onEvent?.({ kind: 'expired', id: sessionId });
      return undefined;
    }
    return record.entities;
  }

  /**
   * Destroy a session explicitly. Returns true when a record was
   * removed; false on unknown id.
   */
  destroy(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);
    if (existed) this.onEvent?.({ kind: 'destroyed', id: sessionId });
    return existed;
  }

  /**
   * Consume a session — fetch entities AND destroy. Intended for
   * single-use rehydrate flows where the caller wants to ensure the
   * PII map is gone immediately after use. Returns undefined when
   * the id is unknown or expired (same as `get`).
   */
  consume(sessionId: string): ReadonlyArray<RehydrationEntity> | undefined {
    const entities = this.get(sessionId);
    if (entities === undefined) return undefined;
    this.sessions.delete(sessionId);
    this.onEvent?.({ kind: 'consumed', id: sessionId });
    return entities;
  }

  /** Remove every expired session. Returns count swept. */
  sweepExpired(): number {
    const now = this.nowMsFn();
    let swept = 0;
    for (const [id, record] of this.sessions) {
      if (record.expiresAtMs <= now) {
        this.sessions.delete(id);
        this.onEvent?.({ kind: 'expired', id });
        swept++;
      }
    }
    return swept;
  }

  /** Number of sessions in memory (live + expired-but-not-yet-swept). */
  size(): number {
    return this.sessions.size;
  }

  /** True when a live (non-expired) session exists for this id. */
  isLive(sessionId: string): boolean {
    return this.get(sessionId) !== undefined;
  }
}
