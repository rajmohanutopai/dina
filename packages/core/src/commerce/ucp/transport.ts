/**
 * Sending one UCP operation to a merchant (plan §3.6 steps 5–7), over MCP or
 * REST, through `ucpFetch` only.
 *
 * MCP (step 5a, MCP spec 2025-11-25, Streamable HTTP): one session per
 * endpoint. `initialize` with Dina's protocol versions; the negotiated version
 * and any `Mcp-Session-Id` are kept; `notifications/initialized` is sent and
 * its 202 accepted; every later request carries `MCP-Protocol-Version` and the
 * session id. A 404 on a request that carried a session id means the session
 * ended: a new one is started and the SAME bytes are sent again (same
 * JSON-RPC id, same idempotency key), once. A server that refuses
 * `initialize` (Shopify answers tools/call without the lifecycle) still
 * works: the client only sends the headers it was given. Answers may be JSON
 * or SSE.
 *
 * REST: the endpoint joined with the OpenAPI path; `UCP-Agent`, a fresh
 * `Request-Id`, and an `Idempotency-Key` on every state change
 * (`buildRestRequest`).
 *
 * Signatures (§3.2, U2): every request, REST and every MCP post, is signed
 * with the node's UCP key (RFC 9421, `sig1`, `keyid` only). A merchant's
 * answer that carries a signature must verify against the keys its profile
 * lists, with one forced profile refresh for a key it does not list; one
 * that fails is treated as a lost answer (`signature_invalid`, sent). An
 * unsigned answer is accepted on the TLS connection, since the spec makes
 * response signing optional for these calls. Merchant calls need TLS 1.3
 * (D8; REST requires it, `checkout/rest.md`).
 *
 * Errors are read by the body's `code` (`error.data.code` on MCP), never by
 * the HTTP status alone, and carry `Retry-After` / `retry_after` (step 7).
 * Nothing here validates or interprets a resource: that is the client's.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { isPlainObject, type JsonObject } from '@dina/a2a';
import { UCP_FETCH_LIMITS, type PolicySocketRequest } from '@dina/net-policy';
import {
  requiredResponseComponents,
  signRequest,
  verifyMessage,
  type HttpMessage,
  type KeyLookup,
  type SignFn,
  buildRestRequest,
  INITIALIZED_NOTIFICATION,
  ucpAgentHeader,
  initializeRequest,
  messageFromSse,
  negotiatedProtocolVersion,
  OPERATIONS,
  parseRetryAfter,
  readMcpError,
  readRestError,
  readToolCallResponse,
  toolCallRequest,
  type OperationName,
  type TransportError,
  readBearerChallenge,
} from '@dina/ucp';

import { ucpFetch, type UcpFetchResult } from './fetch';
import { newUcpId } from './ids';
import { jsonOrUndefined, utf8Text } from './json_bytes';

/** The byte and time caps for an operation's answer (§3.3, `UCP_FETCH_LIMITS`), by its capability. */
export function limitsFor(operation: OperationName): {
  maxResponseBytes: number;
  timeoutMs: number;
} {
  const capability = OPERATIONS[operation].capability;
  if (capability.includes('.catalog.')) return UCP_FETCH_LIMITS.catalog;
  if (capability === 'dev.ucp.shopping.order') return UCP_FETCH_LIMITS.order;
  return UCP_FETCH_LIMITS.checkout;
}
/** `initialize` and its notification: small JSON-RPC exchanges. */
const SESSION_LIMITS = UCP_FETCH_LIMITS.profile;
const MCP_ACCEPT = 'application/json, text/event-stream';
const CLIENT_VERSION = '1';
/** MCP sessions kept at once (one per merchant endpoint). */
const MAX_SESSIONS = 64;

export interface UcpCall {
  transport: 'mcp' | 'rest';
  endpoint: string;
  /** Dina's profile URL, sent as `UCP-Agent`. */
  profileUrl: string;
  operation: OperationName;
  id?: string;
  payload?: JsonObject;
  /** Required for a state change; kept with the exact bytes for any resend. */
  idempotencyKey?: string;
  /** The merchant's keys, to verify a signed answer; without them a signed answer is refused. */
  keys?: MerchantKeys;
}

