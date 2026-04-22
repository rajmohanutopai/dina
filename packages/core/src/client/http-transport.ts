/**
 * HTTP-backed `CoreClient` transport — dispatches typed method calls
 * over signed HTTPS to a remote `dina-core` process.
 *
 * Used by the server build target (`apps/home-node-lite/brain-server/`)
 * where Core + Brain run as two separate Node processes — preserving
 * the "Brain is an untrusted tenant" security boundary. Mobile uses
 * `InProcessTransport` instead (direct CoreRouter dispatch, no wire).
 *
 * **Platform-agnostic by construction.** This module imports no
 * transport-layer concretion: no `fetch`, no `undici`, no `ws`, no
 * `node:http`. Platform specifics are injected via two DI points:
 *
 *   - `HttpClient` — an abstracted request function. `brain-server`
 *     wires a `fetch` or `undici.fetch` adapter; any alternate runtime
 *     (Bun, Deno, edge) can wire its own.
 *   - `CanonicalRequestSigner` — produces the 4 auth headers (`X-DID`,
 *     `X-Timestamp`, `X-Nonce`, `X-Signature`) by signing the canonical
 *     request string with Brain's Ed25519 service key. The caller owns
 *     key material; the transport never touches it.
 *
 * Keeping the HTTP concretion out of this file is what lets the lint
 * gate in task 1.33 forbid `fetch`/`undici`/`ws` imports anywhere in
 * `packages/brain/src/**` without this module tripping the rule.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 1c task 1.31.
 */

import type {
  CoreClient,
  CoreHealth,
  VaultQuery,
  VaultQueryResult,
  VaultItemInput,
  VaultStoreResult,
  VaultListOptions,
  VaultListResult,
  VaultDeleteResult,
  SignResult,
  CanonicalSignRequest,
  SignedHeaders,
  PIIScrubResult,
  PIIRehydrateResult,
  NotifyRequest,
  NotifyResult,
  PersonaStatusResult,
  PersonaUnlockResult,
  ServiceConfig,
  ServiceQueryClientRequest,
  ServiceQueryResult,
  MemoryToCOptions,
  MemoryToCResult,
} from './core-client';

// ---------------------------------------------------------------------------
// DI abstractions — injected by the platform
// ---------------------------------------------------------------------------

/**
 * Minimal HTTP-client contract the transport drives. Deliberately a
 * strict subset of the Fetch API: just enough to round-trip request
 * bytes. Brain-server adapts `globalThis.fetch` / `undici.fetch` to
 * this shape; tests inject a mock that records calls.
 */
export interface HttpClient {
  request(url: string, init: HttpRequestInit): Promise<HttpResponse>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  /** Encoded body bytes. Omit for GET / DELETE. */
  body?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names per the canonical convention. */
  headers: Record<string, string>;
  /** Raw response body bytes; the transport decodes JSON internally. */
  body: Uint8Array;
}

/**
 * Produces the 4 auth headers Core verifies on inbound requests. The
 * signer owns the canonical-string construction (method + path + query
 * + timestamp + nonce + SHA-256(body)) + the Ed25519 sign step. The
 * transport just calls it with raw request inputs and attaches the
 * returned headers.
 *
 * The canonical-string recipe lives in `@dina/protocol`
 * (`buildCanonicalPayload`) — brain-server's signer implementation
 * composes protocol's helper with its private-key sign function.
 */
export type CanonicalRequestSigner = (args: {
  method: string;
  path: string;
  /** Already URL-encoded, no leading `?`. Empty string when no query. */
  query: string;
  /** Raw body bytes; pass an empty Uint8Array for bodyless requests. */
  body: Uint8Array;
}) => Promise<SignedHeaders>;

export interface HttpCoreTransportOptions {
  /** e.g. `http://localhost:8100`. Trailing slash is stripped. */
  baseUrl: string;
  httpClient: HttpClient;
  signer: CanonicalRequestSigner;
}

// ---------------------------------------------------------------------------
// Transport class
// ---------------------------------------------------------------------------

/**
 * Signed-HTTP implementation of `CoreClient`. Mirrors
 * `InProcessTransport` on the wire side (same routes, same bodies) —
 * only the dispatch mechanism changes.
 */
export class HttpCoreTransport implements CoreClient {
  private readonly baseUrl: string;
  private readonly httpClient: HttpClient;
  private readonly signer: CanonicalRequestSigner;

