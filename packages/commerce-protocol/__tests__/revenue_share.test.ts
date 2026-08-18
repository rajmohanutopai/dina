/**
 * §5 revenue share: document shapes, the share arithmetic (§9.1's ONE
 * half-even rounding), the pairwise agreement binding, and the fold in
 * BOTH cash-handler directions — the golden vectors the doc requires.
 */

import { createHash } from 'node:crypto';

import {
  computedShareMinor,
  computeRevenueShareFold,
  revshareRecordDigest,
  validateAgreementDecision,
  validateAgreementProposal,
  validateAgreementTermination,
  validateSettlementAcknowledgement,
  validateSettlementNote,
  verifySettlementAgainstAgreement,
  type AgreementProposal,
  type Sha256Fn,
  type SettlementNote,
} from '../src/index';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());

const HOST = 'did:plc:retailhost0000000000000000';
const VENDOR = 'did:plc:pickleseller00000000000000';

export function makeProposal(overrides: Partial<AgreementProposal> = {}): AgreementProposal {
  const draft = {
    protocol_version: '1.0',
    proposal_id: 'agr-1',
    host_did: HOST,
    vendor_did: VENDOR,
    share_bps: 800, // 8%
    period: 'weekly' as const,
    cash_handler: 'vendor' as const,
    currency: 'INR',
    effective_from: '2026-09-01T00:00:00.000Z',
    proposed_at: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
  return {
    ...draft,
    proposal_digest: revshareRecordDigest('agreement_proposal', draft, hash),
  } as AgreementProposal;
}

export function makeSettlement(
  proposal: AgreementProposal,
  overrides: Partial<SettlementNote> = {},
): SettlementNote {
  const gross = overrides.gross_sales ?? { currency: 'INR', minor_units: '1250000' };
  const share = computedShareMinor(BigInt(gross.minor_units), proposal.share_bps);
  const draft = {
    protocol_version: proposal.protocol_version,
    settlement_id: 'stl-1',
    proposal_digest: proposal.proposal_digest,
    period_start: '2026-09-01T00:00:00.000Z',
    period_end: '2026-09-08T00:00:00.000Z',
    gross_sales: gross,
    computed_share: { currency: gross.currency, minor_units: share.toString() },
    issued_at: '2026-09-08T06:00:00.000Z',
    ...overrides,
  };
  return {
    ...draft,
    settlement_digest: revshareRecordDigest('settlement_note', draft, hash),
  } as SettlementNote;
}

describe('the documents', () => {
  it('a well-formed chain validates; tampering breaks each digest', () => {
    const proposal = makeProposal();
    expect(validateAgreementProposal(proposal, hash)).toBeNull();
    expect(
      validateAgreementProposal({ ...proposal, share_bps: 900 }, hash),
    ).toContain('does not match');

    const decisionDraft = {
      protocol_version: '1.0',
      decision_id: 'dec-1',
      proposal_digest: proposal.proposal_digest,
      kind: 'accepted' as const,
      decided_at: '2026-08-18T10:00:00.000Z',
    };
    const decision = {
      ...decisionDraft,
      decision_digest: revshareRecordDigest('agreement_decision', decisionDraft, hash),
    };
    expect(validateAgreementDecision(decision, hash)).toBeNull();

    const terminationDraft = {
      protocol_version: '1.0',
      termination_id: 'term-1',
      proposal_digest: proposal.proposal_digest,
      effective_at: '2026-10-01T00:00:00.000Z',
      terminated_at: '2026-09-20T00:00:00.000Z',
      ...{},
    };
    const termination = {
      ...terminationDraft,
      termination_digest: revshareRecordDigest('agreement_termination', terminationDraft, hash),
    };
    expect(validateAgreementTermination(termination, hash)).toBeNull();
    // Effective before issuance: refused — retroactive termination
    // rewrites settled periods.
    const retro = { ...terminationDraft, effective_at: '2026-09-01T00:00:00.000Z' };
    expect(
      validateAgreementTermination(
        { ...retro, termination_digest: revshareRecordDigest('agreement_termination', retro, hash) },
        hash,
      ),
    ).toContain('never precedes');
  });

  it('degenerate proposals refuse: same party twice, out-of-range share', () => {
    expect(validateAgreementProposal(makeProposal({ vendor_did: HOST }), hash)).toContain(
      'must differ',
    );
    expect(validateAgreementProposal(makeProposal({ share_bps: 0 }), hash)).toContain('share_bps');
    expect(validateAgreementProposal(makeProposal({ share_bps: 10_000 }), hash)).toContain(
      'share_bps',
    );
  });
});

describe('the share arithmetic (§9.1: ONE half-even rounding)', () => {
  it('8% of ₹12,500.00 is ₹1,000.00; ties round half-even', () => {
    expect(computedShareMinor(1_250_000n, 800)).toBe(100_000n);
    // 625 × 800 / 10000 = 50 exactly.
    expect(computedShareMinor(625n, 800)).toBe(50n);
    // A .5 tie: 25 × 700bps = 1.75 → wait for a real tie use 75 × 700 /
    // 10000 = 5.25 → 5; and 250 × 700 / 10000 = 17.5 → half-even 18? No:
    // 17.5 rounds to the EVEN neighbour, 18. And 350 × 500 / 10000 =
    // 17.5 as well. Pin both directions of the tie:
    expect(computedShareMinor(250n, 700)).toBe(18n); // 17.5 → 18 (even)
    expect(computedShareMinor(650n, 500)).toBe(32n); // 32.5 → 32 (even)
  });

  it('the pairwise verifier refuses a wrong share, wrong currency, wrong version', () => {
    const proposal = makeProposal();
    const good = makeSettlement(proposal);
    expect(validateSettlementNote(good, hash)).toBeNull();
    expect(verifySettlementAgainstAgreement(good, proposal)).toBeNull();

    const padded = makeSettlement(proposal, {
      computed_share: { currency: 'INR', minor_units: '100001' },
    });
    expect(verifySettlementAgainstAgreement(padded, proposal)).toContain('computed_share');

    const wrongCurrency = makeSettlement(proposal, {
      gross_sales: { currency: 'USD', minor_units: '1000' },
      computed_share: { currency: 'USD', minor_units: '80' },
    });
    expect(verifySettlementAgainstAgreement(wrongCurrency, proposal)).toContain('currency');

    const wrongVersion = makeSettlement(proposal, { protocol_version: '1.1' });
    expect(verifySettlementAgainstAgreement(wrongVersion, proposal)).toContain('§9.13');
  });

  it('acknowledgements validate and pin their kinds', () => {
    const proposal = makeProposal();
    const note = makeSettlement(proposal);
    const ackDraft = {
      protocol_version: '1.0',
      settlement_ack_id: 'sack-1',
      settlement_digest: note.settlement_digest,
      kind: 'accepted' as const,
      acknowledged_at: '2026-09-08T07:00:00.000Z',
    };
    const ack = {
      ...ackDraft,
      settlement_ack_digest: revshareRecordDigest('settlement_ack', ackDraft, hash),
    };
    expect(validateSettlementAcknowledgement(ack, hash)).toBeNull();
    expect(
      validateSettlementAcknowledgement({ ...ack, kind: 'maybe' }, hash),
    ).toContain('kind');
  });
});

describe('the fold, both directions — the golden vectors', () => {
  const SETTLEMENTS = [
    { gross_minor: '1250000', share_minor: '100000' }, // week 1: ₹12,500 @ 8%
    { gross_minor: '980000', share_minor: '78400' }, // week 2: ₹9,800 @ 8%
  ];

  it("cash_handler 'vendor': the vendor holds the takings and owes the SHARE", () => {
    expect(
      computeRevenueShareFold({ cash_handler: 'vendor', currency: 'INR', settlements: SETTLEMENTS }),
    ).toEqual({
      ok: true,
      direction: 'vendor_owes_host',
      owed_minor: '178400',
      gross_minor: '2230000',
      share_minor: '178400',
      settlement_count: 2,
    });
  });

  it("cash_handler 'host': the host holds the takings and owes gross − share", () => {
    expect(
      computeRevenueShareFold({ cash_handler: 'host', currency: 'INR', settlements: SETTLEMENTS }),
    ).toEqual({
      ok: true,
      direction: 'host_owes_vendor',
      owed_minor: '2051600',
      gross_minor: '2230000',
      share_minor: '178400',
      settlement_count: 2,
    });
  });

  it('a share exceeding its gross refuses — arithmetic never goes negative silently', () => {
    const bad = computeRevenueShareFold({
      cash_handler: 'host',
      currency: 'INR',
      settlements: [{ gross_minor: '100', share_minor: '101' }],
    });
    expect(!bad.ok && bad.error).toContain('exceeds');
  });
});
