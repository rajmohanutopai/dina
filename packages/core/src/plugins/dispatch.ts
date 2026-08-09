/**
 * Tool-lane dispatch — the invocation decision + envelope assembly +
 * result validation (PLUGIN_ARCHITECTURE.md §9.1, §11).
 *
 * The flow this module owns, Core-side:
 *   1. gatekeeper floor (evaluatePluginIntent, §8)
 *   2. PARAMS-ARE-EGRESS gate (§11 point 5): params are user-derived
 *      free text, scrubbed + category-classified against the
 *      capability's consented scope. Content outside that scope — or
 *      anything sensitive/regulated — makes the invocation NEVER
 *      silent, whatever the floor says. Uncertainty fails toward the
 *      card.
 *   3. envelope assembly: the immutable pinned fields (§9.1) the six
 *      claim-time checks verify against.
 *   4. result validation against the PINNED schema (nonconforming =
 *      task failure, counted against plugin health).
 *
 * `mode === 'silent'` from the gatekeeper is NECESSARY but not
 * SUFFICIENT — this module is where "only if the params clear egress"
 * is enforced.
 */

import { scrubPII } from '../pii/patterns';
import {
  PLUGIN_INVOCATION_PAYLOAD_TYPE,
  type PluginTaskEnvelope,
} from '../workflow/plugin_envelope';

import { validateAgainstSchema } from './schema_validate';

import type { PluginInstall } from './registry';
import type { PluginIntentDecision } from '../gatekeeper/intent';

/** PII entity types that are sensitive/regulated regardless of scope
 * (§11.5: "anything sensitive/regulated → never silent"). Includes the
 * financial/identity types the shared scrubber finds PLUS the
 * credential-token types the local detector below adds. */
const REGULATED_PII = new Set([
  'CREDIT_CARD',
  'BANK_ACCT',
  'SSN',
  'AADHAAR',
  'PAN',
  'IFSC',
  'UPI',
  // Audit D6: credential/secret tokens — silent egress of these was the
  // most sensitive gap. Regexable token shapes are detected locally
  // (`detectSecretTokens`); free-text passwords are inherently
  // un-regexable and are instead covered by the sensitive-category
  // backstop when the caller labels them.
  'API_KEY',
  'BEARER_TOKEN',
  'PRIVATE_KEY',
]);

/**
 * Param CATEGORIES that are sensitive regardless of scope (§8 privacy
 * clamp + §11.5). Audit D6: the regulated-PII backstop can only catch
 * regexable PII; medical diagnoses, credentials, biometric and
 * precise-location content are not regexable, so a param CATEGORY in
 * this set forces a card EVEN WHEN the plugin consented to it — a
 * dermatology-booking plugin consenting to `appointment_booking` must
 * still card when the utterance carries `health`. The owner, not the
 * classifier's scope match, is the final gate for these.
 */
const SENSITIVE_CATEGORIES = new Set([
  'health',
  'medical',
  'mental_health',
  'financial',
  'finance',
  'credentials',
  'credential',
  'biometric',
  'precise_location',
  'government_id',
  'sexual_orientation',
  'religion',
]);

/**
 * Local regexable-secret detector for the params channel. The shared
 * scrubPII does not know credential tokens; this adds the common
 * high-signal shapes (API keys, bearer/JWT, PEM private keys) so they
 * are treated as regulated (never silent). Returns the detected entity
 * types. Deliberately conservative — false negatives on exotic tokens
 * are backstopped by the `credentials` sensitive category.
 */
function detectSecretTokens(text: string): string[] {
  const found = new Set<string>();
  // Provider API keys: sk-…, ghp_…, github_pat_…, AKIA… (AWS),
  // xox[baprs]-… (Slack), AIza… (Google).
  if (
    /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/.test(
      text,
    )
  ) {
    found.add('API_KEY');
  }
  // JWT / bearer: three base64url segments, or an explicit "bearer …".
  if (
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text) ||
    /\bbearer\s+[A-Za-z0-9._-]{16,}/i.test(text)
  ) {
    found.add('BEARER_TOKEN');
  }
  // PEM private key blocks.
  if (/-----BEGIN[A-Z ]*PRIVATE KEY-----/.test(text)) {
    found.add('PRIVATE_KEY');
  }
  return [...found];
}

