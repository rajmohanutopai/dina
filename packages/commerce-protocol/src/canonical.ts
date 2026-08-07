/**
 * Canonical JSON for commerce digest inputs (§9.12).
 *
 * JCS-style: RFC 8785's core rules for the JSON subset the commerce
 * wire emits — object keys sorted by code unit, no insignificant
 * whitespace, standard JSON string escaping. Non-finite numbers and
 * bare `undefined` are REJECTED rather than coerced: a digest input
 * that needed coercion is a bug upstream. Object properties whose
 * value is `undefined` are dropped, matching "absent field" on the
 * wire — an absent optional field and a missing key canonicalize
 * identically.
 *
 * Same rules as @dina/protocol's `canonicalJson` (plugins/digests.ts),
 * duplicated deliberately: both packages are independently consumable
 * leaves (§6.1), and a cross-package import would fold one into the
 * other. The frozen conformance vectors on each side pin the bytes,
 * so drift between the copies is a test failure, not a silent fork.
 *
 * Commerce wire types carry every numeric value as a STRING (money
 * minor units, quantity values, sequences, epochs), so JSON numbers
 * appear only in bounded metadata (e.g. `retry_after_seconds`,
 * `credit_days`) and must be finite integers there.
 */

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** UTF-8 encode — runtime-agnostic (Node, Hermes, browsers, workers). */
export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