/**
 * A call with its bytes built (`prepare`): sent as is, first time and every
 * resend. REST: the body (none for a GET); MCP: the whole JSON-RPC envelope,
 * and its id, to read the answer by.
 */
export interface PreparedCall {
  transport: 'mcp' | 'rest';
  endpoint: string;
  profileUrl: string;
  operation: OperationName;
  id?: string;
  idempotencyKey?: string;
  bytes?: Uint8Array;
  rpcId?: string;
  /**
   * The linked account these bytes may be sent under (an approved checkout,
   * §3.7): checked against the live link at the moment of sending; null:
   * none (sent unlinked). Absent: not bound.
   */
  credential?: { ref: string; revision: number } | null;
}

export type UcpCallResult =
  /** A success answer's UCP payload (the body, or MCP `structuredContent`). */
  | { ok: true; value: JsonObject }
  /** A transport error the merchant named (`code`), with any Retry-After. */
  | { ok: false; kind: 'transport'; error: TransportError }
  /** The request may or may not have reached the merchant (`sent`). */
  | { ok: false; kind: 'network'; error: string; sent: boolean }
  /** An answer that is not the protocol's. */
  | { ok: false; kind: 'malformed'; reason: string };

interface McpSession {
  protocolVersion: string | null;
  sessionId: string | null;
}

/** The node's UCP key, as the signer uses it; null when it is not installed (a sealed phone). */
export interface UcpRequestSigner {
  keyid: string;
  sign: SignFn;
}

/** A merchant's signing keys, from its profile, and a way to read the profile again. */
/** A 401 or 403 keeps its Bearer challenge (RFC 6750 §3): what linking it asks for. */
function withChallenge(error: TransportError, r: UcpFetchResult & { ok: true }): TransportError {
  if (r.status !== 401 && r.status !== 403) return error;
  const challenge = readBearerChallenge(r.headers['www-authenticate']);
  return challenge === null ? error : { ...error, challenge };
}

export interface MerchantKeys {
  keyFor: KeyLookup;
  /** Refresh the profile (at most once a minute per merchant); null when not allowed or failed. */
  refresh(): Promise<KeyLookup | null>;
}

export interface UcpTransportOptions {
  fetch?: (request: PolicySocketRequest) => Promise<UcpFetchResult>;
  randomId?: () => string;
  /**
   * Signs every request. Without one nothing is signed (tests of the bare
   * transport only). Asked again before each post: when it gives null (the
   * phone sealed mid-call) the post is not sent at all, never sent unsigned.
   */
  signer?: () => UcpRequestSigner | null;
}

/** Merchant API calls (D8: TLS 1.3; REST requires it). */
const MERCHANT_TLS = 'TLSv1.3';

export class UcpTransport {
  private readonly fetch: (request: PolicySocketRequest) => Promise<UcpFetchResult>;
  private readonly randomId: () => string;
  private readonly signer: (() => UcpRequestSigner | null) | null;
  private readonly sessions = new Map<string, Promise<McpSession>>();

  constructor(options: UcpTransportOptions = {}) {
    this.fetch = options.fetch ?? ucpFetch;
    this.randomId = options.randomId ?? newUcpId;
    this.signer = options.signer ?? null;
  }

  /**
   * Send a request, signed when the transport signs: with a signer whose key
   * went away it is not sent (`no_identity`, nothing left).
   */
  private go(request: PolicySocketRequest): Promise<UcpFetchResult> {
    if (this.signer === null) return this.fetch(request);
    const signer = this.signer();
    if (signer === null) return Promise.resolve({ ok: false, error: 'no_identity', sent: false });
    return this.fetch(this.signed(request, signer));
  }

  /** The request with its signature headers added. */
  private signed(request: PolicySocketRequest, signer: UcpRequestSigner): PolicySocketRequest {
    const added = signRequest({
      method: request.method,
      url: request.url,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      keyid: signer.keyid,
      sign: signer.sign,
      sha256,
    });
    return { ...request, headers: { ...request.headers, ...added } };
  }