/**
 * Recursively collect the egress SCAN CORPUS from a structured params
 * object: every field NAME and every scalar VALUE (string, number,
 * boolean), stringified. Audit D6: the gate scans the ACTUAL params that
 * ship — not a caller-flattened rendering — so a field absent from a
 * flatten (e.g. `note`) can't escape scrub + classification. Audit (this
 * round): NON-STRING data must be scanned too — a card number stored as a
 * number (`{card: 4111111111111111}`) or a `{confirm:true}` flag, and the
 * field NAMES themselves (a key literally named `password`/`ssn` is a
 * signal), were previously invisible because only string leaves were
 * collected.
 */
function collectScanText(value: unknown, out: string[], depth = 0): void {
  if (depth > 12) return; // matches the manifest schema-depth ceiling
  if (value === null) return;
  if (typeof value === 'string') {
    out.push(value);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const v of value) collectScanText(v, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k); // the field NAME is itself scanned
      collectScanText(v, out, depth + 1);
    }
  }
}

/**
 * True iff the params carry any non-empty scalar (string/number/boolean)
 * anywhere. Audit (this round): "is there anything to leak" must be
 * computed from the actual object, NOT from the joined STRING corpus —
 * `{amount: 500}` has an empty string-join yet is very much non-empty, so
 * the "could not be classified" backstop must still fire for it.
 */
function hasScalarContent(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some((v) => hasScalarContent(v, depth + 1));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) =>
      hasScalarContent(v, depth + 1),
    );
  }
  return false;
}

/**
 * Stable, sorted-key JSON of the EXACT params object for the owner's card
 * (§11.5 WYSIWYG). Audit (this round): the card must render the whole
 * object — numbers, booleans, nulls, and field names — not just the
 * string leaves; a `{amount: 500}` booking previously showed the owner an
 * empty card. Deterministic key order so the render (and any hash of it)
 * is reproducible.
 */
