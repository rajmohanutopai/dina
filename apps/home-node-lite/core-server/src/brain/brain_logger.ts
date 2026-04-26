/**
 * Task 5.52 — structured logging matching Core's slog field names.
 *
 * Core emits structured logs using Go's `log/slog`. The Home Node
 * Lite Brain must use the SAME field-name scheme so ops tooling
 * (log aggregation, alerting rules, dashboards) works identically
 * across the two services:
 *
 *   `req_id`    — request correlation id (maps to brain's TraceContext.requestId).
 *   `method`    — HTTP method.
 *   `path`      — request path.
 *   `status`    — HTTP status.
 *   `duration`  — request latency. Emitted as ms number (not Go Duration).
 *   `did`       — DID of the signing service / actor.
 *   `service`   — which service emitted the line ("brain" / "core" / …).
 *   `error`     — error message (short, safe for ops).
 *   `stack`     — stack trace (only included on explicit opt-in).
 *   `caller`    — file:line of the log site.
 *   `client_msg`— safe-to-show-user message for 4xx/5xx responses.
 *
 * **What this primitive provides**:
 *
 *   1. **Field-name normaliser**. Callers can pass common aliases —
 *      `requestId`, `requestID`, `http_status`, `latencyMs` — and
 *      the logger maps them to Core's canonical names. Prevents
 *      field-name drift at the edges.
 *   2. **Reserved-name validation**. Unknown fields are allowed
 *      but emitted in a `extra` sub-object so the Core scheme's
 *      flat top-level stays predictable.
 *   3. **Trace auto-enrichment**. Reads the current `TraceContext`
 *      (task 5.58) + attaches `req_id` + `parent_id` when present.
 *   4. **Pluggable sink**. `emit(level, msg, fields)` delegates to
 *      an injected function — production wires pino; tests use an
 *      array-backed sink.
 *   5. **Level filter**. `debug/info/warn/error` per the slog
 *      taxonomy.
 *
 * **Field-name scheme is authoritative** — the normaliser accepts
 * aliases but the EMITTED record always uses Core's names. Tests
 * pin the exact field names.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5g task 5.52.
 */

import { currentTrace } from '@dina/brain/src/diagnostics/trace_correlation';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Canonical field names matching Core's slog scheme. */
export type CoreFieldName =
  | 'req_id'
  | 'parent_id'
  | 'method'
  | 'path'
  | 'status'
  | 'duration'
  | 'did'
  | 'service'
  | 'error'
  | 'stack'
  | 'caller'
  | 'client_msg';

const CANONICAL_NAMES: ReadonlySet<CoreFieldName> = new Set([
  'req_id',
  'parent_id',
  'method',
  'path',
  'status',
  'duration',
  'did',
  'service',
  'error',
  'stack',
  'caller',
  'client_msg',
]);

/**
 * Alias → canonical map. Accepts common JS naming conventions +
 * routes to Core's scheme so callers don't have to remember each
 * field's exact form.
 */
const FIELD_ALIASES: ReadonlyMap<string, CoreFieldName> = new Map([
  // request_id variants
  ['request_id', 'req_id'],
  ['requestId', 'req_id'],
  ['requestID', 'req_id'],
  ['reqId', 'req_id'],
  // parent_id variants
  ['parentId', 'parent_id'],
  ['parentID', 'parent_id'],
  // duration variants (Core uses `duration` in ms — emit as number).
  ['duration_ms', 'duration'],
  ['durationMs', 'duration'],
  ['latency', 'duration'],
  ['latency_ms', 'duration'],
  ['latencyMs', 'duration'],
  // http status
  ['http_status', 'status'],
  ['httpStatus', 'status'],
  ['statusCode', 'status'],
  // error message
  ['error_message', 'error'],
  ['err', 'error'],
  // service
  ['service_name', 'service'],
  ['serviceName', 'service'],
]);

/** One emitted log record — always in Core's slog shape. */
export interface LogRecord {
  level: LogLevel;
  msg: string;
  /** Canonical Core fields (flat top-level). */
  fields: Record<string, unknown>;
  /** Non-canonical caller-supplied fields grouped under `extra`. */
  extra: Record<string, unknown>;
  /** UTC ms. */
  time: number;
}

/** Sink — the production wire is pino; tests pass an in-memory collector. */
export type LogEmitFn = (record: LogRecord) => void;

export interface BrainLoggerOptions {
  /** Minimum level to emit. Lines below this level are dropped. Default 'info'. */
  level?: LogLevel;
  /** Sink. Required. */
  emit: LogEmitFn;
  /** Value for the `service` field. Defaults to 'brain'. */
  serviceName?: string;
  /**
   * Fields attached to every log line — useful for shared bindings
   * (e.g. `{did: "did:plc:self"}`). Merged with per-call fields; per-call wins.
   */
  baseFields?: Record<string, unknown>;
  /** Injectable clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /**
   * When true, `err.stack` is included as a `stack` field on error-level
   * records. Default false (stacks are noisy for ops).
   */
  includeStack?: boolean;
}

