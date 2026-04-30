/**
 * PLC-op submission with retry + backoff (TN-IDENT-006).
 *
 * Pure-ish HTTP submitter for signed `plc_operation` payloads. The
 * composer side (TN-IDENT-005, `plc_namespace_update.ts`) is fully
 * deterministic; this module owns the network I/O and the retry
 * policy.
 *
 * Retry classification:
 *
 *   - 2xx → success. Return immediately.
 *   - 4xx → deterministic client error (bad sig, malformed op, stale
 *     `prev`, fragment collision PLC caught after we missed it).
 *     **Do not retry.** Re-submitting the same body will fail the
 *     same way and only adds load to the directory; the caller has
 *     to fix the input.
 *   - 5xx → server error. Retry with exponential backoff.
 *   - Network error / fetch throws / non-4xx-non-5xx unexpected
 *     status → retry with backoff.
 *   - Total attempts capped (default 5). After exhaustion, throw a
 *     classified error.
 *
 * Backoff: 500ms → 1s → 2s → 4s → 8s (base 500ms × 2^attempt). The
 * shorter base than transport/outbox.ts (which uses 30s) reflects
 * that PLC submission is a foreground user action — the caller is
 * watching a spinner, not a background outbox.
 *
 * Determinism + testability: caller injects `fetch` and `sleep`. The
 * default `sleep` is real-time, but tests pass a mock that
 * synchronously resolves; this avoids `jest.useFakeTimers()`
 * tangling with promise microtasks.
 */

import { DEFAULT_PLC_DIRECTORY } from '../constants';

/** Default total attempts including the first try. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** Default base delay in ms for exponential backoff. */
export const DEFAULT_BACKOFF_BASE_MS = 500;

/**
 * Compute the delay before the next retry given how many attempts have
 * already failed (1 = the first attempt failed, return delay before #2).
 *
 * Sequence with default base 500: 500ms → 1s → 2s → 4s → 8s.
 */
export function computePLCBackoff(failedAttempts: number, baseMs = DEFAULT_BACKOFF_BASE_MS): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
    throw new Error(
      `plc_submit: failedAttempts must be a positive integer, got ${failedAttempts}`,
    );
  }
  // Math.pow(2, n-1) for n=1..5 → 1, 2, 4, 8, 16. Multiplied by base
  // gives 500ms, 1s, 2s, 4s, 8s for the default base.
  return baseMs * Math.pow(2, failedAttempts - 1);
}

export interface SubmitPlcOperationConfig {
  /**
   * Fetch implementation. Defaults to `globalThis.fetch`. Tests inject
   * a mock that returns canned responses.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Sleep implementation in ms. Defaults to `setTimeout`-backed sleep.
   * Tests inject a synchronous resolver to avoid real timer tangling.
   */
  sleep?: (ms: number) => Promise<void>;

  /** PLC directory base URL. Defaults to `DEFAULT_PLC_DIRECTORY`. */
  plcURL?: string;

  /** Max total attempts including the first try. Default `DEFAULT_MAX_ATTEMPTS` (5). */
  maxAttempts?: number;

  /** Base delay in ms for exponential backoff. Default `DEFAULT_BACKOFF_BASE_MS` (500). */
  backoffBaseMs?: number;
}

export interface SubmitPlcOperationParams {
  /** The DID this op binds to (e.g. `did:plc:xxxx`). Becomes the path. */
  did: string;
  /** The signed PLC operation envelope (output of `composeAndSign...`). */
  signedOperation: Record<string, unknown>;
}

export interface SubmitPlcOperationResult {
  /** HTTP status code from the successful (2xx) response. */
  status: number;
  /** Response body as parsed JSON, or null when the body wasn't JSON. */
  body: unknown;
  /** Number of attempts made (1 = succeeded on first try). */
  attempts: number;
}

/**
 * Classified failure from `submitPlcOperation`. Distinguishes
 * permanent client errors (no point retrying) from exhausted
 * transient retries — callers may want to surface different UI for
 * each.
 */
export class PLCSubmitError extends Error {
  readonly kind: 'client' | 'exhausted' | 'invalid_input';
  /** HTTP status (when `kind === 'client'` or final attempt was 5xx). */
  readonly status?: number;
  /** Response body text from the final attempt, if any. */
  readonly responseText?: string;
  /** Total attempts made before giving up. */
  readonly attempts: number;
  /** The underlying network/parse error if no HTTP response was obtained. */
  readonly cause?: unknown;