function stableCardJson(value: unknown, depth = 0): string {
  if (depth > 12) return '"…"';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableCardJson(v, depth + 1)).join(',')}]`;
  }
  if (t === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableCardJson(v, depth + 1)}`).join(',')}}`;
  }
  return 'null';
}

// P1-1: the scan/serialize helpers stop descending past this depth. That is a
// DoS guard, but on its OWN it is a BYPASS — a secret nested deeper than the
// cap was neither scanned, counted as content, nor shown on the card, so it
// cleared SILENTLY. So params that EXCEED the inspectable limits can never
// clear: the egress gate reports them and dispatch forces a card (fail
// closed). Anything within the limits is therefore fully inspected.
const MAX_PARAM_DEPTH = 12; // matches the manifest schema-depth ceiling
const MAX_PARAM_BYTES = 64 * 1024; // a booking's params are not 64KB

/** True if the value nests deeper than `max`. */
function exceedsDepth(value: unknown, max: number, depth = 0): boolean {
  if (depth > max) return true;
  if (Array.isArray(value)) return value.some((v) => exceedsDepth(v, max, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) =>
      exceedsDepth(v, max, depth + 1),
    );
  }
  return false;
}

/** Params too deep or too large to fully inspect — the reason they can't
 * clear. Empty string when within limits. Exported so a producer can reject
 * before enqueue as well. */
export function paramsExceedInspectableLimits(params: unknown): string {
  if (exceedsDepth(params, MAX_PARAM_DEPTH)) {
    return `params nest deeper than ${MAX_PARAM_DEPTH} levels — cannot fully inspect`;
  }
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(params) ?? '').length;
  } catch {
    return 'params are not serializable for inspection';
  }
  if (bytes > MAX_PARAM_BYTES) {
    return `params are ${bytes} bytes — over the ${MAX_PARAM_BYTES}-byte inspection cap`;
  }
  return '';
}

export interface ParamsEgressAssessment {
  /** True iff the params carry NO regulated PII, NO sensitive category,
   * every classified category is in scope, and the params were
   * classifiable — the ONLY case a SAFE floor may run silent. */
  clears: boolean;
  /** Why the invocation must card (empty when it clears). */
  reasons: string[];
  /** PII entity types found across ALL string fields (regulated + other). */
  piiTypes: string[];
  /** Caller categories that fall OUTSIDE consent. */
  outOfScopeCategories: string[];
  /** Caller categories that are sensitive regardless of scope (§11.5). */
  sensitiveCategories: string[];
  /**
   * The EXACT outbound params rendered for the owner's card (§11.5: "a
   * card showing the exact params"; "the owner seeing the literal
   * outbound text is the final gate"). This is what actually ships —
   * WYSIWYG. The owner's own screen; showing the literal value is the
   * whole point of the gate.
   */
  cardParamsText: string;
  /**
   * A scrubbed rendering for AUDIT/LOG use only (PII must never reach
   * logs). NEVER shown to the owner in place of the exact text.
   */
  auditText: string;
}

/**
 * Assess the STRUCTURED params as egress (§11, §11.5). Audit D6: the
 * gate scans the actual `params` object that ships in the envelope —
 * every string field, recursively — not a caller-flattened rendering,
 * so a field the flatten omitted (e.g. `note`) cannot escape scrub +
 * classification. `paramCategories` remain the caller's classification
 * but are NO LONGER the sole gate: a sensitive category or regulated
 * PII forces a card even when the category is consented.
 */
export function assessParamsEgress(args: {
  params: unknown;
  paramCategories: string[];
  consentedCategories: readonly string[];
}): ParamsEgressAssessment {
  const reasons: string[] = [];

  // P1-1: params past the inspectable depth/size can never clear — the scan
  // + card + content-check all stop at MAX_PARAM_DEPTH, so a deeper secret
  // would otherwise clear SILENTLY. Reporting it here forces a card (fail
  // closed); everything within the limits below is then fully inspected.
  const overLimit = paramsExceedInspectableLimits(args.params);
  if (overLimit !== '') reasons.push(overLimit);

  // Deep-scan EVERY field name + scalar value in the structured params
  // (strings, numbers, booleans) — not just string leaves.
  const scanParts: string[] = [];
  collectScanText(args.params, scanParts);
  const joined = scanParts.join('\n');

  const scrub = scrubPII(joined);
  const piiTypes = new Set(scrub.entities.map((e) => e.type));
  for (const t of detectSecretTokens(joined)) piiTypes.add(t);

  const regulated = [...piiTypes].filter((t) => REGULATED_PII.has(t));
  if (regulated.length > 0) {
    reasons.push(`regulated data in params: ${regulated.join(', ')}`);
  }

  // Sensitive category → never silent, even when consented (§11.5).
  // Round-12 #17: category comparisons are CASE-INSENSITIVE. `normalizeStringSet`
  // (manifest ingest) dedups + sorts but does NOT lowercase, so `Health` /
  // `FINANCE` would miss the (lowercase) sensitive set AND match a same-cased
  // consent entry — clearing silently. Fold case on BOTH sides of every category
  // comparison; the raw category is still echoed in the reason for readability.
  const sensitive = args.paramCategories.filter((c) => SENSITIVE_CATEGORIES.has(c.toLowerCase()));
  if (sensitive.length > 0) {
    reasons.push(`params carry sensitive categories: ${sensitive.join(', ')}`);
  }

  const consent = new Set(args.consentedCategories.map((c) => c.toLowerCase()));
  const outOfScope = args.paramCategories.filter((c) => !consent.has(c.toLowerCase()));
  if (outOfScope.length > 0) {
    reasons.push(`params carry out-of-scope categories: ${outOfScope.join(', ')}`);
  }

  // Fail toward the card on ABSENCE of classification: non-empty params
  // the classifier could not label are UNCLASSIFIED, not empty (§11.5:
  // uncertainty fails toward the card). "Non-empty" is computed from the
  // OBJECT, not the string-join — a numeric-only `{amount: 500}` is
  // non-empty even though its string corpus is blank.
  if (hasScalarContent(args.params) && args.paramCategories.length === 0) {
    reasons.push('params could not be classified — treated as out-of-scope');
  }

  return {
    clears: reasons.length === 0,
    reasons,
    piiTypes: [...piiTypes],
    outOfScopeCategories: outOfScope,
    sensitiveCategories: sensitive,
    // WYSIWYG: the owner sees the literal outbound params — the FULL
    // object (numbers, booleans, field names), not just string leaves.
    cardParamsText: stableCardJson(args.params),
    auditText: scrub.scrubbed,
  };
}

export type DispatchMode = 'silent' | 'card' | 'blocked';

export interface DispatchDecision {
  mode: DispatchMode;
  /** The gatekeeper's floor decision (§8). */
  intent: PluginIntentDecision;
  /** The params-egress assessment (§11.5). */
  egress: ParamsEgressAssessment;
  /** Human-facing reason (blocked/card) or the silent rationale. */
  reason: string;
}

/**
 * Combine the gatekeeper floor with the params-egress gate. A SAFE or
 * grant-silenced decision runs silent ONLY if the params clear egress;
 * otherwise it escalates to a card showing the exact params. A blocked
 * floor stays blocked.
 */
export function decideDispatch(
  intent: PluginIntentDecision,
  egress: ParamsEgressAssessment,
): DispatchDecision {
  if (intent.mode === 'blocked') {
    return { mode: 'blocked', intent, egress, reason: intent.reason };
  }
  if (intent.mode === 'silent') {
    if (egress.clears) {
      return { mode: 'silent', intent, egress, reason: intent.reason };
    }
    // §11.5: never silent when params don't clear egress, whatever the
    // floor says. The card shows the exact outbound text.
    return {
      mode: 'card',
      intent,
      egress,
      reason: `params require review: ${egress.reasons.join('; ')}`,
    };
  }
  // Gatekeeper already wants a card — egress reasons ride along.
  return {
    mode: 'card',
    intent,
    egress,
    reason:
      egress.reasons.length > 0
        ? `${intent.reason} (also: ${egress.reasons.join('; ')})`
        : intent.reason,
  };
}

/** The envelope carries `'supported' | 'unsupported'`; a capability's
 * declared idempotency is coerced to that pair (anything not the literal
 * 'supported' is treated as unsupported — fail-safe: no silent auto-retry
 * unless the manifest explicitly opted in). */
function coerceEffectsIdempotency(v: unknown): 'supported' | 'unsupported' {
  return v === 'supported' ? 'supported' : 'unsupported';
}

/**
 * Assemble the immutable pinned envelope (§9.1). Set once at enqueue; the
 * claim-time checks verify against these exact fields.
 *
 * Audit (this round): every AUTHORITY field is DERIVED from the install
 * registry — the caller supplies only `installId`/`capabilityId` plus the
 * per-invocation `params`/`context`/`executionId`/`idempotencyKey`. A
 * producer can no longer independently assert `manifest_cid`,
 * `approved_scope_hash`, `schema_snapshot`, `config_revision`,
 * `action_class`, or `effects_idempotency`; a stale or incorrect producer
 * therefore cannot mint a valid-looking envelope with a permissive result
 * schema or a mislabelled action class / retry contract. The claim guard
 * independently re-derives the same fields from the stored manifest, so
 * authority is defence-in-depth on both the produce and claim sides.
 */
/**
 * P1-2: bound the per-invocation `context` against the capability's consented
 * data_scope. `context` is the projected vault slice handed to the runner; the
 * owner consented to a ceiling (`data_scope.max_context_items`), and a
 * capability that declared NO context scope must receive none. This is enforced
 * at BOTH the produce gate (buildPluginEnvelope) and the non-bypassable claim
 * gate, so a producer that skipped the check still cannot flow unbounded — or
 * unstructured — context to the runner. Returns a reason on violation, null
 * when within scope.
 *
 * Scope note: the full §361 invariant ("context created by one Core-owned
 * projection service") also needs that projection service on the produce side —
 * which is what enforces consented CATEGORIES, excludes locked personas, and
 * proves Core-projection provenance. That producer is producer-time (no dispatch
 * producer ships in P0). What this gate CAN enforce at the boundary regardless
 * of who produced the context: it is a bounded projected list (count), AND it
 * carries no raw regulated PII / secret tokens (Round-5 #7 — same egress rule as
 * params, §11.5). A projection producer must scrub; this is the fail-closed
 * backstop if one ever skips it.
 */
export function contextScopeViolation(
  context: unknown,
  maxContextItems: number | undefined,
): string | null {
  if (context === undefined || context === null) return null;
  const max = maxContextItems ?? 0;
  if (!Array.isArray(context)) {
    // Context must be a projected ITEM LIST — a countable, bounded shape. A
    // non-array value can't be measured against max_context_items, so refuse.
    return 'context must be a projected item array (data_scope enforcement)';
  }
  if (context.length === 0) return null;
  if (max <= 0) {
    return 'capability declares no context scope (data_scope.max_context_items) but context was supplied';
  }
  if (context.length > max) {
    return `context has ${context.length} items, exceeds data_scope.max_context_items=${max}`;
  }
  // Round-9 #7: the regulated-content scanner (collectScanText) silently STOPS
  // at depth 12 and applies NO byte cap — so a secret nested deeper than 12, or
  // a small-item-count-but-huge payload, could pass UNSCANNED and clear. Refuse
  // anything too deep or too large to FULLY inspect, mirroring the params
  // channel's fail-closed boundary (paramsExceedInspectableLimits).
  if (exceedsDepth(context, MAX_PARAM_DEPTH)) {
    return `context nests deeper than ${MAX_PARAM_DEPTH} levels — cannot fully inspect (data_scope enforcement)`;
  }
  let contextBytes: number;
  try {
    contextBytes = new TextEncoder().encode(JSON.stringify(context) ?? '').length;
  } catch {
    return 'context is not serializable for inspection (data_scope enforcement)';
  }
  if (contextBytes > MAX_PARAM_BYTES) {
    return `context is ${contextBytes} bytes — over the ${MAX_PARAM_BYTES}-byte inspection cap (data_scope enforcement)`;
  }
  // Round-5 #7: quantity is not authority. A small array of RAW vault records
  // (card numbers, SSNs, API keys) is within the count ceiling yet must never
  // flow to a runner unscrubbed — the same regulated-egress rule the params
  // channel enforces (§11.5). Shape-agnostic scan of every scalar + field name.
  const regulated = contextRegulatedContent(context);
  if (regulated.length > 0) {
    return `context carries raw regulated content (${regulated.join(', ')}) — projection must scrub before dispatch`;
  }
  return null;
}

/** Regulated PII entity types + secret-token shapes present anywhere in the
 *  context corpus — the subset that must be scrubbed out of any projected
 *  context (Round-5 #7). Reuses the params-channel scanner + detectors. */
function contextRegulatedContent(context: unknown): string[] {
  const parts: string[] = [];
  collectScanText(context, parts);
  const joined = parts.join('\n');
  const found = new Set<string>();
  for (const e of scrubPII(joined).entities) if (REGULATED_PII.has(e.type)) found.add(e.type);
  for (const t of detectSecretTokens(joined)) found.add(t);
  return [...found];
}

export function buildPluginEnvelope(args: {
  install: PluginInstall;
  capabilityId: string;
  params: unknown;
  context: unknown;
  executionId: string;
  idempotencyKey: string;
  /**
   * Round-12 #2/#3/#6/#1: the authorization provenance to PIN onto the envelope.
   * `kind: 'grant'` REQUIRES `grantId` (the exact grant consumed via
   * authorizeAndConsume) — the claim guard re-verifies that grant's liveness.
   * `invocationDigest` should be the SAME digest passed to authorizeAndConsume
   * so the two agree on what invocation this execution bound to. Omitted by
   * callers with no authorization context (e.g. tests) — the envelope then
   * carries no provenance and the claim guard applies no grant check.
   *
   * PLG-29 #4: `resource` + `value` are the SAME dispatch metadata passed to
   * authorizeAndConsume. Pinning them lets the claim guard RECOMPUTE the
   * invocation digest from the envelope's own Core-owned fields instead of
   * trusting `invocationDigest`, binding the dispatched invocation to the one
   * charged against the grant. Emitted only under a 'grant' authorization.
   */
  authorization?: {
    kind: 'grant' | 'card';
    grantId?: string;
    invocationDigest?: string;
    resource?: string;
    value?: number;
  };
  /** §11.2a provider-ingress correlation — present only for tasks created
   *  from an inbound D2D service query (provider_ingress.ts). */
  serviceIngress?: PluginTaskEnvelope['service_ingress'];
}): PluginTaskEnvelope {
  const cap = args.install.manifest.capabilities.find((c) => c.id === args.capabilityId);
  if (cap === undefined) {
    throw new Error(`capability "${args.capabilityId}" is not in this install's manifest`);
  }
  const approvedScopeHash = args.install.capabilityHashes[args.capabilityId];
  if (approvedScopeHash === undefined) {
    throw new Error(`capability "${args.capabilityId}" has no consented scope hash`);
  }
  // P1-3: validate the invocation params against the CONSENTED params_schema
  // before enqueue. Only results were schema-checked before, so a runner could
  // receive params outside the shape the owner consented to (missing required
  // fields, extra properties, wrong types). The claim guard re-validates as
  // defence-in-depth.
  if (cap.params_schema !== undefined && cap.params_schema !== null) {
    const check = validateAgainstSchema(args.params, cap.params_schema);
    if (!check.ok) {
      throw new Error(`params violate the consented params_schema: ${check.error ?? 'unknown'}`);
    }
  }
  // Round-11 #4: params too DEEP or LARGE to fully render must be REJECTED, not
  // approved through a lossy `"…"`-truncated card. The forced-card path shows
  // the owner an ellipsized preview while the FULL object ships in the envelope
  // — the owner would approve deep values they never saw. Fail closed here (and
  // the claim guard re-checks), mirroring the round-9 #7 CONTEXT depth/byte guard.
  const paramsLimit = paramsExceedInspectableLimits(args.params);
  if (paramsLimit !== '') {
    throw new Error(`params cannot be fully rendered for approval: ${paramsLimit}`);
  }
  // P1-2: bound `context` to the consented data_scope before it is pinned into
  // the envelope. The claim guard re-checks as defence-in-depth.
  const ctxViolation = contextScopeViolation(args.context, cap.data_scope?.max_context_items);
  if (ctxViolation !== null) {
    throw new Error(`context violates the consented data_scope: ${ctxViolation}`);
  }
  // Round-15 #14: enforce the documented invariant AT BUILD. `kind: 'grant'`
  // REQUIRES a non-empty grantId — otherwise the builder emits a typed envelope
  // that parsePluginEnvelope rejects (grant kind without grant_id), silently
  // terminalizing the task at claim with an opaque integrity error. Fail at
  // enqueue where the producer bug is diagnosable, not at claim time.
  if (args.authorization?.kind === 'grant' && (args.authorization.grantId ?? '') === '') {
    throw new Error("authorization kind 'grant' requires a non-empty grantId");
  }
  return {
    type: PLUGIN_INVOCATION_PAYLOAD_TYPE,
    install_id: args.install.installId,
    capability_id: args.capabilityId,
    params: args.params,
    context: args.context,
    manifest_cid: args.install.currentCid,
    approved_scope_hash: approvedScopeHash,
    schema_snapshot: cap.result_schema ?? null,
    config_revision: args.install.configRevision,
    execution_id: args.executionId,
    idempotency_key: args.idempotencyKey,
    action_class: cap.action_class,
    effects_idempotency: coerceEffectsIdempotency(cap.effects?.idempotency),
    // Round-12 #2/#3/#6/#1: pin the authorization provenance when supplied.
    // PLG-29 #4: resource/value ride ONLY under a 'grant' authorization (the
    // envelope parser's reverse-coherence rejects them on card/absent envelopes),
    // so the claim guard can recompute + verify the invocation digest.
    ...(args.authorization !== undefined
      ? {
          authorization_kind: args.authorization.kind,
          ...(args.authorization.grantId !== undefined
            ? { grant_id: args.authorization.grantId }
            : {}),
          ...(args.authorization.invocationDigest !== undefined
            ? { invocation_digest: args.authorization.invocationDigest }
            : {}),
          ...(args.authorization.kind === 'grant' && args.authorization.resource !== undefined
            ? { resource: args.authorization.resource }
            : {}),
          ...(args.authorization.kind === 'grant' && args.authorization.value !== undefined
            ? { value: args.authorization.value }
            : {}),
        }
      : {}),
    // §11.2a: the ingress correlation block, present only for tasks
    // created from an inbound service query (provider_ingress.ts).
    ...(args.serviceIngress !== undefined ? { service_ingress: args.serviceIngress } : {}),
  };
}