  /**
   * An answer that carries a signature must verify (§3.2): coverage, the
   * digest of the exact bytes, a key the profile lists (after one refresh for
   * one it does not). Null when it is unsigned or verifies.
   */
  private async signatureFailure(
    r: UcpFetchResult & { ok: true },
    keys: MerchantKeys | undefined,
  ): Promise<string | null> {
    // Unsigned only when nothing signature-like arrived (`signedHeaders` is set from the raw answer).
    if (
      r.signedHeaders === undefined &&
      r.headers['signature'] === undefined &&
      r.headers['signature-input'] === undefined
    )
      return null;
    if (keys === undefined || r.signedHeaders === undefined || !r.signedHeaders.ok)
      return 'signature_invalid';
    const msg: HttpMessage = {
      status: r.status,
      headers: {
        ...r.signedHeaders.headers,
        signature: r.headers['signature'] ?? '',
        'signature-input': r.headers['signature-input'] ?? '',
        ...(r.headers['content-digest'] !== undefined
          ? { 'content-digest': r.headers['content-digest'] }
          : {}),
        ...(r.headers['content-type'] !== undefined
          ? { 'content-type': r.headers['content-type'] }
          : {}),
      },
      ...(r.bodyBytes.length > 0 ? { body: r.bodyBytes } : {}),
    };
    const verify = (keyFor: KeyLookup) =>
      verifyMessage({ msg, required: requiredResponseComponents(msg), keyFor, sha256 });
    let outcome = verify(keys.keyFor);
    if (!outcome.ok && outcome.reason === 'key_not_found') {
      const fresh = await keys.refresh();
      if (fresh !== null) outcome = verify(fresh);
    }
    return outcome.ok ? null : 'signature_invalid';
  }

  async call(call: UcpCall): Promise<UcpCallResult> {
    return this.send(this.prepare(call), call.keys);
  }

  /**
   * The exact bytes of a call, built once (§3.10): the REST body, or the
   * whole MCP envelope with its JSON-RPC id. A state change is journaled with
   * these bytes before its first send, and every resend sends them again.
   */
  prepare(call: Omit<UcpCall, 'keys'>): PreparedCall {
    if (call.transport === 'rest') {
      return {
        transport: 'rest',
        endpoint: call.endpoint,
        profileUrl: call.profileUrl,
        operation: call.operation,
        ...(call.id !== undefined ? { id: call.id } : {}),
        ...(call.idempotencyKey !== undefined ? { idempotencyKey: call.idempotencyKey } : {}),
        ...(call.payload !== undefined
          ? { bytes: new TextEncoder().encode(JSON.stringify(call.payload)) }
          : {}),
      };
    }
    const rpcId = this.randomId();
    const envelope = toolCallRequest({
      rpcId,
      operation: call.operation,
      profileUrl: call.profileUrl,
      ...(call.id !== undefined ? { id: call.id } : {}),
      ...(call.idempotencyKey !== undefined ? { idempotencyKey: call.idempotencyKey } : {}),
      ...(call.payload !== undefined ? { payload: call.payload } : {}),
    });
    return {
      transport: 'mcp',
      endpoint: call.endpoint,
      profileUrl: call.profileUrl,
      operation: call.operation,
      ...(call.id !== undefined ? { id: call.id } : {}),
      ...(call.idempotencyKey !== undefined ? { idempotencyKey: call.idempotencyKey } : {}),
      rpcId,
      bytes: new TextEncoder().encode(JSON.stringify(envelope)),
    };
  }

  /**
   * Send prepared bytes, as they are (a first send or a resend). `bearer`: a
   * linked account's access token for this merchant (§3.17), added as
   * `Authorization` at send time, never kept with the journaled bytes.
   */
  async send(prepared: PreparedCall, keys?: MerchantKeys, bearer?: string): Promise<UcpCallResult> {
    return prepared.transport === 'mcp'
      ? this.sendMcp(prepared, keys, bearer)
      : this.sendRest(prepared, keys, bearer);
  }

  // ------------------------------------------------------------ REST

