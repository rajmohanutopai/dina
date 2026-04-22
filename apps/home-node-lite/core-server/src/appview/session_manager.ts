/**
 * Task 6.2 — `createAccount`, `createSession`, `refreshSession`,
 * `deleteSession` surface.
 *
 * The four verbs Core uses to manage its AT Protocol account. Each
 * wraps a distinct `com.atproto.server.*` xRPC call but they share
 * the pre/post persistence handling:
 *
 *   - **createAccount** — one-shot during install. POSTs a new
 *     account to the PDS. On success, persists the returned session
 *     (same shape as createSession).
 *   - **createSession** — "log in with handle + password" (used by
 *     tests + recovery flows). Persists the new tokens.
 *   - **refreshSession** — trades `refreshJwt` for a fresh
 *     `accessJwt`. Called from `SessionTokenStore.getActive` when
 *     the access token is close to expiring; exposed here so
 *     callers can also trigger a manual refresh.
 *   - **deleteSession** — POST `deleteSession` to the PDS + drop
 *     the local record. Logout flow.
 *
 * **Framework-free**: the actual PDS HTTP calls are injected via
 * `pdsClient` — production wires to `@dina/net-node` + the PDS
 * base URL; tests pass scripted stubs. This module orchestrates
 * validation + persistence + error taxonomy + never holds its own
 * HTTP state.
 *
 * **Error taxonomy**:
 *   - `account_exists` — createAccount returned 409 / duplicate.
 *   - `invalid_credentials` — createSession rejected by PDS.
 *   - `refresh_rejected` — refreshSession failed (refreshJwt is
 *     invalid or expired past its own horizon — forces re-login).
 *   - `no_session` — refreshSession / deleteSession called with no
 *     persisted record.
 *   - `network_error` — transport failed.
 *   - `pds_error` — non-2xx response with structured `error` body.
 *   - `malformed_response` — PDS returned 2xx but the body doesn't
 *     match `ServerResponse` shape.
 *
 * **Never throws** — every failure path surfaces a structured
 * outcome the caller switches on.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6a task 6.2.
 */

import {
  SessionTokenStore,
  type SessionRecord,
} from './session_token_store';

/** Raw PDS response body from createSession / createAccount / refreshSession. */
export interface PdsServerResponse {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  /** UTC ms when accessJwt expires (computed from `exp` claim). */
  accessExpiresAtMs: number;
  /** UTC ms when refreshJwt expires. Null when PDS didn't provide. */
  refreshExpiresAtMs: number | null;
}

export type PdsClientRequestKind =
  | 'createAccount'
  | 'createSession'
  | 'refreshSession'
  | 'deleteSession';

export interface PdsClientResult {
  status: number;
  /** Parsed body. Null when the PDS returned no body (e.g. deleteSession 200 empty). */
  body: Record<string, unknown> | null;
}

export type PdsClientFn = (
  kind: PdsClientRequestKind,
  payload: Record<string, unknown>,
  /** Valid bearer for `refreshSession` / `deleteSession`. */
  bearer?: string,
) => Promise<PdsClientResult>;

export interface CreateAccountInput {
  handle: string;
  email: string;
  password: string;
  /** Optional: pass Dina's K256 recovery key so the PDS stamps it on the genesis PLC op. */
  recoveryKey?: string;
  /** Optional: existing did:plc (restoration flow). */
  did?: string;
}

export interface CreateSessionInput {
  identifier: string; // handle or did
  password: string;
}

export type SessionOutcome =
  | { ok: true; record: SessionRecord }
  | {
      ok: false;
      reason:
        | 'account_exists'
        | 'invalid_credentials'
        | 'refresh_rejected'
        | 'no_session'
        | 'network_error'
        | 'pds_error'
        | 'malformed_response';
      error?: string;
      status?: number;
    };

export type DeleteSessionOutcome =
  | { ok: true }
  | { ok: false; reason: 'no_session' | 'network_error' | 'pds_error'; error?: string; status?: number };

