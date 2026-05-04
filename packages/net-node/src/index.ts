/**
 * `@dina/net-node` — network adapter for the Node build target.
 *
 * Provides two capabilities:
 *   1. **HTTP client** (`NodeHttpClient`, task 3.35) — implements
 *      `@dina/core`'s `HttpClient` interface using the global `fetch`
 *      that Node 22+ ships with (undici internally). Suitable as the
 *      DI target for `HttpCoreTransport`.
 *   2. **Signed-request builder** (`createCanonicalRequestSigner`,
 *      task 3.35) — produces `CanonicalRequestSigner` implementations
 *      that Brain's HttpCoreTransport consumes. Composes
 *      `@dina/protocol.buildCanonicalPayload` with an Ed25519 sign
 *      function the caller supplies (typically
 *      `@dina/crypto-node.NodeCryptoAdapter.ed25519Sign`).
 *
 * Phase 3d task roadmap:
 *   - 3.34 ✅ Scaffold
 *   - 3.35 ✅ HTTP client + signed-request builder
 *   - 3.36 ✅ Retry with exponential backoff
 *   - 3.37 ✅ WebSocket client (uses `ws` peer dep, perMessageDeflate off)
 *   - 3.38 ✅ Reconnect helper (computeReconnectDelay)
 *   - 3.39    Unit tests (covered as impls land)
 *
 * **No ambient `node:http` / `ws` imports at this module level.**
 * The `ws` peer dep is an optional dynamic-import pattern (landing
 * with task 3.37). Global `fetch` is built into Node 22+ so no
 * `undici` dep is needed for the HTTP client.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 3d.
 */

import type { HttpClient, HttpRequestInit, HttpResponse, CanonicalRequestSigner } from '@dina/core';
import { buildCanonicalPayload } from '@dina/protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Re-export core's port types so consumers of net-node see a flat surface.
export type { HttpClient, HttpRequestInit, HttpResponse, CanonicalRequestSigner };

// ---------------------------------------------------------------------------
// HTTP client (task 3.35)
// ---------------------------------------------------------------------------

/**
 * Node `HttpClient` implementation backed by the global `fetch`.
 *
 * Node 22+ ships `globalThis.fetch` by default (undici under the hood)
 * — no npm dep needed. Consumers inject this into `HttpCoreTransport`
 * the same way mobile could inject a React Native fetch.
 *
 * Lowercases response headers per the core port's convention. Body
 * arrives as a Node Buffer-Like which we coerce into a plain
 * `Uint8Array` view (no copy).
 *
 * Fetch options passed through:
 *   - `method`, `headers`, `body` as given
 *   - `signal` when `options.timeoutMs` is set (AbortController)
 *
 * NOT implemented here: retry / backoff (task 3.36 — separate helper
 * so callers opt-in per request).
 */
export interface NodeHttpClientOptions {
  /** Request timeout in milliseconds. When set, an AbortController
   *  aborts the fetch after this many ms. Default: no timeout. */
  timeoutMs?: number;
  /** Override the `fetch` function (test hook). Defaults to
   *  `globalThis.fetch`. Type widened to `unknown` to avoid a hard
   *  dependency on the `fetch` types at this module level. */
  fetchFn?: typeof globalThis.fetch;
}