  constructor(args: {
    kind: 'client' | 'exhausted' | 'invalid_input';
    message: string;
    status?: number;
    responseText?: string;
    attempts: number;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = 'PLCSubmitError';
    this.kind = args.kind;
    if (args.status !== undefined) this.status = args.status;
    if (args.responseText !== undefined) this.responseText = args.responseText;
    this.attempts = args.attempts;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}

/**
 * Submit a signed PLC operation to the directory with bounded retry.
 *
 * The body is `JSON.stringify(signedOperation)` — `Content-Type:
 * application/json`. The DID is appended to the directory base URL
 * (no trailing slash) per PLC spec.
 */
export async function submitPlcOperation(
  params: SubmitPlcOperationParams,
  config: SubmitPlcOperationConfig = {},
): Promise<SubmitPlcOperationResult> {
  validateDID(params.did);

  const fetchFn = config.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new PLCSubmitError({
      kind: 'invalid_input',
      message:
        'plc_submit: no fetch available — pass `config.fetch` or run in a runtime with `globalThis.fetch`',
      attempts: 0,
    });
  }
  const sleep = config.sleep ?? defaultSleep;
  const plcURL = (config.plcURL ?? DEFAULT_PLC_DIRECTORY).replace(/\/+$/, '');
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new PLCSubmitError({
      kind: 'invalid_input',
      message: `plc_submit: maxAttempts must be a positive integer, got ${maxAttempts}`,
      attempts: 0,
    });
  }

  const url = `${plcURL}/${params.did}`;
  const body = JSON.stringify(params.signedOperation);

  let lastError: unknown;
  let lastStatus: number | undefined;
  let lastResponseText: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (response.status >= 200 && response.status < 300) {
        const parsed = await safeJSON(response);
        return { status: response.status, body: parsed, attempts: attempt };
      }

      // 4xx — permanent. PLC has rejected the op shape/sig/prev; retry
      // with the same body will fail identically and waste capacity.
      if (response.status >= 400 && response.status < 500) {
        const text = await safeText(response);
        throw new PLCSubmitError({
          kind: 'client',
          message: `plc_submit: client error HTTP ${response.status} from PLC directory — ${text || '(empty body)'}`,
          status: response.status,
          responseText: text,
          attempts: attempt,
        });
      }

      // 5xx (or unexpected non-2xx-non-4xx, e.g. 3xx) → transient, retry.
      lastStatus = response.status;
      lastResponseText = await safeText(response);
      lastError = new Error(`HTTP ${response.status}: ${lastResponseText || '(empty body)'}`);
    } catch (err) {
      // PLCSubmitError with kind 'client' is permanent — re-throw so the
      // retry loop doesn't swallow it.
      if (err instanceof PLCSubmitError && err.kind === 'client') throw err;
      lastError = err;
    }

    // If we just used our last attempt, fall through to the throw below.
    if (attempt < maxAttempts) {
      await sleep(computePLCBackoff(attempt, backoffBaseMs));
    }
  }

  throw new PLCSubmitError({
    kind: 'exhausted',
    message: `plc_submit: gave up after ${maxAttempts} attempts. Last status: ${lastStatus ?? '(network error)'}.`,
    ...(lastStatus !== undefined ? { status: lastStatus } : {}),
    ...(lastResponseText !== undefined ? { responseText: lastResponseText } : {}),
    attempts: maxAttempts,
    cause: lastError,
  });
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function validateDID(did: string): void {
  if (typeof did !== 'string' || did.length === 0) {
    throw new PLCSubmitError({
      kind: 'invalid_input',
      message: 'plc_submit: did must be a non-empty string',
      attempts: 0,
    });
  }
  if (!did.startsWith('did:plc:')) {
    throw new PLCSubmitError({
      kind: 'invalid_input',
      message: `plc_submit: did must start with "did:plc:", got "${did}"`,
      attempts: 0,
    });
  }
  // Path-traversal defence — even though the directory base URL is
  // trusted, the DID is concatenated into the URL path. Reject the
  // characters that would let a caller break out into unrelated
  // endpoints (`/`, `?`, `#`, whitespace, control bytes).
  if (/[\s/?#]/.test(did)) {
    throw new PLCSubmitError({
      kind: 'invalid_input',
      message: `plc_submit: did contains forbidden characters (whitespace, "/", "?", "#"): ${JSON.stringify(did)}`,
      attempts: 0,
    });
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJSON(response: Response): Promise<unknown> {
  // PLC's success response is typically empty or a small JSON envelope.
  // Tolerate either — a non-JSON 2xx body shouldn't be an error for
  // the caller, just return null.
  const text = await safeText(response);
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
