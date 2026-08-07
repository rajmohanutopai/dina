/**
 * AT Protocol PDS publisher — minimal surface for service-profile records.
 *
 * Publishes `com.dinakernel.service.profile` (and in future other `com.dinakernel.*`)
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
 * publish_flag — those are PeerLens features, not service-query.
 */

import { defaultFetch } from '../runtime/fetch';

/** Result of a successful `putRecord`. */
export interface PutRecordResult {
  /** Full AT URI of the record, e.g. `at://did:plc:.../col/rkey`. */
  uri: string;
  /** CID of the record body. */
  cid: string;
}

/** Optional compare-and-swap for `putRecord`. */
export interface PutRecordOptions {
  /**
   * The CID this write expects to replace. `null` requires that NO record
   * exists at the key. Omit the property for a blind overwrite.
   *
   * When the live record is something else the PDS rejects with
   * `InvalidSwap`, which surfaces as a `PDSPublisherError` whose
   * `casLost` is true — a lost race, not a failure to reach the repo.
   */
  swapRecord?: string | null;
}

/** A record read back from a repo, with the CID a later CAS write needs. */
export interface GetRecordResult {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

/** Configuration for `PDSPublisher`. */
export interface PDSPublisherOptions {
  /** Base URL of the PDS (trailing slash stripped). */
  pdsUrl: string;
  /** PDS account handle, e.g. `demoprovider.dinakernel.com`. */
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

  /**
   * The write lost a compare-and-swap: the record at the key was not the
   * one the caller expected to replace. A caller that serializes through
   * CAS must re-read and retry, which is different from every other
   * failure here — those mean the repo is unreachable or refusing.
   */
  get casLost(): boolean {
    return this.xrpcError === 'InvalidSwap';
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
    this.fetchFn = options.fetch ?? defaultFetch();
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
    options: PutRecordOptions = {},
  ): Promise<PutRecordResult> {
    validateCollectionAndRkey(collection, rkey);
    const session = await this.ensureSession();
    const payload: Record<string, unknown> = {
      repo: session.did,
      collection,
      rkey,
      record,
    };
    // AT Protocol compare-and-swap. `swapRecord` present means "write only
    // if the record I am replacing is still exactly this one"; null means
    // "only if nothing is there". Omitting the key entirely is a blind
    // overwrite — which is what every caller got before, and is wrong for
    // any record whose whole purpose is to serialize concurrent writers.
    if ('swapRecord' in options) payload.swapRecord = options.swapRecord ?? null;
    const body = await this.post('/xrpc/com.atproto.repo.putRecord', payload, session.accessJwt);
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
   * Read a record back, with the CID a later compare-and-swap needs.
   * Returns null when no record exists at the key — an absent record is an
   * answer, not a failure. Every other non-success throws, so a caller
   * that must fail closed cannot mistake an unreachable repo for an empty
   * one.
   *
   * `did` defaults to the authenticated account: reading another repo is
   * legal AT Protocol, and the epoch fetcher does not need it, but a
   * caller that passes one gets it rather than silently reading its own.
   */
  async getRecord(collection: string, rkey: string, did?: string): Promise<GetRecordResult | null> {
    validateCollectionAndRkey(collection, rkey);
    const session = await this.ensureSession();
    const params = new URLSearchParams({
      repo: did ?? session.did,
      collection,
      rkey,
    });
    const url = `${this.pdsUrl}/xrpc/com.atproto.repo.getRecord?${params.toString()}`;
    const resp = await this.rawGet(url, session.accessJwt);
    if (resp.status === 400) {
      const err = await toPDSError('/xrpc/com.atproto.repo.getRecord', resp);
      // `RecordNotFound` is the only 400 that means "nothing there". Any
      // other 400 is a malformed request or a refusing repo and must not
      // be read as absence.
      if (err.xrpcError === 'RecordNotFound') return null;
      throw err;
    }
    if (resp.status !== 200) {
      if (resp.status === 401) this.invalidateSession();
      throw await toPDSError('/xrpc/com.atproto.repo.getRecord', resp);
    }
    const body = await parseJSON(resp);
    if (!body || typeof body !== 'object') {
      throw new PDSPublisherError('getRecord: malformed response', null);
    }
    const r = body as Record<string, unknown>;
    if (typeof r.uri !== 'string' || typeof r.cid !== 'string') {
      throw new PDSPublisherError('getRecord: response missing uri/cid', null);
    }
    if (r.value === null || typeof r.value !== 'object') {
      throw new PDSPublisherError('getRecord: response missing value', null);
    }
    return { uri: r.uri, cid: r.cid, value: r.value as Record<string, unknown> };
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

  private async rawGet(url: string, accessJwt: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessJwt}` },
        signal: controller.signal,
      });
    } catch (err) {
      throw new PDSPublisherError(`network error: ${(err as Error).message}`, null);
    } finally {
      clearTimeout(timer);
    }
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
