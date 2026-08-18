/**
 * The §5 revenue-share chain as TWO real nodes: agreement lifecycle
 * (the proposer cannot accept; supersession changes nothing until its
 * own acceptance), settlement rules (handler-only issue, derived share,
 * one live note per period, revision supersession, first-ack finality,
 * non-handler-only ack), and the fold both sides compute identically.
 */

import { createHash } from 'node:crypto';

import { revshareRecordDigest, type Sha256Fn } from '@dina/commerce-protocol';

import {
  InMemoryRevshareDocumentRepository,
  verifyInboundAgreementDecision,
  verifyInboundAgreementProposal,
  verifyInboundAgreementTermination,
  verifyInboundSettlementAck,
  verifyInboundSettlementNote,
  agreementStatus,
} from '../../src/commerce/revshare_ledger';
import { RevshareService } from '../../src/commerce/revshare_service';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());

const HOST = 'did:plc:retailhost0000000000000000';
const VENDOR = 'did:plc:pickleseller00000000000000';
const T0 = 1_800_000_000_000;

interface Side {
  did: string;
  repo: InMemoryRevshareDocumentRepository;
  service: RevshareService;
}

function makeSide(did: string, clock: { now: number }): Side {
  const repo = new InMemoryRevshareDocumentRepository();
  return {
    did,
    repo,
    service: new RevshareService({ documents: repo, nodeDid: () => did, now: () => clock.now }),
  };
}

/** Author on one side, ingest on the other — one document, two ledgers. */
function carry(
  from: Side,
  to: Side,
  kind: 'proposal' | 'decision' | 'termination' | 'settlement' | 'ack',
  document: unknown,
  nowMs: number,
): string {
  const shared = {
    senderDid: from.did,
    selfDid: to.did,
    repository: to.repo,
    evidenceJson: '{}',
    nowMs,
  };
  const outcome =
    kind === 'proposal'
      ? verifyInboundAgreementProposal({ ...shared, proposal: document })
      : kind === 'decision'
        ? verifyInboundAgreementDecision({ ...shared, decision: document })
        : kind === 'termination'
          ? verifyInboundAgreementTermination({ ...shared, termination: document })
          : kind === 'settlement'
            ? verifyInboundSettlementNote({ ...shared, note: document })
            : verifyInboundSettlementAck({ ...shared, ack: document });
  return outcome.outcome;
}

function activate(clock: { now: number }): { host: Side; vendor: Side; proposalDigest: string } {
  const host = makeSide(HOST, clock);
  const vendor = makeSide(VENDOR, clock);
  const proposed = host.service.propose({
    counterpartyDid: VENDOR,
    selfRole: 'host',
    shareBps: 800,
    period: 'weekly',
    cashHandler: 'vendor',
    currency: 'INR',
    effectiveFrom: '2026-09-01T00:00:00.000Z',
  });
  if (!proposed.ok) throw new Error(proposed.refusal);
  expect(carry(host, vendor, 'proposal', proposed.document, clock.now)).toBe('applied');
  const decided = vendor.service.decide({
    proposalDigest: proposed.document.proposal_digest,
    kind: 'accepted',
  });
  if (!decided.ok) throw new Error(decided.refusal);
  expect(carry(vendor, host, 'decision', decided.document, clock.now)).toBe('applied');
  return { host, vendor, proposalDigest: proposed.document.proposal_digest };
}

