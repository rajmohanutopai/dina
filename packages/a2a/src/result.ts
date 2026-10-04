/**
 * Remote results: the default result envelope and sanitation (design §6.5).
 *
 * The order is fixed: size caps → SANITATION → schema validation of the
 * final, transformed value → quarantine. Validating before sanitizing could
 * release bytes the transformation pushed out of contract (a truncated string
 * no longer matching a `const`, a stripped character breaking a pattern), so
 * the schema always sees exactly what would be released.
 *
 * Sanitation:
 *  - only `text` and `data` parts are carried; `raw` and `url` refuse the
 *    whole result (Dina never fetches or decodes a remote's file);
 *  - every string (text, data values, data keys) loses invisible code points
 *    (`stripInvisible`) and lone surrogates; `\t`, `\n`, `\r` stay;
 *  - a text longer than the cap is cut to the cap and the result is flagged;
 *  - part metadata, filenames and media types are dropped.
 * A key that sanitation would merge into another key, a `__proto__` key, or
 * data nested deeper than the released envelope can be canonicalized refuses
 * the result. Sanitation never throws on any input.
 */

import { A2A_LIMITS } from './constants';
import { canonicalize } from './jcs';
import {
  deepFreeze,
  hasOwn,
  isPlainObject,
  utf8Length,
  type JsonObject,
  type JsonValue,
} from './json';
import { FORBIDDEN_MEMBER_NAME } from './strict_json';
import { stripInvisible, type StripReport } from './unicode';
import { partContentKind } from './validate';

/** The default result envelope, used when a skill binding pins no result schema. */
export const DEFAULT_RESULT_SCHEMA: JsonObject = deepFreeze<JsonObject>({
  $id: 'dina:a2a:default-result:v1',
  type: 'object',
  required: ['version', 'parts'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    parts: {
      type: 'array',
      minItems: 1,
      maxItems: A2A_LIMITS.maxParts,
      items: {
        oneOf: [
          {
            type: 'object',
            required: ['text'],
            additionalProperties: false,
            properties: { text: { type: 'string', maxLength: A2A_LIMITS.maxTextCodePoints } },
          },
          {
            type: 'object',
            required: ['data'],
            additionalProperties: false,
            properties: { data: { type: 'object' } },
          },
        ],
      },
    },
  },
});

/**
 * sha256 hex over RFC 8785 of {@link DEFAULT_RESULT_SCHEMA}. Pinned so a
 * silent edit to the schema is a test failure. A schema with this hash IS
 * the default: a skill binding that pins it is stored as pinning nothing,
 * and result ingest treats it as default mode.
 */
export const DEFAULT_RESULT_SCHEMA_HASH =
  '09a27ba0738acdce9992b5b511ff19de478790baa57046dcae87b610969fff0c';

export type SanitizedPart = { text: string } | { data: JsonValue };

export interface SanitizedResult {
  /** The default-envelope value: `{version: 1, parts}`. */
  envelope: { version: 1; parts: SanitizedPart[] };
  /** True when any text was cut to the cap. */
  truncated: boolean;
  /** True when any character was removed. */
  stripped: boolean;
}

export type SanitizeOutcome = { ok: true; result: SanitizedResult } | { ok: false; reason: string };

/**
 * Depth at which a data part's value sits inside the released envelope
 * `{version, parts: [{data: …}]}` (root 0, `parts` 1, the part 2). Sanitation
 * counts from here, so data it accepts never exceeds the canonicalizer's cap
 * once wrapped.
 */
const DATA_DEPTH_IN_ENVELOPE = 3;

class SanitizeRefusal extends Error {}

function sanitizeValue(value: unknown, depth: number, state: StripReport): JsonValue {
  if (depth > A2A_LIMITS.maxJsonDepth) throw new SanitizeRefusal('data_too_deep');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SanitizeRefusal('data_non_finite_number');
    return value;
  }
  if (typeof value === 'string') return stripInvisible(value, state);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, depth + 1, state));
  if (isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, member] of Object.entries(value)) {
      const cleanKey = stripInvisible(key, state);
      // Assigning `__proto__` would set the prototype, not a member.
      if (cleanKey === FORBIDDEN_MEMBER_NAME) throw new SanitizeRefusal('data_forbidden_key');
      if (Object.prototype.hasOwnProperty.call(out, cleanKey))
        throw new SanitizeRefusal('data_key_collision');
      out[cleanKey] = sanitizeValue(member, depth + 1, state);
    }
    return out;
  }
  throw new SanitizeRefusal('data_not_json');
}

function truncateCodePoints(s: string, max: number): { text: string; cut: boolean } {
  let count = 0;
  let end = 0;
  for (const ch of s) {
    if (count === max) return { text: s.slice(0, end), cut: true };
    count += 1;
    end += ch.length;
  }
  return { text: s, cut: false };
}

/**
 * Sanitize the parts of a completed task's artifacts, or of a direct
 * `Message` answer (design §6.4). `parts` arrives unvalidated.
 */
export function sanitizeRemoteParts(parts: unknown): SanitizeOutcome {
  if (!Array.isArray(parts) || parts.length === 0) return { ok: false, reason: 'no_parts' };
  if (parts.length > A2A_LIMITS.maxParts) return { ok: false, reason: 'too_many_parts' };
  let size: number;
  try {
    size = utf8Length(JSON.stringify(parts));
  } catch {
    return { ok: false, reason: 'parts_not_json' };
  }
  if (size > A2A_LIMITS.maxPayloadBytes) return { ok: false, reason: 'result_too_large' };
  const state: StripReport = { stripped: false };
  let truncated = false;
  const out: SanitizedPart[] = [];
  try {
    for (const part of parts) {
      if (!isPlainObject(part)) return { ok: false, reason: 'part_not_object' };
      const kind = partContentKind(part);
      if (kind === null) return { ok: false, reason: 'part_content_not_exactly_one' };
      if (kind === 'raw' || kind === 'url') return { ok: false, reason: `${kind}_part_refused` };
      if (kind === 'text') {
        if (typeof part.text !== 'string') return { ok: false, reason: 'part_text_not_string' };
        const { text, cut } = truncateCodePoints(
          stripInvisible(part.text, state),
          A2A_LIMITS.maxTextCodePoints,
        );
        truncated = truncated || cut;
        out.push({ text });
      } else {
        out.push({ data: sanitizeValue(part.data, DATA_DEPTH_IN_ENVELOPE, state) });
      }
    }
  } catch (err) {
    if (err instanceof SanitizeRefusal) return { ok: false, reason: err.message };
    throw err;
  }
  return {
    ok: true,
    result: { envelope: { version: 1, parts: out }, truncated, stripped: state.stripped },
  };
}

/**
 * The value a result schema validates. With the default envelope, the
 * whole envelope. With a binding's own pinned schema, the single `data`
 * part's value: a custom schema describes structured output, so a result
 * that is not exactly one data part cannot satisfy it.
 */
export function resultValueForSchema(
  result: SanitizedResult,
  mode: 'default' | 'pinned',
): { ok: true; value: JsonValue } | { ok: false; reason: string } {
  if (mode === 'default') return { ok: true, value: result.envelope as unknown as JsonValue };
  const parts = result.envelope.parts;
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only === undefined || !hasOwn(only, 'data')) {
    return { ok: false, reason: 'pinned_schema_needs_one_data_part' };
  }
  return { ok: true, value: (only as { data: JsonValue }).data };
}

/** RFC 8785 text of a released result, the bytes its digest covers. */
export function resultDigestText(value: JsonValue): string {
  return canonicalize(value);
}