export interface SessionManagerOptions {
  pdsClient: PdsClientFn;
  tokenStore: SessionTokenStore;
  onEvent?: (event: SessionManagerEvent) => void;
}

export type SessionManagerEvent =
  | { kind: 'account_created'; did: string }
  | { kind: 'session_created'; did: string }
  | { kind: 'session_refreshed'; did: string }
  | { kind: 'session_deleted'; did: string | null }
  | { kind: 'rejected'; op: PdsClientRequestKind; reason: string };

/** The manager orchestrates the four session ops + persistence. */
export class SessionManager {
  private readonly pdsClient: PdsClientFn;
  private readonly tokenStore: SessionTokenStore;
  private readonly onEvent?: (event: SessionManagerEvent) => void;

  constructor(opts: SessionManagerOptions) {
    if (typeof opts?.pdsClient !== 'function') {
      throw new TypeError('SessionManager: pdsClient is required');
    }
    if (!opts.tokenStore) {
      throw new TypeError('SessionManager: tokenStore is required');
    }
    this.pdsClient = opts.pdsClient;
    this.tokenStore = opts.tokenStore;
    this.onEvent = opts.onEvent;
  }

  async createAccount(input: CreateAccountInput): Promise<SessionOutcome> {
    const validation = validateCreateAccount(input);
    if (validation !== null) {
      this.onEvent?.({ kind: 'rejected', op: 'createAccount', reason: 'invalid_input' });
      return { ok: false, reason: 'malformed_response', error: validation };
    }
    const result = await this.callPds('createAccount', input as unknown as Record<string, unknown>);
    if (!result.ok) {
      // 409 / 400 indicating handle conflict → account_exists.
      if (result.status === 409 || result.status === 400) {
        const bodyErr = (result.body as { error?: string })?.error ?? '';
        if (/taken|exist|already/i.test(bodyErr)) {
          this.onEvent?.({ kind: 'rejected', op: 'createAccount', reason: 'account_exists' });
          return {
            ok: false,
            reason: 'account_exists',
            error: bodyErr || 'handle taken',
            status: result.status,
          };
        }
      }
      return mapPdsError('createAccount', result);
    }
    const record = parseServerResponse(result.body);
    if (record === null) {
      return { ok: false, reason: 'malformed_response', error: 'PDS returned malformed session' };
    }
    await this.tokenStore.save(record);
    this.onEvent?.({ kind: 'account_created', did: record.did });
    return { ok: true, record: await expectLoaded(this.tokenStore) };
  }