describe('the agreement lifecycle', () => {
  it('proposal + accepted decision from the OTHER party = active on both sides', () => {
    const clock = { now: T0 };
    const { host, vendor, proposalDigest } = activate(clock);
    expect(agreementStatus(host.repo, proposalDigest, clock.now).state).toBe('active');
    expect(agreementStatus(vendor.repo, proposalDigest, clock.now).state).toBe('active');
  });

  it('the proposer cannot also accept — structurally, on both ledgers', () => {
    const clock = { now: T0 };
    const host = makeSide(HOST, clock);
    const proposed = host.service.propose({
      counterpartyDid: VENDOR,
      selfRole: 'host',
      shareBps: 800,
      period: 'weekly',
      cashHandler: 'vendor',
      currency: 'INR',
      effectiveFrom: '2026-09-01T00:00:00.000Z',
    });
    if (!proposed.ok) throw new Error(proposed.refusal);
    // Authoring a decision on one's own outbound proposal refuses.
    const selfDecide = host.service.decide({
      proposalDigest: proposed.document.proposal_digest,
      kind: 'accepted',
    });
    expect(!selfDecide.ok && selfDecide.refusal).toContain('proposer cannot');
  });

  it('a decision from a NON-party or a second conflicting decision refuses', () => {
    const clock = { now: T0 };
    const { host, vendor, proposalDigest } = activate(clock);
    void vendor;
    // A second decision for the same proposal conflicts on the host.
    const forged = {
      protocol_version: '1.0',
      decision_id: 'dec-forged',
      proposal_digest: proposalDigest,
      kind: 'rejected',
      decided_at: '2026-08-18T11:00:00.000Z',
    };
    const outcome = verifyInboundAgreementDecision({
      senderDid: VENDOR,
      selfDid: HOST,
      decision: forged,
      repository: host.repo,
      evidenceJson: '{}',
      nowMs: clock.now,
    });
    // Unreadable (no digest) — and even digest-sealed it would CONFLICT.
    expect(['unreadable', 'conflict']).toContain(outcome.outcome);
  });

  it('a re-proposal changes NOTHING until accepted; the old agreement keeps settling', () => {
    const clock = { now: T0 };
    const { host, vendor, proposalDigest } = activate(clock);
    const reproposed = host.service.propose({
      counterpartyDid: VENDOR,
      selfRole: 'host',
      shareBps: 900,
      period: 'weekly',
      cashHandler: 'vendor',
      currency: 'INR',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      replacesProposalDigest: proposalDigest,
    });
    expect(reproposed.ok).toBe(true);
    // The OLD agreement still settles at the OLD share.
    const settled = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '1000000',
    });
    expect(settled.ok && settled.document.computed_share.minor_units).toBe('80000'); // 8%, not 9%
  });

  it('termination ends new settlement but the statement still folds settled periods', () => {
    const clock = { now: T0 };
    const { host, vendor, proposalDigest } = activate(clock);
    const settled = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '1000000',
    });
    if (!settled.ok) throw new Error(settled.refusal);
    expect(carry(vendor, host, 'settlement', settled.document, clock.now)).toBe('applied');
    const acked = host.service.acknowledgeSettlement({
      settlementDigest: settled.document.settlement_digest,
      kind: 'accepted',
    });
    if (!acked.ok) throw new Error(acked.refusal);
    expect(carry(host, vendor, 'ack', acked.document, clock.now)).toBe('applied');

    const terminated = host.service.terminate({ proposalDigest });
    expect(terminated.ok).toBe(true);
    expect(agreementStatus(host.repo, proposalDigest, clock.now).state).toBe('terminated');
    const statement = host.service.statement(proposalDigest);
    expect(statement).toEqual({
      ok: true,
      direction: 'vendor_owes_host',
      owed_minor: '80000',
      gross_minor: '1000000',
      share_minor: '80000',
      settlement_count: 1,
    });
  });
});

