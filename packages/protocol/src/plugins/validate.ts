/**
 * Manifest validation — the trust-boundary gate run identically by the
 * AppView ingester AND the on-node installer (§5 rule 3: "the on-node
 * installer runs the identical validation").
 *
 * Covers, per spec:
 *   - §5 rule 4 structural caps (schema bombs are a real vector) and
 *     uniqueness: duplicate capability ids, duplicate `kinds` entries,
 *     duplicate state/move ids, ambiguous `(state, move)` transitions
 *     are REJECTIONS, never first-match-wins.
 *   - §5 rule 3 kinds combinations: ingest/notify are runner-only,
 *     `provider` requires `query` interaction, session capabilities
 *     carry no kinds. Anti-Her banned categories rejected.
 *   - §5 rule 6 config_schema is non-secret preferences only.
 *   - §14 derived compatibility: the requirement set is DERIVED from
 *     manifest structure, unioned with `required_features`, and the
 *     gate fails closed on unknown fields/features.
 *
 * Validation operates on the NORMALIZED manifest (normalize.ts) — the
 * stored form. Callers normalize first; `validatePluginManifest` also
 * verifies the input IS normalized (defense against a caller skipping
 * the step and storing a form that hashes differently than it runs).
 *
 * Pure functions. Zero runtime deps.
 */

import { normalizeStringSet } from './normalize';
import { hasUnsafeText } from './text_safety';
import {
  PLUGIN_BANNED_CATEGORIES,
  PLUGIN_CAPS,
  PLUGIN_KINDS,
  PLUGIN_NSIDS,
  PLUGIN_OPS,
} from './types';

import type { PluginCapabilityDecl, PluginMachine, PluginManifest } from './types';

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface PluginValidationError {
  /** Stable machine-readable code (tests + UI copy key off this). */
  readonly code: string;
  /** JSON-path-ish location, e.g. `capabilities[2].kinds`. */
  readonly path: string;
  readonly message: string;
}

export interface PluginValidationOk {
  readonly ok: true;
  /**
   * Requirement set DERIVED from manifest structure, unioned with the
   * publisher's `required_features` (§14). The node-side gate is:
   * every entry must be in the node's supported-feature set, else the
   * install/update fails with a clear "needs a newer Dina".
   */
  readonly derivedFeatures: readonly string[];
}

export interface PluginValidationFail {
  readonly ok: false;
  readonly errors: readonly PluginValidationError[];
}

export type PluginValidationResult = PluginValidationOk | PluginValidationFail;

// ---------------------------------------------------------------------------
// Known field sets — unknown fields fail closed (§14: "fails closed on
// any field or feature it doesn't recognize"). A field this validator
// doesn't know is behavior this node can't reason about.
// ---------------------------------------------------------------------------

const KNOWN_MANIFEST_FIELDS = new Set([
  '$type',
  'plugin_id',
  'version',
  'display_name',
  'short_description',
  'icon',
  'homepage',
  'source_url',
  'min_interpreter',
  'min_plugin_protocol',
  'required_features',
  'execution',
  'capabilities',
  'config_schema',
]);

const KNOWN_CAPABILITY_FIELDS = new Set([
  'id',
  'display_name',
  'interaction',
  'action_class',
  'privacy_class',
  'params_schema',
  'result_schema',
  'card',
  'machine',
  'ops_used',
  'verify_budget',
  'instructions',
  'kinds',
  'effects',
  'intent_phrases',
  'data_scope',
  'network_domains',
]);

const ACTION_CLASSES = new Set(['read', 'quote', 'write', 'booking', 'payment', 'agentic']);
const PRIVACY_CLASSES = new Set(['public', 'personal', 'sensitive', 'regulated']);

// Nested-structure allowlists (§14 fail-closed applies at EVERY level, not
// just the top). A new nested key is behavior an older node can't reason
// about — `execution.future_privileged_mode`, `effects.future_retry`,
// `data_scope.future_vault_access` must be rejected, not silently ignored.
const KNOWN_EXECUTION_FIELDS = new Set(['mode', 'runtime']);
const KNOWN_RUNTIME_FIELDS = new Set(['hosted_endpoint', 'issuer', 'self_host', 'artifacts']);
const KNOWN_ISSUER_FIELDS = new Set(['did', 'key']);
const KNOWN_SELF_HOST_FIELDS = new Set(['npm', 'docker']);
const KNOWN_ARTIFACTS_FIELDS = new Set([
  'npm_integrity',
  'image_digest',
  'source_commit',
  'provenance',
]);
const KNOWN_EFFECTS_FIELDS = new Set(['idempotency']);
const KNOWN_DATA_SCOPE_FIELDS = new Set(['categories', 'personas', 'max_context_items']);
const KNOWN_MACHINE_FIELDS = new Set([
  'initial',
  'states',
  'moves',
  'transitions',
  'turn',
  'timeouts',
  'terminal',
]);
const KNOWN_TIMEOUTS_FIELDS = new Set(['move_sec', 'session_ttl_sec']);
const KNOWN_TRANSITION_FIELDS = new Set(['from', 'move', 'ops', 'to']);

/**
 * Reject unknown keys on a nested structured object (§14 fail-closed).
 * Freeform fields (params_schema, result_schema, card, config_schema)
 * are NOT structured and are validated separately — never passed here.
 */
function checkKnownKeys(
  value: unknown,
  known: ReadonlySet<string>,
  path: string,
  err: (code: string, path: string, message: string) => void,
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!known.has(key)) {
      err('unknown_field', `${path}.${key}`, `unknown field "${key}" — fail closed (§14)`);
    }
  }
}

/** Round-8 #4: a non-null, non-array object. Used to guard every structured
 * field BEFORE optional-property access or iteration — the shared protocol
 * validator promises a fail-closed RESULT (it's also AppView's ingest gate),
 * so a scalar where an object/array is expected must never throw or slip. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Round-8 #4: a set-like field must be an ARRAY before `for…of` iteration — a
 * scalar (`kinds: 7`) is not iterable and would THROW mid-validation. Reports
 * `code` and returns [] on a non-array (fail closed), so validation still
 * returns a result instead of crashing. Generic over the declared element type
 * so callers keep their element typing (elements are re-checked downstream). */
function arrayField<T>(
  value: readonly T[] | undefined,
  code: string,
  path: string,
  err: (code: string, path: string, message: string) => void,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    err(code, path, `${path} must be an array`);
    return [];
  }
  return value as T[];
}