  private async sendRest(
    call: PreparedCall,
    keys: MerchantKeys | undefined,
    bearer: string | undefined,
  ): Promise<UcpCallResult> {
    const body = call.bytes === undefined ? undefined : new TextDecoder().decode(call.bytes);
    const req = buildRestRequest({
      endpoint: call.endpoint,
      operation: call.operation,
      ...(call.id !== undefined ? { id: call.id } : {}),
      profileUrl: call.profileUrl,
      // A fresh Request-Id per attempt: the idempotency key is what names the request.
      requestId: this.randomId(),
      ...(call.idempotencyKey !== undefined ? { idempotencyKey: call.idempotencyKey } : {}),
      ...(body !== undefined ? { body } : {}),
    });
    const r = await this.go({
      method: req.method,
      url: req.url,
      headers:
        bearer === undefined ? req.headers : { ...req.headers, authorization: `Bearer ${bearer}` },
      ...(call.bytes !== undefined ? { body: call.bytes } : {}),
      accept: 'json',
      minTls: MERCHANT_TLS,
      // A 401/403 body names the UCP code (identity_required, insufficient_scope).
      readAuthErrorBodies: true,
      ...limitsFor(call.operation),
    });
    if (!r.ok) return { ok: false, kind: 'network', error: r.error, sent: r.sent };
    const failed = await this.signatureFailure(r, keys);
    if (failed !== null) return { ok: false, kind: 'network', error: failed, sent: true };
    const answer = readJson(r.bodyBytes);
    if (r.status === OPERATIONS[call.operation].successStatus || r.status === 200) {
      return isPlainObject(answer)
        ? { ok: true, value: answer as JsonObject }
        : { ok: false, kind: 'malformed', reason: 'body' };
    }
    return {
      ok: false,
      kind: 'transport',
      error: withChallenge(readRestError(r.status, answer, r.headers['retry-after']), r),
    };
  }

  // ------------------------------------------------------------ MCP

  private async sendMcp(
    call: PreparedCall,
    keys: MerchantKeys | undefined,
    bearer: string | undefined,
  ): Promise<UcpCallResult> {
    const bytes = call.bytes as Uint8Array;
    const rpcId = call.rpcId as string;
    const limits = limitsFor(call.operation);
    let pending = this.session(call.endpoint, call.profileUrl);
    let session = await pending;
    let r = await this.post(
      call.endpoint,
      call.profileUrl,
      session,
      bytes,
      'json-or-sse',
      limits,
      call.idempotencyKey,
      bearer,
    );
    if (r.ok && r.status === 404 && session.sessionId !== null) {
      // The session ended: a new one (unless another call already started it), then the same bytes, once.
      if (this.sessions.get(call.endpoint) === pending) this.sessions.delete(call.endpoint);
      pending = this.session(call.endpoint, call.profileUrl);
      session = await pending;
      r = await this.post(
        call.endpoint,
        call.profileUrl,
        session,
        bytes,
        'json-or-sse',
        limits,
        call.idempotencyKey,
        bearer,
      );
    }
    if (!r.ok) return { ok: false, kind: 'network', error: r.error, sent: r.sent };
    const failed = await this.signatureFailure(r, keys);
    if (failed !== null) return { ok: false, kind: 'network', error: failed, sent: true };
    // Streamable HTTP pairs a JSON-RPC error with its HTTP status (overview :2079-2083):
    // read the JSON-RPC answer whatever the status, and fall back to the body only when there is none.
    const message = readRpcMessage(r, rpcId);
    const answer =
      message === null || message === undefined ? null : readToolCallResponse(message, rpcId);
    if (answer !== null && answer.kind === 'rpc_error') {
      const error = withChallenge(
        { ...readMcpError(answer.code, answer.data), httpStatus: r.status },
        r,
      );
      if (error.retryAfter === undefined) {
        const header = parseRetryAfter(r.headers['retry-after']);
        if (header !== undefined) error.retryAfter = header;
      }
      return { ok: false, kind: 'transport', error };
    }
    if (r.status !== 200) {
      return {
        ok: false,
        kind: 'transport',
        error: withChallenge(
          readRestError(r.status, readJson(r.bodyBytes), r.headers['retry-after']),
          r,
        ),
      };
    }
    if (answer === null) return { ok: false, kind: 'malformed', reason: 'not_jsonrpc' };
    if (answer.kind === 'malformed') return { ok: false, kind: 'malformed', reason: answer.reason };
    return { ok: true, value: answer.value };
  }

