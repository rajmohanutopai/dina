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
import { hasUnsafeText, hasDeceptiveText } from './text_safety';
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
  'host_operations',
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
// PLG-27 #11: the TEXT annotations render as strings on the consent/approval
// form, so they must BE strings — a numeric/object `title`/`description` was
// previously accepted silently, leaving a consent field that renders blank or
// oddly. `default`/`examples` are DATA annotations (not rendered as text, and
// already depth-/$ref-bounded by the schema-wide passes), so they keep only the
// string-only spoof/length check without a type constraint.
const TEXT_ANNOTATION_KEYWORDS = new Set(['title', 'description', '$comment', '$schema', '$id']);

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
  // PLG-27 #10: cap the collector itself. The `err()` sink bounds the diagnostic
  // COUNT, but without a collector budget a wide/deep schema still accumulates
  // thousands of SchemaProblem entries (each carrying a full nested path) before
  // the sink trims them — the joined message is super-linear in the input. Stop
  // walking once the budget is hit; a truncated problem list still fails closed
  // (the schema is already invalid the moment ANY problem is recorded).
  if (out.length >= PLUGIN_CAPS.MAX_SCHEMA_PROBLEMS) return;
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
    if (ANNOTATION_SCHEMA_KEYWORDS.has(key)) {
      // Round-16 #16: annotation strings (title/description/$comment) render on
      // the consent/approval form — bound length + reject spoofing chars.
      const av = s[key];
      if (TEXT_ANNOTATION_KEYWORDS.has(key)) {
        // PLG-27 #11: text annotations MUST be strings — reject non-strings
        // outright instead of accepting them silently.
        if (typeof av !== 'string') {
          bad(at(key), `"${key}" annotation must be a string`);
        } else if (av.length > PLUGIN_CAPS.MAX_SCHEMA_ANNOTATION_LENGTH || hasUnsafeText(av)) {
          bad(at(key), 'annotation string is too long or has control/bidi/zero-width chars');
        }
      } else if (
        typeof av === 'string' &&
        (av.length > PLUGIN_CAPS.MAX_SCHEMA_ANNOTATION_LENGTH || hasUnsafeText(av))
      ) {
        bad(at(key), 'annotation string is too long or has control/bidi/zero-width chars');
      }
      continue;
    }
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
          } else if (v.length > PLUGIN_CAPS.MAX_TYPE_MEMBERS || new Set(v).size !== v.length) {
            // PLG-27 #12: bound + dedup the type array (only 7 known types exist,
            // so thousands of duplicate entries are pure amplification).
            bad(at(key), 'type array exceeds the member cap or has duplicate entries');
          }
        } else {
          bad(at(key), 'type must be a string or array of type strings');
        }
        break;
      case 'properties':
        if (v === null || typeof v !== 'object' || Array.isArray(v)) {
          bad(at(key), 'properties must be an object');
        } else if (Object.keys(v).length > PLUGIN_CAPS.MAX_SCHEMA_PROPERTIES) {
          // PLG-27 #12: cap the property-key count (each key inflates consent
          // rendering + every runtime validation).
          bad(at(key), `properties has more than ${PLUGIN_CAPS.MAX_SCHEMA_PROPERTIES} keys`);
        }
        break;
      case 'required':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
          bad(at(key), 'required must be an array of strings');
        } else if (
          // PLG-27 #12: bound the count, dedup, and reject blank required names.
          v.length > PLUGIN_CAPS.MAX_REQUIRED_ENTRIES ||
          new Set(v).size !== v.length ||
          v.some((x) => isBlankOrPadded(x as string)) // PLG-28 #14: blank or padded
        ) {
          bad(
            at(key),
            'required exceeds the entry cap, has duplicates, or has a blank/padded entry',
          );
        }
        break;
      case 'enum':
        if (!Array.isArray(v) || v.length === 0) {
          bad(at(key), 'enum must be a non-empty array');
        } else if (v.length > PLUGIN_CAPS.MAX_ENUM_MEMBERS) {
          // Round-16 #13: the pinned runtime deep-equal-scans EVERY enum member
          // per validation (params/result run in shipped runner mode), so cap
          // the member count to bound the per-invocation linear cost.
          bad(at(key), `enum has ${v.length} members; cap is ${PLUGIN_CAPS.MAX_ENUM_MEMBERS}`);
        }
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
  // PLG-28 #4: an UNSATISFIABLE required/properties pair. When
  // `additionalProperties: false`, every `required` name must be a declared
  // `properties` key — otherwise NO object value can satisfy the schema (omitting
  // the property fails the required check; including it fails the
  // additionalProperties check). The pinned runtime (schema_validate.ts) enforces
  // both, so such a schema silently BRICKS a consented runner capability on every
  // object invocation. Same footgun class as the min>max reject above; this one
  // bites shipping runner params/result schemas today, not just interpreted mode.
  if (owns('required') && owns('additionalProperties') && s.additionalProperties === false) {
    const propKeys =
      s.properties !== null && typeof s.properties === 'object' && !Array.isArray(s.properties)
        ? new Set(Object.keys(s.properties as Record<string, unknown>))
        : new Set<string>();
    if (Array.isArray(s.required)) {
      for (const req of s.required) {
        if (typeof req === 'string' && !propKeys.has(req)) {
          bad(
            at('required'),
            `required property "${req}" is not a declared property while additionalProperties is false — no value can satisfy this schema`,
          );
        }
      }
    }
  }
  // Descend through the recognized subschema containers only.
  if (owns('properties')) {
    const props = s.properties;
    if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
      for (const [name, sub] of Object.entries(props as Record<string, unknown>)) {
        if (out.length >= PLUGIN_CAPS.MAX_SCHEMA_PROBLEMS) break; // PLG-27 #10: collector budget
        // Round-16 #16: property NAMES become consent/approval form field labels
        // — a bidi/zero-width name can spoof `amount`/`recipient`. Bound + check.
        // PLG-27 #13: a whitespace-only or empty property name renders blank —
        // the shared identifier contract (non-empty after trim, bounded, no
        // spoofing chars) applies here as to machine state/move names.
        if (!isValidIdentifier(name)) {
          bad(
            `${at('properties')}.${name}`,
            'property name is empty/blank, too long, or has control/bidi/zero-width chars',
          );
        }
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
 * PLG-27 #10: render at most a bounded slice of schema problems into a single
 * diagnostic message, with a "(+N more)" suffix. The collector is already
 * budget-capped, but a per-message slice keeps each `err()` string small and
 * deterministic regardless of how the budget was consumed.
 */
const MAX_JOINED_SCHEMA_PROBLEMS = 25;
function joinSchemaProblems(
  items: SchemaProblem[],
  fmt: (x: SchemaProblem) => string,
  sep: string,
): string {
  const shown = items.slice(0, MAX_JOINED_SCHEMA_PROBLEMS).map(fmt).join(sep);
  return items.length > MAX_JOINED_SCHEMA_PROBLEMS
    ? `${shown}${sep}(+${items.length - MAX_JOINED_SCHEMA_PROBLEMS} more)`
    : shown;
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
  let diagnosticsTruncated = false;
  const err = (code: string, path: string, message: string): void => {
    // Round-16 #17: bound the diagnostic output. A maximally-malformed manifest
    // (e.g. thousands of unknown keys) would otherwise expand into an error
    // structure much larger than the 256 KB input. Stop at MAX_DIAGNOSTICS and
    // append a single sentinel — deterministic, so the validator stays pure.
    if (errors.length >= PLUGIN_CAPS.MAX_DIAGNOSTICS) {
      if (!diagnosticsTruncated) {
        diagnosticsTruncated = true;
        errors.push({
          code: 'diagnostics_truncated',
          path: '',
          message: `further validation errors omitted (cap ${PLUGIN_CAPS.MAX_DIAGNOSTICS})`,
        });
      }
      return;
    }
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
    isBlankOrPadded(manifest.display_name) || // Round-14 #18 + PLG-28 #14: blank/padded renders deceptively
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
  // Round-16 #18: `icon` is typed `unknown` on the assumption AppView validates
  // it, but the repo-proof / direct-install path runs THIS validator with no
  // AppView. Apply a shape/size FLOOR so malformed/oversized icon data can't
  // enter the stored manifest and reach the consent/marketplace UI: bound the
  // serialized byte size, and reject spoofing chars in a string icon. (Byte-
  // content decoding stays a render-layer concern.)
  if (manifest.icon !== undefined) {
    let iconBytes: number;
    try {
      iconBytes = utf8Length(JSON.stringify(manifest.icon) ?? '');
    } catch {
      iconBytes = PLUGIN_CAPS.MAX_ICON_BYTES + 1; // unserializable → reject
    }
    // PLG-27 #16: `icon` is a blob REFERENCE (a string CID/URL or a blob-ref
    // object), never a bare number/boolean/array. The exact blob-ref STRUCTURE
    // is deliberately undefined at this layer (typed `unknown`; AppView owns the
    // blob format), so we enforce a shape FLOOR — a plain object or a string —
    // rather than inventing a schema. This rejects `icon: 42` / `icon: [..]` /
    // `icon: true` that previously passed on byte size alone.
    // PLG-28 #15: raise the object floor. PLG-27 #16 accepted ANY plain object,
    // including `{}` and `{foo:'bar'}` — an empty/garbage icon that reaches the
    // consent/marketplace surface on the AppView-independent repo-proof path. The
    // exact blob-ref format stays deferred to AppView (icon is `unknown`), so we
    // do NOT invent a schema; we only require an object icon to be NON-EMPTY and
    // carry at least one recognized, non-empty string reference key. A string
    // icon (CID/URL) still passes as before.
    // PLG-30 #14: `$type` is a DISCRIMINATOR, not a reference — `{ $type: 'blob' }`
    // with no actual CID/ref carries no icon, yet it satisfied the old floor and
    // reached the consent/marketplace surface. Require a genuine content-reference
    // key (`cid`/`uri`/`ref`/`src`/`url`) with a non-empty string value; `$type`
    // alone no longer qualifies. (Full blob grammar stays deferred to AppView.)
    const ICON_REF_KEYS = ['cid', 'uri', 'ref', 'src', 'url'] as const;
    const iconObjOk =
      isPlainObject(manifest.icon) &&
      ICON_REF_KEYS.some((k) => {
        const val = (manifest.icon as Record<string, unknown>)[k];
        return typeof val === 'string' && val !== '';
      });
    const iconShapeOk = iconObjOk || typeof manifest.icon === 'string';
    // PLG-29 #18: spoof-scan ALL rendered strings, not just a STRING icon. An
    // OBJECT icon's ref values (e.g. `{cid: 'bidi‮here'}`) reach the consent /
    // marketplace surface too, but PLG-28 #15 ran hasUnsafeText only on a string
    // icon — so a bidi/control/zero-width char inside an object value slipped
    // through. Reject spoofing chars in any icon string value. (A full CID/blob
    // grammar stays deferred to AppView — the format is undefined here.)
    const iconStrings: string[] = isPlainObject(manifest.icon)
      ? Object.values(manifest.icon).filter((v): v is string => typeof v === 'string')
      : typeof manifest.icon === 'string'
        ? [manifest.icon]
        : [];
    if (!iconShapeOk || iconBytes > PLUGIN_CAPS.MAX_ICON_BYTES || iconStrings.some(hasUnsafeText)) {
      err(
        'bad_icon',
        'icon',
        `icon must be a string CID/URL or a blob-ref object with a cid/uri/ref/src/url string, serialize to ≤ ${PLUGIN_CAPS.MAX_ICON_BYTES} bytes, with no control/bidi/zero-width chars`,
      );
    }
  }
  // Round-7 #7: `required_features` is unioned into the compatibility set and
  // must be a string array — a numeric element would be add()ed to the derived
  // feature set and silently mis-gated.
  if (manifest.required_features !== undefined) {
    // Round-16 #15: each token is JOINED into an owner-facing compatibility
    // error (install_service "needs features…"), so bound the count + per-token
    // length and reject empty / spoofing-char tokens. (Dedup is already enforced
    // downstream by the not_normalized check.)
    if (
      !Array.isArray(manifest.required_features) ||
      manifest.required_features.length > PLUGIN_CAPS.MAX_REQUIRED_FEATURES ||
      manifest.required_features.some(
        (f) =>
          typeof f !== 'string' ||
          isBlankOrPadded(f) || // PLG-27 #14 + PLG-28 #14: blank OR padded tokens
          f.length > PLUGIN_CAPS.MAX_REQUIRED_FEATURE_LENGTH ||
          hasUnsafeText(f),
      )
    ) {
      err(
        'bad_required_features',
        'required_features',
        `required_features must be ≤ ${PLUGIN_CAPS.MAX_REQUIRED_FEATURES} non-empty strings (≤ ${PLUGIN_CAPS.MAX_REQUIRED_FEATURE_LENGTH} chars, no control/bidi/zero-width chars)`,
      );
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
        // PLG-27 #14 (same class): reject whitespace-only, not just empty.
        (typeof v !== 'string' || isBlankOrPadded(v) || v.length > 512 || hasUnsafeText(v))
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
  // PLG-28 #5: `card` (and other `unknown` fields) carry unrestricted nested
  // data, and `JSON.stringify` recurses — a deeply-nested `card` throws
  // `RangeError: Maximum call stack size exceeded`. This validator's contract is
  // TOTALITY (it is also AppView's ingest gate), and finishBegin does not wrap it
  // in try/catch, so an unguarded throw here breaks the fail-closed-RESULT
  // promise on the untrusted ingest boundary. Guard it exactly like the icon-size
  // path already does: an unserializable/too-deep manifest is treated as over-cap.
  // PLG-30 #17: `opts.rawByteLength` is a caller-supplied count (AppView ingest
  // measuring the real received bytes). `??` only falls back on null/undefined, so
  // a negative / fractional / NaN value slipped straight through (`-1 > MAX` and
  // `NaN > MAX` are both false) AND short-circuited the real size computation —
  // pairing `rawByteLength: -1` with a genuinely oversized manifest defeated the
  // cap. Honor it ONLY when it is a finite non-negative integer; otherwise measure
  // the manifest ourselves.
  const providedByteLength =
    typeof opts.rawByteLength === 'number' &&
    Number.isInteger(opts.rawByteLength) &&
    opts.rawByteLength >= 0
      ? opts.rawByteLength
      : undefined;
  let byteLength: number;
  try {
    byteLength = providedByteLength ?? utf8Length(JSON.stringify(manifest));
  } catch {
    byteLength = PLUGIN_CAPS.MAX_MANIFEST_BYTES + 1;
  }
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
  if (issuer !== undefined) {
    // Round-15 #12: the issuer signs runtime instance certificates (§14) and is
    // rendered on the consent surface, so it gets the same display-safety +
    // shape floor as the trust-anchor id fields (isSafeAnchorField): a
    // did:-prefixed, bounded, spoofing-char-free DID + a bounded, clean key.
    // Full DID/multibase-doc validity is the verifier seam's job; this closes
    // the "any two strings pass" gap (invalid DIDs, multi-KB values, bidi/
    // zero-width chars all previously passed).
    const okDid =
      isPlainObject(issuer) &&
      typeof issuer.did === 'string' &&
      issuer.did.startsWith('did:') &&
      issuer.did.length <= 256 &&
      !hasUnsafeText(issuer.did);
    const okKey =
      isPlainObject(issuer) &&
      typeof issuer.key === 'string' &&
      !isBlankOrPadded(issuer.key) && // PLG-27 #14 + PLG-28 #14: reject blank OR padded
      issuer.key.length <= 256 &&
      !hasUnsafeText(issuer.key);
    if (!okDid || !okKey) {
      err(
        'bad_issuer',
        'execution.runtime.issuer',
        'issuer.did must be a did:-prefixed ≤256-char string and issuer.key a non-empty ≤256-char string, both without control/bidi/zero-width chars',
      );
    }
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
    // Round-13 #20 + Round-15 #11: a prefix test (`/^https:\/\//`) accepted
    // `"https://"` alone; a bare scheme+host parse still accepted
    // `https://user:pass@host` (embedded credentials) and control/bidi/zero-width
    // chars in the path. Require the https scheme AND (via isSafeHttpUrl) a
    // non-empty host, NO embedded credentials, and no spoofing chars — the same
    // strictness homepage/source_url already enforce, so a garbage or
    // credential-bearing endpoint fails at CONSENT time rather than at fetch.
    let validHttps = false;
    try {
      const u = new URL(runtime.hosted_endpoint);
      validHttps =
        u.protocol === 'https:' && u.hostname !== '' && isSafeHttpUrl(runtime.hosted_endpoint);
    } catch {
      validHttps = false;
    }
    if (!validHttps) {
      err(
        'bad_hosted_endpoint',
        'execution.runtime.hosted_endpoint',
        'hosted_endpoint must be a valid https:// URL with a host, no embedded credentials, no control/bidi/zero-width chars',
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
    isBlankOrPadded(cap.display_name) || // Round-14 #18 + PLG-28 #14: blank/padded renders deceptively
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
    // Round-16 #14: also cap the COUNT + per-entry length — thousands of long
    // categories inflate hashing / normalization / consent rendering / context
    // projection (the whole-manifest byte cap alone permits tens of thousands).
    (!Array.isArray(rawCategories) ||
      rawCategories.length > PLUGIN_CAPS.MAX_DATA_CATEGORIES ||
      rawCategories.some(
        (c) =>
          typeof c !== 'string' ||
          isBlankOrPadded(c) || // PLG-27 #14 + PLG-28 #14: blank OR padded token
          c.length > PLUGIN_CAPS.MAX_DATA_SCOPE_ENTRY_LENGTH ||
          hasUnsafeText(c),
      ))
  ) {
    err(
      'bad_data_categories',
      `${p}.data_scope.categories`,
      `data_scope.categories must be ≤ ${PLUGIN_CAPS.MAX_DATA_CATEGORIES} non-empty strings (≤ ${PLUGIN_CAPS.MAX_DATA_SCOPE_ENTRY_LENGTH} chars, no control/bidi/zero-width chars)`,
    );
  }
  // Round-7 #7: data_scope.personas has the same string-array contract as
  // categories (`personas: [42]` was accepted before). Round-14 #15: it is ALSO
  // a consent-surface token, so give it the SAME non-empty + no-spoofing-char
  // treatment categories got in round-13 #21 (it was left as type-only).
  const rawPersonas = cap.data_scope?.personas;
  if (
    rawPersonas !== undefined &&
    // Round-16 #14: cap COUNT + per-entry length (see categories above).
    (!Array.isArray(rawPersonas) ||
      rawPersonas.length > PLUGIN_CAPS.MAX_DATA_PERSONAS ||
      rawPersonas.some(
        (c) =>
          typeof c !== 'string' ||
          isBlankOrPadded(c) || // PLG-27 #14 + PLG-28 #14: blank OR padded token
          c.length > PLUGIN_CAPS.MAX_DATA_SCOPE_ENTRY_LENGTH ||
          hasUnsafeText(c),
      ))
  ) {
    err(
      'bad_data_personas',
      `${p}.data_scope.personas`,
      `data_scope.personas must be ≤ ${PLUGIN_CAPS.MAX_DATA_PERSONAS} non-empty strings (≤ ${PLUGIN_CAPS.MAX_DATA_SCOPE_ENTRY_LENGTH} chars, no control/bidi/zero-width chars)`,
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
  // PLG-27 #7 (totality): `cap.id` may be a non-string (numeric / null / omitted)
  // — a `bad_capability_id` error is already recorded above, but `canon(cap.id)`
  // would call `.toLowerCase()` on a non-string and THROW, breaking the
  // validator's fail-closed-RESULT contract on the untrusted AppView ingest path
  // (and the direct-install path). Fall back to an empty canon; the manifest is
  // already invalid, so the ban check simply has nothing to match.
  const canonId = typeof cap.id === 'string' ? canon(cap.id) : '';
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
        `schema uses constraints Dina does not enforce (${joinSchemaProblems(unenforceable, (x) => x.path, ', ')}); use only type/properties/required/items/enum and the numeric/string/array bounds`,
      );
    }
    if (malformed.length > 0) {
      err(
        'malformed_schema_constraint',
        `${p}.${name}`,
        `schema constraint has the wrong value shape: ${joinSchemaProblems(malformed, (x) => `${x.path} (${x.detail})`, '; ')}`,
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
    // PLG-28 #10: parse ops_used FIRST so validateMachine can cross-check that
    // every transition op is DECLARED here. Compatibility features are derived
    // from ops_used ONLY, so an op executed by a transition but absent from
    // ops_used would slip past the §14 compatibility gate.
    const ops = arrayField(cap.ops_used, 'bad_ops_used', `${p}.ops_used`, err);
    const opsUsedSet = new Set<string>();
    for (const op of ops) {
      if (!(PLUGIN_OPS as readonly string[]).includes(op)) {
        err('unknown_op', `${p}.ops_used`, `op "${op}" is not in the closed ops library (§10.2)`);
      } else {
        derived.add(`op.${op}`);
        opsUsedSet.add(op);
      }
    }
    if (cap.machine === undefined) {
      err('session_without_machine', `${p}.machine`, 'session capabilities require a machine');
    } else {
      validateMachine(cap.machine, p, opsUsedSet, err);
      derived.add('session');
    }
    const budget = cap.verify_budget ?? 0;
    if (!Number.isInteger(budget) || budget < 0 || budget > PLUGIN_CAPS.MAX_VERIFY_BUDGET) {
      err(
        'bad_verify_budget',
        `${p}.verify_budget`,
        `verify_budget must be an integer 0..${PLUGIN_CAPS.MAX_VERIFY_BUDGET}`,
      );
    }
    // PLG-28 #11: `instructions` is the interpreted LLM-step prompt (string|null)
    // — it feeds the §8.1 behavior hash, the consent surface, and the future
    // interpreter, but was accepted at ANY type/length. Require string|null,
    // bound the length, and reject deceptive chars — but ALLOW newlines/tabs
    // (a multi-line prompt), so use hasDeceptiveText, not hasUnsafeText.
    if (cap.instructions !== undefined && cap.instructions !== null) {
      if (
        typeof cap.instructions !== 'string' ||
        cap.instructions.length > PLUGIN_CAPS.MAX_INSTRUCTIONS_LENGTH ||
        hasDeceptiveText(cap.instructions)
      ) {
        err(
          'bad_instructions',
          `${p}.instructions`,
          `instructions must be a string ≤ ${PLUGIN_CAPS.MAX_INSTRUCTIONS_LENGTH} chars with no control/bidi/zero-width chars (newlines allowed)`,
        );
      }
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
      } else if (isBlankOrPadded(phrase) || phrase.length > PLUGIN_CAPS.MAX_PHRASE_LENGTH) {
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
    // host_operations (§3.4): bounded allowlist of registered
    // extension-operation names. Shape-only here; the per-install
    // consent gate and deny-before-validation live in Core.
    const hostOps = arrayField(
      cap.host_operations,
      'bad_host_operation',
      `${p}.host_operations`,
      err,
    );
    if (hostOps.length > PLUGIN_CAPS.MAX_HOST_OPERATIONS) {
      err(
        'too_many_host_operations',
        `${p}.host_operations`,
        `≤ ${PLUGIN_CAPS.MAX_HOST_OPERATIONS} host operations`,
      );
    }
    for (const op of hostOps) {
      if (
        typeof op !== 'string' ||
        op.length === 0 ||
        op.length > 128 ||
        !/^[a-z0-9_.:-]+$/.test(op)
      ) {
        err(
          'bad_host_operation',
          `${p}.host_operations`,
          `"${String(op)}" is not a valid operation name`,
        );
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
      cap.effects !== undefined ||
      cap.host_operations !== undefined
    ) {
      err(
        'runner_fields_on_interpreted',
        p,
        'kinds/effects/intent_phrases/data_scope/network_domains/host_operations are runner-mode fields',
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
  opsUsed: ReadonlySet<string>,
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
    // Round-16 #8: state identifiers MUST be non-empty strings. A numeric state
    // passes the by-value `stateSet.has(initial/terminal/from/to)` checks below
    // (the set would hold the number) and would diverge across language ports /
    // destabilize the behavior hash. Type-check before building the set.
    // PLG-27 #13: use the shared identifier contract — this ALSO rejects
    // whitespace-only names (which rendered blank) and, for the first time,
    // spoofing chars in state names (states had no hasUnsafeText check at all).
    if (!isValidIdentifier(s)) {
      err(
        'bad_state',
        `${mp}.states`,
        'each state must be a non-empty string (bounded, no control/bidi/zero-width chars)',
      );
      continue;
    }
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
    // PLG-27 #13: move NAMES are matched at runtime against transition `move`
    // refs and render in consent/turn UI — the shared identifier contract
    // rejects empty/whitespace-only/spoofing-char move names (previously only
    // the move SCHEMA was validated, never the name).
    if (!isValidIdentifier(name)) {
      err(
        'bad_move',
        `${mp}.moves`,
        `move name "${name}" must be a non-empty string (bounded, no control/bidi/zero-width chars)`,
      );
    }
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
    // Round-16 #9: move schemas got only depth + recursive-ref checks, but
    // params/result schemas ALSO run the F4 enforceability meta-schema. Without
    // it a move schema can consent to a constraint (`pattern`, `const`, tuple
    // items, boolean subschema) the pinned runtime silently ignores. Apply the
    // same gate here.
    const problems: SchemaProblem[] = [];
    collectSchemaProblems(schema, '', problems);
    const unenforceable = problems.filter((x) => x.kind === 'unenforceable');
    const malformed = problems.filter((x) => x.kind === 'malformed');
    if (unenforceable.length > 0) {
      err(
        'unenforceable_schema_keyword',
        `${mp}.moves.${name}`,
        `move schema uses constraints Dina does not enforce (${joinSchemaProblems(unenforceable, (x) => x.path, ', ')})`,
      );
    }
    if (malformed.length > 0) {
      err(
        'malformed_schema_constraint',
        `${mp}.moves.${name}`,
        `move schema constraint has the wrong value shape: ${joinSchemaProblems(malformed, (x) => `${x.path} (${x.detail})`, '; ')}`,
      );
    }
  }
  if (!stateSet.has(machine.initial)) {
    err('bad_initial', `${mp}.initial`, `initial state "${machine.initial}" is not in states`);
  }
  // PLG-28 #13: `terminal` gets the same rigor `states` already has — non-empty,
  // count-capped, and deduped. Previously duplicates + an empty terminal list
  // passed (hash amplification + a session with no completion path).
  const terminalArr = arrayField(machine.terminal, 'bad_terminal', `${mp}.terminal`, err);
  if (Array.isArray(machine.terminal) && machine.terminal.length === 0) {
    err(
      'bad_terminal',
      `${mp}.terminal`,
      'a session machine must declare at least one terminal state',
    );
  }
  if (terminalArr.length > PLUGIN_CAPS.MAX_STATES) {
    err('bad_terminal', `${mp}.terminal`, `≤ ${PLUGIN_CAPS.MAX_STATES} terminal states`);
  }
  const terminalSet = new Set<string>();
  for (const t of terminalArr) {
    if (!stateSet.has(t)) {
      err('bad_terminal', `${mp}.terminal`, `terminal state "${t}" is not in states`);
    }
    if (terminalSet.has(t)) {
      err('duplicate_terminal', `${mp}.terminal`, `duplicate terminal state "${t}"`);
    }
    terminalSet.add(t);
  }

  // transitions: per-state cap, ops cap + closed set, referential
  // integrity, and NO ambiguous (state, move) pairs (§5 rule 4).
  // Round-9 #3/#11: `transitions: 7` reached `(7).entries()` (throw); arrayField
  // fails closed to [].
  const perState = new Map<string, number>();
  const stateMovePairs = new Set<string>();
  const transitions = arrayField(machine.transitions, 'bad_transitions', `${mp}.transitions`, err);
  for (const [i, t] of transitions.entries()) {
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
    // PLG-30 #12: a terminal state is ABSORBING (execution ends there). A
    // transition OUT of a terminal makes runtimes disagree on whether the session
    // ends or follows the edge — reject it so terminals are unambiguously final.
    if (terminalSet.has(t.from)) {
      err(
        'transition_from_terminal',
        tp,
        `terminal state "${t.from}" must not have outgoing transitions`,
      );
    }
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
      } else if (!opsUsed.has(op)) {
        // PLG-28 #10: every op a transition EXECUTES must be DECLARED in
        // ops_used. Compatibility features are derived from ops_used only, so an
        // undeclared transition op means the §14 gate never learns the plugin
        // needs `op.<x>` — fail closed, ops_used must be the honest declaration.
        err('undeclared_transition_op', tp, `transition op "${op}" is not declared in ops_used`);
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
  // PLG-28 #12 (minimal totality): the spec (§types) documents "transitions are
  // total functions." Full coverage (every reachable (state,move) pair defined,
  // all terminals reachable) is a design item, but the two footguns that brick a
  // session install are cheap to close now: (a) a machine with NO transitions,
  // and (b) a reachable NON-terminal state with no outgoing transition — both
  // install a session that immediately hangs with no legal move. Require ≥1
  // transition and that every non-terminal state is some transition's `from`.
  if (Array.isArray(machine.transitions) && transitions.length === 0) {
    err(
      'no_transitions',
      `${mp}.transitions`,
      'a session machine must declare at least one transition',
    );
  }
  for (const st of stateSet) {
    if (!terminalSet.has(st) && !perState.has(st)) {
      err(
        'dead_end_state',
        `${mp}.transitions`,
        `non-terminal state "${st}" has no outgoing transition — the session can reach it and hang`,
      );
    }
  }
  // PLG-29 #16 + PLG-30 #11: terminal REACHABILITY, tightened. `dead_end_state`
  // only proves each non-terminal has an OUTGOING edge; the earlier check proved
  // only that SOME terminal is reachable from `initial` — a machine could still
  // enter a reachable non-terminal cycle that can never complete and pass. Require
  // that EVERY state reachable from `initial` can itself reach a terminal:
  //   1. forward BFS from `initial` → the states the session can actually enter;
  //   2. reverse BFS from the terminals → the states that CAN reach a terminal;
  //   3. any reachable state NOT in (2) is a stuck state → error.
  // Guarded on a valid initial + non-empty terminal set so it doesn't double-
  // report those errors.
  if (stateSet.has(machine.initial) && terminalSet.size > 0) {
    const fwd = new Map<string, string[]>();
    const rev = new Map<string, string[]>();
    for (const t of transitions) {
      if (isPlainObject(t) && typeof t.from === 'string' && typeof t.to === 'string') {
        const f = fwd.get(t.from);
        if (f) f.push(t.to);
        else fwd.set(t.from, [t.to]);
        const r = rev.get(t.to);
        if (r) r.push(t.from);
        else rev.set(t.to, [t.from]);
      }
    }
    // (1) forward-reachable from `initial`
    const reachable = new Set<string>([machine.initial]);
    const fq: string[] = [machine.initial];
    while (fq.length > 0) {
      for (const nxt of fwd.get(fq.shift() as string) ?? []) {
        if (!reachable.has(nxt)) {
          reachable.add(nxt);
          fq.push(nxt);
        }
      }
    }
    // (2) can reach a terminal — reverse BFS seeded from every terminal
    const canComplete = new Set<string>(terminalSet);
    const rq: string[] = [...terminalSet];
    while (rq.length > 0) {
      for (const prev of rev.get(rq.shift() as string) ?? []) {
        if (!canComplete.has(prev)) {
          canComplete.add(prev);
          rq.push(prev);
        }
      }
    }
    // (3) every reachable state must be able to complete
    const stuck = [...reachable].find((st) => !canComplete.has(st));
    if (stuck !== undefined) {
      err(
        'terminal_unreachable',
        `${mp}.transitions`,
        `state "${stuck}" is reachable from the initial state but cannot reach any terminal — the session can get stuck and never complete`,
      );
    }
  }
  // PLG-29 #17: every DECLARED move must appear in ≥1 transition — a move
  // declared but wired into no transition renders as a legal action the player
  // can never take (dead consent surface). Full state×move totality is
  // intentionally NOT required (moves are legitimately state-gated — see the
  // narrowed "partial function" doc on PluginMachine); this only rejects a move
  // that is unusable everywhere.
  const usedMoves = new Set<string>();
  for (const t of transitions) {
    if (isPlainObject(t) && typeof t.move === 'string') usedMoves.add(t.move);
  }
  for (const name of moves) {
    if (!usedMoves.has(name)) {
      err(
        'unused_move',
        `${mp}.moves.${name}`,
        `declared move "${name}" appears in no transition — it can never be played`,
      );
    }
  }
  // Round-10 #6: `timeouts = null` reached `null.move_sec` (THROW). Require it
  // to be an object before field access.
  const timeouts = machine.timeouts;
  if (
    !isPlainObject(timeouts) ||
    !Number.isInteger(timeouts.move_sec) ||
    (timeouts.move_sec as number) <= 0 ||
    // Round-16 #10: cap the ceiling too. MAX_SAFE_INTEGER passed the positive-
    // integer check → effectively permanent sessions + possible timer overflow
    // in language ports that convert to ms. Bound both to sane, sub-overflow max.
    (timeouts.move_sec as number) > PLUGIN_CAPS.MAX_MOVE_SEC ||
    !Number.isInteger(timeouts.session_ttl_sec) ||
    (timeouts.session_ttl_sec as number) <= 0 ||
    (timeouts.session_ttl_sec as number) > PLUGIN_CAPS.MAX_SESSION_TTL_SEC ||
    // PLG-27 #19: move_sec > session_ttl_sec describes an IMPOSSIBLE move — the
    // session expires before the per-move timeout can ever fire, leaving runtime
    // precedence implementation-defined across ports. Require move_sec ≤ ttl so
    // the shorter, authoritative bound is unambiguous.
    (timeouts.move_sec as number) > (timeouts.session_ttl_sec as number)
  ) {
    err(
      'bad_timeouts',
      `${mp}.timeouts`,
      `timeouts require move_sec in 1..${PLUGIN_CAPS.MAX_MOVE_SEC}, session_ttl_sec in 1..${PLUGIN_CAPS.MAX_SESSION_TTL_SEC}, and move_sec ≤ session_ttl_sec`,
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
    check(`${p}.host_operations`, cap.host_operations);
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

/**
 * PLG-27 #13: one canonical identifier contract shared by machine state names,
 * machine move names, and JSON-Schema property names. All three render on
 * owner-facing surfaces and/or feed the §8.1 behavior hash, so a blank /
 * whitespace-only name renders deceptively and a spoofing-char name can
 * masquerade as another identifier. Non-empty after trim, bounded length, and
 * free of control/bidi/zero-width chars.
 *
 * PLG-28 #14: ALSO reject SURROUNDING whitespace (`s !== s.trim()`). `" health"`
 * and `"health"` are visually identical but hash-/scope-distinct, and normalize
 * does NOT trim tokens — so a token that differs from its trimmed form would
 * survive as a separate set member. We reject at validation rather than trim in
 * normalize because trimming would rewrite the token AFTER the manifest CID was
 * computed, breaking the repo-proof/CID binding (verifier.ts already rejects a
 * URI where `uri !== uri.trim()` for the same reason).
 */
function isValidIdentifier(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.trim() !== '' &&
    s === s.trim() &&
    s.length <= PLUGIN_CAPS.MAX_IDENTIFIER_LENGTH &&
    !hasUnsafeText(s)
  );
}

/**
 * PLG-28 #14: shared blank-OR-surrounded-whitespace predicate for the many
 * consent/scope token sites that are NOT identifiers (display names, data-scope
 * categories/personas, required_features, intent phrases, runtime evidence,
 * issuer key). Returns true when the string is empty after trim OR carries
 * leading/trailing whitespace — both of which normalize can't repair and which
 * render deceptively. (Callers already own the length + hasUnsafeText checks.)
 */
function isBlankOrPadded(s: string): boolean {
  return s.trim() === '' || s !== s.trim();
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
