/**
 * The MONEY rehydrators (RESEARCHER_KERNEL §5.B1) — reading the khata and
 * revenue-share documents back from their ledgers, each through its ingress
 * validator (the same verified-on-read discipline as `rehydrate.ts`). Carved
 * out of the shared module so the money-free path (`rehydrate.ts`: orders,
 * quotes, statuses, invites, catalog pointers) reaches no money wire at all
 * (§5.B2), and so this file moves with the Commerce Pack.
 */

import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

import {
  readDeliveryNote,
  readDeliveryReceipt,
  readPaymentAcknowledgement,
  readPaymentNote,
  validateAgreementDecision,
  validateAgreementProposal,
  validateAgreementTermination,
  validateSettlementAcknowledgement,
  validateSettlementNote,
  type AgreementDecision,
  type AgreementProposal,
  type AgreementTermination,
  type DeliveryNote,
  type DeliveryReceipt,
  type PaymentAcknowledgement,
  type PaymentNote,
  type SettlementAcknowledgement,
  type SettlementNote,
} from '@dina/commerce-protocol';

import type { Rehydrated, Sha256Fn } from './rehydrate';

const defaultHash: Sha256Fn = (data) => nobleSha256(data);

function parse(json: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch (error) {
    return {
      ok: false,
      error: `stored record is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Read the five trade documents (TRADE_FIRST_STRATEGY §4.2/§3.4) back
 * from the ledger, each through its ingress validator — which re-derives
 * the record's own digest, the same corruption net as every rehydrator
 * here.
 */
export function rehydrateDeliveryNote(json: string, sha256: Sha256Fn): Rehydrated<DeliveryNote> {
  const parsed = parse(json);
  if (!parsed.ok) return parsed;
  const read = readDeliveryNote(parsed.value, sha256);
  return read.ok
    ? { ok: true, value: read.note }
    : { ok: false, error: `stored delivery note failed validation: ${read.error}` };
}

export function rehydrateDeliveryReceipt(
  json: string,
  sha256: Sha256Fn,
): Rehydrated<DeliveryReceipt> {
  const parsed = parse(json);
  if (!parsed.ok) return parsed;
  const read = readDeliveryReceipt(parsed.value, sha256);
  return read.ok
    ? { ok: true, value: read.receipt }
    : { ok: false, error: `stored delivery receipt failed validation: ${read.error}` };
}

export function rehydratePaymentNote(json: string, sha256: Sha256Fn): Rehydrated<PaymentNote> {
  const parsed = parse(json);
  if (!parsed.ok) return parsed;
  const read = readPaymentNote(parsed.value, sha256);
  return read.ok
    ? { ok: true, value: read.note }
    : { ok: false, error: `stored payment note failed validation: ${read.error}` };
}

export function rehydratePaymentAck(
  json: string,
  sha256: Sha256Fn,
): Rehydrated<PaymentAcknowledgement> {
  const parsed = parse(json);
  if (!parsed.ok) return parsed;
  const read = readPaymentAcknowledgement(parsed.value, sha256);
  return read.ok
    ? { ok: true, value: read.ack }
    : { ok: false, error: `stored payment ack failed validation: ${read.error}` };
}

// ---------------------------------------------------------------------------
// §5 revenue-share rows — the same verified-on-read discipline
// ---------------------------------------------------------------------------

export type RehydratedRevshare =
  | { kind: 'agreement_proposal'; document: AgreementProposal }
  | { kind: 'agreement_decision'; document: AgreementDecision }
  | { kind: 'agreement_termination'; document: AgreementTermination }
  | { kind: 'settlement_note'; document: SettlementNote }
  | { kind: 'settlement_ack'; document: SettlementAcknowledgement };

/** A stored revshare row this build cannot re-verify. */
export class RevshareIntegrityError extends Error {}

const REVSHARE_VALIDATORS = {
  agreement_proposal: validateAgreementProposal,
  agreement_decision: validateAgreementDecision,
  agreement_termination: validateAgreementTermination,
  settlement_note: validateSettlementNote,
  settlement_ack: validateSettlementAcknowledgement,
} as const;

const REVSHARE_DIGEST_FIELDS = {
  agreement_proposal: 'proposal_digest',
  agreement_decision: 'decision_digest',
  agreement_termination: 'termination_digest',
  settlement_note: 'settlement_digest',
  settlement_ack: 'settlement_ack_digest',
} as const;

export function rehydrateRevshareDocument(row: {
  kind: keyof typeof REVSHARE_VALIDATORS;
  recordJson: string;
  recordDigest: string;
}): RehydratedRevshare {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.recordJson);
  } catch {
    throw new RevshareIntegrityError(`stored ${row.kind} is not JSON`);
  }
  const bad = REVSHARE_VALIDATORS[row.kind](parsed, defaultHash);
  if (bad !== null) throw new RevshareIntegrityError(`stored ${row.kind}: ${bad}`);
  // The validator re-derived the record digest; the ROW key must agree,
  // or the row indexes a record it does not hold.
  if ((parsed as Record<string, unknown>)[REVSHARE_DIGEST_FIELDS[row.kind]] !== row.recordDigest) {
    throw new RevshareIntegrityError(`stored ${row.kind}: row key does not match the record digest`);
  }
  return { kind: row.kind, document: parsed as never };
}

/**
 * A spooled `commerce.trade` body (RESEARCHER_KERNEL §5.B1 Cut 3), read back
 * for replay. Nothing is believed here: the value goes straight into
 * `readTradePushBody` and the verifiers, exactly as a fresh arrival would. An
 * unparseable row reads as `null`, which those refuse as unreadable.
 */
export function rehydrateSpooledTradeBody(json: string): unknown {
  const parsed = parse(json);
  return parsed.ok ? parsed.value : null;
}

/** The four answers the country packs' status rails may give (`PAYMENT_STATUS_RESULT.status`, §5.D). */
export type PaymentRailAnswer = 'settled' | 'pending' | 'failed' | 'unknown';
const PAYMENT_RAIL_ANSWERS: ReadonlySet<string> = new Set(['settled', 'pending', 'failed', 'unknown']);

/**
 * The rail's answer, read back off a completed invocation task's stored
 * `result`. Core's `/complete` already refused a result outside the pinned
 * schema; whatever still is not one of the four values — an unreadable body,
 * an unexpected shape — reads as `unknown`, never as text.
 */
export function rehydratePaymentRailAnswer(resultJson: string | undefined): PaymentRailAnswer {
  let status: unknown;
  try {
    status = (JSON.parse(resultJson ?? '') as { status?: unknown } | null)?.status;
  } catch {
    status = undefined;
  }
  return typeof status === 'string' && PAYMENT_RAIL_ANSWERS.has(status) ? (status as PaymentRailAnswer) : 'unknown';
}

/** The pinned capability id off a stored plugin-invocation payload, or null when unreadable. */
export function rehydrateInvocationCapabilityId(payload: string): string | null {
  try {
    const id = (JSON.parse(payload) as { capability_id?: unknown } | null)?.capability_id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}