  /** The endpoint's session, started once (concurrent first calls share it). */
  private session(endpoint: string, profileUrl: string): Promise<McpSession> {
    const held = this.sessions.get(endpoint);
    if (held !== undefined) return held;
    const pending: Promise<McpSession> = this.start(endpoint, profileUrl).then(
      ({ session, keep }) => {
        // A start that did not settle anything is forgotten, so the next call tries again.
        if (!keep && this.sessions.get(endpoint) === pending) this.sessions.delete(endpoint);
        return session;
      },
    );
    this.sessions.set(endpoint, pending);
    // Endpoints Dina has spoken to stay few; the oldest go first.
    while (this.sessions.size > MAX_SESSIONS)
      this.sessions.delete(this.sessions.keys().next().value as string);
    return pending;
  }

  /**
   * Start a session. A server that plainly refuses the lifecycle (400, 404 or
   * 405 to `initialize`, or JSON-RPC "method not found") is kept as one that
   * takes calls without it. Anything else that fails (no answer, 429, 5xx,
   * another error) is not kept, so the next call tries again.
   */
  private async start(
    endpoint: string,
    profileUrl: string,
  ): Promise<{ session: McpSession; keep: boolean }> {
    const none: McpSession = { protocolVersion: null, sessionId: null };
    const rpcId = this.randomId();
    const bytes = new TextEncoder().encode(
      JSON.stringify(initializeRequest(rpcId, CLIENT_VERSION)),
    );
    const r = await this.post(endpoint, profileUrl, none, bytes, 'json-or-sse', SESSION_LIMITS);
    if (!r.ok) return { session: none, keep: false };
    const message = readRpcMessage(r, rpcId);
    const error = isPlainObject(message) && isPlainObject(message.error) ? message.error : null;
    if (r.status === 400 || r.status === 404 || r.status === 405 || error?.code === -32601) {
      return { session: none, keep: true };
    }
    if (r.status !== 200 || error !== null || !isPlainObject(message))
      return { session: none, keep: false };
    const session: McpSession = {
      protocolVersion: negotiatedProtocolVersion(message.result),
      sessionId: r.headers['mcp-session-id'] ?? null,
    };
    // `notifications/initialized`: a 202 with no body is the expected answer; any other is ignored.
    await this.post(
      endpoint,
      profileUrl,
      session,
      new TextEncoder().encode(JSON.stringify(INITIALIZED_NOTIFICATION)),
      'status',
      SESSION_LIMITS,
    );
    return { session, keep: true };
  }

  private post(
    endpoint: string,
    profileUrl: string,
    session: McpSession,
    body: Uint8Array,
    accept: 'json-or-sse' | 'status',
    limits: { maxResponseBytes: number; timeoutMs: number },
    idempotencyKey?: string,
    bearer?: string,
  ): Promise<UcpFetchResult> {
    // UCP-Agent on every request, MCP too (step 6); the profile also rides in `meta`.
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
      'ucp-agent': ucpAgentHeader(profileUrl),
    };
    if (session.protocolVersion !== null) headers['mcp-protocol-version'] = session.protocolVersion;
    if (session.sessionId !== null) headers['mcp-session-id'] = session.sessionId;
    // A state change carries its key as a signed header too, the same UUID as `meta` (A8;
    // checkout/mcp.md requires it on cancel and complete).
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
    if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
    return this.go({
      method: 'POST',
      url: endpoint,
      headers,
      body,
      accept,
      minTls: MERCHANT_TLS,
      readAuthErrorBodies: true,
      ...limits,
    });
  }
}

const readJson = jsonOrUndefined;

/** The JSON-RPC message answering `rpcId`, from a JSON or an SSE body. */
function readRpcMessage(r: UcpFetchResult & { ok: true }, rpcId: string): unknown {
  const type = (r.headers['content-type'] ?? '').toLowerCase();
  if (type.startsWith('text/event-stream')) {
    const text = utf8Text(r.bodyBytes);
    return text === null ? null : messageFromSse(text, rpcId);
  }
  return readJson(r.bodyBytes);
}