/**
 * Round-10 #23: the official semver.org grammar. MAJOR/MINOR/PATCH are numeric
 * identifiers with NO leading zeros; prerelease/build are dot-separated
 * non-empty identifiers. Rejects `01.02.003` (leading zeros) and `1.2.3-..`
 * (empty prerelease identifier) that the old loose regex let through.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
function isSemVer(v: string): boolean {
  return SEMVER_RE.test(v);
}

// F4: a pinned params/result schema is a CONSENT artifact — the owner is
// shown the shape and expects it enforced. The on-node result validator
// (schema_validate.ts) is deliberately small; a schema that DECLARES a
// constraint the validator does not enforce (pattern, const, oneOf, …)
// would silently accept violating values. So a schema may only use the
// keywords the validator actually enforces, plus harmless annotations —
// anything else is rejected here rather than silently ignored downstream.
const ENFORCED_SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
]);
const ANNOTATION_SCHEMA_KEYWORDS = new Set([
  'title',
  'description',
  'default',
  'examples',
  '$comment',
  '$schema',
  '$id',
]);

const KNOWN_SCHEMA_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

interface SchemaProblem {
  readonly kind: 'unenforceable' | 'malformed';
  readonly path: string;
  readonly detail: string;
}

/**
 * Walk a pinned schema and collect two classes of problem:
 *   - `unenforceable`: a keyword the pinned validator does not apply
 *     (`pattern`, `const`, `oneOf`, a schema-valued `additionalProperties`);
 *   - `malformed` (P1-2): an ENFORCED keyword whose VALUE has the wrong shape
 *     (`maxLength: "1"`, `required: [123]`, `type: "quantum"`). Without this,
 *     manifest validation accepted a constraint that LOOKED enforcing but the
 *     runtime silently ignored (`typeof v === 'number'` fell through) — so a
 *     result violating the consented shape was accepted.
 * Descends only the subschema containers the validator recognizes; a
 * `properties` value's own keys are property names, never keywords.
 */
function collectSchemaProblems(schema: unknown, path: string, out: SchemaProblem[]): void {
  if (schema === undefined || schema === null) return; // absent = no constraint
  const where = path === '' ? '(schema)' : path;
  // P1-3 (round 5): a boolean subschema (`false` = reject-all, `true` =
  // accept-all in JSON Schema) is NOT implemented by the pinned runtime
  // validator — it treats every non-object schema as unconstrained, so a
  // `false` subschema would WRONGLY accept anything. Reject the form so consent
  // can never advertise a constraint the runtime silently ignores.
  if (typeof schema === 'boolean') {
    out.push({ kind: 'unenforceable', path: where, detail: 'boolean subschema is not enforced' });
    return;
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    out.push({ kind: 'malformed', path: where, detail: 'schema must be an object' });
    return;
  }
  const s = schema as Record<string, unknown>;
  const at = (k: string): string => (path === '' ? k : `${path}.${k}`);
  const owns = (k: string): boolean => Object.prototype.hasOwnProperty.call(s, k);
  const bad = (p: string, detail: string): void => {
    out.push({ kind: 'malformed', path: p, detail });
  };

  for (const key of Object.keys(s)) {
    if (key === 'additionalProperties') {
      if (typeof s.additionalProperties !== 'boolean') {
        out.push({ kind: 'unenforceable', path: at(key), detail: 'must be a boolean' });
      }
      continue;
    }
    if (ANNOTATION_SCHEMA_KEYWORDS.has(key)) continue;
    if (!ENFORCED_SCHEMA_KEYWORDS.has(key)) {
      out.push({ kind: 'unenforceable', path: at(key), detail: `"${key}" is not enforced` });
      continue;
    }
    // Enforced keyword — validate its VALUE shape (P1-2 mini meta-schema).
    const v = s[key];
    switch (key) {
      case 'type':
        if (typeof v === 'string') {
          if (!KNOWN_SCHEMA_TYPES.has(v)) bad(at(key), `unknown type "${v}"`);
        } else if (Array.isArray(v)) {
          if (
            v.length === 0 ||
            v.some((t) => typeof t !== 'string' || !KNOWN_SCHEMA_TYPES.has(t))
          ) {
            bad(at(key), 'type array must be non-empty known-type strings');
          }
        } else {
          bad(at(key), 'type must be a string or array of type strings');
        }
        break;
      case 'properties':
        if (v === null || typeof v !== 'object' || Array.isArray(v)) {
          bad(at(key), 'properties must be an object');
        }
        break;
      case 'required':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
          bad(at(key), 'required must be an array of strings');
        }
        break;
      case 'enum':
        if (!Array.isArray(v) || v.length === 0) bad(at(key), 'enum must be a non-empty array');
        break;
      case 'items':
        // P1-3 (round 5): tuple validation (`items: [schemaA, schemaB]`) is NOT
        // implemented by the pinned runtime — it validates EVERY element against
        // `items` as a single schema, and an array-valued schema is treated as
        // unconstrained. A manifest requiring per-position item shapes would
        // consent to a constraint the runtime never applies. Reject the form.
        if (Array.isArray(v)) {
          out.push({
            kind: 'unenforceable',
            path: at(key),
            detail: 'tuple items (array) are not enforced; use a single items schema',
          });
        } else if (v === null || typeof v !== 'object') {
          bad(at(key), 'items must be a schema object');
        }
        break;
      case 'minLength':
      case 'maxLength':
      case 'minItems':
      case 'maxItems':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          bad(at(key), `${key} must be a non-negative integer`);
        }
        break;
      case 'minimum':
      case 'maximum':
        if (typeof v !== 'number' || !Number.isFinite(v))
          bad(at(key), `${key} must be a finite number`);
        break;
    }
  }
  // Round-13 #22: cross-keyword bound consistency. Each bound's VALUE shape is
  // checked above, but an unsatisfiable pair (min > max) would install as a
  // consented schema that no input/result can ever satisfy — a footgun the owner
  // approved. Reject `minimum>maximum`, `minLength>maxLength`, `minItems>maxItems`
  // when BOTH are present and numeric.
  for (const [lo, hi] of [
    ['minimum', 'maximum'],
    ['minLength', 'maxLength'],
    ['minItems', 'maxItems'],
  ] as const) {
    if (
      owns(lo) &&
      owns(hi) &&
      typeof s[lo] === 'number' &&
      typeof s[hi] === 'number' &&
      (s[lo] as number) > (s[hi] as number)
    ) {
      bad(at(lo), `${lo} (${s[lo]}) exceeds ${hi} (${s[hi]}) — no value can satisfy this schema`);
    }
  }
  // Descend through the recognized subschema containers only.
  if (owns('properties')) {
    const props = s.properties;
    if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
      for (const [name, sub] of Object.entries(props as Record<string, unknown>)) {
        collectSchemaProblems(sub, `${at('properties')}.${name}`, out);
      }
    }
  }
  // Descend a SINGLE items schema only — tuple `items` arrays were flagged
  // unenforceable above and are not descended.
  if (owns('items') && !Array.isArray(s.items)) {
    collectSchemaProblems(s.items, at('items'), out);
  }
}

/**
 * Secret-field heuristics for config_schema (§5 rule 6). Two layers:
 * structural (format/writeOnly) and name-pattern. A hostile manifest can
 * mislabel — the consent form's paste-pattern warnings are the second
 * heuristic layer; this validator is the structural floor.
 */
