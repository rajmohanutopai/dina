/**
 * Manifest normalization — set-like arrays deduplicated and sorted
 * (Unicode code-point order).
 *
 * Spec §8.1: JCS sorts object keys but preserves array order, so
 * `["tool","provider"]` versus `["provider","tool"]` must not
 * manufacture a re-consent. Normalization is NOT hash-private: the
 * normalized form is the STORED form — what ingest validates, what the
 * registry keeps, what consent renders, and what runtime consumes.
 * `intent_phrases` ordering in a classifier prompt is behavior, so two
 * manifests that hash alike must also RUN alike.
 *
 * Set-like fields (§8.1): `kinds`, `data_scope.categories`,
 * `data_scope.personas`, `network_domains`, `ops_used`,
 * `intent_phrases` — plus `required_features` and advisory
 * `affected_cids` (same set semantics; see implementation notes).
 *
 * Everything else is preserved byte-for-byte: machine `states`,
 * `terminal`, and transition `ops` are BEHAVIOR (execution order of ops
 * matters; state lists document the machine as authored) and are hashed
 * as authored via the behavior hash.
 *
 * Pure functions. Zero runtime deps.
 */

import type {
  PluginAdvisory,
  PluginCapabilityDecl,
  PluginDataScope,
  PluginManifest,
} from './types';

/**
 * Compare two strings by Unicode CODE POINT (not UTF-16 code unit). JS's
 * default `<`/`.sort()` compares code units, so an astral character
 * (U+1xxxx, encoded as a surrogate pair whose lead unit is 0xD800–0xDBFF)
 * sorts BEFORE a BMP character above U+E000 — the opposite of code-point
 * order. `intent_phrases` permit arbitrary printable Unicode, so a Go /
 * Rust / Swift / Kotlin / Python port sorting by code point would compute
 * a DIFFERENT scope hash for the same manifest. Iterating with `for..of`
 * yields code points, making this the canonical, cross-implementation
 * order. (For ASCII/BMP-only fields the result is identical to `.sort()`,
 * so existing digests are unchanged.)
 */
export function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const an = ai.next();
    const bn = bi.next();
    if (an.done === true && bn.done === true) return 0;
    if (an.done === true) return -1; // a is a prefix of b
    if (bn.done === true) return 1;
    const ca = an.value.codePointAt(0) as number;
    const cb = bn.value.codePointAt(0) as number;
    if (ca !== cb) return ca - cb;
  }
}

/**
 * Deduplicate + sort a string array by Unicode CODE POINT — the canonical
 * order the scope/behavior/presentation digests hash. Set-like arrays are
 * stored in this form (the normalized form IS the stored form, §8.1), so
 * every implementation that sorts by code point produces byte-identical
 * digests.
 *
 * Generic over the string literal type so `PluginKind[]` normalizes
 * without a cast.
 */
export function normalizeStringSet<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function normalizeDataScope(scope: PluginDataScope): PluginDataScope {
  return {
    ...scope,
    categories: normalizeStringSet(scope.categories),
    ...(scope.personas !== undefined ? { personas: normalizeStringSet(scope.personas) } : {}),
  };
}

function normalizeCapability(cap: PluginCapabilityDecl): PluginCapabilityDecl {
  return {
    ...cap,
    ...(cap.kinds !== undefined ? { kinds: normalizeStringSet(cap.kinds) } : {}),
    ...(cap.ops_used !== undefined ? { ops_used: normalizeStringSet(cap.ops_used) } : {}),
    ...(cap.intent_phrases !== undefined
      ? { intent_phrases: normalizeStringSet(cap.intent_phrases) }
      : {}),
    ...(cap.network_domains !== undefined
      ? { network_domains: normalizeStringSet(cap.network_domains) }
      : {}),
    ...(cap.data_scope !== undefined ? { data_scope: normalizeDataScope(cap.data_scope) } : {}),
  };
}

/**
 * Produce the normalized (stored-form) manifest. Deep-copies only the
 * paths it rewrites; schema objects and machine definitions are shared
 * by reference (treat the result as immutable, like the input).
 */
export function normalizePluginManifest(manifest: PluginManifest): PluginManifest {
  return {
    ...manifest,
    ...(manifest.required_features !== undefined
      ? { required_features: normalizeStringSet(manifest.required_features) }
      : {}),
    capabilities: manifest.capabilities.map(normalizeCapability),
  };
}

/** Advisory normalization: `affected_cids` is a set. */
export function normalizePluginAdvisory(advisory: PluginAdvisory): PluginAdvisory {
  return { ...advisory, affected_cids: normalizeStringSet(advisory.affected_cids) };
}
