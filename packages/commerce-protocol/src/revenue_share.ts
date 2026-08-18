/**
 * The revenue-share chain (TRADE_FIRST_STRATEGY §5) — the floor-space
 * model: a host allocates space, takes no inventory risk, and charges a
 * share of whatever the vendor sells. The percentage is the price,
 * guarded the §3 way; settlement is a second document chain on the §4
 * discipline.
 *
 * AUTHENTICITY FOLLOWS THE SHIPPED SEAM: records carry content digests
 * and NO signature fields — each document's authenticity is the
 * retained signed D2D envelope it arrived in (`reconcile.ts` states the
 * rule). "Countersigned" therefore means TWO documents, each with its
 * own envelope evidence, never two signatures in one record.
 *
 * Domains live under their own `dina:commerce:revshare:v1:` family —
 * the trade/catalog/invite precedent — and the §9.13 pairwise version
 * rule binds decision→proposal, termination→proposal, note→proposal and
 * ack→note.
 */

import { roundRationalHalfEven } from './arithmetic';
import { bytesToHex, canonicalJson, utf8Bytes } from './canonical';
import {
  validateDid,
  validateHex64,
  validateId,
  validateIsoUtc,
  validateProtocolVersionShape,
} from './common';
import { minorUnitsToString, moneyMinorUnits, validateMoney, type Money } from './money';

import type { Sha256Fn } from './digests';

export const REVSHARE_DIGEST_PREFIX = 'dina:commerce:revshare:v1:';

export const REVSHARE_DIGEST_DOMAINS = [
  'agreement_proposal',
  'agreement_decision',
  'agreement_termination',
  'settlement_note',
  'settlement_ack',
] as const;
export type RevshareDigestDomain = (typeof REVSHARE_DIGEST_DOMAINS)[number];

export function revshareRecordDigest(
  domain: RevshareDigestDomain,
  draft: unknown,
  sha256: Sha256Fn,
): string {
  return bytesToHex(
    sha256(utf8Bytes(`${REVSHARE_DIGEST_PREFIX}${domain}\n${canonicalJson(draft)}`)),
  );
}

export const REVSHARE_PERIODS = ['daily', 'weekly', 'monthly'] as const;
export type RevsharePeriod = (typeof REVSHARE_PERIODS)[number];

export const CASH_HANDLERS = ['host', 'vendor'] as const;
export type CashHandler = (typeof CASH_HANDLERS)[number];

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/consistent-type-definitions --
 * Type aliases, not interfaces — these feed `revshareRecordDigest`
 * (typed `unknown` → canonical JSON), and interfaces force double-casts
 * at every digest call, the cast family a prior wire bug shipped
 * through. */

export type AgreementProposal = {
  protocol_version: string;
  proposal_id: string;
  host_did: string;
  vendor_did: string;
  /** Basis points of gross sales — the percentage IS the price here. */
  share_bps: number;
  period: RevsharePeriod;
  /** Who holds the money between settlements. */
  cash_handler: CashHandler;
  currency: string;
  effective_from: string;
  /** Supersession lineage. Changes NOTHING until its own acceptance. */
  replaces_proposal_digest?: string;
  proposed_at: string;
  proposal_digest: string;
};

export type AgreementDecision = {
  protocol_version: string;
  decision_id: string;
  proposal_digest: string;
  kind: 'accepted' | 'rejected';
  decided_at: string;
  decision_digest: string;
};

export type AgreementTermination = {
  protocol_version: string;
  termination_id: string;
  proposal_digest: string;
  /** May postdate issuance; never precedes it. */
  effective_at: string;
  terminated_at: string;
  termination_digest: string;
};

export type SettlementNote = {
  protocol_version: string;
  settlement_id: string;
  proposal_digest: string;
  period_start: string;
  period_end: string;
  gross_sales: Money;
  /** Validated: gross × share_bps / 10000, ONE half-even rounding (§9.1). */
  computed_share: Money;
  /** A correction SUPERSEDES by revision — never a second live note. */
  replaces_settlement_digest?: string;
  issued_at: string;
  settlement_digest: string;
};

export type SettlementAcknowledgement = {
  protocol_version: string;
  settlement_ack_id: string;
  settlement_digest: string;
  kind: 'accepted' | 'disputed';
  acknowledged_at: string;
  settlement_ack_digest: string;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

// ---------------------------------------------------------------------------
// Validators — shape, then digest recomputation
// ---------------------------------------------------------------------------

function digestMismatch(
  domain: RevshareDigestDomain,
  record: Record<string, unknown>,
  digestField: string,
  sha256: Sha256Fn,
): string | null {
  const draft: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === digestField) continue;
    draft[key] = value;
  }
  if (revshareRecordDigest(domain, draft, sha256) !== record[digestField]) {
    return `${digestField}: does not match the record it sits on`;
  }
  return null;
}