const SECRET_NAME_PATTERN =
  /(pass(word|phrase)?|secret|token|api[_-]?key|credential|private[_-]?key)/i;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ValidatePluginManifestOptions {
  /**
   * Byte length of the canonical record bytes as fetched (the honest
   * cap input). When absent, falls back to UTF-8-ish length of
   * JSON.stringify — good enough to stop schema bombs, and the fetch
   * layer should always pass the real number.
   */
  readonly rawByteLength?: number;
}

export function validatePluginManifest(
  manifest: PluginManifest,
  opts: ValidatePluginManifestOptions = {},
): PluginValidationResult {
  const errors: PluginValidationError[] = [];
  const err = (code: string, path: string, message: string): void => {
    errors.push({ code, path, message });
  };

  // --- top-level shape -----------------------------------------------------
  // Round-10 #6: the validator promises a fail-closed RESULT for EVERY JSON
  // value (it is also AppView's ingest gate). A root `null` / scalar reached
  // `Object.keys(null)` → THROW; guard before any property access.
  if (!isPlainObject(manifest)) {
    err('bad_manifest', '', 'manifest must be an object');
    return { ok: false, errors };
  }
  const record = manifest as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_MANIFEST_FIELDS.has(key)) {
      err('unknown_field', key, `unknown manifest field "${key}" — fail closed (§14)`);
    }
  }
  if (manifest.$type !== PLUGIN_NSIDS.release) {
    err('bad_type', '$type', `$type must be "${PLUGIN_NSIDS.release}"`);
  }
  if (!isPluginId(manifest.plugin_id)) {
    err('bad_plugin_id', 'plugin_id', 'plugin_id must be a reverse-DNS identifier (a.b.c)');
  }
  // Round-10 #23: strict SemVer — no leading zeros in numeric identifiers, no
  // empty dot-separated prerelease identifiers. The old `\d+\.\d+\.\d+(-…)?`
  // accepted `01.02.003` and `1.2.3-..`, which break version ordering /
  // advisory matching across implementations.
  if (typeof manifest.version !== 'string' || !isSemVer(manifest.version)) {
    err('bad_version', 'version', 'version must be strict semver (MAJOR.MINOR.PATCH)');
  }
  if (
    typeof manifest.display_name !== 'string' ||
    manifest.display_name.trim() === '' || // Round-14 #18: whitespace-only renders blank
    manifest.display_name.length > PLUGIN_CAPS.MAX_DISPLAY_NAME_LENGTH ||
    // Round-13 #21: no spoofing chars in owner-facing consent text.
    hasUnsafeText(manifest.display_name)
  ) {
    err(
      'bad_display_name',
      'display_name',
      `display_name required, ≤ ${PLUGIN_CAPS.MAX_DISPLAY_NAME_LENGTH} chars, no control/bidi/zero-width chars`,
    );
  }
  if (
    manifest.short_description !== undefined &&
    (typeof manifest.short_description !== 'string' ||
      manifest.short_description.length > PLUGIN_CAPS.MAX_SHORT_DESCRIPTION_LENGTH ||
      hasUnsafeText(manifest.short_description)) // Round-13 #21
  ) {
    err(
      'bad_short_description',
      'short_description',
      `short_description ≤ ${PLUGIN_CAPS.MAX_SHORT_DESCRIPTION_LENGTH} chars, no control/bidi/zero-width chars`,
    );
  }
  // Round-6 #5: structural type checks for the remaining primitive fields —
  // enum + unknown-key checks alone let numeric/negative values through and
  // they are later rendered (homepage/source_url) or used for routing
  // (protocol versions). These are ALSO in the presentation digest (round-5 #9),
  // so a non-string would corrupt the change-receipt too.
  for (const [field, val] of [
    ['homepage', manifest.homepage],
    ['source_url', manifest.source_url],
  ] as const) {
    if (val !== undefined) {
      if (typeof val !== 'string' || val.length > 2048) {
        err('bad_url', field, `${field} must be a string URL (≤ 2048 chars)`);
      } else if (!isSafeHttpUrl(val)) {
        // Round-7 #7 + Round-14 #13: a scheme-prefix regex accepted `"https://"`
        // alone, `https://user:pass@host` (credentials), malformed hosts, and
        // trailing control/bidi/zero-width chars. Parse as a real URL: require
        // http(s), a non-empty host, no embedded credentials, and no spoofing
        // chars — these strings are rendered/linked on owner-facing surfaces.
        err(
          'bad_url',
          field,
          `${field} must be a valid http(s):// URL with a host, no credentials, no control/bidi/zero-width chars`,
        );
      }
    }
  }
  // Round-7 #7: `required_features` is unioned into the compatibility set and
  // must be a string array — a numeric element would be add()ed to the derived
  // feature set and silently mis-gated.
  if (manifest.required_features !== undefined) {
    if (
      !Array.isArray(manifest.required_features) ||
      manifest.required_features.some((f) => typeof f !== 'string')
    ) {
      err('bad_required_features', 'required_features', 'required_features must be a string array');
    }
  }
  // Round-7 #7: `execution.runtime`, when present, must be an OBJECT. A scalar
  // (`runtime: 7`) slips past `checkKnownKeys` (which returns on non-objects)
  // and the optional-chained runner checks, persisting malformed runtime state.
  const rawRuntime = manifest.execution?.runtime;
  if (
    rawRuntime !== undefined &&
    (typeof rawRuntime !== 'object' || rawRuntime === null || Array.isArray(rawRuntime))
  ) {
    err('bad_runtime', 'execution.runtime', 'execution.runtime must be an object');
  }
  // Round-8 #4: the runtime's nested sub-objects have the same contract — a
  // scalar (`self_host: 7`, `artifacts: 7`) slips past `checkKnownKeys` (which
  // returns on a non-object) and would persist malformed runtime state. Guard
  // each as an object when the runtime itself is a valid object.
  if (isPlainObject(rawRuntime)) {
    for (const [key, val] of [
      ['self_host', rawRuntime.self_host],
      ['artifacts', rawRuntime.artifacts],
    ] as const) {
      if (val !== undefined && !isPlainObject(val)) {
        err(
          'bad_runtime_field',
          `execution.runtime.${key}`,
          `execution.runtime.${key} must be an object`,
        );
      }
    }
    // Round-14 #14: the artifact / self_host field VALUES are runtime EVIDENCE
    // (package refs, image digests) rendered on the consent surface — validate
    // each as a non-empty string without spoofing chars, not just "the container
    // is an object". (A strict digest/package-ref grammar is a separate, wider
    // change that would need the real format spec — left as-is here.)
    const evidence: [string, unknown][] = [];
    if (isPlainObject(rawRuntime.artifacts)) {
      for (const k of KNOWN_ARTIFACTS_FIELDS) {
        evidence.push([`artifacts.${k}`, (rawRuntime.artifacts as Record<string, unknown>)[k]]);
      }
    }
    if (isPlainObject(rawRuntime.self_host)) {
      for (const k of KNOWN_SELF_HOST_FIELDS) {
        evidence.push([`self_host.${k}`, (rawRuntime.self_host as Record<string, unknown>)[k]]);
      }
    }
    for (const [path, v] of evidence) {
      if (
        v !== undefined &&
        (typeof v !== 'string' || v === '' || v.length > 512 || hasUnsafeText(v))
      ) {
        err(
          'bad_runtime_evidence',
          `execution.runtime.${path}`,
          `execution.runtime.${path} must be a non-empty string (≤ 512 chars) without control/bidi/zero-width chars`,
        );
      }
    }
  }
  for (const [field, val] of [
    ['min_interpreter', manifest.min_interpreter],
    ['min_plugin_protocol', manifest.min_plugin_protocol],
  ] as const) {
    if (val !== undefined && (typeof val !== 'number' || !Number.isInteger(val) || val < 1)) {
      err('bad_protocol_version', field, `${field} must be a positive integer`);
    }
  }

  // --- size cap ------------------------------------------------------------
  const byteLength = opts.rawByteLength ?? utf8Length(JSON.stringify(manifest));
  if (byteLength > PLUGIN_CAPS.MAX_MANIFEST_BYTES) {
    err(
      'manifest_too_large',
      '',
      `manifest is ${byteLength} bytes; cap is ${PLUGIN_CAPS.MAX_MANIFEST_BYTES} (§5 rule 4)`,
    );
  }

  // --- execution -----------------------------------------------------------
  // F10: fail closed on unknown nested keys at every level of the
  // execution/runtime tree, not just the top of the manifest.
  checkKnownKeys(manifest.execution, KNOWN_EXECUTION_FIELDS, 'execution', err);
  checkKnownKeys(manifest.execution?.runtime, KNOWN_RUNTIME_FIELDS, 'execution.runtime', err);
  checkKnownKeys(
    manifest.execution?.runtime?.issuer,
    KNOWN_ISSUER_FIELDS,
    'execution.runtime.issuer',
    err,
  );
  checkKnownKeys(
    manifest.execution?.runtime?.self_host,
    KNOWN_SELF_HOST_FIELDS,
    'execution.runtime.self_host',
    err,
  );
  checkKnownKeys(
    manifest.execution?.runtime?.artifacts,
    KNOWN_ARTIFACTS_FIELDS,
    'execution.runtime.artifacts',
    err,
  );
  // Round-6 #5: the issuer signs instance certificates (§14) — its did/key must
  // be strings, not just present. `checkKnownKeys` only rejects UNKNOWN keys.
  // Round-10 #6: `issuer = null` reached `null.did` (THROW). Guard it's an
  // object before field access (a non-object issuer is itself invalid).
  const issuer = manifest.execution?.runtime?.issuer;
  if (
    issuer !== undefined &&
    (!isPlainObject(issuer) || typeof issuer.did !== 'string' || typeof issuer.key !== 'string')
  ) {
    err('bad_issuer', 'execution.runtime.issuer', 'issuer.did and issuer.key must be strings');
  }
  const mode = manifest.execution?.mode;
  if (mode !== 'interpreted' && mode !== 'runner') {
    err('bad_execution_mode', 'execution.mode', 'execution.mode must be "interpreted" or "runner"');
  }
  const runtime = manifest.execution?.runtime;
  if (mode === 'interpreted' && runtime !== undefined) {
    err('runtime_on_interpreted', 'execution.runtime', 'interpreted plugins have no runtime block');
  }
  if (mode === 'runner' && runtime?.hosted_endpoint !== undefined) {
    // Hosted runners need a manifest-authorized issuer: the instance
    // certificate signer (§14) — the repo DID cannot sign on a
    // community PDS.
    if (runtime.issuer === undefined || runtime.issuer.did === '' || runtime.issuer.key === '') {
      err(
        'hosted_without_issuer',
        'execution.runtime.issuer',
        'hosted runners must declare runtime.issuer {did, key} — it signs instance certificates (§14)',
      );
    }
    // Round-13 #20: a prefix test (`/^https:\/\//`) accepted `"https://"` alone
    // and other malformed values. Parse as a real URL and require the https
    // scheme AND a non-empty host, so a garbage endpoint fails at CONSENT time
    // rather than much later at fetch.
    let validHttps = false;
    try {
      const u = new URL(runtime.hosted_endpoint);
      validHttps = u.protocol === 'https:' && u.hostname !== '';
    } catch {
      validHttps = false;
    }
    if (!validHttps) {
      err(
        'bad_hosted_endpoint',
        'execution.runtime.hosted_endpoint',
        'hosted_endpoint must be a valid https:// URL with a host',
      );
    }
  }

  // --- capabilities --------------------------------------------------------
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    err('no_capabilities', 'capabilities', 'at least one capability is required');
  } else if (manifest.capabilities.length > PLUGIN_CAPS.MAX_CAPABILITIES) {
    err('too_many_capabilities', 'capabilities', `≤ ${PLUGIN_CAPS.MAX_CAPABILITIES} capabilities`);
  }

  const seenCapIds = new Set<string>();
  const derived = new Set<string>();
  // Round-9 #3/#11: guard the iteration — a non-array `capabilities` is reported
  // above but must not THROW here (`for…of 7`). `arrayField` fails closed to [].
  for (const [i, cap] of arrayField(
    manifest.capabilities,
    'bad_capabilities',
    'capabilities',
    err,
  ).entries()) {
    validateCapability(cap, i, mode, seenCapIds, derived, err);
  }

  // --- config_schema (§5 rule 6: non-secret preferences only) --------------
  if (manifest.config_schema !== undefined) {
    derived.add('config');
    // Round-10 #12: config_schema must be a JSON-Schema OBJECT. A null / number
    // / array was silently accepted (the depth/ref/secret checks all no-op on a
    // non-object). Fail closed on the shape. (The full enforceable-keyword pass
    // that params/result schemas get is deferred until a config runtime ships —
    // P0 drops the `config` feature at install, so no config values run yet.)
    if (!isPlainObject(manifest.config_schema)) {
      err('bad_config_schema', 'config_schema', 'config_schema must be an object');
    }
    const depth = schemaDepth(manifest.config_schema, 0);
    if (depth > PLUGIN_CAPS.MAX_SCHEMA_DEPTH) {
      err(
        'schema_too_deep',
        'config_schema',
        `schema depth ${depth} exceeds ${PLUGIN_CAPS.MAX_SCHEMA_DEPTH}`,
      );
    }
    if (hasRecursiveRef(manifest.config_schema)) {
      err('recursive_ref', 'config_schema', 'recursive $ref is not allowed (§5 rule 4)');
    }
    for (const hit of findSecretFields(manifest.config_schema)) {
      err(
        'secret_config_field',
        `config_schema.${hit}`,
        'config_schema is non-secret preferences only — Dina refuses to be the credential intake (§5 rule 6)',
      );
    }
  }

  // --- required_features union + normalization check -----------------------
  // Round-8 #4: guard the iteration — a non-array required_features is reported
  // above but must not THROW here (`for…of 7`).
  if (Array.isArray(manifest.required_features)) {
    for (const f of manifest.required_features) derived.add(f);
  }
  assertNormalized(manifest, err);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, derivedFeatures: [...derived].sort() };
}

