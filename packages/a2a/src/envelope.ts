/**
 * Skill names and the Dina invocation envelope (design §7.2a).
 *
 * A2A messages have no skill field, so Dina defines one: an inbound message
 * carries exactly one `data` part `{skill, params, grant_id?, schema_hash?}`.
 * `text` parts are ignored for dispatch (a caller may describe the call in
 * prose; prose never selects what runs); `raw` and `url` parts are refused;
 * zero or several `data` parts make the message malformed. Unknown members
 * in the data part are refused: a field Dina ignores today could be read by
 * code tomorrow, and the caller would never learn it was dropped.
 *
 * The envelope's own members are snake_case, as all Dina wire JSON is; only
 * A2A protocol fields are camelCase (spec §5.5).
 */

import { A2A_LIMITS } from './constants';
import { LOWER_HEX_64, hasOwn, isPlainObject, type JsonObject } from './json';
import { untrustedJsonProblem } from './strict_json';
import { partContentKind } from './validate';

/** Official capabilities are flat; namespaced custom ones are dotted (protocol capability-registry). */
const CAPABILITY_RE = /^(?:[a-z0-9_]{1,128}|[a-z0-9]{1,64}(?:\.[a-z0-9_]{1,64}){1,8})$/;
/** Same charset and bounds as `isValidServiceListingRkey` in @dina/protocol. */
const RKEY_RE = /^[A-Za-z0-9._~-]{1,512}$/;

export interface QualifiedSkill {
  capability: string;
  /** Present when the caller named one listing (`capability@rkey`). */
  rkey?: string;
}

export function isValidListingRkey(rkey: string): boolean {
  return rkey !== '.' && rkey !== '..' && RKEY_RE.test(rkey);
}

export function isValidCapabilityName(name: string): boolean {
  return CAPABILITY_RE.test(name);
}

/** Parse `capability` or `capability@rkey`; `null` when malformed. Never normalizes. */
export function parseQualifiedSkill(raw: string): QualifiedSkill | null {
  const at = raw.indexOf('@');
  if (at === -1) return isValidCapabilityName(raw) ? { capability: raw } : null;
  if (raw.indexOf('@', at + 1) !== -1) return null;
  const capability = raw.slice(0, at);
  const rkey = raw.slice(at + 1);
  if (!isValidCapabilityName(capability) || !isValidListingRkey(rkey)) return null;
  return { capability, rkey };
}

export function qualifySkill(capability: string, rkey: string): string {
  return `${capability}@${rkey}`;
}

export interface InvocationEnvelope {
  skill: QualifiedSkill;
  /** The skill string exactly as sent, for receipts and hashing. */
  skillText: string;
  params: JsonObject;
  grantId?: string;
  schemaHash?: string;
}

/**
 * Every way an envelope can fail to parse. All of them are design §7.2 step 4
 * failures: a protocol error to the caller, with no durable state.
 */
export const ENVELOPE_FAILURES = [
  'no_parts',
  'part_not_object',
  'part_content_not_exactly_one',
  'raw_part_refused',
  'url_part_refused',
  'no_data_part',
  'several_data_parts',
  'data_not_object',
  'unknown_envelope_member',
  'skill_required',
  'skill_malformed',
  'params_not_object',
  'params_forbidden_member',
  'params_too_deep',
  'grant_id_malformed',
  'schema_hash_malformed',
] as const;
export type EnvelopeFailure = (typeof ENVELOPE_FAILURES)[number];

export type ParsedEnvelope =
  | { ok: true; envelope: InvocationEnvelope }
  | { ok: false; reason: EnvelopeFailure };

/**
 * Params sit one level inside the hashed envelope `{skill, params, …}`, so
 * they may nest one level less than the canonicalizer's cap.
 */
const PARAMS_MAX_DEPTH = A2A_LIMITS.maxJsonDepth - 1;

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['skill', 'params', 'grant_id', 'schema_hash']);
const GRANT_ID_RE = /^[A-Za-z0-9._:~-]{1,256}$/;

/** Parse the envelope out of an inbound message's `parts`. */
export function parseInvocationEnvelope(parts: unknown): ParsedEnvelope {
  if (!Array.isArray(parts) || parts.length === 0) return { ok: false, reason: 'no_parts' };
  let data: unknown;
  let dataCount = 0;
  for (const part of parts) {
    if (!isPlainObject(part)) return { ok: false, reason: 'part_not_object' };
    const kind = partContentKind(part);
    if (kind === null) return { ok: false, reason: 'part_content_not_exactly_one' };
    if (kind === 'raw') return { ok: false, reason: 'raw_part_refused' };
    if (kind === 'url') return { ok: false, reason: 'url_part_refused' };
    if (kind === 'data') {
      dataCount += 1;
      data = part.data;
    }
  }
  if (dataCount !== 1)
    return { ok: false, reason: dataCount === 0 ? 'no_data_part' : 'several_data_parts' };
  return parseEnvelopeData(data);
}

export function parseEnvelopeData(data: unknown): ParsedEnvelope {
  if (!isPlainObject(data)) return { ok: false, reason: 'data_not_object' };
  for (const key of Object.keys(data)) {
    if (!ENVELOPE_KEYS.has(key)) return { ok: false, reason: 'unknown_envelope_member' };
  }
  if (typeof data.skill !== 'string') return { ok: false, reason: 'skill_required' };
  const skill = parseQualifiedSkill(data.skill);
  if (skill === null) return { ok: false, reason: 'skill_malformed' };
  if (!isPlainObject(data.params)) return { ok: false, reason: 'params_not_object' };
  const paramsProblem = untrustedJsonProblem(data.params, PARAMS_MAX_DEPTH);
  if (paramsProblem === 'forbidden_member') return { ok: false, reason: 'params_forbidden_member' };
  if (paramsProblem === 'too_deep') return { ok: false, reason: 'params_too_deep' };
  const envelope: InvocationEnvelope = {
    skill,
    skillText: data.skill,
    params: data.params as JsonObject,
  };
  if (hasOwn(data, 'grant_id')) {
    if (typeof data.grant_id !== 'string' || !GRANT_ID_RE.test(data.grant_id)) {
      return { ok: false, reason: 'grant_id_malformed' };
    }
    envelope.grantId = data.grant_id;
  }
  if (hasOwn(data, 'schema_hash')) {
    if (typeof data.schema_hash !== 'string' || !LOWER_HEX_64.test(data.schema_hash)) {
      return { ok: false, reason: 'schema_hash_malformed' };
    }
    envelope.schemaHash = data.schema_hash;
  }
  return { ok: true, envelope };
}

/** The envelope as Dina hashes and stores it (pre-normalization). */
export function envelopeObject(envelope: InvocationEnvelope): JsonObject {
  const out: JsonObject = { skill: envelope.skillText, params: envelope.params };
  if (envelope.grantId !== undefined) out.grant_id = envelope.grantId;
  if (envelope.schemaHash !== undefined) out.schema_hash = envelope.schemaHash;
  return out;
}