/**
 * Build an envelope pinned to a PRIOR manifest, under a lifecycle-continuity
 * authorization (§9.13, WS-3.8).
 *
 * A buyer whose order was opened against an earlier manifest must keep being
 * answered under THAT contract until the order is terminal. The current
 * manifest cannot vouch for it — the capability may have changed shape, or
 * left the manifest entirely — so every authority field here comes from the
 * authorization, which recorded the prior manifest's own values at rebind
 * time. `install` supplies identity only.
 *
 * The claim guard performs the mirror check: it admits a prior-CID envelope
 * only through a live entry for the same triple, and re-derives these same
 * fields from it. Both sides read one record, so neither can drift.
 */
export function buildContinuityEnvelope(args: {
  install: PluginInstall;
  authorization: {
    previousCid: string;
    capabilityId: string;
    approvedScopeHash: string;
    configRevision: number;
    actionClass: string;
    effectsIdempotency: 'supported' | 'unsupported';
    paramsSchemaJson: string;
    resultSchemaJson: string;
    maxContextItems: number | null;
    /** §9.13 — the version the prior manifest declared. '' when unknown. */
    priorVersion?: string;
  };
  params: unknown;
  context: unknown;
  executionId: string;
  idempotencyKey: string;
  serviceIngress?: PluginTaskEnvelope['service_ingress'];
}): PluginTaskEnvelope {
  const auth = args.authorization;
  let paramsSchema: unknown;
  let resultSchema: unknown;
  try {
    paramsSchema = JSON.parse(auth.paramsSchemaJson);
    resultSchema = JSON.parse(auth.resultSchemaJson);
  } catch (error) {
    // The rows were written from values that had already been validated, so
    // unreadable schemas mean storage corruption. Refuse rather than dispatch
    // against no contract at all.
    throw new Error(
      `continuity authorization holds unreadable schemas: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (paramsSchema !== null && paramsSchema !== undefined) {
    const check = validateAgainstSchema(args.params, paramsSchema);
    if (!check.ok) {
      throw new Error(
        `params violate the PRIOR params_schema this order was opened under: ${check.error ?? 'unknown'}`,
      );
    }
  }
  const paramsLimit = paramsExceedInspectableLimits(args.params);
  if (paramsLimit !== '') {
    throw new Error(`params cannot be fully rendered for approval: ${paramsLimit}`);
  }
  const ctxViolation = contextScopeViolation(args.context, auth.maxContextItems ?? undefined);
  if (ctxViolation !== null) {
    throw new Error(`context violates the prior data_scope: ${ctxViolation}`);
  }
  return {
    type: PLUGIN_INVOCATION_PAYLOAD_TYPE,
    install_id: args.install.installId,
    capability_id: auth.capabilityId,
    params: args.params,
    context: args.context,
    // The PRIOR CID, which is what makes the claim guard take the drain lane.
    manifest_cid: auth.previousCid,
    // §9.13 — WHICH CONTRACT this continuation speaks. Only present when the
    // authorization recorded one, so a row written before the column existed
    // stays silent rather than claiming a version it does not know.
    ...(auth.priorVersion !== undefined && auth.priorVersion !== ''
      ? { prior_version: auth.priorVersion }
      : {}),
    approved_scope_hash: auth.approvedScopeHash,
    schema_snapshot: resultSchema ?? null,
    config_revision: auth.configRevision,
    execution_id: args.executionId,
    idempotency_key: args.idempotencyKey,
    action_class: auth.actionClass,
    effects_idempotency: auth.effectsIdempotency,
    ...(args.serviceIngress !== undefined ? { service_ingress: args.serviceIngress } : {}),
  };
}

export interface PluginResultValidation {
  ok: boolean;
  parsed?: unknown;
  error?: string;
}

/**
 * Validate a runner's completion against the PINNED result schema
 * (§9.1: nonconforming = task failure). The schema is the one snapshot
 * on the envelope, NOT whatever the plugin's current manifest says —
 * the owner consented to this shape. Non-JSON results fail.
 */
export function validatePluginResult(
  resultJSON: string,
  pinnedSchema: unknown,
): PluginResultValidation {
  // PLG-27 #5: gate on the RAW UTF-8 byte size BEFORE JSON.parse. On the
  // in-process / mobile path (no HTTP body limit) an oversized result would
  // otherwise be fully materialized into an object graph by JSON.parse before any
  // limit could reject it — the expensive work happening before the cheap check.
  // Reject on bytes first so parse never runs on an over-cap string.
  if (new TextEncoder().encode(resultJSON).length > MAX_PARAM_BYTES) {
    return { ok: false, error: `result exceeds the ${MAX_PARAM_BYTES}-byte inspection cap` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJSON);
  } catch {
    return { ok: false, error: 'result is not valid JSON' };
  }
  // Round-16 #6: also bound nesting REGARDLESS of schema. The params/context
  // INBOUND direction is already depth-capped, but a runner result with no pinned
  // schema was persisted verbatim — a deeply-nested result can overflow recursive
  // comparisons downstream. `exceedsDepth` short-circuits at the cap (bounded
  // recursion) and V8's JSON.parse throws RangeError on pathological nesting
  // (caught above), so this is safe on any input that passed the byte gate.
  // Nonconforming = task failure, exactly like a schema mismatch.
  if (exceedsDepth(parsed, MAX_PARAM_DEPTH)) {
    return { ok: false, error: `result nests deeper than ${MAX_PARAM_DEPTH} levels` };
  }
  // No pinned schema = accept any JSON (a capability may omit
  // result_schema); with one, conform or fail.
  if (pinnedSchema === undefined || pinnedSchema === null) {
    return { ok: true, parsed };
  }
  const check = validateAgainstSchema(parsed, pinnedSchema);
  if (!check.ok) {
    return { ok: false, error: `result violates pinned schema: ${check.error ?? 'unknown'}` };
  }
  return { ok: true, parsed };
}