// ---------------------------------------------------------------------------
// Capability validation
// ---------------------------------------------------------------------------

function validateCapability(
  cap: PluginCapabilityDecl,
  index: number,
  mode: string | undefined,
  seenCapIds: Set<string>,
  derived: Set<string>,
  err: (code: string, path: string, message: string) => void,
): void {
  const p = `capabilities[${index}]`;
  // Round-9 #3/#11: a capability element MUST be a plain object before any
  // field access. `capabilities: [null]` / `[7]` reached `Object.keys(null)`
  // (throw) or `cap.id.includes(...)` on `undefined` (throw). Fail closed here
  // — the shared validator promises a RESULT, and it is AppView's ingest gate.
  if (!isPlainObject(cap)) {
    err('bad_capability', p, 'each capability must be an object');
    return;
  }
  const record = cap as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_CAPABILITY_FIELDS.has(key)) {
      err('unknown_field', `${p}.${key}`, `unknown capability field "${key}" — fail closed (§14)`);
    }
  }

  // id: unique, reverse-DNS-ish (custom lane) — grants, routing,
  // envelopes, and scope hashes all identify a capability by this
  // string; two definitions behind one string is how independent
  // components come to silently disagree (§5 rule 4).
  if (!isPluginId(cap.id)) {
    err('bad_capability_id', `${p}.id`, 'capability id must be a reverse-DNS identifier');
  } else if (seenCapIds.has(cap.id)) {
    err('duplicate_capability_id', `${p}.id`, `duplicate capability id "${cap.id}"`);
  }
  seenCapIds.add(cap.id);

  // Round-6 #5: a capability display_name is rendered to the owner on the
  // consent + Activity surfaces — enum/unknown-key checks let a numeric value
  // through. Require a non-empty string within the cap.
  if (
    typeof cap.display_name !== 'string' ||
    cap.display_name.trim() === '' || // Round-14 #18: whitespace-only renders blank
    cap.display_name.length > PLUGIN_CAPS.MAX_DISPLAY_NAME_LENGTH ||
    hasUnsafeText(cap.display_name) // Round-13 #21
  ) {
    err(
      'bad_capability_display_name',
      `${p}.display_name`,
      `capability display_name required, ≤ ${PLUGIN_CAPS.MAX_DISPLAY_NAME_LENGTH} chars, no control/bidi/zero-width chars`,
    );
  }
  if (cap.interaction !== 'query' && cap.interaction !== 'session') {
    err('bad_interaction', `${p}.interaction`, 'interaction must be "query" or "session"');
  }
  if (!ACTION_CLASSES.has(cap.action_class)) {
    err(
      'bad_action_class',
      `${p}.action_class`,
      `unknown action_class "${String(cap.action_class)}"`,
    );
  }
  if (!PRIVACY_CLASSES.has(cap.privacy_class)) {
    err(
      'bad_privacy_class',
      `${p}.privacy_class`,
      `unknown privacy_class "${String(cap.privacy_class)}"`,
    );
  }

  // Round-8 #4: data_scope must itself be an object when present — `data_scope: 7`
  // slipped past `checkKnownKeys` and every optional-chained access below.
  if (cap.data_scope !== undefined && !isPlainObject(cap.data_scope)) {
    err('bad_data_scope', `${p}.data_scope`, 'data_scope must be an object');
  }
  // Round-6 #5: data_scope.categories must be a string array. Beyond letting a
  // numeric category through, an un-typed value CRASHES the banned-category
  // check below (`(7).includes` throws) — a malformed manifest must fail closed,
  // not throw. Compute a safe string list once and use it for the ban check.
  const rawCategories = cap.data_scope?.categories;
  if (
    rawCategories !== undefined &&
    // Round-13 #21: each category is a consent-surface token — must be a
    // NON-EMPTY string with no control/bidi/zero-width chars (an empty or
    // spoofing-char category renders deceptively in the consent card).
    (!Array.isArray(rawCategories) ||
      rawCategories.some((c) => typeof c !== 'string' || c === '' || hasUnsafeText(c)))
  ) {
    err(
      'bad_data_categories',
      `${p}.data_scope.categories`,
      'data_scope.categories must be an array of non-empty strings without control/bidi/zero-width chars',
    );
  }
  // Round-7 #7: data_scope.personas has the same string-array contract as
  // categories (`personas: [42]` was accepted before). Round-14 #15: it is ALSO
  // a consent-surface token, so give it the SAME non-empty + no-spoofing-char
  // treatment categories got in round-13 #21 (it was left as type-only).
  const rawPersonas = cap.data_scope?.personas;
  if (
    rawPersonas !== undefined &&
    (!Array.isArray(rawPersonas) ||
      rawPersonas.some((c) => typeof c !== 'string' || c === '' || hasUnsafeText(c)))
  ) {
    err(
      'bad_data_personas',
      `${p}.data_scope.personas`,
      'data_scope.personas must be an array of non-empty strings without control/bidi/zero-width chars',
    );
  }
  const catList: string[] = Array.isArray(rawCategories)
    ? rawCategories.filter((c): c is string => typeof c === 'string')
    : [];

  // Anti-Her ban (§5 rule 3) — checked against data_scope categories and
  // the capability id itself. Round-10 #7: match is CASE- and SEPARATOR-
  // insensitive — `Romantic`, `com.acme.virtual-friend` (hyphen), etc. must not
  // slip past a ban on `romantic`/`virtual_friend`. Canonicalize both sides:
  // lowercase and fold `-`/`_`/`.` to a single separator before substring match.
  // Round-12 #16: the CATEGORY match is SUBSTRING, not exact array-element
  // equality — the ID path already used substring, but categories used
  // `.includes(b)` (element equality), so a compound category token like
  // `romantic_advice` / `emotional_intimacy_coach` slipped the ban while the
  // capability id stayed innocuous. Categories now get the same containment
  // test as the id (same over-block tradeoff the id path already accepts).
  const canon = (s: string): string => s.toLowerCase().replace(/[-_.]+/g, '_');
  const canonId = canon(cap.id);
  const canonCats = catList.map(canon);
  for (const banned of PLUGIN_BANNED_CATEGORIES) {
    const b = canon(banned);
    if (canonCats.some((c) => c.includes(b)) || canonId.includes(b)) {
      err(
        'banned_category',
        `${p}`,
        `companionship/emotional-intimacy capabilities are banned (Anti-Her, §5 rule 3)`,
      );
    }
  }

  // Schemas: depth + recursion caps + F4 enforceability.
  for (const [name, schema] of [
    ['params_schema', cap.params_schema],
    ['result_schema', cap.result_schema],
  ] as const) {
    if (schema === undefined) continue;
    const depth = schemaDepth(schema, 0);
    if (depth > PLUGIN_CAPS.MAX_SCHEMA_DEPTH) {
      err(
        'schema_too_deep',
        `${p}.${name}`,
        `schema depth ${depth} exceeds ${PLUGIN_CAPS.MAX_SCHEMA_DEPTH}`,
      );
    }
    if (hasRecursiveRef(schema)) {
      err('recursive_ref', `${p}.${name}`, 'recursive $ref is not allowed (§5 rule 4)');
    }
    // F4 + P1-2: reject constraints the pinned validator cannot enforce, AND
    // enforced constraints whose VALUE is malformed (so a schema can't promise
    // a guarantee we either drop or silently ignore at runtime).
    const problems: SchemaProblem[] = [];
    collectSchemaProblems(schema, '', problems);
    const unenforceable = problems.filter((x) => x.kind === 'unenforceable');
    const malformed = problems.filter((x) => x.kind === 'malformed');
    if (unenforceable.length > 0) {
      err(
        'unenforceable_schema_keyword',
        `${p}.${name}`,
        `schema uses constraints Dina does not enforce (${unenforceable.map((x) => x.path).join(', ')}); use only type/properties/required/items/enum and the numeric/string/array bounds`,
      );
    }
    if (malformed.length > 0) {
      err(
        'malformed_schema_constraint',
        `${p}.${name}`,
        `schema constraint has the wrong value shape: ${malformed.map((x) => `${x.path} (${x.detail})`).join('; ')}`,
      );
    }
  }

  // F10: fail closed on unknown nested keys in the structured sub-objects.
  checkKnownKeys(cap.effects, KNOWN_EFFECTS_FIELDS, `${p}.effects`, err);
  checkKnownKeys(cap.data_scope, KNOWN_DATA_SCOPE_FIELDS, `${p}.data_scope`, err);

  // --- session (interpreted) capabilities ----------------------------------
  if (cap.interaction === 'session') {
    if (mode !== 'interpreted') {
      err(
        'session_requires_interpreted',
        `${p}.interaction`,
        'session capabilities are interpreted-mode only',
      );
    }
    if (cap.kinds !== undefined) {
      err('kinds_on_session', `${p}.kinds`, 'session capabilities carry no kinds (§5 rule 3)');
    }
    if (cap.machine === undefined) {
      err('session_without_machine', `${p}.machine`, 'session capabilities require a machine');
    } else {
      validateMachine(cap.machine, p, err);
      derived.add('session');
    }
    const ops = arrayField(cap.ops_used, 'bad_ops_used', `${p}.ops_used`, err);
    for (const op of ops) {
      if (!(PLUGIN_OPS as readonly string[]).includes(op)) {
        err('unknown_op', `${p}.ops_used`, `op "${op}" is not in the closed ops library (§10.2)`);
      } else {
        derived.add(`op.${op}`);
      }
    }
    const budget = cap.verify_budget ?? 0;
    if (!Number.isInteger(budget) || budget < 0 || budget > PLUGIN_CAPS.MAX_VERIFY_BUDGET) {
      err(
        'bad_verify_budget',
        `${p}.verify_budget`,
        `verify_budget must be an integer 0..${PLUGIN_CAPS.MAX_VERIFY_BUDGET}`,
      );
    }
  }

  // --- runner capabilities --------------------------------------------------
  if (mode === 'runner') {
    if (cap.interaction === 'session') {
      err(
        'session_on_runner',
        `${p}.interaction`,
        'runner plugins cannot declare session capabilities',
      );
    }
    // kinds: required, unique entries, valid values, legal combos.
    const kinds = arrayField(cap.kinds, 'bad_kinds', `${p}.kinds`, err);
    if (kinds.length === 0) {
      err(
        'missing_kinds',
        `${p}.kinds`,
        'runner capabilities must declare kinds (§5) — Core authorizes against a consented declaration',
      );
    }
    const seenKinds = new Set<string>();
    for (const k of kinds) {
      if (!(PLUGIN_KINDS as readonly string[]).includes(k)) {
        err('unknown_kind', `${p}.kinds`, `unknown kind "${k}" — fail closed (§14)`);
        continue;
      }
      if (seenKinds.has(k)) {
        err('duplicate_kind', `${p}.kinds`, `duplicate kind "${k}"`);
      }
      seenKinds.add(k);
      derived.add(`kind.${k}`);
    }
    if (seenKinds.has('provider') && cap.interaction !== 'query') {
      err(
        'provider_requires_query',
        `${p}.kinds`,
        'provider kind requires query interaction (§5 rule 3)',
      );
    }
    // effects: required contract field for retry safety (§9.1).
    const idem = cap.effects?.idempotency;
    if (idem !== 'supported' && idem !== 'unsupported') {
      err(
        'missing_effects',
        `${p}.effects.idempotency`,
        'runner capabilities must declare effects.idempotency ("supported" | "unsupported")',
      );
    } else if (idem === 'supported') {
      derived.add('idempotent_retry');
    }
    // intent_phrases: caps + charset (printable, no control chars).
    const phrases = arrayField(cap.intent_phrases, 'bad_phrase', `${p}.intent_phrases`, err);
    if (phrases.length > PLUGIN_CAPS.MAX_INTENT_PHRASES) {
      err(
        'too_many_phrases',
        `${p}.intent_phrases`,
        `≤ ${PLUGIN_CAPS.MAX_INTENT_PHRASES} intent phrases`,
      );
    }
    for (const phrase of phrases) {
      // Round-6 #5: a numeric phrase has `.length === undefined`, so the bounds
      // check below silently passed it. Type-guard first.
      if (typeof phrase !== 'string') {
        err('bad_phrase', `${p}.intent_phrases`, 'intent phrases must be strings');
      } else if (phrase.trim().length === 0 || phrase.length > PLUGIN_CAPS.MAX_PHRASE_LENGTH) {
        // Round-14 #16: a whitespace-only phrase (`"   "`) is non-empty by
        // `.length` but renders blank and, after trim/embed, reads as an
        // extremely broad routing claim. Reject trimmed-empty.
        err(
          'bad_phrase',
          `${p}.intent_phrases`,
          `phrases must be 1..${PLUGIN_CAPS.MAX_PHRASE_LENGTH} non-whitespace chars`,
        );
      } else if (hasUnsafeText(phrase)) {
        // Round-13 #21: widen from ASCII-control-only to also reject C1 /
        // bidi-override / zero-width spoofing chars in owner-facing phrases.
        err(
          'bad_phrase',
          `${p}.intent_phrases`,
          'phrases must not contain control/bidi/zero-width characters',
        );
      }
    }
    // data_scope caps.
    const items = cap.data_scope?.max_context_items;
    if (
      items !== undefined &&
      (!Number.isInteger(items) || items < 0 || items > PLUGIN_CAPS.MAX_CONTEXT_ITEMS)
    ) {
      err(
        'bad_max_context_items',
        `${p}.data_scope.max_context_items`,
        `max_context_items must be 0..${PLUGIN_CAPS.MAX_CONTEXT_ITEMS}`,
      );
    }
    // network_domains: hostname shape only — consent transparency.
    const domains = arrayField(cap.network_domains, 'bad_domain', `${p}.network_domains`, err);
    if (domains.length > PLUGIN_CAPS.MAX_NETWORK_DOMAINS) {
      err(
        'too_many_domains',
        `${p}.network_domains`,
        `≤ ${PLUGIN_CAPS.MAX_NETWORK_DOMAINS} network domains`,
      );
    }
    for (const d of domains) {
      if (!isHostname(d)) {
        err('bad_domain', `${p}.network_domains`, `"${d}" is not a bare hostname`);
      }
    }
    // Interpreted-only fields leaking into runner caps.
    if (
      cap.machine !== undefined ||
      cap.instructions !== undefined ||
      cap.verify_budget !== undefined
    ) {
      err(
        'interpreted_fields_on_runner',
        p,
        'machine/instructions/verify_budget are interpreted-mode fields',
      );
    }
  } else if (mode === 'interpreted') {
    // Runner-only fields leaking into interpreted caps — interpreted
    // plugins see nothing personal, ever (§11): no data_scope, no
    // network, no kinds, no intent routing.
    if (
      cap.kinds !== undefined ||
      cap.data_scope !== undefined ||
      cap.network_domains !== undefined ||
      cap.intent_phrases !== undefined ||
      cap.effects !== undefined
    ) {
      err(
        'runner_fields_on_interpreted',
        p,
        'kinds/effects/intent_phrases/data_scope/network_domains are runner-mode fields',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Machine validation (§5 rule 4 caps + uniqueness + referential integrity)
// ---------------------------------------------------------------------------

function validateMachine(
  machine: PluginMachine,
  p: string,
  err: (code: string, path: string, message: string) => void,
): void {
  const mp = `${p}.machine`;
  // Round-9 #3/#11: a non-object machine must not throw on `.initial` etc.
  if (!isPlainObject(machine)) {
    err('bad_machine', mp, 'machine must be an object');
    return;
  }
  // F10: fail closed on unknown machine / timeouts keys.
  checkKnownKeys(machine, KNOWN_MACHINE_FIELDS, mp, err);
  checkKnownKeys(machine.timeouts, KNOWN_TIMEOUTS_FIELDS, `${mp}.timeouts`, err);
  // Round-9 #3/#11: `states: 7` reached `for…of 7` (not iterable → throw).
  // arrayField fails closed to [] and flags the non-array; keep the range
  // check for real arrays (an empty [] is still `bad_states`).
  const states = arrayField(machine.states, 'bad_states', `${mp}.states`, err);
  if (
    Array.isArray(machine.states) &&
    (states.length === 0 || states.length > PLUGIN_CAPS.MAX_STATES)
  ) {
    err('bad_states', `${mp}.states`, `states must be 1..${PLUGIN_CAPS.MAX_STATES}`);
  }
  const stateSet = new Set<string>();
  for (const s of states) {
    if (stateSet.has(s)) err('duplicate_state', `${mp}.states`, `duplicate state "${s}"`);
    stateSet.add(s);
  }
  // Round-9 #3/#11: `moves: 7` was silently coerced to an empty move set
  // (`Object.keys(7)` → []) — a non-object moves must be REJECTED, not accepted.
  if (machine.moves !== undefined && !isPlainObject(machine.moves)) {
    err('bad_moves', `${mp}.moves`, 'moves must be an object');
  }
  const movesObj = isPlainObject(machine.moves) ? machine.moves : {};
  const moves = Object.keys(movesObj);
  if (moves.length > PLUGIN_CAPS.MAX_MOVE_TYPES) {
    err('too_many_moves', `${mp}.moves`, `≤ ${PLUGIN_CAPS.MAX_MOVE_TYPES} move types`);
  }
  for (const [name, schema] of Object.entries(movesObj)) {
    const depth = schemaDepth(schema, 0);
    if (depth > PLUGIN_CAPS.MAX_SCHEMA_DEPTH) {
      err(
        'schema_too_deep',
        `${mp}.moves.${name}`,
        `move schema depth ${depth} exceeds ${PLUGIN_CAPS.MAX_SCHEMA_DEPTH}`,
      );
    }
    if (hasRecursiveRef(schema)) {
      err('recursive_ref', `${mp}.moves.${name}`, 'recursive $ref is not allowed');
    }
  }
  if (!stateSet.has(machine.initial)) {
    err('bad_initial', `${mp}.initial`, `initial state "${machine.initial}" is not in states`);
  }
  for (const t of arrayField(machine.terminal, 'bad_terminal', `${mp}.terminal`, err)) {
    if (!stateSet.has(t))
      err('bad_terminal', `${mp}.terminal`, `terminal state "${t}" is not in states`);
  }

  // transitions: per-state cap, ops cap + closed set, referential
  // integrity, and NO ambiguous (state, move) pairs (§5 rule 4).
  // Round-9 #3/#11: `transitions: 7` reached `(7).entries()` (throw); arrayField
  // fails closed to [].
  const perState = new Map<string, number>();
  const stateMovePairs = new Set<string>();
  for (const [i, t] of arrayField(
    machine.transitions,
    'bad_transitions',
    `${mp}.transitions`,
    err,
  ).entries()) {
    const tp = `${mp}.transitions[${i}]`;
    // A non-object transition element must not throw on `.from`/`.ops`.
    if (!isPlainObject(t)) {
      err('bad_transition', tp, 'each transition must be an object');
      continue;
    }
    checkKnownKeys(t, KNOWN_TRANSITION_FIELDS, tp, err);
    if (!stateSet.has(t.from)) err('bad_transition_from', tp, `unknown from-state "${t.from}"`);
    if (!stateSet.has(t.to)) err('bad_transition_to', tp, `unknown to-state "${t.to}"`);
    if (!moves.includes(t.move)) err('bad_transition_move', tp, `unknown move "${t.move}"`);
    const count = (perState.get(t.from) ?? 0) + 1;
    perState.set(t.from, count);
    if (count > PLUGIN_CAPS.MAX_TRANSITIONS_PER_STATE) {
      err(
        'too_many_transitions',
        tp,
        `≤ ${PLUGIN_CAPS.MAX_TRANSITIONS_PER_STATE} transitions per state`,
      );
    }
    const ops = arrayField(t.ops, 'bad_ops', `${tp}.ops`, err);
    if (ops.length > PLUGIN_CAPS.MAX_OPS_PER_TRANSITION) {
      err('too_many_ops', tp, `≤ ${PLUGIN_CAPS.MAX_OPS_PER_TRANSITION} ops per transition`);
    }
    for (const op of ops) {
      if (!(PLUGIN_OPS as readonly string[]).includes(op)) {
        err('unknown_op', tp, `op "${op}" is not in the closed ops library (§10.2)`);
      }
    }
    const pair = `${t.from}\u0000${t.move}`;
    if (stateMovePairs.has(pair)) {
      err(
        'ambiguous_transition',
        tp,
        `ambiguous (state, move) pair ("${t.from}", "${t.move}") — rejections, never first-match-wins`,
      );
    }
    stateMovePairs.add(pair);
  }
  // Round-10 #6: `timeouts = null` reached `null.move_sec` (THROW). Require it
  // to be an object before field access.
  const timeouts = machine.timeouts;
  if (
    !isPlainObject(timeouts) ||
    !Number.isInteger(timeouts.move_sec) ||
    (timeouts.move_sec as number) <= 0 ||
    !Number.isInteger(timeouts.session_ttl_sec) ||
    (timeouts.session_ttl_sec as number) <= 0
  ) {
    err(
      'bad_timeouts',
      `${mp}.timeouts`,
      'timeouts require positive integer move_sec + session_ttl_sec',
    );
  }
  if (machine.turn !== 'alternate' && machine.turn !== 'free') {
    err('bad_turn', `${mp}.turn`, 'turn must be "alternate" or "free"');
  }
}

// ---------------------------------------------------------------------------
// Normalization check — the normalized form is the stored form (§8.1);
// a manifest that arrives un-normalized must be normalized by the
// caller BEFORE validation + storage, so hash and runtime agree.
// ---------------------------------------------------------------------------

function assertNormalized(
  manifest: PluginManifest,
  err: (code: string, path: string, message: string) => void,
): void {
  const check = (path: string, values: readonly string[] | undefined): void => {
    if (values === undefined) return;
    // Round-6 #5: a malformed set (non-array, or non-string elements) is
    // reported by the structural checks in validateCapability (bad_data_
    // categories etc.); skip the normalized-ness check here so `normalizeStringSet`
    // (which iterates + compares code points) never THROWS on it — the validator
    // must fail closed, never crash.
    if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) return;
    const normalized = normalizeStringSet(values);
    if (values.length !== normalized.length || values.some((v, i) => v !== normalized[i])) {
      err(
        'not_normalized',
        path,
        'set-like array is not deduplicated + sorted — normalize before validating (§8.1)',
      );
    }
  };
  check('required_features', manifest.required_features);
  // Round-9 #3/#11: a non-array `capabilities` or a scalar/null element would
  // THROW here (`.entries()` / field access on a non-object). The structural
  // errors are already reported by validateCapability — skip malformed entries
  // so this normalization pass fails closed instead of crashing.
  const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  for (const [i, cap] of caps.entries()) {
    // Runtime-only object check (no type predicate — keep cap's declared type so
    // the string-set fields stay typed): skip malformed entries already flagged.
    if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) continue;
    const p = `capabilities[${i}]`;
    check(`${p}.kinds`, cap.kinds);
    check(`${p}.ops_used`, cap.ops_used);
    check(`${p}.intent_phrases`, cap.intent_phrases);
    check(`${p}.network_domains`, cap.network_domains);
    check(`${p}.data_scope.categories`, cap.data_scope?.categories);
    check(`${p}.data_scope.personas`, cap.data_scope?.personas);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Round-14 #13: a safe, renderable http(s) URL — parses as a URL with an
 * http/https scheme, a non-empty host, NO embedded credentials, and no
 * spoofing chars. A scheme-prefix regex alone accepted `"https://"` and
 * `https://user:pass@host`.
 */
function isSafeHttpUrl(s: string): boolean {
  if (hasUnsafeText(s)) return false;
  try {
    const u = new URL(s);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      u.hostname !== '' &&
      u.username === '' &&
      u.password === ''
    );
  } catch {
    return false;
  }
}

/** Reverse-DNS identifier: ≥3 dot-separated lowercase alnum segments. */
function isPluginId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length >= 5 &&
    id.length <= 253 &&
    /^[a-z0-9]+([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]+([a-z0-9-]*[a-z0-9])?){2,}$/.test(id)
  );
}