  async createSession(input: CreateSessionInput): Promise<SessionOutcome> {
    if (
      typeof input?.identifier !== 'string' ||
      input.identifier === '' ||
      typeof input.password !== 'string' ||
      input.password === ''
    ) {
      return {
        ok: false,
        reason: 'malformed_response',
        error: 'identifier and password are required',
      };
    }
    const result = await this.callPds('createSession', input as unknown as Record<string, unknown>);
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) {
        this.onEvent?.({ kind: 'rejected', op: 'createSession', reason: 'invalid_credentials' });
        return {
          ok: false,
          reason: 'invalid_credentials',
          error: (result.body as { error?: string })?.error ?? 'authentication failed',
          status: result.status,
        };
      }
      return mapPdsError('createSession', result);
    }
    const record = parseServerResponse(result.body);
    if (record === null) {
      return { ok: false, reason: 'malformed_response', error: 'PDS returned malformed session' };
    }
    await this.tokenStore.save(record);
    this.onEvent?.({ kind: 'session_created', did: record.did });
    return { ok: true, record: await expectLoaded(this.tokenStore) };
  }

  async refreshSession(): Promise<SessionOutcome> {
    const current = await this.tokenStore.load();
    if (current === null) {
      return { ok: false, reason: 'no_session' };
    }
    const result = await this.callPds('refreshSession', {}, current.refreshJwt);
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) {
        this.onEvent?.({ kind: 'rejected', op: 'refreshSession', reason: 'refresh_rejected' });
        return {
          ok: false,
          reason: 'refresh_rejected',
          error: (result.body as { error?: string })?.error ?? 'refresh jwt rejected',
          status: result.status,
        };
      }
      return mapPdsError('refreshSession', result);
    }
    const record = parseServerResponse(result.body);
    if (record === null) {
      return { ok: false, reason: 'malformed_response', error: 'PDS returned malformed session' };
    }
    await this.tokenStore.save(record);
    this.onEvent?.({ kind: 'session_refreshed', did: record.did });
    return { ok: true, record: await expectLoaded(this.tokenStore) };
  }

  async deleteSession(): Promise<DeleteSessionOutcome> {
    const current = await this.tokenStore.load();
    if (current === null) {
      return { ok: false, reason: 'no_session' };
    }
    const result = await this.callPds('deleteSession', {}, current.refreshJwt);
    // deleteSession is best-effort — even on PDS error we still clear
    // the local record (the server might have already expired our
    // tokens).
    await this.tokenStore.clear();
    this.onEvent?.({ kind: 'session_deleted', did: current.did });
    if (!result.ok) {
      const body = result.body as { error?: string } | null;
      return {
        ok: false,
        reason: 'pds_error',
        error: body?.error ?? `status ${result.status}`,
        status: result.status,
      };
    }
    return { ok: true };
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async callPds(
    kind: PdsClientRequestKind,
    payload: Record<string, unknown>,
    bearer?: string,
  ): Promise<{ ok: true; body: Record<string, unknown> | null } | { ok: false; status: number; body: Record<string, unknown> | null }> {
    let result: PdsClientResult;
    try {
      result = await this.pdsClient(kind, payload, bearer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, body: { error: msg } };
    }
    if (result.status >= 200 && result.status < 300) {
      return { ok: true, body: result.body };
    }
    return { ok: false, status: result.status, body: result.body };
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function validateCreateAccount(input: CreateAccountInput): string | null {
  if (!input || typeof input !== 'object') return 'input required';
  if (typeof input.handle !== 'string' || input.handle === '') {
    return 'handle required';
  }
  if (typeof input.email !== 'string' || input.email === '') {
    return 'email required';
  }
  if (typeof input.password !== 'string' || input.password === '') {
    return 'password required';
  }
  return null;
}

function parseServerResponse(body: Record<string, unknown> | null): PdsServerResponse | null {
  if (body === null) return null;
  const b = body;
  if (typeof b.did !== 'string' || b.did === '') return null;
  if (typeof b.handle !== 'string' || b.handle === '') return null;
  if (typeof b.accessJwt !== 'string' || b.accessJwt === '') return null;
  if (typeof b.refreshJwt !== 'string' || b.refreshJwt === '') return null;
  if (typeof b.accessExpiresAtMs !== 'number' || !Number.isInteger(b.accessExpiresAtMs)) {
    return null;
  }
  const refreshExpiresAtMs =
    b.refreshExpiresAtMs === null ||
    (typeof b.refreshExpiresAtMs === 'number' && Number.isInteger(b.refreshExpiresAtMs))
      ? (b.refreshExpiresAtMs as number | null)
      : null;
  return {
    did: b.did,
    handle: b.handle,
    accessJwt: b.accessJwt,
    refreshJwt: b.refreshJwt,
    accessExpiresAtMs: b.accessExpiresAtMs,
    refreshExpiresAtMs,
  };
}

function mapPdsError(
  op: PdsClientRequestKind,
  result: { ok: false; status: number; body: Record<string, unknown> | null },
): SessionOutcome {
  const body = result.body as { error?: string } | null;
  if (result.status === 0) {
    return {
      ok: false,
      reason: 'network_error',
      error: body?.error ?? `${op} transport failed`,
    };
  }
  return {
    ok: false,
    reason: 'pds_error',
    status: result.status,
    error: body?.error ?? `${op} failed with status ${result.status}`,
  };
}

async function expectLoaded(store: SessionTokenStore): Promise<SessionRecord> {
  const loaded = await store.load();
  if (loaded === null) {
    throw new Error('SessionManager: just-saved record failed to load');
  }
  return loaded;
}
