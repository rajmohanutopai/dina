/**
 * The revenue-share ledger (TRADE_FIRST_STRATEGY §5) — the khata
 * discipline applied to the floor-space model: store rows keyed by
 * digest, first-writer-wins, envelope evidence retained, and every rule
 * enforced ONCE, shared by the inbound verifiers and the authoring
 * service.
 *
 * THE LIFECYCLE RULES, stated so supersession cannot be read two ways
 * (§5): an agreement is ACTIVE when a party holds proposal + accepted
 * decision with verified envelope evidence, and the envelope senders
 * match the two DIDs the proposal names — the party who proposed cannot
 * also accept. A re-proposal changes NOTHING until its own acceptance;
 * the old agreement keeps settling until then or until a termination
 * takes effect. Exactly one LIVE settlement per (agreement, period); a
 * correction SUPERSEDES by revision; the replaced note stays stored,
 * excluded from the fold. The first acknowledgement per settlement
 * digest is final for that revision.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  computeRevenueShareFold,
  validateAgreementDecision,
  validateAgreementProposal,
  validateAgreementTermination,
  validateSettlementAcknowledgement,
  validateSettlementNote,
  verifySettlementAgainstAgreement,
  type AgreementDecision,
  type AgreementProposal,
  type AgreementTermination,
  type RevshareFoldResult,
  type Sha256Fn,
  type SettlementAcknowledgement,
  type SettlementNote,
} from '@dina/commerce-protocol';

import {
  rehydrateRevshareDocument,
  type RehydratedRevshare,
} from './rehydrate';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

const hash: Sha256Fn = (data) => sha256(data);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type RevshareDocumentKind =
  | 'agreement_proposal'
  | 'agreement_decision'
  | 'agreement_termination'
  | 'settlement_note'
  | 'settlement_ack';

export interface RevshareDocumentRow {
  recordDigest: string;
  kind: RevshareDocumentKind;
  counterpartyDid: string;
  /** The agreement this row belongs to ('' on proposals themselves —
   *  their own digest IS the agreement key). */
  proposalDigest: string;
  answersDigest: string;
  direction: 'inbound' | 'outbound';
  recordJson: string;
  evidenceJson: string;
  createdAt: number;
}

export interface RevshareDocumentRepository {
  /** First-writer-wins on record digest. False when already stored. */
  put(row: RevshareDocumentRow): boolean;
  get(recordDigest: string): RevshareDocumentRow | null;
  listByProposal(proposalDigest: string, kind: RevshareDocumentKind): RevshareDocumentRow[];
  listByCounterparty(counterpartyDid: string, kind: RevshareDocumentKind): RevshareDocumentRow[];
  answersTo(recordDigest: string, kind: RevshareDocumentKind): RevshareDocumentRow[];
}