export function validateAgreementProposal(value: unknown, sha256: Sha256Fn): string | null {
  if (value === null || typeof value !== 'object') return 'proposal: must be an object';
  const p = value as Partial<AgreementProposal> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(p.protocol_version, 'proposal.protocol_version') ??
    validateId(p.proposal_id, 'proposal.proposal_id') ??
    validateDid(p.host_did, 'proposal.host_did') ??
    validateDid(p.vendor_did, 'proposal.vendor_did') ??
    (p.host_did !== p.vendor_did ? null : 'proposal: host and vendor must differ') ??
    (typeof p.share_bps === 'number' &&
    Number.isInteger(p.share_bps) &&
    p.share_bps >= 1 &&
    p.share_bps <= 9999
      ? null
      : 'proposal.share_bps: must be an integer in [1, 9999]') ??
    ((REVSHARE_PERIODS as readonly string[]).includes(p.period as string)
      ? null
      : 'proposal.period: unknown period') ??
    ((CASH_HANDLERS as readonly string[]).includes(p.cash_handler as string)
      ? null
      : 'proposal.cash_handler: unknown handler') ??
    (typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency)
      ? null
      : 'proposal.currency: must be a three-letter uppercase code') ??
    validateIsoUtc(p.effective_from, 'proposal.effective_from') ??
    (p.replaces_proposal_digest === undefined
      ? null
      : validateHex64(p.replaces_proposal_digest, 'proposal.replaces_proposal_digest')) ??
    validateIsoUtc(p.proposed_at, 'proposal.proposed_at') ??
    validateHex64(p.proposal_digest, 'proposal.proposal_digest') ??
    digestMismatch('agreement_proposal', p, 'proposal_digest', sha256)
  );
}

export function validateAgreementDecision(value: unknown, sha256: Sha256Fn): string | null {
  if (value === null || typeof value !== 'object') return 'decision: must be an object';
  const d = value as Partial<AgreementDecision> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(d.protocol_version, 'decision.protocol_version') ??
    validateId(d.decision_id, 'decision.decision_id') ??
    validateHex64(d.proposal_digest, 'decision.proposal_digest') ??
    (d.kind === 'accepted' || d.kind === 'rejected' ? null : 'decision.kind: unknown kind') ??
    validateIsoUtc(d.decided_at, 'decision.decided_at') ??
    validateHex64(d.decision_digest, 'decision.decision_digest') ??
    digestMismatch('agreement_decision', d, 'decision_digest', sha256)
  );
}

export function validateAgreementTermination(value: unknown, sha256: Sha256Fn): string | null {
  if (value === null || typeof value !== 'object') return 'termination: must be an object';
  const t = value as Partial<AgreementTermination> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(t.protocol_version, 'termination.protocol_version') ??
    validateId(t.termination_id, 'termination.termination_id') ??
    validateHex64(t.proposal_digest, 'termination.proposal_digest') ??
    validateIsoUtc(t.effective_at, 'termination.effective_at') ??
    validateIsoUtc(t.terminated_at, 'termination.terminated_at') ??
    (Date.parse(t.effective_at as string) >= Date.parse(t.terminated_at as string)
      ? null
      : 'termination.effective_at: never precedes issuance') ??
    validateHex64(t.termination_digest, 'termination.termination_digest') ??
    digestMismatch('agreement_termination', t, 'termination_digest', sha256)
  );
}

/**
 * The §9.1 arithmetic seam: what the share MUST be for a gross under an
 * agreement — one half-even rounding, no second discipline.
 */
export function computedShareMinor(grossMinor: bigint, shareBps: number): bigint {
  return roundRationalHalfEven(grossMinor * BigInt(shareBps), 10_000n);
}

export function validateSettlementNote(value: unknown, sha256: Sha256Fn): string | null {
  if (value === null || typeof value !== 'object') return 'settlement: must be an object';
  const n = value as Partial<SettlementNote> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(n.protocol_version, 'settlement.protocol_version') ??
    validateId(n.settlement_id, 'settlement.settlement_id') ??
    validateHex64(n.proposal_digest, 'settlement.proposal_digest') ??
    validateIsoUtc(n.period_start, 'settlement.period_start') ??
    validateIsoUtc(n.period_end, 'settlement.period_end') ??
    (Date.parse(n.period_end as string) > Date.parse(n.period_start as string)
      ? null
      : 'settlement.period_end: must follow period_start') ??
    validateMoney(n.gross_sales) ??
    validateMoney(n.computed_share) ??
    ((n.gross_sales as Money).currency === (n.computed_share as Money).currency
      ? null
      : 'settlement: gross and share must share a currency') ??
    (n.replaces_settlement_digest === undefined
      ? null
      : validateHex64(n.replaces_settlement_digest, 'settlement.replaces_settlement_digest')) ??
    validateIsoUtc(n.issued_at, 'settlement.issued_at') ??
    validateHex64(n.settlement_digest, 'settlement.settlement_digest') ??
    digestMismatch('settlement_note', n, 'settlement_digest', sha256)
  );
}