  constructor(options: HttpCoreTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.httpClient = options.httpClient;
    this.signer = options.signer;
  }

  async healthz(): Promise<CoreHealth> {
    return this.call<CoreHealth>('GET', '/healthz', undefined, undefined, 'healthz');
  }

  async vaultQuery(persona: string, query: VaultQuery): Promise<VaultQueryResult> {
    return this.call<VaultQueryResult>(
      'POST',
      '/v1/vault/query',
      undefined,
      { persona, ...query },
      `vaultQuery(persona=${persona})`,
    );
  }

  async vaultStore(persona: string, item: VaultItemInput): Promise<VaultStoreResult> {
    return this.call<VaultStoreResult>(
      'POST',
      '/v1/vault/store',
      undefined,
      { persona, ...item },
      `vaultStore(persona=${persona})`,
    );
  }

  async vaultList(persona: string, opts?: VaultListOptions): Promise<VaultListResult> {
    const query: Record<string, string> = { persona };
    if (opts?.limit !== undefined) query.limit = String(opts.limit);
    if (opts?.offset !== undefined) query.offset = String(opts.offset);
    if (opts?.type !== undefined) query.type = opts.type;
    return this.call<VaultListResult>(
      'GET',
      '/v1/vault/list',
      query,
      undefined,
      `vaultList(persona=${persona})`,
    );
  }

  async vaultDelete(persona: string, itemId: string): Promise<VaultDeleteResult> {
    return this.call<VaultDeleteResult>(
      'DELETE',
      `/v1/vault/items/${encodeURIComponent(itemId)}`,
      { persona },
      undefined,
      `vaultDelete(persona=${persona}, id=${itemId})`,
    );
  }

  async didSign(payload: Uint8Array): Promise<SignResult> {
    // Bytes → base64 so the server sees the same shape whether the
    // transport is InProcess or HTTP (both route bodies are JSON).
    const base64Payload = bytesToBase64(payload);
    return this.call<SignResult>(
      'POST',
      '/v1/did/sign',
      undefined,
      { payload: base64Payload },
      'didSign',
    );
  }

  async didSignCanonical(req: CanonicalSignRequest): Promise<SignedHeaders> {
    return this.call<SignedHeaders>(
      'POST',
      '/v1/did/sign-canonical',
      undefined,
      {
        method: req.method,
        path: req.path,
        query: req.query,
        body: bytesToBase64(req.body),
      },
      'didSignCanonical',
    );
  }

  async piiScrub(text: string): Promise<PIIScrubResult> {
    return this.call<PIIScrubResult>('POST', '/v1/pii/scrub', undefined, { text }, 'piiScrub');
  }

  async piiRehydrate(sessionId: string, text: string): Promise<PIIRehydrateResult> {
    return this.call<PIIRehydrateResult>(
      'POST',
      '/v1/pii/rehydrate',
      undefined,
      { sessionId, text },
      `piiRehydrate(session=${sessionId})`,
    );
  }

  async notify(notification: NotifyRequest): Promise<NotifyResult> {
    return this.call<NotifyResult>(
      'POST',
      '/v1/notify',
      undefined,
      notification,
      `notify(priority=${notification.priority})`,
    );
  }

  async personaStatus(persona: string): Promise<PersonaStatusResult> {
    return this.call<PersonaStatusResult>(
      'GET',
      '/v1/persona/status',
      { persona },
      undefined,
      `personaStatus(persona=${persona})`,
    );
  }

  async personaUnlock(persona: string, passphrase: string): Promise<PersonaUnlockResult> {
    // Passphrase on body, never query — passphrases must never end up
    // in reverse-proxy access logs or browser history.
    return this.call<PersonaUnlockResult>(
      'POST',
      '/v1/persona/unlock',
      undefined,
      { persona, passphrase },
      `personaUnlock(persona=${persona})`,
    );
  }

  async serviceConfig(): Promise<ServiceConfig | null> {
    const res = await this.callRaw('GET', '/v1/service/config', undefined, undefined);
    if (res.status === 404) return null;
    return this.parseOk<ServiceConfig>(res, 'serviceConfig');
  }

