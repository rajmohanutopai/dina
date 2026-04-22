/**
 * Task 5.9 (half B) — Node HttpClient adapter over `globalThis.fetch`.
 *
 * The transport half of the signed-HTTP client. `HttpCoreTransport`
 * (task 1.31) is platform-agnostic: it accepts an injected
 * `HttpClient` whose surface is a minimal Fetch subset. This module
 * adapts Node's built-in `fetch` (available since Node 18) into that
 * shape without pulling in `undici` / `node-fetch` / `axios`.
 *
 * **Why a custom adapter, not just pass `fetch` directly**:
 *
 *   - The `HttpCoreTransport` contract is `(url, init) → {status,
 *     headers, body}` where `body` is parsed JSON. Native fetch
 *     returns a `Response` whose `headers` is a `Headers` object and
 *     whose body must be awaited separately. The adapter normalises.
 *   - Errors split cleanly: network / DNS / abort → thrown
 *     `NetworkError`; HTTP 4xx/5xx → resolved outcome with the
 *     status (callers decide whether to treat as error). This
 *     distinction matters for `retryWithBackoff` (task 5.11) which
 *     distinguishes retryable transport failures from caller bugs.
 *   - AbortSignal, body encoding, default timeout all live here so
 *     the transport layer stays single-purpose.
 *
 * **Zero-dep**: everything is built on `node:*`. No `undici` import
 * even though Node exposes it — relying on `globalThis.fetch` means
 * the adapter runs under Bun, Deno, edge runtimes unchanged.
 *
 * **What's NOT here**: signing. Signing is 5.9 half A + the future
 * `CanonicalRequestSigner` composition layer. This module is only
 * the wire send/receive.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5b task 5.9.
 */