export class NodeHttpClient implements HttpClient {
  private readonly timeoutMs: number | undefined;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: NodeHttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs;
    // Explicit `in` check: if the caller passed `fetchFn: undefined`
    // that's an assertion of "no fetch available in this runtime"
    // and we throw; otherwise fall through to the global.
    const resolved =
      'fetchFn' in options ? options.fetchFn : globalThis.fetch;
    if (typeof resolved !== 'function') {
      throw new Error(
        'net-node: global fetch is not available (Node 22+ required); pass options.fetchFn explicitly',
      );
    }
    this.fetchFn = resolved;
  }

  async request(url: string, init: HttpRequestInit): Promise<HttpResponse> {
    const controller = this.timeoutMs !== undefined ? new AbortController() : null;
    const timer =
      controller !== null
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;
    try {
      const fetchInit: RequestInit = {
        method: init.method,
        headers: init.headers,
      };
      if (init.body !== undefined) {
        // Node's undici fetch accepts Uint8Array / ArrayBuffer / string
        // / etc. for `body`. We only produce Uint8Array (from
        // HttpCoreTransport), so this coerces cleanly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchInit.body = init.body as any;
      }
      if (controller !== null) {
        fetchInit.signal = controller.signal;
      }

      const res = await this.fetchFn(url, fetchInit);
      const bodyBuf = new Uint8Array(await res.arrayBuffer());

      // Flatten headers to a plain { lowercase: value } record — matches
      // the HttpResponse contract. `res.headers.forEach` yields
      // already-lowercase keys per the Fetch spec.
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: res.status,
        headers,
        body: bodyBuf,
      };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Signed-request builder (task 3.35)
// ---------------------------------------------------------------------------

/** A raw Ed25519 signer — takes privateKey + message bytes, returns the
 *  64-byte signature. Matches `NodeCryptoAdapter.ed25519Sign` shape
 *  exactly but without the async wrapper (callers typically inject the
 *  async one; we await it below). */
export type Ed25519SignFn = (
  privateKey: Uint8Array,
  message: Uint8Array,
) => Promise<Uint8Array> | Uint8Array;

/** Produce a random nonce of the given byte length. Caller typically
 *  injects `crypto.randomBytes` (node built-in) or
 *  `NodeCryptoAdapter.randomBytes`. */
export type NonceFn = (byteLen: number) => Promise<Uint8Array> | Uint8Array;

/** Clock source for the request timestamp. Defaults to `Date.now()`. */
export type NowFn = () => number;

export interface CanonicalRequestSignerConfig {
  /** The signer's DID — attached as the `X-DID` header. */
  did: string;
  /** 32-byte Ed25519 private-key seed. */
  privateKey: Uint8Array;
  /** Ed25519 sign function. Inject
   *  `(priv, msg) => NodeCryptoAdapter.ed25519Sign(priv, msg)` in prod,
   *  or any shape-compatible test signer. */
  sign: Ed25519SignFn;
  /** Random-bytes source. Defaults to `node:crypto.randomBytes` via
   *  the built-in CSPRNG. Test-time callers can inject a deterministic
   *  one. */
  nonce?: NonceFn;
  /** Clock source. Defaults to `Date.now`. Test-time callers can pin
   *  this to a fixed value for reproducible signatures. */
  now?: NowFn;
}

/**
 * Construct a `CanonicalRequestSigner` — the signer shape
 * `HttpCoreTransport` expects for its DI point. Signs each request
 * with the config's Ed25519 key using Dina's canonical payload:
 *
 *     METHOD\nPATH\nQUERY\nTIMESTAMP\nNONCE\nSHA256_HEX(BODY)
 *
 * Timestamp is RFC-3339-like (ISO 8601 UTC). Nonce is 16 random
 * bytes hex-encoded (32 hex chars). Core's auth middleware verifies
 * with this exact recipe.
 */
export function createCanonicalRequestSigner(
  config: CanonicalRequestSignerConfig,
): CanonicalRequestSigner {
  const nonceFn = config.nonce ?? defaultNonce;
  const nowFn = config.now ?? Date.now;

  return async ({ method, path, query, body }) => {
    const timestamp = new Date(nowFn()).toISOString();
    const nonceBytes = await Promise.resolve(nonceFn(16));
    const nonce = bytesToHex(nonceBytes);
    const bodyHash = bytesToHex(sha256(body));

    const canonical = buildCanonicalPayload(method, path, query, timestamp, nonce, bodyHash);
    const sigBytes = await Promise.resolve(
      config.sign(config.privateKey, new TextEncoder().encode(canonical)),
    );

    return {
      did: config.did,
      timestamp,
      nonce,
      signature: bytesToHex(sigBytes),
    };
  };
}

/**
 * Default nonce source — `node:crypto.randomBytes` via a late-bound
 * import so the module doesn't create an ambient dep at load time.
 * Returns a plain Uint8Array view (not a Buffer subclass).
 */
async function defaultNonce(byteLen: number): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = await import('node:crypto');
  const buf = randomBytes(byteLen);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff (task 3.36)
// ---------------------------------------------------------------------------

/**
 * Defaults chosen to match `@dina/core`'s existing retry policy:
 * 3 retries, 1s initial delay, 2x backoff, jitter [0.5, 1.5) × delay.
 */
export const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1_000,
  backoffFactor: 2,
  /** Statuses that are known-won't-be-fixed-by-a-retry. Mirrors core's
   *  `isNonRetryableStatus`: auth failures are the caller's problem,
   *  not transient. 4xx other than 408/429 are also non-retryable. */
  nonRetryableStatuses: new Set([400, 401, 403, 404, 409, 410, 422]),
} as const;

