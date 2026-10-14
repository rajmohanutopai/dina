/**
 * The ONE place the term engine parses anything it stored
 * (SHELF_SPACE_NEGOTIATION §5) — the commerce boundary rule: a stored record
 * is read only by re-deriving it.
 *
 *   - Documents run straight back through their protocol validator, digest
 *     included, so a row edited after it was written reads as ABSENT, never
 *     as a document this node half-believes.
 *   - The owner's policies run back through the same validators the write
 *     path used; a row that fails reads as the policy being OFF.
 *   - Card material and card payloads are Core's own, checked field by field
 *     and read toward REFUSAL: a miss reads as no card, so nothing is
 *     approved, authorised or sent on a payload nobody checked.
 *   - A held or queued document body is parsed here and re-validated by its
 *     consumer before anything acts on it (ingest re-runs its verifier; the
 *     outbox re-runs its shape check before a resend).
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  isTermName,
  validateAgreementDecision,
  validateAgreementTermination,
  validateCanonicalInteger,
  validateSettlementAcknowledgement,
  validateSettlementNote,
  validateTermAgreementProposal,
  validateTermCounter,
  validateTermListing,
  validateTermOffer,
  validateTermRequest,
  type AgreementDecision,
  type AgreementTermination,
  type SettlementAcknowledgement,
  type SettlementNote,
  type Sha256Fn,
  type TermAgreementProposal,
  type TermCounter,
  type TermListing,
  type TermName,
  type TermOffer,
  type TermRequest,
} from '@dina/commerce-protocol';

import {
  DEFAULT_TERM_POLICY,
  validateTermBuyerPolicy,
  validateTermPolicy,
  type TermBuyerPolicy,
  type TermPolicy,
} from './term_policy';

import type { TermAgreementApprovalPayload } from '../approval_payload';
import type { TermDocumentKind, TermDocumentRow } from './term_store';

const hash: Sha256Fn = (data) => sha256(data);

function parse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function readRow<T>(
  row: TermDocumentRow | null,
  kind: TermDocumentKind,
  validate: (v: unknown) => string | null,
): T | null {
  if (row === null || row.kind !== kind) return null;
  const value = parse(row.recordJson);
  return validate(value) === null ? (value as T) : null;
}

export const readTermRequestRow = (row: TermDocumentRow | null): TermRequest | null =>
  readRow(row, 'term_request', (v) => validateTermRequest(v, hash));
export const readTermOfferRow = (row: TermDocumentRow | null): TermOffer | null =>
  readRow(row, 'term_offer', (v) => validateTermOffer(v, hash));
export const readTermCounterRow = (row: TermDocumentRow | null): TermCounter | null =>
  readRow(row, 'term_counter', (v) => validateTermCounter(v, hash));
export const readTermProposalRow = (row: TermDocumentRow | null): TermAgreementProposal | null =>
  readRow(row, 'term_agreement_proposal', (v) => validateTermAgreementProposal(v, hash));
export const readTermDecisionRow = (row: TermDocumentRow | null): AgreementDecision | null =>
  readRow(row, 'agreement_decision', (v) => validateAgreementDecision(v, hash));
export const readTermTerminationRow = (row: TermDocumentRow | null): AgreementTermination | null =>
  readRow(row, 'agreement_termination', (v) => validateAgreementTermination(v, hash));
export const readTermSettlementRow = (row: TermDocumentRow | null): SettlementNote | null =>
  readRow(row, 'settlement_note', (v) => validateSettlementNote(v, hash));
export const readTermAckRow = (row: TermDocumentRow | null): SettlementAcknowledgement | null =>
  readRow(row, 'settlement_ack', (v) => validateSettlementAcknowledgement(v, hash));

/** A stored listing (this node's own, or the one a negotiation was started on). */
export function readTermListingJson(json: string): TermListing | null {
  const value = parse(json);
  return validateTermListing(value, hash) === null ? (value as TermListing) : null;
}