export interface HttpResponse {
  /** HTTP status code. */
  status: number;
  /** Response headers as a plain object — header names lower-cased. */
  headers: Record<string, string>;
  /** Parsed JSON body, or `null` if empty / non-JSON. */
  body: unknown;
  /** Raw response text — useful for non-JSON error responses. */
  text: string;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Absolute URL. */
  url: string;
  /** Request headers — values are passed through verbatim. */
  headers?: Record<string, string>;
  /** JSON-serialisable body. When present, `content-type: application/json` is set. */
  body?: unknown;
  /** Abort signal — honoured by native fetch. */
  signal?: AbortSignal;
  /**
   * Hard timeout in ms. When set, the adapter creates an internal
   * AbortController + combines it with the caller's signal. Any
   * expiry throws `NetworkError` with `reason: 'timeout'`.
   */
  timeoutMs?: number;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export type NetworkErrorReason =
  | 'aborted'
  | 'timeout'
  | 'dns'
  | 'connection'
  | 'tls'
  | 'body_parse'
  | 'unknown';

export class NetworkError extends Error {
  constructor(
    public readonly reason: NetworkErrorReason,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface CreateNodeHttpClientOptions {
  /** Injectable fetch — defaults to `globalThis.fetch`. Tests pass a stub. */
  fetchFn?: typeof fetch;
  /** Default timeout applied to every request unless the call overrides. */
  defaultTimeoutMs?: number;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * Build a fetch-backed HTTP client. The returned function is
 * stateless — safe to share across concurrent requests.
 */
export function createNodeHttpClient(
  opts: CreateNodeHttpClientOptions = {},
): HttpClient {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new TypeError(
      'createNodeHttpClient: fetch is not available in this runtime — provide `fetchFn`',
    );
  }
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

  return async function nodeHttpClient(req: HttpRequest): Promise<HttpResponse> {
    validateRequest(req);

    // Combine caller signal + internal timeout into one AbortController.
    const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
    const controller = new AbortController();
    const callerSignal = req.signal;
    const timeoutHandle =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
        : null;
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const init: RequestInit = {
      method: req.method,
      signal: controller.signal,
      headers: buildHeaders(req),
    };
    if (req.body !== undefined && req.method !== 'GET' && req.method !== 'DELETE') {
      init.body = JSON.stringify(req.body);
    }

    let response: Response;
    try {
      response = await fetchFn(req.url, init);
    } catch (err) {
      throw classifyNetworkError(err, callerSignal, timeoutMs);
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    }

    const text = await response.text();
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch (err) {
        // Non-JSON response body — leave body null; caller reads `text` for details.
        // (4xx error responses from non-Dina layers may be HTML; don't throw.)
        body = null;
        // Only treat as a parse error when we expected JSON AND the
        // status is a success — mid-2xx with bad JSON is a server
        // bug the caller wants to see as an error.
        if (response.status >= 200 && response.status < 300) {
          throw new NetworkError(
            'body_parse',
            `response body is not valid JSON: ${String(err instanceof Error ? err.message : err)}`,
            err,
          );
        }
      }
    }

    return {
      status: response.status,
      headers: normaliseHeaders(response.headers),
      body,
      text,
    };
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateRequest(req: HttpRequest): void {
  if (!req || typeof req !== 'object') {
    throw new TypeError('HttpClient: request is required');
  }
  const { method, url } = req;
  if (
    method !== 'GET' &&
    method !== 'POST' &&
    method !== 'PUT' &&
    method !== 'DELETE' &&
    method !== 'PATCH'
  ) {
    throw new TypeError(`HttpClient: invalid method "${String(method)}"`);
  }
  if (typeof url !== 'string' || url === '') {
    throw new TypeError('HttpClient: url must be a non-empty string');
  }
}

function buildHeaders(req: HttpRequest): Record<string, string> {
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (
    req.body !== undefined &&
    req.method !== 'GET' &&
    req.method !== 'DELETE' &&
    !hasHeader(headers, 'content-type')
  ) {
    headers['content-type'] = 'application/json';
  }
  if (!hasHeader(headers, 'accept')) {
    headers['accept'] = 'application/json';
  }
  return headers;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return true;
  }
  return false;
}

function normaliseHeaders(src: Headers | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!src) return out;
  if (typeof (src as Headers).forEach === 'function') {
    (src as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  // Plain object fallback (e.g. test stubs).
  for (const [k, v] of Object.entries(src as Record<string, string>)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function classifyNetworkError(
  err: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): NetworkError {
  // AbortError — distinguish caller-abort from timeout-abort.
  const name = (err as { name?: string } | null)?.name;
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'AbortError' || /aborted/i.test(message)) {
    if (callerSignal?.aborted) {
      return new NetworkError('aborted', 'request aborted by caller', err);
    }
    if (timeoutMs > 0) {
      return new NetworkError('timeout', `request timed out after ${timeoutMs}ms`, err);
    }
    return new NetworkError('aborted', message || 'request aborted', err);
  }
  const code = (err as { code?: unknown } | { cause?: { code?: unknown } } | null);
  const codeVal =
    typeof (code as { code?: unknown } | null)?.code === 'string'
      ? ((code as { code: string }).code)
      : typeof (code as { cause?: { code?: unknown } } | null)?.cause?.code === 'string'
        ? ((code as { cause: { code: string } }).cause.code)
        : null;
  if (codeVal === 'ENOTFOUND' || codeVal === 'EAI_AGAIN') {
    return new NetworkError('dns', message, err);
  }
  if (
    codeVal === 'ECONNREFUSED' ||
    codeVal === 'ECONNRESET' ||
    codeVal === 'ETIMEDOUT' ||
    codeVal === 'EHOSTUNREACH'
  ) {
    return new NetworkError('connection', message, err);
  }
  if (
    codeVal === 'CERT_HAS_EXPIRED' ||
    codeVal === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    /SSL|TLS|certificate/i.test(message)
  ) {
    return new NetworkError('tls', message, err);
  }
  return new NetworkError('unknown', message, err);
}
