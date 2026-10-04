/**
 * Deterministic ingress normalization of one inbound A2A invocation
 * (design §7.2 step 9), after the skill has resolved to a live listing
 * capability with a pinned schema pair.
 *
 * Steps, each the same rule D2D ingress applies in Core's
 * `service/query_ingress.ts` (checkQuerySchemaHash / validateQueryParams /
 * param stripping), except where noted:
 *  - `schema_hash` is OPTIONAL for A2A. A D2D requester must echo a
 *    published hash; an A2A caller that ignores the optional Dina extension
 *    never saw one (control plane §18.4). A hash that IS sent must match.
 *    Params are validated against the pinned schema either way.
 *  - a schema pair with a keyword Core's validator would skip, in the params
 *    schema or the result schema, is refused outright
 *    (`schema_unenforceable`): the D2D validator
 *    (`service/capabilities/schema.ts`) and the plugin validator differ,
 *    and a constraint one side skips must not be the one standing between
 *    a remote caller and an executor, or between a result and the caller;
 *  - params validate against the pinned params schema;
 *  - params the schema does not declare are dropped (an empty `properties`
 *    map declares nothing, so nothing is dropped), and what is left must
 *    still validate: the payload that executes satisfies its schema (a
 *    `required` member the schema never declares would otherwise be dropped
 *    after the check passed).
 *
 * Params carrying a `__proto__` member, or too deep to hash, are refused as
 * invalid. The function never throws on caller input.
 *
 * The pre-hash covers the envelope exactly as sent; the post-hash covers
 * what will execute. Every failure here is a refusal (the caller sees the
 * one collapsed REJECTED), never a protocol error (design §7.2 step 8).
 */

import {
  JcsError,
  canonicalize,
  envelopeObject,
  qualifySkill,
  untrustedJsonProblem,
  type InvocationEnvelope,
  type JsonObject,
} from '@dina/a2a';
import { pinnedSchemaProblems } from '@dina/protocol';

import { validateAgainstSchema } from '../plugins/schema_validate';
import { capabilitySchemaHash } from '../service/capability_schema_hash';

import { sha256HexOfText } from './digest';

export interface PinnedSchemaPair {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  description?: string;
  /** The hash stored with the listing; accepted as well as the recomputed one. */
  storedHash?: string;
}

export interface NormalizedInvocation {
  canonicalCapability: string;
  rkey: string;
  /** The qualified skill id that will execute (`capability@rkey`). */
  skill: string;
  params: JsonObject;
  strippedParams: string[];
  /** The schema hash the execution snapshot pins. */
  schemaHash: string;
  preHash: string;
  postHash: string;
}

/** Whether Core's validator enforces every keyword of both schemas of a pair (`pinnedSchemaProblems`, `pinned_runtime`). */
export function schemaPairEnforceable(schemas: Pick<PinnedSchemaPair, 'params' | 'result'>): boolean {
  return (
    pinnedSchemaProblems(schemas.params, 'pinned_runtime').length === 0 &&
    pinnedSchemaProblems(schemas.result, 'pinned_runtime').length === 0
  );
}

export const NORMALIZATION_FAILURES = [
  'schema_unenforceable',
  'schema_version_mismatch',
  'params_invalid',
] as const;
export type NormalizationFailure = (typeof NORMALIZATION_FAILURES)[number];

export type NormalizeOutcome =
  | { ok: true; normalized: NormalizedInvocation }
  | { ok: false; reason: NormalizationFailure };

export function normalizeInvocation(args: {
  envelope: InvocationEnvelope;
  canonicalCapability: string;
  rkey: string;
  schemas: PinnedSchemaPair;
}): NormalizeOutcome {
  const { envelope, canonicalCapability, rkey, schemas } = args;
  if (!schemaPairEnforceable(schemas)) return { ok: false, reason: 'schema_unenforceable' };
  let recomputed: string;
  try {
    recomputed = capabilitySchemaHash(schemas);
  } catch (err) {
    if (err instanceof JcsError) return { ok: false, reason: 'schema_unenforceable' };
    throw err;
  }
  if (
    envelope.schemaHash !== undefined &&
    envelope.schemaHash !== recomputed &&
    envelope.schemaHash !== schemas.storedHash
  ) {
    return { ok: false, reason: 'schema_version_mismatch' };
  }
  if (untrustedJsonProblem(envelope.params) !== null)
    return { ok: false, reason: 'params_invalid' };
  if (!validateAgainstSchema(envelope.params, schemas.params).ok) {
    return { ok: false, reason: 'params_invalid' };
  }
  const declared = schemas.params.properties;
  const allowed =
    declared !== null && typeof declared === 'object' && !Array.isArray(declared)
      ? Object.keys(declared)
      : [];
  const params: JsonObject = {};
  const strippedParams: string[] = [];
  for (const [key, value] of Object.entries(envelope.params)) {
    if (allowed.length === 0 || allowed.includes(key)) params[key] = value;
    else strippedParams.push(key);
  }
  if (strippedParams.length > 0 && !validateAgainstSchema(params, schemas.params).ok) {
    return { ok: false, reason: 'params_invalid' };
  }
  const skill = qualifySkill(canonicalCapability, rkey);
  const post: JsonObject = { skill, params };
  if (envelope.grantId !== undefined) post.grant_id = envelope.grantId;
  let preHash: string;
  let postHash: string;
  try {
    preHash = sha256HexOfText(canonicalize(envelopeObject(envelope)));
    postHash = sha256HexOfText(canonicalize(post));
  } catch (err) {
    if (err instanceof JcsError) return { ok: false, reason: 'params_invalid' };
    throw err;
  }
  return {
    ok: true,
    normalized: {
      canonicalCapability,
      rkey,
      skill,
      params,
      strippedParams,
      schemaHash: recomputed,
      preHash,
      postHash,
    },
  };
}
