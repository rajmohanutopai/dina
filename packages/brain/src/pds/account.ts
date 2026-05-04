/**
 * AT Protocol PDS account lifecycle client.
 *
 * Thin wrappers over the XRPC endpoints needed to bootstrap a home-node
 * identity against a PDS:
 *
 *   POST /xrpc/com.atproto.server.describeServer  — capability probe
 *   POST /xrpc/com.atproto.server.createAccount   — register a new account
 *   POST /xrpc/com.atproto.server.createSession   — log in + get JWT
 *   POST /xrpc/com.atproto.server.refreshSession  — extend session
 *
 * Companion to `PDSPublisher` (which consumes session credentials to put
 * records). This module owns the pre-record phase: ensuring the account
 * exists and a session is available.
 *
 * Source: docker-compose-test-stack.yml + AT Protocol createAccount spec.
 */

/** Structured error for PDS account failures. */
export class PDSAccountError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly xrpcError?: string,
  ) {
    super(message);
    this.name = 'PDSAccountError';
  }
}

export interface PDSSession {
  accessJwt: string;
  refreshJwt: string;
  handle: string;
  did: string;
}

export interface PDSAccountOptions {
  /** Base URL of the PDS (trailing slash stripped). */
  pdsUrl: string;
  /** Per-request timeout in ms. Default 15 s. */
  timeoutMs?: number;
  /** Injectable `fetch`. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

export interface CreateAccountParams {
  handle: string;
  password: string;
  /** Optional email (some PDS configurations require it). */
  email?: string;
  /** Optional invite code (when PDS is invite-gated). */
  inviteCode?: string;
  /**
   * Bring-your-own DID (self-managed did:plc). When supplied, the PDS
   * treats this as an external DID that must resolve to a PLC record
   * naming the PDS as its home. When omitted, the PDS generates a
   * managed did:plc itself.
   */
  did?: string;
  /**
   * `did:key:z…` form of the client's secp256k1 rotation key. When
   * supplied (and `did` is omitted), the PDS registers this key as a
   * rotation key on the genesis PLC op alongside the PDS's own
   * rotation key — so the client retains independent authority to
   * issue PLC updates (add services, rotate signing keys) without
   * needing the PDS's cooperation.
   *
   * Mirrors Go core (`core/internal/adapter/pds/plc_client.go`'s
   * `CreateDIDOptions.RecoveryKey`).
   */
  recoveryKey?: string;
}

export interface CreateSessionParams {
  /** Handle or DID. */
  identifier: string;
  password: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * XRPC client for PDS account lifecycle. Stateless — every call supplies
 * its own credentials. Callers that want session caching should wrap this
 * with `PDSPublisher` (session-caching) or their own memoizer.
 */
export class PDSAccountClient {
  private readonly pdsUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: PDSAccountOptions) {
    if (!options.pdsUrl) throw new Error('PDSAccountClient: pdsUrl is required');
    this.pdsUrl = options.pdsUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (this.timeoutMs <= 0) {
      throw new Error(`PDSAccountClient: timeoutMs must be > 0 (got ${this.timeoutMs})`);
    }
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  /** Return the PDS's `describeServer` response (invite requirement, available handles, etc.). */
  async describeServer(): Promise<Record<string, unknown>> {
    const url = `${this.pdsUrl}/xrpc/com.atproto.server.describeServer`;
    const resp = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (resp.status !== 200) {
      throw await toAccountError('describeServer', resp);
    }
    return (await parseJSON(resp)) as Record<string, unknown>;
  }

  /**
   * Create a new PDS account. Returns a full `PDSSession` on success.
   * Throws `PDSAccountError { xrpcError: 'HandleNotAvailable' | 'InvalidHandle' |
   * 'InvalidInviteCode' | ... }` on the typical failure modes.
   */
  async createAccount(params: CreateAccountParams): Promise<PDSSession> {
    if (!params.handle) throw new PDSAccountError('handle is required', null);
    if (!params.password) throw new PDSAccountError('password is required', null);
    const body: Record<string, unknown> = {
      handle: params.handle,
      password: params.password,
    };
    if (params.email !== undefined) body.email = params.email;
    if (params.inviteCode !== undefined) body.inviteCode = params.inviteCode;
    if (params.did !== undefined) body.did = params.did;
    if (params.recoveryKey !== undefined) body.recoveryKey = params.recoveryKey;
    const url = `${this.pdsUrl}/xrpc/com.atproto.server.createAccount`;
    const resp = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.status !== 200) {
      throw await toAccountError('createAccount', resp);
    }
    return this.parseSession(resp, 'createAccount');
  }