/** The pairwise §5 checks a note owes its agreement. */
export function verifySettlementAgainstAgreement(
  note: SettlementNote,
  proposal: AgreementProposal,
): string | null {
  if (note.proposal_digest !== proposal.proposal_digest) {
    return 'settlement: answers a different agreement';
  }
  if (note.protocol_version !== proposal.protocol_version) {
    return 'settlement: §9.13 — a conversation pins one protocol version';
  }
  if (note.gross_sales.currency !== proposal.currency) {
    return 'settlement: currency differs from the agreement';
  }
  const expected = computedShareMinor(moneyMinorUnits(note.gross_sales), proposal.share_bps);
  if (moneyMinorUnits(note.computed_share) !== expected) {
    const rendered = minorUnitsToString(expected);
    return `settlement.computed_share: must be ${rendered.value ?? '(overflow)'} (gross × ${String(proposal.share_bps)}bps, half-even)`;
  }
  return null;
}

export function validateSettlementAcknowledgement(
  value: unknown,
  sha256: Sha256Fn,
): string | null {
  if (value === null || typeof value !== 'object') return 'ack: must be an object';
  const a = value as Partial<SettlementAcknowledgement> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(a.protocol_version, 'ack.protocol_version') ??
    validateId(a.settlement_ack_id, 'ack.settlement_ack_id') ??
    validateHex64(a.settlement_digest, 'ack.settlement_digest') ??
    (a.kind === 'accepted' || a.kind === 'disputed' ? null : 'ack.kind: unknown kind') ??
    validateIsoUtc(a.acknowledged_at, 'ack.acknowledged_at') ??
    validateHex64(a.settlement_ack_digest, 'ack.settlement_ack_digest') ??
    digestMismatch('settlement_ack', a, 'settlement_ack_digest', sha256)
  );
}

// ---------------------------------------------------------------------------
// The fold (§5, the §4.4 shape)
// ---------------------------------------------------------------------------

export interface RevshareFoldInput {
  cash_handler: CashHandler;
  currency: string;
  /** Accepted settlements of the LATEST revision per period — the
   *  ingest rules (dedup, supersession) distilled this list. */
  settlements: { gross_minor: string; share_minor: string }[];
}

export type RevshareFoldResult =
  | {
      ok: true;
      /** Who owes whom, stated once per `cash_handler` value (§5). */
      direction: 'vendor_owes_host' | 'host_owes_vendor';
      owed_minor: string;
      gross_minor: string;
      share_minor: string;
      settlement_count: number;
    }
  | { ok: false; error: string };

export function computeRevenueShareFold(input: RevshareFoldInput): RevshareFoldResult {
  let gross = 0n;
  let share = 0n;
  for (const [i, settlement] of input.settlements.entries()) {
    const grossMoney: Money = { currency: input.currency, minor_units: settlement.gross_minor };
    const shareMoney: Money = { currency: input.currency, minor_units: settlement.share_minor };
    const bad = validateMoney(grossMoney) ?? validateMoney(shareMoney);
    if (bad) return { ok: false, error: `fold.settlements[${String(i)}]: ${bad}` };
    gross += moneyMinorUnits(grossMoney);
    share += moneyMinorUnits(shareMoney);
  }
  if (share > gross) {
    return { ok: false, error: 'fold: the share exceeds the gross it was computed from' };
  }
  // `cash_handler: 'vendor'` — the vendor holds the takings and owes the
  // host the share. `'host'` — the host holds them and owes the vendor
  // the remainder. Plain integer subtraction; §9.1's overflow rule rides
  // minorUnitsToString.
  const owed = input.cash_handler === 'vendor' ? share : gross - share;
  const owedText = minorUnitsToString(owed);
  const grossText = minorUnitsToString(gross);
  const shareText = minorUnitsToString(share);
  if (owedText.value === null || grossText.value === null || shareText.value === null) {
    return { ok: false, error: 'fold: totals exceed the representable bound' };
  }
  return {
    ok: true,
    direction: input.cash_handler === 'vendor' ? 'vendor_owes_host' : 'host_owes_vendor',
    owed_minor: owedText.value,
    gross_minor: grossText.value,
    share_minor: shareText.value,
    settlement_count: input.settlements.length,
  };
}