export interface RetryConfig {
  /** Maximum number of retry attempts AFTER the initial request
   *  (so maxRetries: 3 means up to 4 total attempts). */
  maxRetries?: number;
  /** Initial delay in ms before the first retry. */
  initialDelayMs?: number;
  /** Multiplier applied to delay after each retry. */
  backoffFactor?: number;
  /** Statuses that should NOT be retried. Defaults to the core set;
   *  callers can pass a different set (e.g. exclude 422 to retry
   *  validation errors on flaky endpoints). */
  nonRetryableStatuses?: ReadonlySet<number>;
  /** Sleep function (test hook — inject a no-op or tick-counter for
   *  tests that don't want real wall-clock delays). Default: real
   *  `setTimeout`. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Jitter factor in [0, 1]. Each retry delay is multiplied by
   *  `1 + (random - 0.5) * 2 * jitter` — `jitter: 0.5` gives
   *  [0.5, 1.5) × delay (matches core). `jitter: 0` disables. */
  jitter?: number;
  /** Entropy source for jitter (test hook). Default: `Math.random`. */
  random?: () => number;
  /** Called on each retry attempt — useful for logging / metrics. */
  onRetry?: (attempt: number, response: HttpResponse | null, error: Error | null) => void;
}

/**
 * Wrap an `HttpClient` with exponential-backoff retries. Use the
 * `retry()` method opt-in per request; the inner `client.request` is
 * still available when a caller explicitly doesn't want retries.
 *
 * Retry policy:
 *   - Network errors (`fetch` throws / aborts) → retry.
 *   - 5xx responses → retry.
 *   - Statuses in `nonRetryableStatuses` → fail fast, return response.
 *   - 408 (timeout) + 429 (rate limit) → retry (they're NOT in the
 *     default non-retryable set).
 *   - After `maxRetries` retries, return the last response or rethrow
 *     the last error.
 */
export class RetryingHttpClient {
  private readonly config: Required<RetryConfig>;

  constructor(
    private readonly inner: HttpClient,
    partialConfig: RetryConfig = {},
  ) {
    this.config = {
      maxRetries: partialConfig.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
      initialDelayMs: partialConfig.initialDelayMs ?? DEFAULT_RETRY_CONFIG.initialDelayMs,
      backoffFactor: partialConfig.backoffFactor ?? DEFAULT_RETRY_CONFIG.backoffFactor,
      nonRetryableStatuses:
        partialConfig.nonRetryableStatuses ?? DEFAULT_RETRY_CONFIG.nonRetryableStatuses,
      sleepMs:
        partialConfig.sleepMs ??
        ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))),
      jitter: partialConfig.jitter ?? 0.5,
      random: partialConfig.random ?? Math.random,
      onRetry: partialConfig.onRetry ?? ((): void => undefined),
    };
  }

  /** The wrapped inner client — use this to opt OUT of retries. */
  get client(): HttpClient {
    return this.inner;
  }

  /**
   * Send `init` to `url`, retrying transient failures per the config.
   * Returns the last response (which may still be 5xx after retries
   * are exhausted) or throws the last error.
   */
  async request(url: string, init: HttpRequestInit): Promise<HttpResponse> {
    let lastError: Error | null = null;
    let lastResponse: HttpResponse | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const baseDelay =
          this.config.initialDelayMs * Math.pow(this.config.backoffFactor, attempt - 1);
        const jittered = baseDelay * (1 + (this.config.random() - 0.5) * 2 * this.config.jitter);
        await this.config.sleepMs(Math.max(0, Math.floor(jittered)));
        this.config.onRetry(attempt, lastResponse, lastError);
      }

      try {
        const response = await this.inner.request(url, init);
        if (this.config.nonRetryableStatuses.has(response.status)) {
          return response; // fail-fast; caller handles the 4xx
        }
        // Retry on 5xx + 408 (request timeout) + 429 (rate limit).
        // These are the IETF-blessed transient failures.
        const isTransient =
          (response.status >= 500 && response.status <= 599) ||
          response.status === 408 ||
          response.status === 429;
        if (isTransient) {
          lastResponse = response;
          lastError = null;
          continue;
        }
        return response; // 1xx/2xx/3xx → success
      } catch (err) {
        // Network-level failure (fetch throw, abort, DNS, etc.) — retry.
        lastError = err instanceof Error ? err : new Error(String(err));
        lastResponse = null;
      }
    }

    if (lastError !== null) throw lastError;
    // Exhausted retries on a 5xx — return the last response so the
    // caller can still observe the status instead of raising.
    if (lastResponse !== null) return lastResponse;
    throw new Error('net-node: retry loop exited without a response or error (unreachable)');
  }
}