  /** Log in to an existing account. */
  async createSession(params: CreateSessionParams): Promise<PDSSession> {
    const url = `${this.pdsUrl}/xrpc/com.atproto.server.createSession`;
    const resp = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        identifier: params.identifier,
        password: params.password,
      }),
    });
    if (resp.status !== 200) {
      throw await toAccountError('createSession', resp);
    }
    return this.parseSession(resp, 'createSession');
  }

  /** Swap a refresh JWT for a fresh access JWT. */
  async refreshSession(refreshJwt: string): Promise<PDSSession> {
    const url = `${this.pdsUrl}/xrpc/com.atproto.server.refreshSession`;
    const resp = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${refreshJwt}`,
      },
    });
    if (resp.status !== 200) {
      throw await toAccountError('refreshSession', resp);
    }
    return this.parseSession(resp, 'refreshSession');
  }

  /**
   * Ensure an account exists for `{handle, password}`. Tries `createSession`
   * first; on auth failure (XRPC `AccountNotFound` / `InvalidIdentifier`),
   * falls back to `createAccount`. Returns the session.
   *
   * `existingDID` allows the caller to bring a self-managed did:plc — if
   * supplied AND createSession fails AND createAccount is invoked, the DID
   * is passed through so the PDS uses it instead of minting its own.
   */
  async ensureAccount(params: {
    handle: string;
    password: string;
    email?: string;
    inviteCode?: string;
    existingDID?: string;
    recoveryKey?: string;
  }): Promise<{ session: PDSSession; created: boolean }> {
    try {
      const session = await this.createSession({
        identifier: params.handle,
        password: params.password,
      });
      return { session, created: false };
    } catch (err) {
      if (!(err instanceof PDSAccountError) || !isMissingAccount(err)) {
        throw err;
      }
      const session = await this.createAccount({
        handle: params.handle,
        password: params.password,
        email: params.email,
        inviteCode: params.inviteCode,
        did: params.existingDID,
        recoveryKey: params.recoveryKey,
      });
      return { session, created: true };
    }
  }

  // -------------------------------------------------------------------------

  private async parseSession(resp: Response, op: string): Promise<PDSSession> {
    const body = (await parseJSON(resp)) as Record<string, unknown>;
    const accessJwt = body.accessJwt;
    const refreshJwt = body.refreshJwt;
    const handle = body.handle;
    const did = body.did;
    if (
      typeof accessJwt !== 'string' ||
      accessJwt === '' ||
      typeof refreshJwt !== 'string' ||
      refreshJwt === '' ||
      typeof handle !== 'string' ||
      handle === '' ||
      typeof did !== 'string' ||
      did === ''
    ) {
      throw new PDSAccountError(
        `${op}: response missing one of accessJwt / refreshJwt / handle / did`,
        resp.status,
      );
    }
    return { accessJwt, refreshJwt, handle, did };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (err) {
      throw new PDSAccountError(`network error: ${(err as Error).message}`, null);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * True iff a createSession failure means "no such account" vs. a genuine
 * error (bad password, rate limit, server down). Per the PDS XRPC spec,
 * missing accounts surface as:
 *   - 400 { error: "AccountNotFound" }
 *   - 400 { error: "InvalidIdentifier" }
 *   - 401 { error: "AuthenticationRequired" } (some PDS impls)
 *
 * We do NOT treat 401 AuthenticationRequired as "missing" because that's
 * ambiguous with "wrong password"; callers who want fallback must supply
 * the correct password.
 */
function isMissingAccount(err: PDSAccountError): boolean {
  if (err.status !== 400) return false;
  return err.xrpcError === 'AccountNotFound' || err.xrpcError === 'InvalidIdentifier';
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

async function toAccountError(op: string, resp: Response): Promise<PDSAccountError> {
  const body = await parseJSON(resp);
  let xrpcError: string | undefined;
  let message: string | undefined;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (typeof b.error === 'string') xrpcError = b.error;
    if (typeof b.message === 'string') message = b.message;
  }
  const tail =
    xrpcError !== undefined && message !== undefined
      ? `${xrpcError}: ${message}`
      : (xrpcError ?? message ?? 'upstream error');
  return new PDSAccountError(`${op}: HTTP ${resp.status} — ${tail}`, resp.status, xrpcError);
}
