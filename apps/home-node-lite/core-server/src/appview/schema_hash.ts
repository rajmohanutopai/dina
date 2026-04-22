/**
 * Task 6.18 — `schema_hash` canonical SHA-256.
 *
 * Providers of D2D capabilities publish a `capability_schemas` block
 * to their AT Protocol `com.dina.service.profile` record; requesters
 * pull that block from AppView and send a `schema_hash` alongside
 * each `service.query`. The provider compares the inbound hash to
 * the hash of its currently-published schema and rejects mismatches
 * as `schema_version_mismatch` (see the SF-Transit plan doc, §Part 2
 * "ServiceHandler validates…"). If hashes don't agree, the requester
 * refreshes from AppView + retries once.
 *
 * **Hash contract** (must be byte-identical to the Python reference
 * `brain/src/service/capabilities/registry.py::compute_schema_hash`):
 *
 *   hash = SHA-256( canonical-JSON(schema-object) )
 *   canonical-JSON =
 *     - Object keys sorted lexicographically (code-point order)
 *     - Nested objects canonicalised recursively
 *     - Arrays preserve element order but recurse into elements
 *     - No whitespace between tokens
 *     - `undefined` / function / symbol values dropped from objects
 *     - `undefined` inside arrays becomes `null` (matches JSON.stringify)
 *     - `NaN` / `±Infinity` become `null` (matches JSON.stringify)
 *     - Circular structures throw TypeError
 *     - Top-level `undefined` throws TypeError (can't hash nothing)
 *
 * **Why a custom canonicaliser instead of `JSON.stringify(v, null, 0)`?**
 * Three reasons:
 *   1. `JSON.stringify` is insertion-order for string keys + numeric
 *      order for integer-like keys. Python's `json.dumps(sort_keys=True)`
 *      does plain lex sort. We need to match Python so requester +
 *      provider agree on the hash. `{"10": 0, "2": 0}` differs between
 *      the two engines without this canonicaliser.
 *   2. Deterministic cycle detection with a useful error rather than
 *      a stack overflow.
 *   3. Centralised rule for number-normalisation (NaN → null) so
 *      we don't depend on V8's stringify quirks.
 *
 * **Output is stable** across Node versions, platforms, and the
 * order the caller built the object — this is the property the
 * schema_hash contract relies on.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6e task 6.18.
 */

import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialisation — stable byte-output for a given
 * JSON-compatible value. See module doc for the exact rules.
 *
 * @throws TypeError on circular references, top-level `undefined`,
 *         or `bigint` (matches `JSON.stringify` behaviour).
 */
export function canonicalJSON(value: unknown): string {
  const out = canonicalise(value, new WeakSet<object>());
  if (out === undefined) {
    throw new TypeError('canonicalJSON: top-level value is not JSON-serialisable');
  }
  return out;
}

/**
 * SHA-256 over the canonical JSON form. Returns lowercase-hex —
 * matches Python's `hashlib.sha256(...).hexdigest()`.
 */
export function computeSchemaHash(schema: unknown): string {
  if (
    schema === null ||
    typeof schema !== 'object' ||
    Array.isArray(schema)
  ) {
    throw new TypeError(
      'computeSchemaHash: schema must be a plain object (received ' +
        describe(schema) +
        ')',
    );
  }
  const canonical = canonicalJSON(schema);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ── Internals ──────────────────────────────────────────────────────────

/**
 * Returns the canonical JSON string, or `undefined` to signal "this
 * value is JSON-undefined" (drops from objects, becomes `null` in
 * arrays). Mirrors `JSON.stringify`'s behaviour except object keys
 * are lex-sorted.
 */
function canonicalise(value: unknown, seen: WeakSet<object>): string | undefined {
  // JSON.stringify drops these from objects + arrays-with-null in arrays.
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return undefined;
  }
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    // NaN + ±Infinity → null (matches JSON.stringify).
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') {
    throw new TypeError('canonicalJSON: cannot serialize BigInt');
  }
  if (typeof value !== 'object') {
    // Unknown primitive — refuse rather than silently coerce.
    throw new TypeError(
      'canonicalJSON: unsupported value type ' + typeof value,
    );
  }
  if (seen.has(value)) {
    throw new TypeError('canonicalJSON: circular structure detected');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const parts = value.map((v) => {
        const s = canonicalise(v, seen);
        // JSON.stringify turns undefined-in-array into null.
        return s === undefined ? 'null' : s;
      });
      return '[' + parts.join(',') + ']';
    }
    // Plain object — sort keys lexicographically (code-point order),
    // which matches Python's `json.dumps(sort_keys=True)`.
    const keys = Object.keys(value as object).sort();
    const entries: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      const s = canonicalise(v, seen);
      if (s === undefined) continue; // drop
      entries.push(JSON.stringify(k) + ':' + s);
    }
    return '{' + entries.join(',') + '}';
  } finally {
    seen.delete(value);
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