// ---------------------------------------------------------------------------
// WebSocket client (task 3.37)
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket contract the Node client exposes. Shape mirrors
 * `@dina/core`'s `WSLike` interface so this adapter drops in via the
 * `setWSFactory` injection point. Browser-style event fields
 * (`onopen` / `onmessage` / `onclose` / `onerror`) rather than the
 * `.on('event', cb)` EventEmitter style — matches both React Native's
 * WebSocket and `ws` package v8+.
 */
export interface WebSocketClient {
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  /** WebSocket readyState constants: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. */
  readyState: number;
}

export type WebSocketFactory = (url: string) => WebSocketClient;

export interface NodeWebSocketOptions {
  /** Inject an alternate `ws` module (test hook). Defaults to the
   *  late-bound `require('ws')` so callers on runtimes without `ws`
   *  can still import this package. */
  wsModule?: { WebSocket: new (url: string, options?: unknown) => unknown };
}

/**
 * Create a `WebSocketClient` over `url` using the `ws` peer dep. The
 * `compression: false` option mirrors the fix from CLAUDE.md
 * ("Python `websockets` client needs `compression=None`; default
 * permessage-deflate sets RSV1; Go's `coder/websocket` closes with
 * 1002 protocol error"). Core's Go runtime closes on RSV1 frames,
 * so any Node client talking to it must disable compression.
 *
 * Returns `null` when `ws` isn't installed — callers should fall back
 * to whatever alternate transport makes sense (or surface a clear
 * missing-dep error to the user).
 */
export async function createNodeWebSocket(
  url: string,
  options: NodeWebSocketOptions = {},
): Promise<WebSocketClient | null> {
  const wsModule = options.wsModule ?? (await loadWsModule());
  if (wsModule === null) return null;

  const ws = new wsModule.WebSocket(url, { perMessageDeflate: false }) as {
    send(data: string | Uint8Array | ArrayBuffer): void;
    close(): void;
    readyState: number;
    on(event: 'open' | 'message' | 'close' | 'error', cb: (...args: unknown[]) => void): void;
  };

  return adaptWsInstance(ws);
}

/**
 * Build the synchronous factory shape `@dina/core`'s MsgBox runtime
 * expects. Production Core server boot uses this path; tests inject a
 * fake factory to avoid real network IO.
 */
export function makeNodeWebSocketFactory(
  options: NodeWebSocketOptions = {},
): WebSocketFactory {
  return (url: string) => {
    const wsModule = options.wsModule ?? loadWsModuleSync();
    if (wsModule === null) {
      throw new Error('net-node: ws package is not installed; add ws to the runtime dependencies');
    }
    const ws = new wsModule.WebSocket(url, { perMessageDeflate: false }) as {
      send(data: string | Uint8Array | ArrayBuffer): void;
      close(): void;
      readyState: number;
      on(event: 'open' | 'message' | 'close' | 'error', cb: (...args: unknown[]) => void): void;
    };
    return adaptWsInstance(ws);
  };
}

