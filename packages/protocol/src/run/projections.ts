/**
 * Interactive-run signed projections (INTERACTIVE_SERVICES_ARCHITECTURE.md
 * §6.2). All provider outputs are runtime-issuer-signed over DISTINCT,
 * domain-separated, snake_case projections. These builders produce the exact
 * byte string that gets signed/verified — the compatibility law any language
 * port targets. Zero-dep (digests are precomputed SHA-256 hex passed in by the
 * caller; crypto stays out of `@dina/protocol`).
 *
 * The domain-separation prefix guarantees a message signature can never be
 * replayed as an exhausted/result signature and vice-versa.
 */

export const RUN_MESSAGE_DOMAIN = 'dina:run:message:v1';
export const RUN_EXHAUSTED_DOMAIN = 'dina:run:exhausted:v1';
export const RUN_RESULT_DOMAIN = 'dina:run:result:v1';

/** Fields bound by the message/proposal projection (§6.2). */
export interface RunMessageProjectionInput {
  provider_did: string;
  service_uri: string;
  run_id: string;
  message_id: string;
  sequence: number;
  dedup_key: string;
  kind: 'informational' | 'action';
  /** empty string for an informational message. */
  action_type: string;
  /** SHA-256 hex of the bounded `params`. */
  params_digest: string;
  /** SHA-256 hex of the validated `card`. */
  card_digest: string;
  issued_at: number;
  expires_at: number;
  schema_version: string;
  runtime_issuer_did: string;
  runtime_key_id: string;
}

/** Fields bound by the exhausted-marker projection (PULL only, §6.2/§7.1). */
export interface RunExhaustedProjectionInput {
  provider_did: string;
  service_uri: string;
  run_id: string;
  /** the exhausting pull cursor. */
  cursor: number;
  issued_at: number;
  schema_version: string;
  runtime_issuer_did: string;
  runtime_key_id: string;
}

/** Fields bound by the action-result completion projection (§6.2). */
export interface RunResultProjectionInput {
  provider_did: string;
  service_uri: string;
  run_id: string;
  message_id: string;
  delegation_id: string;
  decision_revision: number;
  status: 'completed' | 'failed';
  /** SHA-256 hex of the result card. */
  result_card_digest: string;
  issued_at: number;
  schema_version: string;
  runtime_issuer_did: string;
  runtime_key_id: string;
}

/** Build the canonical signed string for a run message/proposal (§6.2). */
export function buildRunMessageProjection(i: RunMessageProjectionInput): string {
  return [
    RUN_MESSAGE_DOMAIN,
    i.provider_did,
    i.service_uri,
    i.run_id,
    i.message_id,
    String(i.sequence),
    i.dedup_key,
    i.kind,
    i.action_type,
    i.params_digest,
    i.card_digest,
    String(i.issued_at),
    String(i.expires_at),
    i.schema_version,
    i.runtime_issuer_did,
    i.runtime_key_id,
  ].join('\n');
}

/** Build the canonical signed string for an exhausted marker (§6.2). */
export function buildRunExhaustedProjection(i: RunExhaustedProjectionInput): string {
  return [
    RUN_EXHAUSTED_DOMAIN,
    i.provider_did,
    i.service_uri,
    i.run_id,
    String(i.cursor),
    String(i.issued_at),
    i.schema_version,
    i.runtime_issuer_did,
    i.runtime_key_id,
  ].join('\n');
}

/** Build the canonical signed string for an action-result completion (§6.2). */
export function buildRunResultProjection(i: RunResultProjectionInput): string {
  return [
    RUN_RESULT_DOMAIN,
    i.provider_did,
    i.service_uri,
    i.run_id,
    i.message_id,
    i.delegation_id,
    String(i.decision_revision),
    i.status,
    i.result_card_digest,
    String(i.issued_at),
    i.schema_version,
    i.runtime_issuer_did,
    i.runtime_key_id,
  ].join('\n');
}

/**
 * The bounded classification view Core hands Brain (§6.2/§12.6). NOT signed —
 * it is a size-limited, snake_case object with the card's permitted display text
 * and the content digest. NO vault context, NO `params`. Defined here so the
 * shape is a frozen part of the wire contract.
 */
export interface RunClassificationView {
  message_id: string;
  message_revision: number;
  kind: 'informational';
  title: string;
  body: string;
  content_digest: string;
}

// Additive public NSIDs (declaration / outcome), §12.4. Reserved for ATProto
// records; NOT the flat service-capability id.
export const RUN_DECLARATION_NSID = 'com.dinakernel.run.declaration';
export const RUN_OUTCOME_NSID = 'com.dinakernel.run.outcome';

/** The flat, snake_case service-capability id for an interactive run (§12.1). */
export const INTERACTIVE_RUN_CAPABILITY = 'interactive_run';
