/**
 * Requester-identity auto-fill (WM-BRAIN-06e).
 *
 * Many provider-side capability schemas declare a required identity
 * field — `patient_id`, `customer_ref`, `account_number`, `member_id`.
 * When a Dina requester omits one, the downstream options are both
 * bad: ask the LLM to invent an id (hallucination risk), or let the
 * query bounce off the provider's own JSON-Schema validator.
 *
 * This module plugs the gap deterministically: ANY required field
 * whose name "looks like" a requester identity (matches
 * `looksLikeRequesterField`) gets `"self"` substituted when the caller
 * left it missing or empty. `"self"` is the agreed-upon wire sentinel
 * that the provider resolves to the authenticated DID on its side —
 * no PII traverses the wire and there is no ambiguity for the LLM to
 * hallucinate around.
 *
 * Heuristic (port of `_looks_like_requester_field`):
 *   - Prefixes:  patient_, customer_, account_, member_
 *   - Suffix _ref / _id match ONLY when combined with one of those
 *     prefixes. Plain `id` / `ref` is too generic — we must not fill
 *     something like `reservation_id` because the caller omitting it
 *     is a genuine error, not an identity gap.
 *
 * Public surface stays small on purpose: `looksLikeRequesterField` +
 * `autofillRequesterFields`. Both are pure.
 *
 * Port of `brain/src/service/vault_context.py::_autofill_requester_fields`.
 */

/** Lowercase prefixes that mark a requester identity field. */
const REQUESTER_PREFIXES = ['patient_', 'customer_', 'account_', 'member_'] as const;

/** Wire sentinel — expanded to the authenticated DID on the provider side. */
export const REQUESTER_SELF_SENTINEL = 'self';

/**
 * Heuristic: does `fieldName` look like a requester identity field?
 *
 *   patient_id     → true
 *   customer_ref   → true
 *   account_number → true   (prefix match, any suffix works)
 *   member_email   → true   (prefix match — conservative: accept any
 *                             field the caller prefixed with member_)
 *   id             → false  (plain suffix; too generic)
 *   reservation_id → false  (suffix-only without one of the prefixes)
 *   notes          → false
 *
 * Case-insensitive. Empty / whitespace → false.
 */
export function looksLikeRequesterField(name: string): boolean {
  if (typeof name !== 'string') return false;
  const n = name.trim().toLowerCase();
  if (n === '') return false;
  for (const p of REQUESTER_PREFIXES) {
    if (n.startsWith(p)) return true;
  }
  return false;
}

/**
 * JSON-Schema subset the autofill reads. We only need `required`
 * (string array) and, optionally, `properties` (so the filler never
 * invents keys that aren't declared).
 */
export interface RequesterAutofillSchema {
  required?: readonly string[];
  properties?: Record<string, unknown>;
}

/** Result of a fill pass. `filled` lists the keys that were populated. */
export interface RequesterAutofillResult {
  params: Record<string, unknown>;
  filled: string[];
}

/**
 * Fill requester identity fields on `params` with `"self"` when the
 * caller omitted or blank-stringed them.
 *
 * Rules (match Python):
 *   - Only schemas with a non-empty `required` array do anything.
 *   - A required key is eligible only if it exists in
 *     `schema.properties` (filler never invents keys the schema
 *     doesn't declare). When `properties` is absent, the check is
 *     skipped — callers that pass partial schemas still get the fill.
 *   - A required key is filled iff `looksLikeRequesterField(key)`.
 *   - Already-supplied values (including the empty string, which we
 *     treat as missing) are OVERWRITTEN only when the value is missing
 *     or an empty string. Non-empty values (any type) are preserved.
 *   - Returns a NEW params object; input is never mutated.
 */
export function autofillRequesterFields(
  params: Record<string, unknown>,
  schema: RequesterAutofillSchema | null | undefined,
): RequesterAutofillResult {
  const safeParams: Record<string, unknown> = { ...(params ?? {}) };
  const result: RequesterAutofillResult = {
    params: safeParams,
    filled: [],
  };
  if (schema === null || schema === undefined) return result;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length === 0) return result;
  const properties = schema.properties;

  for (const key of required) {
    if (typeof key !== 'string' || key === '') continue;
    if (properties !== undefined && !Object.prototype.hasOwnProperty.call(properties, key)) {
      // Schema declares key as required but NOT in properties —
      // something is off with the published schema. Skip; don't try
      // to infer a slot.
      continue;
    }
    if (!looksLikeRequesterField(key)) continue;
    const current = safeParams[key];
    if (current !== undefined && current !== '') continue;
    safeParams[key] = REQUESTER_SELF_SENTINEL;
    result.filled.push(key);
  }
  return result;
}