  async serviceQuery(req: ServiceQueryClientRequest): Promise<ServiceQueryResult> {
    // Route expects snake_case; camelCase→snake_case at the boundary
    // (same mapping as InProcessTransport — both transports speak the
    // identical wire format). Optional fields omitted when undefined.
    const body: Record<string, unknown> = {
      to_did: req.toDID,
      capability: req.capability,
      query_id: req.queryId,
      params: req.params,
      ttl_seconds: req.ttlSeconds,
    };
    if (req.serviceName !== undefined) body.service_name = req.serviceName;
    if (req.originChannel !== undefined) body.origin_channel = req.originChannel;
    if (req.schemaHash !== undefined) body.schema_hash = req.schemaHash;

    const raw = await this.call<{ task_id: string; query_id: string; deduped?: boolean }>(
      'POST',
      '/v1/service/query',
      undefined,
      body,
      `serviceQuery(capability=${req.capability})`,
    );
    const out: ServiceQueryResult = { taskId: raw.task_id, queryId: raw.query_id };
    if (raw.deduped !== undefined) out.deduped = raw.deduped;
    return out;
  }

  async memoryToC(opts?: MemoryToCOptions): Promise<MemoryToCResult> {
    const query: Record<string, string> = {};
    if (opts?.personas !== undefined && opts.personas.length > 0) {
      query.persona = opts.personas.join(',');
    }
    if (opts?.limit !== undefined) {
      query.limit = String(opts.limit);
    }
    return this.call<MemoryToCResult>(
      'GET',
      '/v1/memory/toc',
      Object.keys(query).length > 0 ? query : undefined,
      undefined,
      'memoryToC',
    );
  }

  // -------------------------------------------------------------------------
  // Private dispatch helpers
  // -------------------------------------------------------------------------

  /** Signed request + JSON-parse + 2xx assertion. */
  private async call<T>(
    method: string,
    path: string,
    query: Record<string, string> | undefined,
    body: unknown | undefined,
    ctx: string,
  ): Promise<T> {
    const res = await this.callRaw(method, path, query, body);
    return this.parseOk<T>(res, ctx);
  }

  /** Signed request, returns raw HttpResponse without 2xx enforcement.
   *  Used by callers that need to branch on specific non-2xx (e.g.
   *  `serviceConfig` treats 404 as "no config set" → null). */
  private async callRaw(
    method: string,
    path: string,
    query: Record<string, string> | undefined,
    body: unknown | undefined,
  ): Promise<HttpResponse> {
    const queryString = query !== undefined ? buildQueryString(query) : '';
    const bodyBytes =
      body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));

    const signed = await this.signer({ method, path, query: queryString, body: bodyBytes });

    const url = this.baseUrl + path + (queryString !== '' ? '?' + queryString : '');
    const headers: Record<string, string> = {
      'x-did': signed.did,
      'x-timestamp': signed.timestamp,
      'x-nonce': signed.nonce,
      'x-signature': signed.signature,
    };
    const init: HttpRequestInit = { method, headers };
    if (bodyBytes.byteLength > 0) {
      init.body = bodyBytes;
      headers['content-type'] = 'application/json';
    }
    return this.httpClient.request(url, init);
  }

  /** Decode JSON body + throw on non-2xx. Surfaces Core errors to Brain. */
  private parseOk<T>(res: HttpResponse, ctx: string): T {
    const text = res.body.byteLength > 0 ? new TextDecoder().decode(res.body) : '';
    let parsed: unknown = undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `HttpCoreTransport: ${ctx} returned non-JSON body (status ${res.status})`,
        );
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const err = (parsed as { error?: string } | undefined)?.error ?? 'no error field';
      throw new Error(`HttpCoreTransport: ${ctx} failed ${res.status} — ${err}`);
    }
    return parsed as T;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * URL-encode a flat string map into a query string. Stable key order
 * (sorted) so the canonical-signing path stays deterministic — the
 * signer sees the same query string this function builds. No leading
 * `?`; caller prepends.
 */
function buildQueryString(query: Record<string, string>): string {
  const keys = Object.keys(query).sort();
  return keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? '')}`)
    .join('&');
}

/**
 * Uint8Array → base64 without a Buffer dep. Uses the built-in
 * `btoa(String.fromCharCode(...bytes))` path. Safe for the payload
 * sizes we round-trip through /v1/did/sign (a few KB at most).
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Small chunks to avoid arg-limit crashes on large inputs.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return (globalThis as { btoa?: (s: string) => string }).btoa?.(binary) ??
    // Node before 16 lacks globalThis.btoa; fall back via Buffer when
    // present. @dina/core doesn't depend on Node, but this path keeps
    // tests working when running under jest+node.
    (globalThis as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } })
      .Buffer!.from(binary, 'binary')
      .toString('base64');
}