/** Bare hostname (no scheme, no path, no port, no userinfo). */
function isHostname(d: string): boolean {
  return (
    d.length > 0 &&
    d.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)
  );
}

/** Max nesting depth of a JSON value (objects + arrays both count). */
export function schemaDepth(value: unknown, depth: number): number {
  if (value === null || typeof value !== 'object') return depth;
  let max = depth + 1;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    // Cheap early exit: past the cap, exact depth no longer matters.
    if (max > PLUGIN_CAPS.MAX_SCHEMA_DEPTH + 1) return max;
    const d = schemaDepth(child, depth + 1);
    if (d > max) max = d;
  }
  return max;
}

/**
 * Recursive-$ref detection (§5 rule 4: "no recursive $ref"). We reject
 * ANY internal `$ref` — the conservative reading. Plugin schemas are
 * small by design; `$ref` indirection buys nothing but a recursion
 * vector, and rejecting it entirely means no cycle detector to get
 * wrong. (Implementation note: spec says "no recursive $ref"; we
 * enforce "no $ref at all" and document the tightening.)
 */
export function hasRecursiveRef(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasRecursiveRef);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '$ref') return true;
    if (hasRecursiveRef(v)) return true;
  }
  return false;
}

/** Walk a JSON Schema's properties for secret-typed / secret-named fields. */
export function findSecretFields(schema: unknown, prefix = ''): string[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const s = schema as Record<string, unknown>;
  const hits: string[] = [];
  if (s.format === 'password' || s.writeOnly === true) hits.push(prefix || '(root)');
  const props = s.properties;
  if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
    for (const [name, sub] of Object.entries(props as Record<string, unknown>)) {
      const path = prefix === '' ? name : `${prefix}.${name}`;
      if (SECRET_NAME_PATTERN.test(name)) hits.push(path);
      hits.push(...findSecretFields(sub, path));
    }
  }
  // items / oneOf / anyOf / allOf containers.
  for (const key of ['items', 'oneOf', 'anyOf', 'allOf'] as const) {
    const sub = s[key];
    if (Array.isArray(sub)) for (const v of sub) hits.push(...findSecretFields(v, prefix));
    else if (sub !== undefined) hits.push(...findSecretFields(sub, prefix));
  }
  return hits;
}

/** UTF-8 byte length without Buffer (runtime-agnostic). */
function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i) as number;
    if (code > 0xffff) i++; // surrogate pair consumed
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
