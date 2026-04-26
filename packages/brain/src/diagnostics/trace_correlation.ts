/**
 * Task 5.58 — trace correlation (`request_id` propagation).
 *
 * A single user-facing request (e.g. `POST /api/v1/ask`) fans out
 * into many internal calls:
 *
 *   Brain `/api/v1/ask` → ModelRouter → provider adapter → Core
 *   `/v1/vault/query` → Core `/v1/pii/scrub` → external LLM → back.
 *
 * Without a trace context, logs + metrics can't correlate these into
 * one story. This primitive threads a `request_id` through every
 * downstream call + log line via Node's `AsyncLocalStorage`, so any
 * code running under `withTrace()` can read the current trace
 * without passing a parameter through six function boundaries.
 *
 * **Contract** (pinned by tests):
 *   - `withTrace(trace, fn)` — run `fn` inside a scope where
 *     `currentTrace()` returns `trace`. The scope extends across
 *     every async `await` inside `fn`.
 *   - `currentTrace()` — returns the current trace or `null` when
 *     called outside any scope.
 *   - `newRequestId()` — 16-byte random hex (32 chars). Each request
 *     gets a fresh id.
 *   - Nested `withTrace()` calls create a **child trace** — the
 *     child's `parentId` is the parent's `requestId`, preserving
 *     the fan-out tree.
 *   - `withChildTrace(fn)` — convenience: reads the current trace,
 *     creates a child with a fresh id + parentId set, runs `fn`
 *     inside.
 *   - `inboundRequestId(rawHeader)` — validates a client-supplied
 *     `X-Request-Id` header. Accepts 16–64 char `[0-9a-z_-]+`;
 *     anything else is rejected (returns null) and the caller
 *     generates a fresh id.
 *   - `headersFor(trace)` — returns an object ready to spread into
 *     `fetch` options: `{ 'x-request-id': <id>, 'x-parent-id'?:
 *     <parent> }`. Parent omitted when absent.
 *
 * **Why AsyncLocalStorage** and not an explicit parameter:
 *   - Explicit threading breaks at every LLM adapter boundary + at
 *     every helper. Forgetting one drops the trace silently.
 *   - AsyncLocalStorage is the Node-native pattern for this; logs
 *     (pino child bindings), metrics (otel), outbound clients all
 *     pick it up from a common context.
 *
 * **Never mutate the trace object** — it's a frozen value. A caller
 * that wants to add a tag creates a child or a new trace.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5h task 5.58.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface TraceContext {
  /** 32-char hex request id. Unique per user-facing request. */
  requestId: string;
  /** Parent request id — null when this IS the root. */
  parentId: string | null;
  /** UTC ms at the moment the trace was created. */
  startedAtMs: number;
}

const storage = new AsyncLocalStorage<TraceContext>();

/**
 * 16-byte random hex — 32 characters. Collision-resistant enough
 * for a request-id even at high throughput (birthday bound ≈ 2^64).
 */
export function newRequestId(): string {
  return randomBytes(16).toString('hex');
}

/** Build a root trace with a fresh id. */
export function newRootTrace(nowMsFn: () => number = () => Date.now()): TraceContext {
  return Object.freeze({
    requestId: newRequestId(),
    parentId: null,
    startedAtMs: nowMsFn(),
  });
}

/** Build a child trace — parentId set to the provided parent's requestId. */
export function newChildTrace(
  parent: TraceContext,
  nowMsFn: () => number = () => Date.now(),
): TraceContext {
  return Object.freeze({
    requestId: newRequestId(),
    parentId: parent.requestId,
    startedAtMs: nowMsFn(),
  });
}

/**
 * Run `fn` inside an async scope bound to `trace`. Any
 * `currentTrace()` call inside `fn` (or its awaited descendants)
 * returns `trace`.
 */
export async function withTrace<T>(trace: TraceContext, fn: () => Promise<T>): Promise<T> {
  if (!isValidTrace(trace)) {
    throw new TypeError('withTrace: invalid trace context');
  }
  return storage.run(trace, fn);
}

/**
 * Convenience: if a trace is already active, derive a child;
 * otherwise create a root. Runs `fn` in the resulting scope.
 */
export async function withChildTrace<T>(
  fn: () => Promise<T>,
  nowMsFn: () => number = () => Date.now(),
): Promise<T> {
  const parent = storage.getStore();
  const trace = parent ? newChildTrace(parent, nowMsFn) : newRootTrace(nowMsFn);
  return storage.run(trace, fn);
}

/** Read the active trace. Returns null when called outside any scope. */
export function currentTrace(): TraceContext | null {
  return storage.getStore() ?? null;
}

/**
 * Validate a client-supplied `X-Request-Id` header. Accepts 16–64
 * characters of `[0-9a-z_-]+`; everything else is rejected so a
 * malicious client can't inject log-line separators or ANSI
 * sequences through the request id.
 */
export function inboundRequestId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 16 || trimmed.length > 64) return null;
  if (!/^[0-9a-z_-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Build the headers an outbound request should carry to propagate
 * the trace. Spread into `fetch` options or the signed-HTTP client.
 * Returns only non-empty fields.
 */
export function headersFor(trace: TraceContext): Record<string, string> {
  const out: Record<string, string> = { 'x-request-id': trace.requestId };
  if (trace.parentId !== null) out['x-parent-id'] = trace.parentId;
  return out;
}

/**
 * Convenience: merge trace headers into an existing headers object.
 * The caller's headers win on conflict — explicit always beats
 * implicit.
 */
export function mergeTraceHeaders(
  trace: TraceContext,
  headers: Record<string, string> = {},
): Record<string, string> {
  return { ...headersFor(trace), ...headers };
}

/**
 * Log-binding helper — returns the fields a structured logger
 * (pino, slog) should pin to every log line under the current
 * scope. Safe to call outside a scope (returns `{}`).
 */
export function logBindings(): Record<string, string> {
  const trace = currentTrace();
  if (!trace) return {};
  const out: Record<string, string> = { request_id: trace.requestId };
  if (trace.parentId !== null) out.parent_id = trace.parentId;
  return out;
}

// ── Internals ──────────────────────────────────────────────────────────

function isValidTrace(t: unknown): t is TraceContext {
  if (t === null || typeof t !== 'object') return false;
  const c = t as Partial<TraceContext>;
  if (typeof c.requestId !== 'string' || c.requestId.length === 0) return false;
  if (c.parentId !== null && typeof c.parentId !== 'string') return false;
  if (typeof c.startedAtMs !== 'number' || !Number.isFinite(c.startedAtMs)) {
    return false;
  }
  return true;
}
