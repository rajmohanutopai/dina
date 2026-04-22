/**
 * Audit event builder — structured audit log entry.
 *
 * Every brain action that modifies state, reveals data, or takes an
 * action on behalf of the user should produce one audit event.
 * This primitive builds the canonical record shape:
 *
 *   { id, timestampMs, actor, action, target, persona?, result,
 *     requestId?, severity, metadata? }
 *
 * **Why a builder, not direct construction**:
 *
 *   - Validation — `actor` must have a role, `action` must match a
 *     canonical verb, `target` must name the affected resource.
 *   - Field ordering deterministic for content-addressed storage.
 *   - Automatic secret redaction — metadata fields that match
 *     known-secret key patterns (`password`, `apiKey`, `passphrase`,
 *     …) get replaced with `<redacted>` before the event is
 *     emitted. Prevents ops logs from carrying credentials.
 *   - Severity inferred from (action × result) — e.g. `deleted +
 *     success = info`, `deleted + failed = error`. Callers can
 *     override.
 *
 * **Pure builder** — no IO, no persistence. Emits a
 * `BuiltAuditEvent` ready for the caller to ship to the audit
 * store (typically `CoreClient`-backed).
 *
 * **Never throws** on runtime secrets — redaction is best-effort:
 * even with a novel secret-named field the caller passes in, we
 * don't drop non-matching fields. The goal is "catch the obvious
 * ones"; callers still own per-domain redaction.
 */

import { createHash } from 'node:crypto';

export type AuditActor =
  | { role: 'user'; did?: string; name?: string }
  | { role: 'brain' }
  | { role: 'agent'; did: string; name?: string }
  | { role: 'admin'; did?: string; name?: string };

/** Canonical action verbs — snake_case to match the Core audit schema. */
export type AuditAction =
  | 'persona_unlock'
  | 'persona_lock'
  | 'vault_read'
  | 'vault_write'
  | 'vault_delete'
  | 'notify_sent'
  | 'service_query'
  | 'service_response'
  | 'agent_allow'
  | 'agent_review'
  | 'agent_block'
  | 'config_updated'
  | 'key_rotated'
  | 'export_created'
  | 'login_success'
  | 'login_failed';

export type AuditResult = 'success' | 'failed' | 'pending';

export type AuditSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface AuditTarget {
  /** Resource type — `vault_item`, `persona`, `contact`, `config`, etc. */
  type: string;
  /** Stable id of the resource. */
  id: string;
  /** Optional short label — the event viewer renders this without
   *  needing a lookup. */
  label?: string;
}

export interface AuditEventInput {
  actor: AuditActor;
  action: AuditAction;
  target: AuditTarget;
  result: AuditResult;
  /** Optional persona the action touched. */
  persona?: string;
  /** Optional request-id for trace correlation (see 5.58). */
  requestId?: string;
  /** Optional free-form metadata (will be secret-redacted). */
  metadata?: Record<string, unknown>;
  /** Override inferred severity. */
  severity?: AuditSeverity;
  /** Unix ms — defaults to `nowMsFn()` or `Date.now()`. */
  timestampMs?: number;
}

export interface BuildAuditEventOptions {
  /** Clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Extra secret-named keys to redact. Merged with built-in list. */
  extraSecretKeys?: ReadonlyArray<string>;
  /** Id generator. Defaults to `SHA-256(timestamp+action+target.id).slice(0,16)`. */
  makeIdFn?: (input: { timestampMs: number; action: string; targetId: string }) => string;
}

export interface BuiltAuditEvent {
  id: string;
  timestampMs: number;
  actor: AuditActor;
  action: AuditAction;
  target: AuditTarget;
  result: AuditResult;
  severity: AuditSeverity;
  persona: string | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
}

export class AuditEventError extends Error {
  constructor(
    public readonly code:
      | 'invalid_actor'
      | 'invalid_action'
      | 'invalid_target'
      | 'invalid_result'
      | 'invalid_timestamp',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'AuditEventError';
  }
}

/**
 * Secret-name patterns that trigger redaction. Matched
 * case-insensitively via `.includes` on the lowercased key.
 */
export const SECRET_KEY_PATTERNS: ReadonlyArray<string> = [
  'password',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'session_id',
  'credential',
];

export const REDACTED_VALUE = '<redacted>';

/**
 * Build an audit event. Pure. Throws on invalid input so misuse is
 * caught at the call site — callers typically construct events in a
 * single location per action type.
 */