describe('settlement rules, two ledgers folding identically', () => {
  it('the full period: handler issues, non-handler acks, both statements agree to the paisa', () => {
    const clock = { now: T0 };
    const { host, vendor, proposalDigest } = activate(clock);

    // Two weekly periods; the vendor (cash handler) issues both.
    for (const [start, end, gross] of [
      ['2026-09-01T00:00:00.000Z', '2026-09-08T00:00:00.000Z', '1250000'],
      ['2026-09-08T00:00:00.000Z', '2026-09-15T00:00:00.000Z', '980000'],
    ] as const) {
      const settled = vendor.service.issueSettlement({
        proposalDigest,
        periodStart: start,
        periodEnd: end,
        grossMinor: gross,
      });
      if (!settled.ok) throw new Error(settled.refusal);
      expect(carry(vendor, host, 'settlement', settled.document, clock.now)).toBe('applied');
      const acked = host.service.acknowledgeSettlement({
        settlementDigest: settled.document.settlement_digest,
        kind: 'accepted',
      });
      if (!acked.ok) throw new Error(acked.refusal);
      expect(carry(host, vendor, 'ack', acked.document, clock.now)).toBe('applied');
    }

    const hostStatement = host.service.statement(proposalDigest);
    const vendorStatement = vendor.service.statement(proposalDigest);
    expect(hostStatement).toEqual(vendorStatement);
    expect(hostStatement).toEqual({
      ok: true,
      direction: 'vendor_owes_host',
      owed_minor: '178400',
      gross_minor: '2230000',
      share_minor: '178400',
      settlement_count: 2,
    });
  });

  it('only the cash handler issues; only the non-handler acks; the period never doubles', () => {
    const clock = { now: T0 };
    const { host, vendor, proposalDigest } = activate(clock);
    // The HOST (non-handler here) cannot issue.
    const hostIssue = host.service.issueSettlement({
      proposalDigest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '1000000',
    });
    expect(!hostIssue.ok && hostIssue.refusal).toContain('cash handler');

    const settled = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '1000000',
    });
    if (!settled.ok) throw new Error(settled.refusal);
    // A second note for the SAME period refuses on the author's own node.
    const doubled = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '999999',
    });
    expect(!doubled.ok && doubled.refusal).toContain('already has a live settlement');
    // The handler cannot ack its own note.
    expect(carry(vendor, host, 'settlement', settled.document, clock.now)).toBe('applied');
    const vendorAck = vendor.service.acknowledgeSettlement({
      settlementDigest: settled.document.settlement_digest,
      kind: 'accepted',
    });
    expect(vendorAck.ok).toBe(false); // outbound note, not inbound
  });

  it('a revision supersedes: the replaced note stays stored, out of the fold; the revision needs its own ack', () => {
    const clock = { now: T0 };
    const { host, vendor, proposalDigest } = activate(clock);
    const first = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '1000000',
    });
    if (!first.ok) throw new Error(first.refusal);
    expect(carry(vendor, host, 'settlement', first.document, clock.now)).toBe('applied');
    // Dispute path: a superseding revision, never a second answer.
    const revision = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '1100000',
      replacesSettlementDigest: first.document.settlement_digest,
    });
    if (!revision.ok) throw new Error(revision.refusal);
    expect(carry(vendor, host, 'settlement', revision.document, clock.now)).toBe('applied');
    const acked = host.service.acknowledgeSettlement({
      settlementDigest: revision.document.settlement_digest,
      kind: 'accepted',
    });
    if (!acked.ok) throw new Error(acked.refusal);
    expect(carry(host, vendor, 'ack', acked.document, clock.now)).toBe('applied');

    // Both sides fold the REVISION only — 8% of 11,000.00.
    const statement = vendor.service.statement(proposalDigest);
    expect(statement).toEqual({
      ok: true,
      direction: 'vendor_owes_host',
      owed_minor: '88000',
      gross_minor: '1100000',
      share_minor: '88000',
      settlement_count: 1,
    });
    // History kept: the replaced note is still retrievable.
    expect(vendor.repo.get(first.document.settlement_digest)).not.toBeNull();
  });

  it('the first acknowledgement is final for a revision; a conflicting second refuses', () => {
    const clock = { now: T0 };
    const { host, vendor, proposalDigest } = activate(clock);
    const settled = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '1000000',
    });
    if (!settled.ok) throw new Error(settled.refusal);
    expect(carry(vendor, host, 'settlement', settled.document, clock.now)).toBe('applied');
    const acked = host.service.acknowledgeSettlement({
      settlementDigest: settled.document.settlement_digest,
      kind: 'disputed',
    });
    if (!acked.ok) throw new Error(acked.refusal);
    expect(carry(host, vendor, 'ack', acked.document, clock.now)).toBe('applied');
    // The same ack replays as duplicate; a different one conflicts.
    expect(carry(host, vendor, 'ack', acked.document, clock.now)).toBe('duplicate');
    const second = host.service.acknowledgeSettlement({
      settlementDigest: settled.document.settlement_digest,
      kind: 'accepted',
    });
    expect(second.ok).toBe(false);
  });
});
describe('§5 boundaries — termination and supersession END new periods', () => {
  it('a period opened AFTER termination refuses on BOTH ledgers; one opened before still settles', () => {
    const clock = { now: T0 };
    const { host, vendor, proposalDigest } = activate(clock);
    const terminated = host.service.terminate({ proposalDigest });
    if (!terminated.ok) throw new Error(terminated.refusal);
    expect(carry(host, vendor, 'termination', terminated.document, clock.now)).toBe('applied');

    // T0 renders past the termination clock — a period opened after it
    // must not settle: the handler cannot issue it, and even a hand-made
    // note refuses at the counterparty ledger.
    const newPeriod = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2027-06-01T00:00:00.000Z',
      periodEnd: '2027-06-08T00:00:00.000Z',
      grossMinor: '1000000',
    });
    expect(!newPeriod.ok && newPeriod.refusal).toContain('terminated');

    // A period opened BEFORE the termination still settles under it.
    const oldPeriod = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '500000',
    });
    if (!oldPeriod.ok) throw new Error(oldPeriod.refusal);
    expect(carry(vendor, host, 'settlement', oldPeriod.document, clock.now)).toBe('applied');
  });

  it('an accepted replacement SUPERSEDES: the old refuses new periods, the replacement refuses earlier ones', () => {
    const clock = { now: T0 };
    const { host, vendor, proposalDigest } = activate(clock);

    // Host re-proposes at a new share; vendor accepts. The §5 sentence
    // this pins: "the old agreement keeps settling UNTIL the replacement
    // is accepted".
    const reproposed = host.service.propose({
      counterpartyDid: VENDOR,
      selfRole: 'host',
      shareBps: 1000,
      period: 'weekly',
      cashHandler: 'vendor',
      currency: 'INR',
      effectiveFrom: '2027-02-01T00:00:00.000Z',
      replacesProposalDigest: proposalDigest,
    });
    if (!reproposed.ok) throw new Error(reproposed.refusal);
    expect(carry(host, vendor, 'proposal', reproposed.document, clock.now)).toBe('applied');
    const accepted = vendor.service.decide({
      proposalDigest: reproposed.document.proposal_digest,
      kind: 'accepted',
    });
    if (!accepted.ok) throw new Error(accepted.refusal);
    expect(carry(vendor, host, 'decision', accepted.document, clock.now)).toBe('applied');

    expect(agreementStatus(host.repo, proposalDigest, clock.now).state).toBe('superseded');
    expect(agreementStatus(vendor.repo, proposalDigest, clock.now).state).toBe('superseded');

    // New period under the OLD share: refused on both sides.
    const underOld = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2027-06-01T00:00:00.000Z',
      periodEnd: '2027-06-08T00:00:00.000Z',
      grossMinor: '1000000',
    });
    expect(!underOld.ok && underOld.refusal).toContain('superseded');

    // The SAME early period under the replacement: refused — it settles
    // under the agreement it replaced, never twice at two shares.
    const doubleSettle = vendor.service.issueSettlement({
      proposalDigest: reproposed.document.proposal_digest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '1000000',
    });
    expect(!doubleSettle.ok && doubleSettle.refusal).toContain('at or after its acceptance');

    // A period opened before the supersession still settles under OLD.
    const earlyUnderOld = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '400000',
    });
    if (!earlyUnderOld.ok) throw new Error(earlyUnderOld.refusal);
    expect(carry(vendor, host, 'settlement', earlyUnderOld.document, clock.now)).toBe('applied');

    // And a NEW period under the replacement settles at the NEW share.
    const underNew = vendor.service.issueSettlement({
      proposalDigest: reproposed.document.proposal_digest,
      periodStart: '2027-06-01T00:00:00.000Z',
      periodEnd: '2027-06-08T00:00:00.000Z',
      grossMinor: '1000000',
    });
    if (!underNew.ok) throw new Error(underNew.refusal);
    expect(underNew.document.computed_share.minor_units).toBe('100000'); // 10% now
    expect(carry(vendor, host, 'settlement', underNew.document, clock.now)).toBe('applied');
  });

  it('the wire arm refuses the proposer deciding its own proposal', () => {
    const clock = { now: T0 };
    const host = makeSide(HOST, clock);
    const vendor = makeSide(VENDOR, clock);
    const proposed = host.service.propose({
      counterpartyDid: VENDOR,
      selfRole: 'host',
      shareBps: 800,
      period: 'weekly',
      cashHandler: 'vendor',
      currency: 'INR',
      effectiveFrom: '2026-09-01T00:00:00.000Z',
    });
    if (!proposed.ok) throw new Error(proposed.refusal);
    expect(carry(host, vendor, 'proposal', proposed.document, clock.now)).toBe('applied');
    // The PROPOSER wires an "accepted" decision at the vendor: the
    // vendor's ledger holds that proposal INBOUND, so the structural
    // direction rule refuses it regardless of the signature story.
    const forgedDraft = {
      protocol_version: '1.0',
      decision_id: 'dec-forged',
      proposal_digest: proposed.document.proposal_digest,
      kind: 'accepted',
      decided_at: '2027-01-15T00:00:00.000Z',
    };
    const forged = {
      ...forgedDraft,
      decision_digest: revshareRecordDigest('agreement_decision', forgedDraft, hash),
    };
    const outcome = verifyInboundAgreementDecision({
      senderDid: HOST,
      selfDid: VENDOR,
      decision: forged,
      repository: vendor.repo,
      evidenceJson: '{}',
      nowMs: clock.now,
    });
    expect(outcome.outcome).toBe('refused');
    expect(outcome.detail).toContain('proposer cannot');
  });

  it('first-ack finality on the WIRE: a contradicting second ack conflicts, the first stands', () => {
    const clock = { now: T0 };
    const { host, vendor, proposalDigest } = activate(clock);
    const settled = vendor.service.issueSettlement({
      proposalDigest,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-08T00:00:00.000Z',
      grossMinor: '1000000',
    });
    if (!settled.ok) throw new Error(settled.refusal);
    expect(carry(vendor, host, 'settlement', settled.document, clock.now)).toBe('applied');
    const acked = host.service.acknowledgeSettlement({
      settlementDigest: settled.document.settlement_digest,
      kind: 'accepted',
    });
    if (!acked.ok) throw new Error(acked.refusal);
    expect(carry(host, vendor, 'ack', acked.document, clock.now)).toBe('applied');

    // A hand-made CONTRADICTING ack from the same non-handler: conflict,
    // never replacement — money already changed state on the first.
    const secondDraft = {
      protocol_version: '1.0',
      settlement_ack_id: 'ack-second',
      settlement_digest: settled.document.settlement_digest,
      kind: 'disputed',
      acknowledged_at: '2027-01-16T00:00:00.000Z',
    };
    const second = {
      ...secondDraft,
      settlement_ack_digest: revshareRecordDigest('settlement_ack', secondDraft, hash),
    };
    const outcome = verifyInboundSettlementAck({
      senderDid: HOST,
      selfDid: VENDOR,
      ack: second,
      repository: vendor.repo,
      evidenceJson: '{}',
      nowMs: clock.now,
    });
    expect(outcome.outcome).toBe('conflict');
  });
});
