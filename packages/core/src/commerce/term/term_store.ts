/**
 * The term-negotiation store (SHELF_SPACE_NEGOTIATION §5) — every table the
 * term engine reads and writes, behind one class over the Tier-0 database.
 *
 * Documents follow the revenue-share ledger's discipline: digest-keyed,
 * first writer wins, both directions, envelope evidence retained. Every row
 * also names the REQUEST it belongs to, because that is what binds a
 * stranger's later documents to the one first contact that let them in
 * (§5.3 "First contact with a stranger").
 *
 * EVERY WRITE IS ONE STATEMENT. First-writer-wins is `INSERT OR IGNORE`; a
 * receipt or an answer that must never replace a final one is a conditional
 * `UPDATE`. So no method here opens a transaction, and the acts that must
 * land together (an agreement accepted and counted, a proposal stored with
 * its negotiation moved on) take the commerce runtime's ONE coordinator
 * (`CommerceTransaction`) from the engine instead.
 */

import { StrategyQuestionStore } from '../../commitment/strategy_questions';

import type { TermListingAccess } from './term_policy';
import type { DatabaseAdapter, DBRow } from '../../storage/db_adapter';
import type { TermReceiptOutcome } from '@dina/commerce-protocol';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type TermDocumentKind =
  | 'term_request'
  | 'term_offer'
  | 'term_counter'
  | 'term_agreement_proposal'
  | 'agreement_decision'
  | 'agreement_termination'
  | 'settlement_note'
  | 'settlement_ack';

export interface TermDocumentRow {
  recordDigest: string;
  kind: TermDocumentKind;
  counterpartyDid: string;
  /** The request this document belongs to (every term document has one). */
  requestId: string;
  /** The agreement this row belongs to; '' before an agreement exists. */
  proposalDigest: string;
  /** The digest this row answers or revises; '' when none. */
  answersDigest: string;
  direction: 'inbound' | 'outbound';
  recordJson: string;
  evidenceJson: string;
  createdAt: number;
}

export interface TermOutboxRow {
  recordDigest: string;
  toDid: string;
  kind: string;
  documentJson: string;
  createdAt: number;
  nextAttemptAt: number;
  attempts: number;
  /** No resend after this instant (§5.3 stop points). */
  stopAt: number;
  /** The latest receipt the counterparty sent; null until one arrives. */
  receiptOutcome: TermReceiptOutcome | null;
  receiptAt: number | null;
  /** Set when resends ran out without a final receipt. */
  gaveUpAt: number | null;
}

export interface TermAnswerRow {
  ofDigest: string;
  senderDid: string;
  kind: string;
  outcome: TermReceiptOutcome;
  updatedAt: number;
}

export type TermHeldReason = 'prerequisite' | 'owner_card';

export interface TermHeldRow {
  recordDigest: string;
  senderDid: string;
  kind: string;
  requestId: string;
  proposalDigest: string;
  reason: TermHeldReason;
  bodyJson: string;
  evidenceJson: string;
  receivedAt: number;
  expiresAt: number;
}

export interface TermListingRow {
  listingId: string;
  resourceRef: string;
  recordJson: string;
  listingDigest: string;
  state: 'published' | 'withdrawn';
  /** The directory may still hold the public record (a withdrawal not yet removed there). */
  recordPublic: boolean;
  /** Who may ask about it (§6.2); private to this node, never in the record. */
  access: TermListingAccess;
  updatedAt: number;
}

export type TermNegotiationState = 'negotiating' | 'ready' | 'proposed' | 'agreed' | 'closed';

export interface TermNegotiationRow {
  requestId: string;
  sellerDid: string;
  listingJson: string;
  policyJson: string;
  state: TermNegotiationState;
  closeReason: string;
  deadlineAt: number;
  nextActionAt: number;
  createdAt: number;
  updatedAt: number;
}

export type TermCardState = 'pending' | 'approved' | 'declined' | 'lapsed';

