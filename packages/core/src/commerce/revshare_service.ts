/**
 * The revenue-share authoring service (TRADE_FIRST_STRATEGY §5) — the
 * khata service's discipline: AUTHORING RUNS THE INBOUND RULES ON
 * ITSELF, so a node never authors a document its counterparty will
 * refuse; the share is DERIVED, never caller-supplied; and the fold is
 * the one arithmetic authority.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  computedShareMinor,
  revshareRecordDigest,
  validateAgreementDecision,
  validateAgreementProposal,
  validateAgreementTermination,
  validateSettlementAcknowledgement,
  validateSettlementNote,
  type AgreementDecision,
  type AgreementProposal,
  type AgreementTermination,
  type CashHandler,
  type RevshareFoldResult,
  type RevsharePeriod,
  type Sha256Fn,
  type SettlementAcknowledgement,
  type SettlementNote,
} from '@dina/commerce-protocol';

import { rehydrateRevshareDocument } from './rehydrate';
import {
  agreementStatus,
  checkSettlementNote,
  liveSettlements,
  revshareStatement,
  type AgreementStatus,
  type RevshareDocumentRepository,
  settlementAdmissibleUnderStatus,
} from './revshare_ledger';

const hash: Sha256Fn = (data) => sha256(data);

export type RevshareAuthorOutcome<T> = { ok: true; document: T } | { ok: false; refusal: string };

function refuse<T>(refusal: string): RevshareAuthorOutcome<T> {
  return { ok: false, refusal };
}

function mintId(prefix: string): string {
  return `${prefix}_${bytesToHex(randomBytes(12))}`;
}

export interface RevshareServiceDeps {
  documents: RevshareDocumentRepository;
  nodeDid: () => string;
  now: () => number;
}

export class RevshareService {
  constructor(private readonly deps: RevshareServiceDeps) {}

  private iso(nowMs: number): string {
    return new Date(nowMs).toISOString();
  }

  /** Propose an agreement — either party may. `selfRole` states which
   *  party THIS node is; the counterparty is the other. */
  propose(args: {
    counterpartyDid: string;
    selfRole: 'host' | 'vendor';
    shareBps: number;
    period: RevsharePeriod;
    cashHandler: CashHandler;
    currency: string;
    effectiveFrom: string;
    replacesProposalDigest?: string;
  }): RevshareAuthorOutcome<AgreementProposal> {
    const self = this.deps.nodeDid();
    const draft = {
      protocol_version: '1.0',
      proposal_id: mintId('agr'),
      host_did: args.selfRole === 'host' ? self : args.counterpartyDid,
      vendor_did: args.selfRole === 'vendor' ? self : args.counterpartyDid,
      share_bps: args.shareBps,
      period: args.period,
      cash_handler: args.cashHandler,
      currency: args.currency,
      effective_from: args.effectiveFrom,
      ...(args.replacesProposalDigest !== undefined
        ? { replaces_proposal_digest: args.replacesProposalDigest }
        : {}),
      proposed_at: this.iso(this.deps.now()),
    };
    const proposal = {
      ...draft,
      proposal_digest: revshareRecordDigest('agreement_proposal', draft, hash),
    } as AgreementProposal;
    const shapeError = validateAgreementProposal(proposal, hash);
    if (shapeError !== null) return refuse(shapeError);
    if (args.replacesProposalDigest !== undefined) {
      const replaced = agreementStatus(this.deps.documents, args.replacesProposalDigest, this.deps.now());
      if (replaced.state !== 'active') {
        return refuse('a re-proposal supersedes an ACTIVE agreement or nothing');
      }
    }
    this.deps.documents.put({
      recordDigest: proposal.proposal_digest,
      kind: 'agreement_proposal',
      counterpartyDid: args.counterpartyDid,
      proposalDigest: '',
      // A replacing proposal ANSWERS the agreement it supersedes.
      answersDigest: args.replacesProposalDigest ?? '',
      direction: 'outbound',
      recordJson: JSON.stringify(proposal),
      evidenceJson: '{}',
      createdAt: this.deps.now(),
    });
    return { ok: true, document: proposal };
  }

  /** Decide an INBOUND proposal — the proposer cannot also accept. */
  decide(args: {
    proposalDigest: string;
    kind: 'accepted' | 'rejected';
  }): RevshareAuthorOutcome<AgreementDecision> {
    const proposalRow = this.deps.documents.get(args.proposalDigest);
    if (proposalRow === null || proposalRow.kind !== 'agreement_proposal') {
      return refuse('no retained proposal with that digest');
    }
    if (proposalRow.direction !== 'inbound') {
      return refuse('the proposer cannot also decide');
    }
    const read = rehydrateRevshareDocument(proposalRow);
    if (read.kind !== 'agreement_proposal') return refuse('retained row is not a proposal');
    const existing = this.deps.documents.answersTo(args.proposalDigest, 'agreement_decision');
    if (existing.length > 0) {
      return refuse('the proposal already has a decision — the first answer stands');
    }
    const draft = {
      protocol_version: read.document.protocol_version,
      decision_id: mintId('dec'),
      proposal_digest: args.proposalDigest,
      kind: args.kind,
      decided_at: this.iso(this.deps.now()),
    };
    const decision = {
      ...draft,
      decision_digest: revshareRecordDigest('agreement_decision', draft, hash),
    } as AgreementDecision;
    const shapeError = validateAgreementDecision(decision, hash);
    if (shapeError !== null) return refuse(shapeError);
    this.deps.documents.put({
      recordDigest: decision.decision_digest,
      kind: 'agreement_decision',
      counterpartyDid: proposalRow.counterpartyDid,
      proposalDigest: args.proposalDigest,
      answersDigest: args.proposalDigest,
      direction: 'outbound',
      recordJson: JSON.stringify(decision),
      evidenceJson: '{}',
      createdAt: this.deps.now(),
    });
    return { ok: true, document: decision };
  }

  /** Terminate an ACTIVE agreement — either party may. */
  terminate(args: {
    proposalDigest: string;
    effectiveAt?: string;
  }): RevshareAuthorOutcome<AgreementTermination> {
    const now = this.deps.now();
    const status = agreementStatus(this.deps.documents, args.proposalDigest, now);
    if (status.state !== 'active') return refuse(`termination of a ${status.state} agreement`);
    const draft = {
      protocol_version: status.proposal.protocol_version,
      termination_id: mintId('term'),
      proposal_digest: args.proposalDigest,
      effective_at: args.effectiveAt ?? this.iso(now),
      terminated_at: this.iso(now),
    };
    const termination = {
      ...draft,
      termination_digest: revshareRecordDigest('agreement_termination', draft, hash),
    } as AgreementTermination;
    const shapeError = validateAgreementTermination(termination, hash);
    if (shapeError !== null) return refuse(shapeError);
    this.deps.documents.put({
      recordDigest: termination.termination_digest,
      kind: 'agreement_termination',
      counterpartyDid:
        status.proposal.host_did === this.deps.nodeDid()
          ? status.proposal.vendor_did
          : status.proposal.host_did,
      proposalDigest: args.proposalDigest,
      answersDigest: args.proposalDigest,
      direction: 'outbound',
      recordJson: JSON.stringify(termination),
      evidenceJson: '{}',
      createdAt: now,
    });
    return { ok: true, document: termination };
  }

  /**
   * Issue a settlement — the CASH HANDLER's act, and the share is
   * DERIVED from the agreement, never supplied: a handler cannot round
   * in its own favour by a paisa.
   */
  issueSettlement(args: {
    proposalDigest: string;
    periodStart: string;
    periodEnd: string;
    grossMinor: string;
    replacesSettlementDigest?: string;
  }): RevshareAuthorOutcome<SettlementNote> {
    const now = this.deps.now();
    const status = agreementStatus(this.deps.documents, args.proposalDigest, now);
    if (status.state !== 'active' && status.state !== 'terminated' && status.state !== 'superseded') {
      return refuse(`settlement under a ${status.state} agreement`);
    }
    const self = this.deps.nodeDid();
    const handlerDid =
      status.proposal.cash_handler === 'host' ? status.proposal.host_did : status.proposal.vendor_did;
    if (self !== handlerDid) return refuse('only the cash handler issues settlements');
    let gross: bigint;
    try {
      gross = BigInt(args.grossMinor);
    } catch {
      return refuse('gross must be a minor-unit integer');
    }
    const draft = {
      protocol_version: status.proposal.protocol_version,
      settlement_id: mintId('stl'),
      proposal_digest: args.proposalDigest,
      period_start: args.periodStart,
      period_end: args.periodEnd,
      gross_sales: { currency: status.proposal.currency, minor_units: args.grossMinor },
      computed_share: {
        currency: status.proposal.currency,
        minor_units: computedShareMinor(gross, status.proposal.share_bps).toString(),
      },
      ...(args.replacesSettlementDigest !== undefined
        ? { replaces_settlement_digest: args.replacesSettlementDigest }
        : {}),
      issued_at: this.iso(now),
    };
    const note = {
      ...draft,
      settlement_digest: revshareRecordDigest('settlement_note', draft, hash),
    } as SettlementNote;
    const shapeError = validateSettlementNote(note, hash);
    if (shapeError !== null) return refuse(shapeError);
    const admission = settlementAdmissibleUnderStatus(status, note);
    if (admission !== null) return refuse(admission);
    const ruleError = checkSettlementNote({
      note,
      proposal: status.proposal,
      repository: this.deps.documents,
    });
    if (ruleError !== null) return refuse(ruleError);
    this.deps.documents.put({
      recordDigest: note.settlement_digest,
      kind: 'settlement_note',
      counterpartyDid:
        status.proposal.host_did === self ? status.proposal.vendor_did : status.proposal.host_did,
      proposalDigest: args.proposalDigest,
      answersDigest: note.replaces_settlement_digest ?? '',
      direction: 'outbound',
      recordJson: JSON.stringify(note),
      evidenceJson: '{}',
      createdAt: now,
    });
    return { ok: true, document: note };
  }

  /** Acknowledge an INBOUND settlement — the non-handler's act. */
  acknowledgeSettlement(args: {
    settlementDigest: string;
    kind: 'accepted' | 'disputed';
  }): RevshareAuthorOutcome<SettlementAcknowledgement> {
    const noteRow = this.deps.documents.get(args.settlementDigest);
    if (noteRow === null || noteRow.kind !== 'settlement_note' || noteRow.direction !== 'inbound') {
      return refuse('no received settlement with that digest');
    }
    const read = rehydrateRevshareDocument(noteRow);
    if (read.kind !== 'settlement_note') return refuse('retained row is not a settlement');
    const existing = this.deps.documents.answersTo(args.settlementDigest, 'settlement_ack');
    if (existing.length > 0) {
      return refuse('the settlement already has an acknowledgement — the first answer stands');
    }
    const draft = {
      protocol_version: read.document.protocol_version,
      settlement_ack_id: mintId('sack'),
      settlement_digest: args.settlementDigest,
      kind: args.kind,
      acknowledged_at: this.iso(this.deps.now()),
    };
    const ack = {
      ...draft,
      settlement_ack_digest: revshareRecordDigest('settlement_ack', draft, hash),
    } as SettlementAcknowledgement;
    const shapeError = validateSettlementAcknowledgement(ack, hash);
    if (shapeError !== null) return refuse(shapeError);
    this.deps.documents.put({
      recordDigest: ack.settlement_ack_digest,
      kind: 'settlement_ack',
      counterpartyDid: noteRow.counterpartyDid,
      proposalDigest: noteRow.proposalDigest,
      answersDigest: args.settlementDigest,
      direction: 'outbound',
      recordJson: JSON.stringify(ack),
      evidenceJson: '{}',
      createdAt: this.deps.now(),
    });
    return { ok: true, document: ack };
  }

  /** The agreement's derived statement (§5's fold). */
  statement(proposalDigest: string): RevshareFoldResult {
    return revshareStatement(this.deps.documents, proposalDigest, this.deps.now());
  }

  /** Where an agreement stands, plus its unanswered settlements. */
  status(proposalDigest: string): {
    status: AgreementStatus;
    unansweredSettlements: string[];
  } {
    const status = agreementStatus(this.deps.documents, proposalDigest, this.deps.now());
    const unanswered =
      status.state === 'active' || status.state === 'terminated' || status.state === 'superseded'
        ? liveSettlements(this.deps.documents, proposalDigest)
            .filter(
              (entry) =>
                this.deps.documents.answersTo(entry.note.settlement_digest, 'settlement_ack')
                  .length === 0,
            )
            .map((entry) => entry.note.settlement_digest)
        : [];
    return { status, unansweredSettlements: unanswered };
  }
}
