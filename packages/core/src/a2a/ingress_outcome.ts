/**
 * What an inbound caller sees for each way ingress can fail (design §7.2):
 * failures of steps 1–4 (authentication, version, size, structure and the
 * envelope) are protocol errors with no durable state; refusals of steps
 * 7–9 (skill resolution, the action registry, access, normalization) are one
 * collapsed `REJECTED` task (A2A-I4), the reason kept inside Dina.
 *
 * The table names every reason explicitly, so a reason added to any of the
 * three lists without a class here is a compile error.
 */

import {
  REFUSAL_VIEW,
  a2aError,
  type EnvelopeFailure,
  type InboundTaskView,
  type JsonRpcErrorObject,
} from '@dina/a2a';

import type { InboundClassificationFailure } from './action_registry';
import type { InboundCardFailure } from './inbound_card';
import type { InboundAccessFailure } from './inbound_resolve';
import type { NormalizationFailure } from './normalize';

export type IngressFailure =
  | EnvelopeFailure
  | InboundClassificationFailure
  | InboundAccessFailure
  | NormalizationFailure
  | InboundCardFailure;
export type IngressOutcomeClass = 'protocol_error' | 'rejected';

export const INGRESS_OUTCOME_CLASS: Readonly<Record<IngressFailure, IngressOutcomeClass>> =
  Object.freeze({
    // Step 4: the envelope (design §7.2a).
    no_parts: 'protocol_error',
    part_not_object: 'protocol_error',
    part_content_not_exactly_one: 'protocol_error',
    raw_part_refused: 'protocol_error',
    url_part_refused: 'protocol_error',
    no_data_part: 'protocol_error',
    several_data_parts: 'protocol_error',
    data_not_object: 'protocol_error',
    unknown_envelope_member: 'protocol_error',
    skill_required: 'protocol_error',
    skill_malformed: 'protocol_error',
    params_not_object: 'protocol_error',
    params_forbidden_member: 'protocol_error',
    params_too_deep: 'protocol_error',
    grant_id_malformed: 'protocol_error',
    schema_hash_malformed: 'protocol_error',
    // Step 7: the action registry.
    custom_capability: 'rejected',
    commerce_capability: 'rejected',
    unknown_capability: 'rejected',
    payment_denied: 'rejected',
    // Steps 7–8: resolution, access mode and executor (M2).
    skill_unknown: 'rejected',
    skill_ambiguous: 'rejected',
    not_public_exposable: 'rejected',
    not_in_scope: 'rejected',
    grant_not_authorized: 'rejected',
    no_executor: 'rejected',
    // Step 9: normalization.
    schema_unenforceable: 'rejected',
    schema_version_mismatch: 'rejected',
    params_invalid: 'rejected',
    // The card's own bounds: what no card shows, no call reaches.
    skill_id_too_long: 'rejected',
    skill_too_large: 'rejected',
  });

export type IngressFailureResponse =
  | { kind: 'protocol_error'; error: JsonRpcErrorObject }
  | { kind: 'rejected'; view: InboundTaskView; reason: IngressFailure };

/**
 * Protocol errors about the kind of content sent, not its shape: a message
 * with no part in a media type Dina reads. The card's `defaultInputModes` is
 * `application/json` and the invocation is its data part, so text, raw bytes
 * and URLs are media types Dina does not support (spec §3.1.1: that MUST be
 * `ContentTypeNotSupportedError`).
 */
const CONTENT_TYPE_FAILURES: ReadonlySet<IngressFailure> = new Set<IngressFailure>(['no_data_part', 'raw_part_refused', 'url_part_refused']);

/**
 * The caller-facing answer. A protocol error names its reason (it is about
 * the caller's own bytes); a refusal returns the one collapsed view and keeps
 * the reason for the receipt and the audit log only.
 */
export function ingressFailureResponse(reason: IngressFailure): IngressFailureResponse {
  if (INGRESS_OUTCOME_CLASS[reason] !== 'protocol_error') return { kind: 'rejected', view: REFUSAL_VIEW, reason };
  return { kind: 'protocol_error', error: a2aError(CONTENT_TYPE_FAILURES.has(reason) ? 'contentTypeNotSupported' : 'invalidParams', reason) };
}