export class BrainLogger {
  private readonly level: LogLevel;
  private readonly emit: LogEmitFn;
  private readonly serviceName: string;
  private readonly baseFields: Record<string, unknown>;
  private readonly nowMsFn: () => number;
  private readonly includeStack: boolean;

  constructor(opts: BrainLoggerOptions) {
    if (typeof opts?.emit !== 'function') {
      throw new TypeError('BrainLogger: emit is required');
    }
    this.emit = opts.emit;
    this.level = opts.level ?? 'info';
    this.serviceName = opts.serviceName ?? 'brain';
    this.baseFields = { ...(opts.baseFields ?? {}) };
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.includeStack = opts.includeStack ?? false;
  }

  debug(msg: string, fields: Record<string, unknown> = {}): void {
    this.log('debug', msg, fields);
  }

  info(msg: string, fields: Record<string, unknown> = {}): void {
    this.log('info', msg, fields);
  }

  warn(msg: string, fields: Record<string, unknown> = {}): void {
    this.log('warn', msg, fields);
  }

  /**
   * Error log. Pass an `Error` instance as `error` field + it's
   * converted to a short message; `includeStack: true` at
   * construction attaches the stack trace as the `stack` field.
   */
  error(msg: string, fields: Record<string, unknown> = {}): void {
    this.log('error', msg, fields);
  }

  /**
   * Create a child logger with additional permanent bindings.
   * Useful for scoped contexts like "all logs from this request"
   * without repeating fields on every call.
   */
  child(fields: Record<string, unknown>): BrainLogger {
    return new BrainLogger({
      level: this.level,
      emit: this.emit,
      serviceName: this.serviceName,
      baseFields: { ...this.baseFields, ...fields },
      nowMsFn: this.nowMsFn,
      includeStack: this.includeStack,
    });
  }

  // ── Internals ────────────────────────────────────────────────────────

  private log(
    level: LogLevel,
    msg: string,
    rawFields: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const merged: Record<string, unknown> = {
      ...this.baseFields,
      ...rawFields,
    };

    // Auto-attach trace context if present.
    const trace = currentTrace();
    if (trace) {
      if (!('req_id' in merged) && !aliasPresent(merged, 'req_id')) {
        merged['req_id'] = trace.requestId;
      }
      if (
        trace.parentId !== null &&
        !('parent_id' in merged) &&
        !aliasPresent(merged, 'parent_id')
      ) {
        merged['parent_id'] = trace.parentId;
      }
    }

    // Ensure service name is always present.
    if (!('service' in merged) && !aliasPresent(merged, 'service')) {
      merged['service'] = this.serviceName;
    }

    // Partition into canonical + extra.
    const fields: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined) continue;
      const canonical = canonicalName(k);
      if (canonical) {
        const normalised = canonicalisePrimitive(canonical, v, this.includeStack);
        // If normalising `error: Error` emits multiple fields (error + stack),
        // splay them into `fields`.
        for (const [nk, nv] of Object.entries(normalised)) {
          fields[nk] = nv;
        }
      } else {
        extra[k] = v;
      }
    }

    this.emit({
      level,
      msg,
      fields,
      extra,
      time: this.nowMsFn(),
    });
  }
}

function aliasPresent(fields: Record<string, unknown>, canonical: CoreFieldName): boolean {
  for (const [alias, target] of FIELD_ALIASES) {
    if (target === canonical && alias in fields) return true;
  }
  return false;
}

function canonicalName(raw: string): CoreFieldName | null {
  if (CANONICAL_NAMES.has(raw as CoreFieldName)) return raw as CoreFieldName;
  const aliased = FIELD_ALIASES.get(raw);
  return aliased ?? null;
}

/**
 * Apply per-field value normalisation. `error: Error` → `error:
 * err.message` (plus `stack: err.stack` when `includeStack`).
 * Durations come through as numbers untouched.
 */
function canonicalisePrimitive(
  canonical: CoreFieldName,
  value: unknown,
  includeStack: boolean,
): Record<string, unknown> {
  if (canonical === 'error') {
    if (value instanceof Error) {
      const out: Record<string, unknown> = { error: value.message };
      if (includeStack && typeof value.stack === 'string') {
        out.stack = value.stack;
      }
      return out;
    }
    if (typeof value === 'string') return { error: value };
    return { error: String(value) };
  }
  return { [canonical]: value };
}
