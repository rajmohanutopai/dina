/**
 * The deterministic front of the outbound result pipeline (design §6.5):
 * size caps → sanitation → schema validation of the FINAL transformed value
 * → digest. Quarantine, the guard job and release wrap this in M1a; this
 * part is pure, so the ordering rule it encodes is tested on its own.
 *
 * The schema is the binding's pinned result schema, or the default envelope.
 * A pinned schema is re-audited here as well as at binding time: a schema
 * that reached this point by any other path must not be trusted to have been
 * audited. A pinned schema identical to the default envelope is the default.
 */

import {
  DEFAULT_RESULT_SCHEMA,
  DEFAULT_RESULT_SCHEMA_HASH,
  JcsError,
  resultValueForSchema,
  sanitizeRemoteParts,
  type JsonValue,
} from '@dina/a2a';
import { pinnedSchemaProblems } from '@dina/protocol';

import { validateAgainstSchema } from '../plugins/schema_validate';

import { canonicalDigest } from './digest';

export interface IngestedResult {
  /** The value that will be released once a guard receipt clears it. */
  value: JsonValue;
  /** Lowercase sha256 hex over RFC 8785 of `value` — what the guard verdict binds to. */
  digest: string;
  mode: 'default' | 'pinned';
  truncated: boolean;
  stripped: boolean;
}

export type IngestOutcome = { ok: true; result: IngestedResult } | { ok: false; reason: string };

export function ingestRemoteResult(
  parts: unknown,
  pinnedSchema?: Record<string, unknown>,
): IngestOutcome {
  const sanitized = sanitizeRemoteParts(parts);
  if (!sanitized.ok) return { ok: false, reason: sanitized.reason };
  const mode = pinnedSchema === undefined || isDefaultSchema(pinnedSchema) ? 'default' : 'pinned';
  const schema =
    mode === 'pinned' && pinnedSchema !== undefined ? pinnedSchema : DEFAULT_RESULT_SCHEMA;
  if (mode === 'pinned' && pinnedSchemaProblems(schema, 'pinned_runtime').length > 0) {
    return { ok: false, reason: 'result_schema_unenforceable' };
  }
  const selected = resultValueForSchema(sanitized.result, mode);
  if (!selected.ok) return { ok: false, reason: selected.reason };
  const check = validateAgainstSchema(selected.value, schema);
  if (!check.ok) return { ok: false, reason: 'result_schema_mismatch' };
  let digest: string;
  try {
    digest = canonicalDigest(selected.value);
  } catch (err) {
    // Sanitation leaves only canonicalizable values; this is the backstop.
    if (err instanceof JcsError) return { ok: false, reason: 'result_not_canonical' };
    throw err;
  }
  return {
    ok: true,
    result: {
      value: selected.value,
      digest,
      mode,
      truncated: sanitized.result.truncated,
      stripped: sanitized.result.stripped,
    },
  };
}

function isDefaultSchema(schema: Record<string, unknown>): boolean {
  try {
    return canonicalDigest(schema) === DEFAULT_RESULT_SCHEMA_HASH;
  } catch {
    return false;
  }
}