export interface TermCardRow {
  cardId: string;
  cardType: string;
  requestId: string;
  refDigest: string;
  state: TermCardState;
  materialJson: string;
  /** The inbox line and payload, kept so a card raised before the inbox existed is raised again. */
  description: string;
  payloadJson: string;
  decideBy: number;
  createdAt: number;
  decidedAt: number | null;
  /** What came of the owner's yes: '' (no yes), 'ok', or the refusal. */
  yesOutcome: string;
}

export interface TermFloorAuthorizationRow {
  requestId: string;
  termName: string;
  value: string;
  cardId: string;
  createdAt: number;
}

export interface TermStrategyTurn {
  requestId: string;
  turn: number;
  taskId: string;
  state: 'pending' | 'applied' | 'fallen_back';
  createdAt: number;
}

function turnFromDb(row: DBRow): TermStrategyTurn {
  const state = String(row.state);
  return {
    requestId: String(row.request_id),
    turn: Number(row.turn),
    taskId: String(row.task_id),
    state: state === 'applied' || state === 'fallen_back' ? state : 'pending',
    createdAt: Number(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function documentFromDb(row: DBRow): TermDocumentRow {
  return {
    recordDigest: str(row.record_digest),
    kind: str(row.kind) as TermDocumentKind,
    counterpartyDid: str(row.counterparty_did),
    requestId: str(row.request_id),
    proposalDigest: str(row.proposal_digest),
    answersDigest: str(row.answers_digest),
    direction: str(row.direction) as 'inbound' | 'outbound',
    recordJson: str(row.record_json),
    evidenceJson: str(row.evidence_json) || '{}',
    createdAt: num(row.created_at),
  };
}

function outboxFromDb(row: DBRow): TermOutboxRow {
  return {
    recordDigest: str(row.record_digest),
    toDid: str(row.to_did),
    kind: str(row.kind),
    documentJson: str(row.document_json),
    createdAt: num(row.created_at),
    nextAttemptAt: num(row.next_attempt_at),
    attempts: num(row.attempts),
    stopAt: num(row.stop_at),
    receiptOutcome:
      row.receipt_outcome === null ? null : (str(row.receipt_outcome) as TermReceiptOutcome),
    receiptAt: numOrNull(row.receipt_at),
    gaveUpAt: numOrNull(row.gave_up_at),
  };
}

function heldFromDb(row: DBRow): TermHeldRow {
  return {
    recordDigest: str(row.record_digest),
    senderDid: str(row.sender_did),
    kind: str(row.kind),
    requestId: str(row.request_id),
    proposalDigest: str(row.proposal_digest),
    reason: str(row.reason) as TermHeldReason,
    bodyJson: str(row.body_json),
    evidenceJson: str(row.evidence_json) || '{}',
    receivedAt: num(row.received_at),
    expiresAt: num(row.expires_at),
  };
}

function negotiationFromDb(row: DBRow): TermNegotiationRow {
  return {
    requestId: str(row.request_id),
    sellerDid: str(row.seller_did),
    listingJson: str(row.listing_json),
    policyJson: str(row.policy_json),
    state: str(row.state) as TermNegotiationState,
    closeReason: str(row.close_reason),
    deadlineAt: num(row.deadline_at),
    nextActionAt: num(row.next_action_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function cardFromDb(row: DBRow): TermCardRow {
  return {
    cardId: str(row.card_id),
    cardType: str(row.card_type),
    requestId: str(row.request_id),
    refDigest: str(row.ref_digest),
    state: str(row.state) as TermCardState,
    materialJson: str(row.material_json),
    description: str(row.description),
    payloadJson: str(row.payload_json) || '{}',
    decideBy: num(row.decide_by),
    createdAt: num(row.created_at),
    decidedAt: numOrNull(row.decided_at),
    yesOutcome: str(row.yes_outcome),
  };
}

export class TermStore {
  constructor(private readonly db: DatabaseAdapter) {}

  /** Brain's questions to the owner (COMMITMENT_KERNEL §15 step 11), in the same database. */
  questions(): StrategyQuestionStore {
    return new StrategyQuestionStore(this.db);
  }

  // --- documents -----------------------------------------------------------

  /** First writer wins on the digest. False when the row already exists. */
  putDocument(row: TermDocumentRow): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO commerce_term_documents
           (record_digest, kind, counterparty_did, request_id, proposal_digest, answers_digest,
            direction, record_json, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.recordDigest,
          row.kind,
          row.counterpartyDid,
          row.requestId,
          row.proposalDigest,
          row.answersDigest,
          row.direction,
          row.recordJson,
          row.evidenceJson,
          row.createdAt,
        ],
      ) > 0
    );
  }

  getDocument(recordDigest: string): TermDocumentRow | null {
    const rows = this.db.query(`SELECT * FROM commerce_term_documents WHERE record_digest = ?`, [
      recordDigest,
    ]);
    return rows[0] === undefined ? null : documentFromDb(rows[0]);
  }

  listByRequest(requestId: string, kind: TermDocumentKind): TermDocumentRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_term_documents WHERE request_id = ? AND kind = ?
          ORDER BY created_at, record_digest`,
        [requestId, kind],
      )
      .map(documentFromDb);
  }

  listByProposal(proposalDigest: string, kind: TermDocumentKind): TermDocumentRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_term_documents WHERE proposal_digest = ? AND kind = ?
          ORDER BY created_at, record_digest`,
        [proposalDigest, kind],
      )
      .map(documentFromDb);
  }

  answersTo(recordDigest: string, kind: TermDocumentKind): TermDocumentRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_term_documents WHERE answers_digest = ? AND kind = ?
          ORDER BY created_at, record_digest`,
        [recordDigest, kind],
      )
      .map(documentFromDb);
  }

  listByKind(kind: TermDocumentKind, direction?: 'inbound' | 'outbound'): TermDocumentRow[] {
    return this.db
      .query(
        direction === undefined
          ? `SELECT * FROM commerce_term_documents WHERE kind = ? ORDER BY created_at, record_digest`
          : `SELECT * FROM commerce_term_documents WHERE kind = ? AND direction = ?
              ORDER BY created_at, record_digest`,
        direction === undefined ? [kind] : [kind, direction],
      )
      .map(documentFromDb);
  }

  /** The request a stored document belongs to, by its own digest. */
  requestOf(recordDigest: string): string | null {
    const row = this.getDocument(recordDigest);
    return row === null ? null : row.requestId;
  }

  // --- strategy turns (COMMITMENT_KERNEL §11) --------------------------------

  getTurn(requestId: string, turn: number): TermStrategyTurn | null {
    const row = this.db.query(
      `SELECT * FROM commerce_term_strategy_turns WHERE request_id = ? AND turn = ?`,
      [requestId, turn],
    )[0];
    return row === undefined ? null : turnFromDb(row);
  }

  /** Record a turn handed to the strategy; false when the turn was asked already. */
  putTurn(row: Omit<TermStrategyTurn, 'state'>): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO commerce_term_strategy_turns (request_id, turn, task_id, state, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
        [row.requestId, row.turn, row.taskId, row.createdAt],
      ) > 0
    );
  }

  /** Close a pending turn; false when it was already closed (a replayed commit). */
  closeTurn(requestId: string, turn: number, state: 'applied' | 'fallen_back'): boolean {
    return (
      this.db.run(
        `UPDATE commerce_term_strategy_turns SET state = ? WHERE request_id = ? AND turn = ? AND state = 'pending'`,
        [state, requestId, turn],
      ) > 0
    );
  }

  /**
   * Turns still pending that were asked before `beforeMs`. A turn waiting on
   * the owner's answer to the strategy's question is not stale: its card
   * decides when it ends (COMMITMENT_KERNEL §15 step 11).
   */
  staleTurns(beforeMs: number): TermStrategyTurn[] {
    return this.db
      .query(
        `SELECT * FROM commerce_term_strategy_turns t
          WHERE t.state = 'pending' AND t.created_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM commitment_strategy_questions q
               WHERE q.negotiation_id = t.request_id AND q.turn = t.turn AND q.answer IS NULL)`,
        [beforeMs],
      )
      .map(turnFromDb);
  }

  /**
   * The same turn asked of the strategy again, after the owner answered its
   * question: a new task, and the wait measured from now.
   */
  restartTurn(requestId: string, turn: number, taskId: string, nowMs: number): boolean {
    return (
      this.db.run(
        `UPDATE commerce_term_strategy_turns SET task_id = ?, created_at = ?
          WHERE request_id = ? AND turn = ? AND state = 'pending'`,
        [taskId, nowMs, requestId, turn],
      ) > 0
    );
  }

  // --- outbox (§5.3 delivery) -----------------------------------------------

  /** Record a send intent once; a second put for the same digest is a no-op. */
  putOutbox(
    row: Omit<TermOutboxRow, 'attempts' | 'receiptOutcome' | 'receiptAt' | 'gaveUpAt'>,
  ): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO commerce_term_outbox
           (record_digest, to_did, kind, document_json, created_at, next_attempt_at, stop_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          row.recordDigest,
          row.toDid,
          row.kind,
          row.documentJson,
          row.createdAt,
          row.nextAttemptAt,
          row.stopAt,
        ],
      ) > 0
    );
  }

  getOutbox(recordDigest: string): TermOutboxRow | null {
    const rows = this.db.query(`SELECT * FROM commerce_term_outbox WHERE record_digest = ?`, [
      recordDigest,
    ]);
    return rows[0] === undefined ? null : outboxFromDb(rows[0]);
  }

  /** Intents due for a send: no final receipt, not given up, due now. */
  dueOutbox(nowMs: number, limit: number): TermOutboxRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_term_outbox
          WHERE gave_up_at IS NULL
            AND (receipt_outcome IS NULL OR receipt_outcome = 'held')
            AND next_attempt_at <= ?
          ORDER BY next_attempt_at, record_digest LIMIT ?`,
        [nowMs, limit],
      )
      .map(outboxFromDb);
  }

  /**
   * A FIRST send that failed outright (no sender yet early in a boot, the relay
   * down): try again by `at`, sooner than the schedule said. Only the first —
   * a failure that repeats (a blocked peer, a relay that stays down) keeps the
   * normal resend schedule rather than a retry every minute. Never later,
   * never for a row with a final receipt or given up.
   */
  pullAttemptForward(recordDigest: string, at: number): void {
    this.db.run(
      `UPDATE commerce_term_outbox SET next_attempt_at = MIN(next_attempt_at, ?)
        WHERE record_digest = ? AND gave_up_at IS NULL AND attempts <= 1
          AND (receipt_outcome IS NULL OR receipt_outcome = 'held')`,
      [at, recordDigest],
    );
  }

  markAttempt(recordDigest: string, nextAttemptAt: number): void {
    this.db.run(
      `UPDATE commerce_term_outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE record_digest = ?`,
      [nextAttemptAt, recordDigest],
    );
  }

  /**
   * Record a receipt. A final outcome is never replaced (§5.3): a late `held`
   * after `stored` or `refused` changes nothing — the condition is in the
   * statement. Returns the row as stored.
   */
  recordReceipt(
    recordDigest: string,
    outcome: TermReceiptOutcome,
    nowMs: number,
    nextAttemptAt: number,
  ): TermOutboxRow | null {
    this.db.run(
      `UPDATE commerce_term_outbox SET receipt_outcome = ?, receipt_at = ?, next_attempt_at = ?
        WHERE record_digest = ? AND (receipt_outcome IS NULL OR receipt_outcome = 'held')`,
      [outcome, nowMs, nextAttemptAt, recordDigest],
    );
    return this.getOutbox(recordDigest);
  }

  giveUp(recordDigest: string, nowMs: number): void {
    this.db.run(
      `UPDATE commerce_term_outbox SET gave_up_at = ? WHERE record_digest = ? AND gave_up_at IS NULL`,
      [nowMs, recordDigest],
    );
  }

  /** Was this digest sent to this peer by this node? */
  sentTo(recordDigest: string, peerDid: string): boolean {
    const row = this.getOutbox(recordDigest);
    return row !== null && row.toDid === peerDid;
  }

  // --- answers this node gave (§5.3 receipts) --------------------------------

  getAnswer(ofDigest: string): TermAnswerRow | null {
    const rows = this.db.query(`SELECT * FROM commerce_term_answers WHERE of_digest = ?`, [
      ofDigest,
    ]);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      ofDigest: str(row.of_digest),
      senderDid: str(row.sender_did),
      kind: str(row.kind),
      outcome: str(row.outcome) as TermReceiptOutcome,
      updatedAt: num(row.updated_at),
    };
  }

  /**
   * Record this node's answer to an inbound document. A final answer is never
   * replaced; `held` may move to a final one. Returns whether it changed.
   */
  setAnswer(args: {
    ofDigest: string;
    senderDid: string;
    kind: string;
    outcome: TermReceiptOutcome;
    nowMs: number;
  }): boolean {
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO commerce_term_answers (of_digest, sender_did, kind, outcome, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [args.ofDigest, args.senderDid, args.kind, args.outcome, args.nowMs],
    );
    if (inserted > 0) return true;
    return (
      this.db.run(
        `UPDATE commerce_term_answers SET outcome = ?, updated_at = ?
          WHERE of_digest = ? AND outcome = 'held' AND ? != 'held'`,
        [args.outcome, args.nowMs, args.ofDigest, args.outcome],
      ) > 0
    );
  }

  // --- held documents (§5.3 order of arrival, §6.2 stranger card) ------------

  putHeld(row: TermHeldRow): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO commerce_term_held
           (record_digest, sender_did, kind, request_id, proposal_digest, reason, body_json,
            evidence_json, received_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.recordDigest,
          row.senderDid,
          row.kind,
          row.requestId,
          row.proposalDigest,
          row.reason,
          row.bodyJson,
          row.evidenceJson,
          row.receivedAt,
          row.expiresAt,
        ],
      ) > 0
    );
  }

  getHeld(recordDigest: string): TermHeldRow | null {
    const rows = this.db.query(`SELECT * FROM commerce_term_held WHERE record_digest = ?`, [
      recordDigest,
    ]);
    return rows[0] === undefined ? null : heldFromDb(rows[0]);
  }

  removeHeld(recordDigest: string): void {
    this.db.run(`DELETE FROM commerce_term_held WHERE record_digest = ?`, [recordDigest]);
  }

  listHeld(reason?: TermHeldReason): TermHeldRow[] {
    return this.db
      .query(
        reason === undefined
          ? `SELECT * FROM commerce_term_held ORDER BY received_at, record_digest`
          : `SELECT * FROM commerce_term_held WHERE reason = ? ORDER BY received_at, record_digest`,
        reason === undefined ? [] : [reason],
      )
      .map(heldFromDb);
  }

  /** Held rows a newly stored document might unblock. */
  heldRelatedTo(requestId: string, proposalDigest: string): TermHeldRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_term_held
          WHERE reason = 'prerequisite'
            AND ((request_id != '' AND request_id = ?) OR (proposal_digest != '' AND proposal_digest = ?))
          ORDER BY received_at, record_digest`,
        [requestId, proposalDigest],
      )
      .map(heldFromDb);
  }

  /** A stranger waiting on the owner's card (§6.2): their one request, if any. */
  pendingStrangerRequest(senderDid: string): TermHeldRow | null {
    const rows = this.db.query(
      `SELECT * FROM commerce_term_held WHERE sender_did = ? AND reason = 'owner_card'
        ORDER BY received_at LIMIT 1`,
      [senderDid],
    );
    return rows[0] === undefined ? null : heldFromDb(rows[0]);
  }

  // --- policy ---------------------------------------------------------------

  getPolicy(): { policyJson: string; revision: number; updatedAt: number } | null {
    const rows = this.db.query(`SELECT * FROM commerce_term_policy WHERE id = 1`);
    const row = rows[0];
    return row === undefined
      ? null
      : {
          policyJson: str(row.policy_json),
          revision: num(row.revision),
          updatedAt: num(row.updated_at),
        };
  }

  /** Replace the policy; the revision moves on by one, in one statement. */
  putPolicy(policyJson: string, nowMs: number): number {
    this.db.run(
      `INSERT INTO commerce_term_policy (id, policy_json, revision, updated_at) VALUES (1, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET policy_json = excluded.policy_json,
         revision = commerce_term_policy.revision + 1, updated_at = excluded.updated_at`,
      [policyJson, nowMs],
    );
    return this.getPolicy()?.revision ?? 1;
  }

  // --- listings ---------------------------------------------------------------

  putListing(row: TermListingRow): void {
    this.db.run(
      `INSERT INTO commerce_term_listings (listing_id, resource_ref, record_json, listing_digest, state, record_public, access, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(listing_id) DO UPDATE SET resource_ref = excluded.resource_ref,
         record_json = excluded.record_json, listing_digest = excluded.listing_digest,
         state = excluded.state, record_public = excluded.record_public, access = excluded.access,
         updated_at = excluded.updated_at`,
      [
        row.listingId,
        row.resourceRef,
        row.recordJson,
        row.listingDigest,
        row.state,
        row.recordPublic ? 1 : 0,
        row.access,
        row.updatedAt,
      ],
    );
  }

  /**
   * The directory confirmed the public record of THIS withdrawn listing is
   * gone. Conditional on the state and digest the removal was for: a listing
   * republished while the removal was in flight keeps its flag.
   */
  markListingRecordRemoved(listingId: string, listingDigest: string, nowMs: number): void {
    this.db.run(
      `UPDATE commerce_term_listings SET record_public = 0, updated_at = ?
        WHERE listing_id = ? AND listing_digest = ? AND state = 'withdrawn'`,
      [nowMs, listingId, listingDigest],
    );
  }

  getListing(listingId: string): TermListingRow | null {
    const rows = this.db.query(`SELECT * FROM commerce_term_listings WHERE listing_id = ?`, [
      listingId,
    ]);
    const row = rows[0];
    return row === undefined
      ? null
      : {
          listingId: str(row.listing_id),
          resourceRef: str(row.resource_ref),
          recordJson: str(row.record_json),
          listingDigest: str(row.listing_digest),
          state: str(row.state) as 'published' | 'withdrawn',
          recordPublic: num(row.record_public) === 1,
          access: str(row.access) === 'anyone' ? 'anyone' : 'contacts_or_card',
          updatedAt: num(row.updated_at),
        };
  }

  listListings(): TermListingRow[] {
    return this.db
      .query(`SELECT listing_id FROM commerce_term_listings ORDER BY listing_id`)
      .map((row) => this.getListing(str(row.listing_id)))
      .filter((row): row is TermListingRow => row !== null);
  }

  // --- the buyer's negotiations ----------------------------------------------

  putNegotiation(row: TermNegotiationRow): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO commerce_term_negotiations
           (request_id, seller_did, listing_json, policy_json, state, close_reason, deadline_at,
            next_action_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.requestId,
          row.sellerDid,
          row.listingJson,
          row.policyJson,
          row.state,
          row.closeReason,
          row.deadlineAt,
          row.nextActionAt,
          row.createdAt,
          row.updatedAt,
        ],
      ) > 0
    );
  }

  getNegotiation(requestId: string): TermNegotiationRow | null {
    const rows = this.db.query(`SELECT * FROM commerce_term_negotiations WHERE request_id = ?`, [
      requestId,
    ]);
    return rows[0] === undefined ? null : negotiationFromDb(rows[0]);
  }

  listNegotiations(): TermNegotiationRow[] {
    return this.db
      .query(`SELECT * FROM commerce_term_negotiations ORDER BY created_at, request_id`)
      .map(negotiationFromDb);
  }

  dueNegotiations(nowMs: number): TermNegotiationRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_term_negotiations
          WHERE state = 'negotiating' AND next_action_at <= ? ORDER BY next_action_at, request_id`,
        [nowMs],
      )
      .map(negotiationFromDb);
  }

  /** Move a negotiation from one state to another; false when it was not in `from`. */
  moveNegotiation(args: {
    requestId: string;
    from: readonly TermNegotiationState[];
    to: TermNegotiationState;
    nowMs: number;
    nextActionAt?: number;
    closeReason?: string;
  }): boolean {
    const placeholders = args.from.map(() => '?').join(', ');
    const changes = this.db.run(
      `UPDATE commerce_term_negotiations
          SET state = ?, updated_at = ?, next_action_at = COALESCE(?, next_action_at),
              close_reason = COALESCE(?, close_reason)
        WHERE request_id = ? AND state IN (${placeholders})`,
      [
        args.to,
        args.nowMs,
        args.nextActionAt ?? null,
        args.closeReason ?? null,
        args.requestId,
        ...args.from,
      ],
    );
    return changes > 0;
  }

  setNextAction(requestId: string, nextActionAt: number, nowMs: number): void {
    this.db.run(
      `UPDATE commerce_term_negotiations SET next_action_at = ?, updated_at = ? WHERE request_id = ?`,
      [nextActionAt, nowMs, requestId],
    );
  }

  // --- owner cards --------------------------------------------------------------

  putCard(row: Omit<TermCardRow, 'decidedAt' | 'yesOutcome'>): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO commerce_term_cards
           (card_id, card_type, request_id, ref_digest, state, material_json, description, payload_json,
            decide_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.cardId,
          row.cardType,
          row.requestId,
          row.refDigest,
          row.state,
          row.materialJson,
          row.description,
          row.payloadJson,
          row.decideBy,
          row.createdAt,
        ],
      ) > 0
    );
  }

  getCard(cardId: string): TermCardRow | null {
    const rows = this.db.query(`SELECT * FROM commerce_term_cards WHERE card_id = ?`, [cardId]);
    return rows[0] === undefined ? null : cardFromDb(rows[0]);
  }

  cardsForRequest(requestId: string, cardType?: string): TermCardRow[] {
    return this.db
      .query(
        cardType === undefined
          ? `SELECT * FROM commerce_term_cards WHERE request_id = ? ORDER BY created_at, card_id`
          : `SELECT * FROM commerce_term_cards WHERE request_id = ? AND card_type = ? ORDER BY created_at, card_id`,
        cardType === undefined ? [requestId] : [requestId, cardType],
      )
      .map(cardFromDb);
  }

  /** Close a pending card; false when it was not pending (one decision only). */
  decideCard(cardId: string, state: Exclude<TermCardState, 'pending'>, nowMs: number): boolean {
    return (
      this.db.run(
        `UPDATE commerce_term_cards SET state = ?, decided_at = ? WHERE card_id = ? AND state = 'pending'`,
        [state, nowMs, cardId],
      ) > 0
    );
  }

  /** Record what came of the owner's yes on a card (`TermEngine.decideCard`). */
  setCardYesOutcome(cardId: string, outcome: string): void {
    this.db.run(`UPDATE commerce_term_cards SET yes_outcome = ? WHERE card_id = ?`, [
      outcome,
      cardId,
    ]);
  }

  /** Cards with a recorded yes decided since `sinceMs`: their inbox task may still be open. */
  cardsWithYesSince(sinceMs: number): TermCardRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_term_cards WHERE yes_outcome != '' AND decided_at >= ? ORDER BY decided_at`,
        [sinceMs],
      )
      .map(cardFromDb);
  }

  pendingCards(): TermCardRow[] {
    return this.db
      .query(`SELECT * FROM commerce_term_cards WHERE state = 'pending' ORDER BY created_at`)
      .map(cardFromDb);
  }

  lapsedCards(nowMs: number): TermCardRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_term_cards WHERE state = 'pending' AND decide_by <= ? ORDER BY decide_by`,
        [nowMs],
      )
      .map(cardFromDb);
  }

  // --- owner authorisations between the floors ----------------------------------

  putFloorAuthorization(row: TermFloorAuthorizationRow): void {
    this.db.run(
      `INSERT INTO commerce_term_floor_authorizations (request_id, term_name, value, card_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(request_id, term_name) DO UPDATE SET value = excluded.value,
         card_id = excluded.card_id, created_at = excluded.created_at`,
      [row.requestId, row.termName, row.value, row.cardId, row.createdAt],
    );
  }

  floorAuthorizations(requestId: string): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const row of this.db.query(
      `SELECT term_name, value FROM commerce_term_floor_authorizations WHERE request_id = ?`,
      [requestId],
    )) {
      out.set(str(row.term_name), BigInt(str(row.value)));
    }
    return out;
  }
}
