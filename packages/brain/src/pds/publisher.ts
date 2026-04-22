/**
 * AT Protocol PDS publisher — minimal surface for service-profile records.
 *
 * Publishes `com.dina.service.profile` (and in future other `com.dina.*`)
 * records to the community PDS using standard AT Protocol XRPC endpoints:
 *
 *   POST /xrpc/com.atproto.server.createSession   — JWT auth
 *   POST /xrpc/com.atproto.repo.putRecord         — upsert
 *   POST /xrpc/com.atproto.repo.deleteRecord      — idempotent delete
 *
 * Session management:
 *   - Lazy: first write triggers `createSession`.
 *   - Cached: the access JWT + DID are held in memory for `sessionTtlMs`
 *     (default 1 hour — actual PDS sessions last ~2 hours, we refresh early
 *     to avoid the mid-request expiry race).
 *   - Refresh-on-expiry: after `sessionTtlMs` the next write re-authenticates.
 *
 * Error surface: every terminal non-success throws `PDSPublisherError` with
 * the upstream status. Callers that want idempotent delete semantics can
 * catch `err.status === 400` with message containing `RecordNotFound`, or
 * use the dedicated `deleteRecordIdempotent` helper.
 *
 * Source: brain/src/adapter/pds_publisher.py
 *
 * Out of scope (will be added by later tasks): publish_vouch, publish_review,
 * publish_flag — those are Trust Network features, not Bus Driver.
 */

/** Result of a successful `putRecord`. */
export interface PutRecordResult {
  /** Full AT URI of the record, e.g. `at://did:plc:.../col/rkey`. */
  uri: string;
  /** CID of the record body. */
  cid: string;
}

/** Configuration for `PDSPublisher`. */
export interface PDSPublisherOptions {
  /** Base URL of the PDS (trailing slash stripped). */
  pdsUrl: string;
  /** PDS account handle, e.g. `busdriver.dinakernel.com`. */
  handle: string;
  /** PDS account app password. Never logged. */
  password: string;
  /** Cached session TTL in ms. Default 1 hour. */
  sessionTtlMs?: number;
  /** Per-request timeout in ms. Default 15 s (matches Python `httpx(timeout=15)`). */
  timeoutMs?: number;
  /** Injectable `fetch`. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Injectable clock in ms. Defaults to `Date.now`. */
  nowFn?: () => number;
}

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1_000; // 1 hour
const DEFAULT_TIMEOUT_MS = 15_000;

/** Structured error for every terminal PDS failure. */
export class PDSPublisherError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly xrpcError?: string,
  ) {
    super(message);
    this.name = 'PDSPublisherError';
  }
}

interface Session {
  accessJwt: string;
  did: string;
  /** Absolute expiry in ms-since-epoch. */
  expiresAtMs: number;
}

/**
 * AT Protocol publisher. Maintains one cached session. The caller supplies
 * credentials at construction; credentials are never exposed via any method.
 */
export class PDSPublisher {
  private readonly pdsUrl: string;
  private readonly handle: string;
  private readonly password: string;
  private readonly sessionTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly nowFn: () => number;
  private session: Session | null = null;
  /** In-flight session refresh; collapses concurrent requests to one login. */
  private sessionInFlight: Promise<Session> | null = null;

  constructor(options: PDSPublisherOptions) {
    if (!options.pdsUrl) throw new Error('PDSPublisher: pdsUrl is required');
    if (!options.handle) throw new Error('PDSPublisher: handle is required');
    if (!options.password) throw new Error('PDSPublisher: password is required');

    this.pdsUrl = options.pdsUrl.replace(/\/$/, '');
    this.handle = options.handle;
    this.password = options.password;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.nowFn = options.nowFn ?? Date.now;

    if (this.sessionTtlMs <= 0) {
      throw new Error(`PDSPublisher: sessionTtlMs must be > 0 (got ${this.sessionTtlMs})`);
    }
    if (this.timeoutMs <= 0) {
      throw new Error(`PDSPublisher: timeoutMs must be > 0 (got ${this.timeoutMs})`);
    }
  }

  /**
   * The DID of the authenticated PDS account. `null` until the first
   * successful write (session is established lazily).
   */
  get did(): string | null {
    return this.session?.did ?? null;
  }

  /**
   * Establish a PDS session (if needed) and return the authenticated DID.
   * Use this when a caller needs the DID **before** a record-modifying
   * operation — e.g. to verify that the session identity matches an expected
   * home-node DID before writing. Throws `PDSPublisherError` on auth failure.
   */
  async authenticate(): Promise<string> {
    const session = await this.ensureSession();
    return session.did;
  }

  /**
   * Upsert a record at a stable `rkey`. Matching AT Protocol semantics:
   * subsequent calls with the same `(collection, rkey)` REPLACE the record
   * in place.
   */
  async putRecord(
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
  ): Promise<PutRecordResult> {
    validateCollectionAndRkey(collection, rkey);
    const session = await this.ensureSession();
    const body = await this.post(
      '/xrpc/com.atproto.repo.putRecord',
      {
        repo: session.did,
        collection,
        rkey,
        record,
      },
      session.accessJwt,
    );
    if (!body || typeof body !== 'object') {
      throw new PDSPublisherError('putRecord: malformed response', null);
    }
    const r = body as Record<string, unknown>;
    if (typeof r.uri !== 'string' || typeof r.cid !== 'string') {
      throw new PDSPublisherError('putRecord: response missing uri/cid', null);
    }
    return { uri: r.uri, cid: r.cid };
  }