/**
 * The store's policy: a row that no longer validates reads as OFF — a floor
 * read wrong is a floor broken. A policy saved before who-may-ask moved onto
 * each listing (schema v72) still carries a store-wide `access`; it is read
 * without it, and the engine's boot sweep moves it onto the listings
 * (`adoptLegacyAccess`), so an upgrade or an old archive keeps renting on.
 */
export function readTermPolicyJson(json: string | null): TermPolicy {
  if (json === null) return DEFAULT_TERM_POLICY;
  const value = withoutLegacyAccess(parse(json));
  return validateTermPolicy(value) === null ? (value as TermPolicy) : { ...DEFAULT_TERM_POLICY };
}

/** The store-wide `access` a pre-v72 policy carried, if any, and the policy without it. */
export function legacyTermAccess(json: string): 'contacts_or_card' | 'anyone' | null {
  const value = parse(json);
  if (value === null || typeof value !== 'object' || !('access' in value)) return null;
  return (value as { access?: unknown }).access === 'anyone' ? 'anyone' : 'contacts_or_card';
}

/** A stored pre-v72 policy's JSON with its store-wide `access` dropped (`adoptLegacyAccess`). */
export function termPolicyJsonWithoutAccess(json: string): string {
  return JSON.stringify(withoutLegacyAccess(parse(json)));
}

function withoutLegacyAccess(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || !('access' in value)) return value;
  const { access: _legacy, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** The brand's policy for one negotiation; unreadable reads as absent (the loop closes it). */
export function readTermBuyerPolicyJson(json: string): TermBuyerPolicy | null {
  const value = parse(json);
  return validateTermBuyerPolicy(value) === null ? (value as TermBuyerPolicy) : null;
}

/** The approval payload a card was minted with — Core's own, checked before it binds anything. */
export function readTermApprovalMaterial(json: string): TermAgreementApprovalPayload | null {
  const value = parse(json);
  if (value === null || typeof value !== 'object') return null;
  const m = value as Partial<TermAgreementApprovalPayload>;
  if (m.kind !== 'term_agreement_proposal' && m.kind !== 'term_agreement_decision') return null;
  if (typeof m.offerDigest !== 'string' || typeof m.proposalDigest !== 'string') return null;
  if (m.agreement === undefined || m.agreement === null || typeof m.agreement !== 'object')
    return null;
  if (m.principal === undefined || m.principal === null || typeof m.principal !== 'object')
    return null;
  return m as TermAgreementApprovalPayload;
}

/** The floor card's asked values: every name a table term, every value a canonical integer. */
export function readTermFloorMaterial(json: string): Partial<Record<TermName, string>> | null {
  const value = parse(json);
  if (value === null || typeof value !== 'object') return null;
  const asked = (value as { asked?: unknown }).asked;
  if (asked === null || typeof asked !== 'object') return null;
  const out: Partial<Record<TermName, string>> = {};
  for (const [name, v] of Object.entries(asked as Record<string, unknown>)) {
    if (!isTermName(name) || typeof v !== 'string' || validateCanonicalInteger(v, 15) !== null)
      return null;
    out[name] = v;
  }
  return out;
}

/** A term card's workflow payload: its type and card id, or nothing. */
export function readTermCardPayload(
  payload: string,
  types: readonly string[],
): { type: string; cardId: string } | null {
  const value = parse(payload);
  if (value === null || typeof value !== 'object') return null;
  const { type, card_id: cardId } = value as { type?: unknown; card_id?: unknown };
  return typeof type === 'string' && types.includes(type) && typeof cardId === 'string'
    ? { type, cardId }
    : null;
}

/** A card's stored inbox payload: an object, or nothing (it is Core's own, re-raised as kept). */
export function readTermCardPayloadJson(json: string): Record<string, unknown> | null {
  const value = parse(json);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A held or queued document body; its consumer re-validates before acting (module doc). */
export function readStoredTermBody(json: string): unknown {
  return parse(json);
}