export class SQLiteRevshareDocumentRepository implements RevshareDocumentRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(row: RevshareDocumentRow): boolean {
    let inserted = false;
    this.db.transaction(() => {
      const existing = this.db.query<{ record_digest: string }>(
        `SELECT record_digest FROM commerce_revshare_documents WHERE record_digest = ?`,
        [row.recordDigest],
      );
      if (existing[0] !== undefined) return;
      this.db.run(
        `INSERT INTO commerce_revshare_documents
           (record_digest, kind, counterparty_did, proposal_digest, answers_digest,
            direction, record_json, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.recordDigest,
          row.kind,
          row.counterpartyDid,
          row.proposalDigest,
          row.answersDigest,
          row.direction,
          row.recordJson,
          row.evidenceJson,
          row.createdAt,
        ],
      );
      inserted = true;
    });
    return inserted;
  }

  get(recordDigest: string): RevshareDocumentRow | null {
    const rows = this.db.query<DBRow>(
      `SELECT * FROM commerce_revshare_documents WHERE record_digest = ?`,
      [recordDigest],
    );
    return rows[0] === undefined ? null : fromDb(rows[0]);
  }

  listByProposal(proposalDigest: string, kind: RevshareDocumentKind): RevshareDocumentRow[] {
    return this.db
      .query<DBRow>(
        `SELECT * FROM commerce_revshare_documents
          WHERE proposal_digest = ? AND kind = ? ORDER BY created_at, record_digest`,
        [proposalDigest, kind],
      )
      .map(fromDb);
  }

  listByCounterparty(counterpartyDid: string, kind: RevshareDocumentKind): RevshareDocumentRow[] {
    return this.db
      .query<DBRow>(
        `SELECT * FROM commerce_revshare_documents
          WHERE counterparty_did = ? AND kind = ? ORDER BY created_at, record_digest`,
        [counterpartyDid, kind],
      )
      .map(fromDb);
  }

  answersTo(recordDigest: string, kind: RevshareDocumentKind): RevshareDocumentRow[] {
    return this.db
      .query<DBRow>(
        `SELECT * FROM commerce_revshare_documents
          WHERE answers_digest = ? AND kind = ? ORDER BY created_at, record_digest`,
        [recordDigest, kind],
      )
      .map(fromDb);
  }
}

function fromDb(row: DBRow): RevshareDocumentRow {
  return {
    recordDigest: String(row.record_digest),
    kind: String(row.kind) as RevshareDocumentKind,
    counterpartyDid: String(row.counterparty_did),
    proposalDigest: String(row.proposal_digest ?? ''),
    answersDigest: String(row.answers_digest ?? ''),
    direction: String(row.direction) as 'inbound' | 'outbound',
    recordJson: String(row.record_json),
    evidenceJson: String(row.evidence_json ?? '{}'),
    createdAt: Number(row.created_at),
  };
}

/** Test double. A production caller would be the bug. */
export class InMemoryRevshareDocumentRepository implements RevshareDocumentRepository {
  private readonly rows = new Map<string, RevshareDocumentRow>();

  private sorted(filter: (row: RevshareDocumentRow) => boolean): RevshareDocumentRow[] {
    return [...this.rows.values()]
      .filter(filter)
      .sort((a, b) => a.createdAt - b.createdAt || a.recordDigest.localeCompare(b.recordDigest))
      .map((r) => ({ ...r }));
  }

  put(row: RevshareDocumentRow): boolean {
    if (this.rows.has(row.recordDigest)) return false;
    this.rows.set(row.recordDigest, { ...row });
    return true;
  }

  get(recordDigest: string): RevshareDocumentRow | null {
    const row = this.rows.get(recordDigest);
    return row === undefined ? null : { ...row };
  }

  listByProposal(proposalDigest: string, kind: RevshareDocumentKind): RevshareDocumentRow[] {
    return this.sorted((r) => r.proposalDigest === proposalDigest && r.kind === kind);
  }

  listByCounterparty(counterpartyDid: string, kind: RevshareDocumentKind): RevshareDocumentRow[] {
    return this.sorted((r) => r.counterpartyDid === counterpartyDid && r.kind === kind);
  }

  answersTo(recordDigest: string, kind: RevshareDocumentKind): RevshareDocumentRow[] {
    return this.sorted((r) => r.answersDigest === recordDigest && r.kind === kind);
  }
}

// ---------------------------------------------------------------------------
// Agreement lifecycle — ONE definition
// ---------------------------------------------------------------------------

export type AgreementStatus =
  | { state: 'none' }
  | { state: 'proposed'; proposal: AgreementProposal }
  | { state: 'rejected'; proposal: AgreementProposal }
  | { state: 'active'; proposal: AgreementProposal }
  | { state: 'terminated'; proposal: AgreementProposal; effectiveAt: string }
  /** A replacement proposal was ACCEPTED — new periods settle under it. */
  | { state: 'superseded'; proposal: AgreementProposal; effectiveAt: string };

/**
 * Where an agreement stands, from this node's own retained rows. ACTIVE
 * requires proposal + accepted decision where the DECIDER is not the
 * PROPOSER — enforced structurally by directions: an inbound proposal
 * pairs with an outbound decision and the reverse, so a party cannot
 * accept its own proposal out of its own store.
 */
export function agreementStatus(
  repository: RevshareDocumentRepository,
  proposalDigest: string,
  nowMs: number,
): AgreementStatus {
  const proposalRow = repository.get(proposalDigest);
  if (proposalRow === null || proposalRow.kind !== 'agreement_proposal') return { state: 'none' };
  const proposal = readProposal(proposalRow);
  if (proposal === null) return { state: 'none' };

  const decisions = repository
    .answersTo(proposalDigest, 'agreement_decision')
    // The proposer cannot also accept: the decision must run in the
    // OPPOSITE direction to the proposal.
    .filter((row) => row.direction !== proposalRow.direction);
  const decision = decisions[0] === undefined ? null : readDecision(decisions[0]);
  if (decision === null) return { state: 'proposed', proposal };
  if (decision.kind === 'rejected') return { state: 'rejected', proposal };

  for (const terminationRow of repository.answersTo(proposalDigest, 'agreement_termination')) {
    const termination = readTermination(terminationRow);
    if (termination !== null && Date.parse(termination.effective_at) <= nowMs) {
      return { state: 'terminated', proposal, effectiveAt: termination.effective_at };
    }
  }
  // §5 — "the old agreement keeps settling UNTIL the replacement is
  // accepted": an ACCEPTED proposal that names this one via
  // `replaces_proposal_digest` (indexed as its answers_digest) ends it
  // for new periods, effective at the acceptance.
  for (const replacementRow of repository.answersTo(proposalDigest, 'agreement_proposal')) {
    const acceptance = replacementAcceptance(repository, replacementRow);
    if (acceptance !== null) {
      return { state: 'superseded', proposal, effectiveAt: acceptance };
    }
  }
  return { state: 'active', proposal };
}

/** The accepted decision's clock for a replacement proposal row, if any. */
function replacementAcceptance(
  repository: RevshareDocumentRepository,
  replacementRow: RevshareDocumentRow,
): string | null {
  if (replacementRow.kind !== 'agreement_proposal') return null;
  for (const decisionRow of repository.answersTo(replacementRow.recordDigest, 'agreement_decision')) {
    if (decisionRow.direction === replacementRow.direction) continue; // proposer cannot accept
    const decision = readDecision(decisionRow);
    if (decision !== null && decision.kind === 'accepted') return decision.decided_at;
  }
  return null;
}

/** The clock an agreement's OWN acceptance ran at, if it is accepted. */
export function acceptedDecisionAt(
  repository: RevshareDocumentRepository,
  proposalDigest: string,
): string | null {
  const proposalRow = repository.get(proposalDigest);
  if (proposalRow === null) return null;
  return replacementAcceptance(repository, proposalRow);
}

/**
 * §5 — whether a settlement note may still open under this agreement's
 * status. Terminated and superseded agreements settle ONLY periods that
 * opened before the end took effect; without this, an explicit
 * termination never actually ended anything.
 */
export function settlementAdmissibleUnderStatus(
  status: AgreementStatus,
  note: SettlementNote,
): string | null {
  if (status.state === 'active') return null;
  if (status.state === 'terminated' || status.state === 'superseded') {
    return Date.parse(note.period_start) < Date.parse(status.effectiveAt)
      ? null
      : `the agreement ${status.state === 'terminated' ? 'terminated' : 'was superseded'} at ${status.effectiveAt} — new periods do not settle under it`;
  }
  return `settlement under a ${status.state} agreement`;
}

function readProposal(row: RevshareDocumentRow): AgreementProposal | null {
  const read = rehydrateRevshareDocument(row);
  return read.kind === 'agreement_proposal' ? read.document : null;
}
function readDecision(row: RevshareDocumentRow): AgreementDecision | null {
  const read = rehydrateRevshareDocument(row);
  return read.kind === 'agreement_decision' ? read.document : null;
}
function readTermination(row: RevshareDocumentRow): AgreementTermination | null {
  const read = rehydrateRevshareDocument(row);
  return read.kind === 'agreement_termination' ? read.document : null;
}
function readSettlement(row: RevshareDocumentRow): SettlementNote | null {
  const read = rehydrateRevshareDocument(row);
  return read.kind === 'settlement_note' ? read.document : null;
}
function readAck(row: RevshareDocumentRow): SettlementAcknowledgement | null {
  const read = rehydrateRevshareDocument(row);
  return read.kind === 'settlement_ack' ? read.document : null;
}

/**
 * The LIVE settlement per period: the note no superseding revision has
 * replaced. Used by the period-dedup rule and by the fold.
 */
export function liveSettlements(
  repository: RevshareDocumentRepository,
  proposalDigest: string,
): { row: RevshareDocumentRow; note: SettlementNote }[] {
  const rows = repository.listByProposal(proposalDigest, 'settlement_note');
  const replaced = new Set<string>();
  const notes: { row: RevshareDocumentRow; note: SettlementNote }[] = [];
  for (const row of rows) {
    const note = readSettlement(row);
    if (note === null) continue;
    if (note.replaces_settlement_digest !== undefined) {
      replaced.add(note.replaces_settlement_digest);
    }
    notes.push({ row, note });
  }
  return notes.filter((entry) => !replaced.has(entry.note.settlement_digest));
}

// ---------------------------------------------------------------------------
// Inbound verification — the shared rules
// ---------------------------------------------------------------------------

export type RevshareIngestOutcome =
  | 'applied'
  | 'duplicate'
  | 'unreadable'
  | 'not_ours'
  | 'refused'
  | 'conflict';

export interface RevshareIngest {
  outcome: RevshareIngestOutcome;
  detail?: string;
  recordDigest?: string;
}

function ingest(
  outcome: RevshareIngestOutcome,
  detail?: string,
  recordDigest?: string,
): RevshareIngest {
  return { outcome, ...(detail !== undefined ? { detail } : {}), ...(recordDigest !== undefined ? { recordDigest } : {}) };
}

export function verifyInboundAgreementProposal(args: {
  senderDid: string;
  selfDid: string;
  proposal: unknown;
  repository: RevshareDocumentRepository;
  evidenceJson: string;
  nowMs: number;
}): RevshareIngest {
  const bad = validateAgreementProposal(args.proposal, hash);
  if (bad !== null) return ingest('unreadable', bad);
  const proposal = args.proposal as AgreementProposal;
  if (args.repository.get(proposal.proposal_digest) !== null) {
    return ingest('duplicate', undefined, proposal.proposal_digest);
  }
  const parties = [proposal.host_did, proposal.vendor_did];
  if (!parties.includes(args.senderDid)) {
    return ingest('refused', 'the sender is not a party the proposal names');
  }
  if (!parties.includes(args.selfDid)) {
    return ingest('not_ours', 'this node is not a party the proposal names');
  }
  if (args.senderDid === args.selfDid) return ingest('refused', 'a party cannot send to itself');
  if (proposal.replaces_proposal_digest !== undefined) {
    // The authoring side's rule, mirrored: a re-proposal supersedes an
    // ACTIVE agreement or nothing.
    const replaced = agreementStatus(args.repository, proposal.replaces_proposal_digest, args.nowMs);
    if (replaced.state !== 'active') {
      return ingest('refused', 'a re-proposal supersedes an ACTIVE agreement or nothing');
    }
  }
  args.repository.put({
    recordDigest: proposal.proposal_digest,
    kind: 'agreement_proposal',
    counterpartyDid: args.senderDid,
    proposalDigest: '',
    // A replacing proposal ANSWERS the agreement it supersedes — the
    // index `agreementStatus` walks to end the old one on acceptance.
    answersDigest: proposal.replaces_proposal_digest ?? '',
    direction: 'inbound',
    recordJson: JSON.stringify(proposal),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  return ingest('applied', undefined, proposal.proposal_digest);
}

export function verifyInboundAgreementDecision(args: {
  senderDid: string;
  selfDid: string;
  decision: unknown;
  repository: RevshareDocumentRepository;
  evidenceJson: string;
  nowMs: number;
}): RevshareIngest {
  const bad = validateAgreementDecision(args.decision, hash);
  if (bad !== null) return ingest('unreadable', bad);
  const decision = args.decision as AgreementDecision;
  if (args.repository.get(decision.decision_digest) !== null) {
    return ingest('duplicate', undefined, decision.decision_digest);
  }
  const proposalRow = args.repository.get(decision.proposal_digest);
  if (proposalRow === null || proposalRow.kind !== 'agreement_proposal') {
    return ingest('refused', 'no retained proposal for this decision');
  }
  const proposal = readProposal(proposalRow);
  if (proposal === null) return ingest('refused', 'the retained proposal cannot be re-verified');
  if (decision.protocol_version !== proposal.protocol_version) {
    return ingest('refused', '§9.13 — a conversation pins one protocol version');
  }
  // The party who proposed cannot also accept: an inbound decision must
  // answer a proposal THIS node authored (outbound).
  if (proposalRow.direction !== 'outbound') {
    return ingest('refused', 'the proposer cannot also decide');
  }
  if (args.senderDid !== proposalRow.counterpartyDid) {
    return ingest('refused', 'the decision sender is not the proposal counterparty');
  }
  const existing = args.repository.answersTo(decision.proposal_digest, 'agreement_decision');
  if (existing.length > 0) {
    const first = existing[0] === undefined ? null : readDecision(existing[0]);
    return first !== null && first.decision_digest === decision.decision_digest
      ? ingest('duplicate', undefined, decision.decision_digest)
      : ingest('conflict', 'the proposal already has a decision — the first answer stands');
  }
  args.repository.put({
    recordDigest: decision.decision_digest,
    kind: 'agreement_decision',
    counterpartyDid: args.senderDid,
    proposalDigest: decision.proposal_digest,
    answersDigest: decision.proposal_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(decision),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  return ingest('applied', undefined, decision.decision_digest);
}

export function verifyInboundAgreementTermination(args: {
  senderDid: string;
  selfDid: string;
  termination: unknown;
  repository: RevshareDocumentRepository;
  evidenceJson: string;
  nowMs: number;
}): RevshareIngest {
  const bad = validateAgreementTermination(args.termination, hash);
  if (bad !== null) return ingest('unreadable', bad);
  const termination = args.termination as AgreementTermination;
  if (args.repository.get(termination.termination_digest) !== null) {
    return ingest('duplicate', undefined, termination.termination_digest);
  }
  const status = agreementStatus(args.repository, termination.proposal_digest, args.nowMs);
  if (status.state !== 'active') {
    return ingest('refused', `termination of a ${status.state} agreement`);
  }
  if (termination.protocol_version !== status.proposal.protocol_version) {
    return ingest('refused', '§9.13 — a conversation pins one protocol version');
  }
  if (![status.proposal.host_did, status.proposal.vendor_did].includes(args.senderDid)) {
    return ingest('refused', 'the sender is not a party of this agreement');
  }
  args.repository.put({
    recordDigest: termination.termination_digest,
    kind: 'agreement_termination',
    counterpartyDid: args.senderDid,
    proposalDigest: termination.proposal_digest,
    answersDigest: termination.proposal_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(termination),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  return ingest('applied', undefined, termination.termination_digest);
}

/** Shared by inbound verification AND authoring: the §5 note rules. */
export function checkSettlementNote(args: {
  note: SettlementNote;
  proposal: AgreementProposal;
  repository: RevshareDocumentRepository;
}): string | null {
  const pairError = verifySettlementAgainstAgreement(args.note, args.proposal);
  if (pairError !== null) return pairError;
  // §5's other boundary: a REPLACEMENT settles only periods opened at or
  // after its own acceptance — the earlier ones settle under the
  // agreement it replaced, never twice.
  if (args.proposal.replaces_proposal_digest !== undefined) {
    const acceptedAt = acceptedDecisionAt(args.repository, args.note.proposal_digest);
    if (acceptedAt !== null && Date.parse(args.note.period_start) < Date.parse(acceptedAt)) {
      return 'a replacement settles only periods opened at or after its acceptance';
    }
  }
  const live = liveSettlements(args.repository, args.note.proposal_digest);
  if (args.note.replaces_settlement_digest !== undefined) {
    const replaced = live.find(
      (entry) => entry.note.settlement_digest === args.note.replaces_settlement_digest,
    );
    if (replaced === undefined) {
      return 'the revision replaces a settlement that is not live';
    }
    if (
      replaced.note.period_start !== args.note.period_start ||
      replaced.note.period_end !== args.note.period_end
    ) {
      return 'a revision must cover the period it corrects';
    }
    return null;
  }
  // Exactly one live note per (agreement, period).
  const clash = live.some(
    (entry) =>
      entry.note.period_start === args.note.period_start &&
      entry.note.period_end === args.note.period_end,
  );
  return clash ? 'the period already has a live settlement — supersede it by revision' : null;
}

export function verifyInboundSettlementNote(args: {
  senderDid: string;
  selfDid: string;
  note: unknown;
  repository: RevshareDocumentRepository;
  evidenceJson: string;
  nowMs: number;
}): RevshareIngest {
  const bad = validateSettlementNote(args.note, hash);
  if (bad !== null) return ingest('unreadable', bad);
  const note = args.note as SettlementNote;
  if (args.repository.get(note.settlement_digest) !== null) {
    return ingest('duplicate', undefined, note.settlement_digest);
  }
  const status = agreementStatus(args.repository, note.proposal_digest, args.nowMs);
  if (status.state === 'none' || status.state === 'proposed' || status.state === 'rejected') {
    return ingest('refused', `settlement under a ${status.state} agreement`);
  }
  const admission = settlementAdmissibleUnderStatus(status, note);
  if (admission !== null) return ingest('refused', admission);
  const handlerDid =
    status.proposal.cash_handler === 'host' ? status.proposal.host_did : status.proposal.vendor_did;
  if (args.senderDid !== handlerDid) {
    return ingest('refused', 'only the cash handler issues settlements');
  }
  const ruleError = checkSettlementNote({ note, proposal: status.proposal, repository: args.repository });
  if (ruleError !== null) return ingest('refused', ruleError);
  args.repository.put({
    recordDigest: note.settlement_digest,
    kind: 'settlement_note',
    counterpartyDid: args.senderDid,
    proposalDigest: note.proposal_digest,
    answersDigest: note.replaces_settlement_digest ?? '',
    direction: 'inbound',
    recordJson: JSON.stringify(note),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  return ingest('applied', undefined, note.settlement_digest);
}

export function verifyInboundSettlementAck(args: {
  senderDid: string;
  selfDid: string;
  ack: unknown;
  repository: RevshareDocumentRepository;
  evidenceJson: string;
  nowMs: number;
}): RevshareIngest {
  const bad = validateSettlementAcknowledgement(args.ack, hash);
  if (bad !== null) return ingest('unreadable', bad);
  const ack = args.ack as SettlementAcknowledgement;
  if (args.repository.get(ack.settlement_ack_digest) !== null) {
    return ingest('duplicate', undefined, ack.settlement_ack_digest);
  }
  const noteRow = args.repository.get(ack.settlement_digest);
  if (noteRow === null || noteRow.kind !== 'settlement_note') {
    return ingest('refused', 'no retained settlement for this acknowledgement');
  }
  const note = readSettlement(noteRow);
  if (note === null) return ingest('refused', 'the retained settlement cannot be re-verified');
  if (ack.protocol_version !== note.protocol_version) {
    return ingest('refused', '§9.13 — a conversation pins one protocol version');
  }
  const status = agreementStatus(args.repository, note.proposal_digest, args.nowMs);
  if (status.state === 'none' || status.state === 'proposed' || status.state === 'rejected') {
    return ingest('refused', 'acknowledgement under a non-agreement');
  }
  // The envelope sender MUST be the party that is NOT the cash handler.
  const nonHandlerDid =
    status.proposal.cash_handler === 'host' ? status.proposal.vendor_did : status.proposal.host_did;
  if (args.senderDid !== nonHandlerDid) {
    return ingest('refused', 'only the non-cash-handler party acknowledges');
  }
  const existing = args.repository.answersTo(ack.settlement_digest, 'settlement_ack');
  if (existing.length > 0) {
    const first = existing[0] === undefined ? null : readAck(existing[0]);
    return first !== null && first.settlement_ack_digest === ack.settlement_ack_digest
      ? ingest('duplicate', undefined, ack.settlement_ack_digest)
      : ingest('conflict', 'the settlement already has an acknowledgement — the first answer stands');
  }
  args.repository.put({
    recordDigest: ack.settlement_ack_digest,
    kind: 'settlement_ack',
    counterpartyDid: args.senderDid,
    proposalDigest: note.proposal_digest,
    answersDigest: ack.settlement_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(ack),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  return ingest('applied', undefined, ack.settlement_ack_digest);
}

// ---------------------------------------------------------------------------
// The fold input (§5, the §4.4 shape)
// ---------------------------------------------------------------------------

/**
 * The agreement's statement: the fold over ACCEPTED settlements of the
 * latest revision per period. Both sides compute identical numbers from
 * the same documents.
 */
export function revshareStatement(
  repository: RevshareDocumentRepository,
  proposalDigest: string,
  nowMs: number,
): RevshareFoldResult {
  const status = agreementStatus(repository, proposalDigest, nowMs);
  if (status.state === 'none' || status.state === 'proposed' || status.state === 'rejected') {
    return { ok: false, error: `no settled agreement: ${status.state}` };
  }
  const settlements: { gross_minor: string; share_minor: string }[] = [];
  for (const entry of liveSettlements(repository, proposalDigest)) {
    const acks = repository.answersTo(entry.note.settlement_digest, 'settlement_ack');
    const ack = acks[0] === undefined ? null : readAck(acks[0]);
    if (ack === null || ack.kind !== 'accepted') continue;
    settlements.push({
      gross_minor: entry.note.gross_sales.minor_units,
      share_minor: entry.note.computed_share.minor_units,
    });
  }
  return computeRevenueShareFold({
    cash_handler: status.proposal.cash_handler,
    currency: status.proposal.currency,
    settlements,
  });
}

/** RehydratedRevshare is re-exported for callers walking raw rows. */
export type { RehydratedRevshare };