  /**
   * Delete a record. Throws on any failure — use `deleteRecordIdempotent` if
   * you need "already-gone" to succeed.
   */
  async deleteRecord(collection: string, rkey: string): Promise<void> {
    validateCollectionAndRkey(collection, rkey);
    const session = await this.ensureSession();
    await this.post(
      '/xrpc/com.atproto.repo.deleteRecord',
      { repo: session.did, collection, rkey },
      session.accessJwt,
    );
  }

  /**
   * Delete a record, treating "not found" as success. Use this when callers
   * want the op to be safely retryable — publishing a service profile,
   * flipping `isDiscoverable → false`, etc.
   */
  async deleteRecordIdempotent(collection: string, rkey: string): Promise<void> {
    try {
      await this.deleteRecord(collection, rkey);
    } catch (err) {
      if (err instanceof PDSPublisherError && isRecordGone(err)) {
        return;
      }
      throw err;
    }
  }

  /**
   * Force a session refresh on next call. Useful after a 401 bubbles up or
   * when rotating credentials in tests.
   */
  invalidateSession(): void {
    this.session = null;
    this.sessionInFlight = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Return a fresh-enough session, creating or refreshing as needed.
   * Concurrent callers share a single in-flight login.
   */
  private async ensureSession(): Promise<Session> {
    const existing = this.session;
    if (existing !== null && this.nowFn() < existing.expiresAtMs) {
      return existing;
    }
    if (this.sessionInFlight !== null) {
      return this.sessionInFlight;
    }
    this.sessionInFlight = this.createSession().finally(() => {
      this.sessionInFlight = null;
    });
    return this.sessionInFlight;
  }

  private async createSession(): Promise<Session> {
    const url = `${this.pdsUrl}/xrpc/com.atproto.server.createSession`;
    const resp = await this.rawPost(url, {
      identifier: this.handle,
      password: this.password,
    });

    if (resp.status !== 200) {
      throw await toPDSError('createSession', resp);
    }
    const body = (await parseJSON(resp)) as Record<string, unknown>;
    const accessJwt = body.accessJwt;
    const did = body.did;
    if (typeof accessJwt !== 'string' || typeof did !== 'string') {
      throw new PDSPublisherError('createSession: response missing accessJwt/did', resp.status);
    }
    const session: Session = {
      accessJwt,
      did,
      expiresAtMs: this.nowFn() + this.sessionTtlMs,
    };
    this.session = session;
    return session;
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    accessJwt: string,
  ): Promise<unknown> {
    const url = `${this.pdsUrl}${path}`;
    const resp = await this.rawPost(url, body, accessJwt);
    if (resp.status !== 200) {
      if (resp.status === 401) {
        // JWT expired between the ensureSession check and the request — let
        // the next call re-auth.
        this.invalidateSession();
      }
      throw await toPDSError(path, resp);
    }
    return parseJSON(resp);
  }

  private async rawPost(
    url: string,
    body: Record<string, unknown>,
    accessJwt?: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (accessJwt !== undefined) {
      headers.Authorization = `Bearer ${accessJwt}`;
    }
    try {
      return await this.fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new PDSPublisherError(`network error: ${(err as Error).message}`, null);
    } finally {
      clearTimeout(timer);
    }
  }
}

function validateCollectionAndRkey(collection: string, rkey: string): void {
  if (!collection) throw new PDSPublisherError('collection is required', null);
  if (!rkey) throw new PDSPublisherError('rkey is required', null);
}

/**
 * True iff an error from `deleteRecord` means "the record is already gone".
 *
 * AT Protocol does NOT have a universal "not found" code for deleteRecord.
 * Different PDS implementations use:
 *   - HTTP 404                              (reference PDS)
 *   - HTTP 200 no-op                        (most tolerant — already handled)
 *   - HTTP 400 `RecordNotFound`             (some third-party implementations)
 *
 * We intentionally do NOT treat the generic `InvalidRequest` as "gone" — that
 * code covers schema errors, bad rkey shape, and other genuine failures.
 */
function isRecordGone(err: PDSPublisherError): boolean {
  if (err.status === 404) return true;
  if (err.status === 400 && err.xrpcError === 'RecordNotFound') return true;
  return false;
}

async function parseJSON(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function toPDSError(path: string, resp: Response): Promise<PDSPublisherError> {
  const body = await parseJSON(resp);
  let xrpcError: string | undefined;
  let message = `PDS ${path} failed: HTTP ${resp.status}`;
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    if (typeof r.error === 'string') {
      xrpcError = r.error;
      message += ` (${r.error})`;
    }
    if (typeof r.message === 'string') {
      message += ` — ${r.message}`;
    }
  }
  return new PDSPublisherError(message, resp.status, xrpcError);
}