function adaptWsInstance(ws: {
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(): void;
  readyState: number;
  on(event: 'open' | 'message' | 'close' | 'error', cb: (...args: unknown[]) => void): void;
}): WebSocketClient {
  // Adapter: the `ws` package uses `.on('event', cb)` emitter API.
  // We expose browser-style `onopen/onmessage/onclose/onerror`
  // properties the WSLike contract expects. Each property is late-
  // assigned by the caller; our wiring here forwards emitter events
  // to whichever callback is currently set.
  const client: WebSocketClient = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    get readyState() {
      return ws.readyState;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  ws.on('open', () => client.onopen?.());
  ws.on('message', (...args) => {
    const raw = args[0];
    // `ws` delivers a Buffer by default; the WSLike contract says
    // `{ data: string }`. Coerce on the way through.
    const data = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
    client.onmessage?.({ data });
  });
  ws.on('close', (...args) => {
    const code = args[0];
    const reason = args[1];
    client.onclose?.({
      code: typeof code === 'number' ? code : 1006,
      reason:
        reason instanceof Uint8Array
          ? new TextDecoder().decode(reason)
          : reason !== undefined
            ? String(reason)
            : '',
    });
  });
  ws.on('error', (...args) => client.onerror?.(args[0]));

  return client;
}

/**
 * Late-bound dynamic `require('ws')`. Returns `null` when the
 * package isn't installed — `ws` is an optional peer dep so the
 * runtime may legitimately not have it. Callers decide what to do
 * with the null (fall back, error, warn).
 */
async function loadWsModule(): Promise<{
  WebSocket: new (url: string, options?: unknown) => unknown;
} | null> {
  try {
    const mod = (await import('ws')) as unknown as {
      default?: { WebSocket: new (url: string, options?: unknown) => unknown };
      WebSocket?: new (url: string, options?: unknown) => unknown;
    };
    // `ws` v8 exports the class as `default.WebSocket` under ESM
    // resolution + as a named `WebSocket` under CJS. Handle both.
    if (mod.WebSocket !== undefined) return { WebSocket: mod.WebSocket };
    if (mod.default !== undefined && mod.default.WebSocket !== undefined) {
      return { WebSocket: mod.default.WebSocket };
    }
    return null;
  } catch {
    return null;
  }
}

function loadWsModuleSync(): {
  WebSocket: new (url: string, options?: unknown) => unknown;
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('ws') as {
      WebSocket?: new (url: string, options?: unknown) => unknown;
      default?: { WebSocket?: new (url: string, options?: unknown) => unknown };
    };
    if (mod.WebSocket !== undefined) return { WebSocket: mod.WebSocket };
    if (mod.default?.WebSocket !== undefined) return { WebSocket: mod.default.WebSocket };
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reconnect helper (task 3.38)
// ---------------------------------------------------------------------------

/** Reconnect backoff config — matches `@dina/core/src/relay/msgbox_ws.ts`
 *  constants by default (1s base, 60s cap, doubling). */
export interface ReconnectDelayConfig {
  /** First retry delay in ms. Default 1000. */
  baseDelayMs?: number;
  /** Cap on the computed delay. Default 60_000 (60s). */
  maxDelayMs?: number;
  /** Backoff factor. Default 2 (doubling). */
  backoffFactor?: number;
  /** Jitter factor in [0, 1] — a value of 0.25 gives
   *  [0.75x, 1.25x] × computed delay. Default 0 (deterministic). */
  jitter?: number;
  /** Entropy source for jitter. Default Math.random. */
  random?: () => number;
}

/**
 * Compute the delay (in ms) before the next reconnect attempt.
 *
 * Deterministic by default (no jitter) so tests observing exact
 * timings don't need to pin an RNG. Matches the Go port's convention:
 *
 *     min(baseDelay × backoff^attempt, maxDelay)
 *
 * `attempt` is 0-indexed: attempt=0 = first retry after disconnect.
 *
 * Add jitter in production callers to spread the "thundering herd"
 * when many clients reconnect simultaneously after a server restart.
 */
export function computeReconnectDelay(
  attempt: number,
  config: ReconnectDelayConfig = {},
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`net-node: reconnect attempt must be a non-negative integer, got ${attempt}`);
  }
  const base = config.baseDelayMs ?? 1_000;
  const max = config.maxDelayMs ?? 60_000;
  const factor = config.backoffFactor ?? 2;
  const jitter = config.jitter ?? 0;
  const random = config.random ?? Math.random;

  const computed = Math.min(base * Math.pow(factor, attempt), max);
  if (jitter === 0) return Math.floor(computed);
  const jittered = computed * (1 + (random() - 0.5) * 2 * jitter);
  // Clamp the jittered value to [0, max] — large jitter on the last
  // uncapped step could otherwise spike above max.
  return Math.max(0, Math.min(max, Math.floor(jittered)));
}