export function buildAuditEvent(
  input: AuditEventInput,
  opts: BuildAuditEventOptions = {},
): BuiltAuditEvent {
  validateActor(input.actor);
  validateAction(input.action);
  validateTarget(input.target);
  validateResult(input.result);
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const timestampMs = input.timestampMs ?? nowMsFn();
  if (!Number.isFinite(timestampMs)) {
    throw new AuditEventError('invalid_timestamp', 'timestampMs must be finite');
  }

  const severity = input.severity ?? inferSeverity(input.action, input.result);

  const redactedMeta = input.metadata
    ? redactSecrets(input.metadata, opts.extraSecretKeys)
    : null;

  const targetId = input.target.id;
  const id = opts.makeIdFn
    ? opts.makeIdFn({ timestampMs, action: input.action, targetId })
    : defaultIdOf(timestampMs, input.action, targetId);

  return {
    id,
    timestampMs,
    actor: input.actor,
    action: input.action,
    target: { ...input.target },
    result: input.result,
    severity,
    persona: input.persona ?? null,
    requestId: input.requestId ?? null,
    metadata: redactedMeta,
  };
}

/**
 * Redact any nested field whose key (case-insensitive) contains a
 * known secret-name pattern. Exposed so callers can apply the same
 * rules to non-audit payloads.
 */
export function redactSecrets(
  obj: Record<string, unknown>,
  extraKeys: ReadonlyArray<string> = [],
): Record<string, unknown> {
  const patterns = [
    ...SECRET_KEY_PATTERNS,
    ...extraKeys.map((k) => k.toLowerCase()),
  ];
  const seen = new WeakSet<object>();
  return redactInner(obj, patterns, seen) as Record<string, unknown>;
}

// ── Internals ──────────────────────────────────────────────────────────

function validateActor(actor: AuditActor): void {
  if (!actor || typeof actor !== 'object') {
    throw new AuditEventError('invalid_actor', 'actor object required');
  }
  if (
    actor.role !== 'user' &&
    actor.role !== 'brain' &&
    actor.role !== 'agent' &&
    actor.role !== 'admin'
  ) {
    throw new AuditEventError('invalid_actor', `unknown role "${String((actor as { role?: unknown }).role)}"`);
  }
  if (actor.role === 'agent' && (typeof actor.did !== 'string' || actor.did === '')) {
    throw new AuditEventError('invalid_actor', 'agent actor requires non-empty did');
  }
}

function validateAction(action: AuditAction): void {
  if (typeof action !== 'string') {
    throw new AuditEventError('invalid_action', 'action must be a string');
  }
  // Canonical verbs enforced at the type level; runtime check
  // catches any caller that cast past the type.
  const canonical: AuditAction[] = [
    'persona_unlock', 'persona_lock', 'vault_read', 'vault_write', 'vault_delete',
    'notify_sent', 'service_query', 'service_response',
    'agent_allow', 'agent_review', 'agent_block',
    'config_updated', 'key_rotated', 'export_created',
    'login_success', 'login_failed',
  ];
  if (!canonical.includes(action)) {
    throw new AuditEventError('invalid_action', `unknown action "${action}"`);
  }
}

function validateTarget(target: AuditTarget): void {
  if (!target || typeof target !== 'object') {
    throw new AuditEventError('invalid_target', 'target object required');
  }
  if (typeof target.type !== 'string' || target.type === '') {
    throw new AuditEventError('invalid_target', 'target.type required');
  }
  if (typeof target.id !== 'string' || target.id === '') {
    throw new AuditEventError('invalid_target', 'target.id required');
  }
}

function validateResult(result: AuditResult): void {
  if (result !== 'success' && result !== 'failed' && result !== 'pending') {
    throw new AuditEventError('invalid_result', `unknown result "${String(result)}"`);
  }
}

function inferSeverity(action: AuditAction, result: AuditResult): AuditSeverity {
  if (result === 'failed') {
    if (action === 'login_failed' || action === 'agent_block') return 'warn';
    return 'error';
  }
  if (action === 'vault_delete' || action === 'export_created' || action === 'key_rotated') {
    return 'warn';
  }
  if (action === 'agent_review') return 'warn';
  return 'info';
}

function redactInner(
  value: unknown,
  patterns: ReadonlyArray<string>,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '<circular>';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, patterns, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = k.toLowerCase().replace(/[-_]/g, '');
    if (patterns.some((p) => lowerKey.includes(p.replace(/[-_]/g, '')))) {
      out[k] = REDACTED_VALUE;
    } else {
      out[k] = redactInner(v, patterns, seen);
    }
  }
  return out;
}

function defaultIdOf(timestampMs: number, action: string, targetId: string): string {
  const h = createHash('sha256')
    .update(`${timestampMs}|${action}|${targetId}`)
    .digest('hex');
  return h.slice(0, 16);
}
