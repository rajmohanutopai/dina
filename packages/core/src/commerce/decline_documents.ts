/**
 * The quote-decline ledger — the money-FREE slice carved out of the trade-
 * document ledger (RESEARCHER_KERNEL_ARCHITECTURE.md §5.B1, Cut 1).
 *
 * A tender decline ("no, I won't quote this") carries no money: it is a
 * coordinate-and-close record, not a khata document. So it stays in the kernel
 * when the money engine (delivery / payment / ledger) moves to the Commerce
 * Pack. This module owns the decline row contract, a decline-scoped store, the
 * row-level rehydrate (with the stored-digest cross-check), and the inbound
 * verifier — everything the kernel's tender / buyer-response decline path needs,
 * with NO dependency on the money documents.
 *
 * STORAGE (§5.B1 Cut 2): declines have their OWN table,
 * `commerce_decline_documents` (migration v42), carved out of the shared
 * `commerce_trade_documents` so the money rows (delivery / payment) can move to
 * the Commerce Pack without dragging the kernel's declines with them.
 *
 * The inbound verifier mirrors the trade verifiers: the TRANSPORT-authenticated
 * sender is the authority, every party field inside the counterparty's body is
 * checked against it, and the one-answer rule (a request has at most one
 * decline; the first verified answer is final) is enforced here because only a
 * store can see the other answers.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  readQuoteDecline,
  tradeRecordDigest,
  validateQuoteDecline,
  verifyQuoteDeclineAgainstRequest,
  type QuoteDecline,
  type QuoteRequest,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { rehydrateQuoteDecline } from './rehydrate';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

const hash: Sha256Fn = (data) => sha256(data);

/**
 * A stored decline. A decline is always `kind = 'quote_decline'` and has no
 * purchase order, so the store fills those; `direction` distinguishes a decline
 * this node RECEIVED (`inbound`, at the buyer) from one it AUTHORED (`outbound`,
 * at the supplier).
 */
export interface DeclineDocumentRow {
  recordDigest: string;
  /** The other party — the relationship key (the supplier who declined). */
  counterpartyDid: string;
  /** The digest of the request this decline answers. */
  requestDigest: string;
  direction: 'inbound' | 'outbound';
  recordJson: string;
  evidenceJson: string;
  createdAt: number;
}

export interface DeclineDocumentRepository {
  /** First-writer-wins on record digest. False when already stored. */
  put(row: DeclineDocumentRow): boolean;
  get(recordDigest: string): DeclineDocumentRow | null;
  /** The declines answering a request — the one-answer rule reads this. */
  answersTo(requestDigest: string): DeclineDocumentRow[];
}

/** A stored row that no longer describes itself. Not an ordinary refusal. */
export class DeclineLedgerIntegrityError extends Error {}

/**
 * Re-derive a stored decline through its validator, plus the cross-check only
 * the store can make: the record's own `decline_digest` must be the digest the
 * row is keyed by. A row edited after writing throws rather than reading as a
 * different decline.
 */
export function rehydrateDeclineDocument(row: DeclineDocumentRow): QuoteDecline {
  const read = rehydrateQuoteDecline(row.recordJson, hash);
  if (!read.ok) {
    throw new DeclineLedgerIntegrityError(
      `stored quote_decline ${row.recordDigest}: ${read.error}`,
    );
  }
  if (read.value.decline_digest !== row.recordDigest) {
    throw new DeclineLedgerIntegrityError(
      `stored quote_decline ${row.recordDigest}: digest mismatch with row`,
    );
  }
  return read.value;
}

function declineRowFromDb(row: DBRow): DeclineDocumentRow {
  return {
    recordDigest: String(row.record_digest),
    counterpartyDid: String(row.counterparty_did),
    requestDigest: String(row.answers_digest),
    direction: String(row.direction) === 'outbound' ? 'outbound' : 'inbound',
    recordJson: String(row.record_json),
    evidenceJson: String(row.evidence_json),
    createdAt: Number(row.created_at),
  };
}

/** SQLite store over the kernel's own `commerce_decline_documents` table. */
export class SQLiteDeclineDocumentRepository implements DeclineDocumentRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(row: DeclineDocumentRow): boolean {
    return (
      this.db.run(
        `INSERT INTO commerce_decline_documents
           (record_digest, counterparty_did, answers_digest, direction,
            record_json, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(record_digest) DO NOTHING`,
        [
          row.recordDigest,
          row.counterpartyDid,
          row.requestDigest,
          row.direction,
          row.recordJson,
          row.evidenceJson,
          row.createdAt,
        ],
      ) > 0
    );
  }

  get(recordDigest: string): DeclineDocumentRow | null {
    const rows = this.db.query(
      `SELECT * FROM commerce_decline_documents WHERE record_digest = ?`,
      [recordDigest],
    );
    return rows[0] === undefined ? null : declineRowFromDb(rows[0]);
  }

  answersTo(requestDigest: string): DeclineDocumentRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_decline_documents
          WHERE answers_digest = ?
          ORDER BY created_at, record_digest`,
        [requestDigest],
      )
      .map(declineRowFromDb);
  }
}

/** Test double. A production caller would be the bug. */
export class InMemoryDeclineDocumentRepository implements DeclineDocumentRepository {
  private readonly rows = new Map<string, DeclineDocumentRow>();

  put(row: DeclineDocumentRow): boolean {
    if (this.rows.has(row.recordDigest)) return false;
    this.rows.set(row.recordDigest, { ...row });
    return true;
  }

  get(recordDigest: string): DeclineDocumentRow | null {
    const row = this.rows.get(recordDigest);
    return row === undefined ? null : { ...row };
  }

  answersTo(requestDigest: string): DeclineDocumentRow[] {
    return [...this.rows.values()]
      .filter((r) => r.requestDigest === requestDigest)
      .sort((a, b) => a.createdAt - b.createdAt || a.recordDigest.localeCompare(b.recordDigest))
      .map((row) => ({ ...row }));
  }
}

// ---------------------------------------------------------------------------
// Inbound verification (moved from trade_ledger — the money-free decline path)
// ---------------------------------------------------------------------------

/** What happened to an inbound decline. Same vocabulary as `TradeIngest`, so
 *  the buyer-response lane maps every outcome the same way it always did. */
export type DeclineIngestOutcome =
  | 'applied'
  | 'duplicate'
  | 'unreadable'
  | 'not_ours'
  | 'refused'
  | 'conflict';

export interface DeclineIngest {
  outcome: DeclineIngestOutcome;
  detail?: string;
  recordDigest?: string;
}

/** Injected: the retained request a decline claims to answer. */
export type RetainedRequestReader = (requestId: string) => QuoteRequest | null;

export function verifyInboundQuoteDecline(args: {
  senderDid: string;
  selfDid: string;
  decline: unknown;
  repository: DeclineDocumentRepository;
  readRequest: RetainedRequestReader;
  evidenceJson: string;
  nowMs: number;
}): DeclineIngest {
  const read = readQuoteDecline(args.decline, hash);
  if (!read.ok) return { outcome: 'unreadable', detail: read.error };
  const decline = read.decline;

  const request = args.readRequest(decline.request_id);
  if (request === null) {
    return { outcome: 'refused', detail: `decline: no retained request ${decline.request_id}` };
  }
  if (request.supplier_did !== args.senderDid) {
    return { outcome: 'not_ours', detail: 'decline: sender is not the request supplier' };
  }
  if (request.buyer_did !== args.selfDid) {
    return { outcome: 'not_ours', detail: 'decline: this node is not the request buyer' };
  }
  const bindError = verifyQuoteDeclineAgainstRequest(decline, request);
  if (bindError) return { outcome: 'refused', detail: bindError };

  const digest = tradeRecordDigest('quote_decline', decline, hash);
  const existing = args.repository.answersTo(decline.request_digest);
  if (existing.length > 0) {
    return existing.some((row) => row.recordDigest === digest)
      ? { outcome: 'duplicate', recordDigest: digest }
      : {
          outcome: 'conflict',
          detail: 'decline: the request already has a different decline — the first answer stands',
          recordDigest: existing[0]?.recordDigest ?? '',
        };
  }

  const stored = args.repository.put({
    recordDigest: digest,
    counterpartyDid: args.senderDid,
    requestDigest: decline.request_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(decline),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  return stored
    ? { outcome: 'applied', recordDigest: digest }
    : { outcome: 'duplicate', recordDigest: digest };
}

// ---------------------------------------------------------------------------
// Authoring (moved from trade_ledger_service — the supplier's decline side)
// ---------------------------------------------------------------------------

/** A supplier authoring a decline. Money-free, so it lives here, not in the
 *  khata service. Parallel to the trade service's `TradeAuthorOutcome`. */
export type DeclineAuthorOutcome =
  | { ok: true; document: QuoteDecline }
  | { ok: false; refusal: string };

/**
 * The SUPPLIER side of §3.4: author a signed decline answering a retained
 * request. Only the addressed supplier may author it, a request gets at most one
 * decline, and the record is shape- and bind-checked before it is stored
 * OUTBOUND. Mirrors `verifyInboundQuoteDecline`, the buyer side.
 */
export function authorQuoteDecline(args: {
  request: QuoteRequest;
  reasonCode: string;
  nodeDid: string;
  nowMs: number;
  repository: DeclineDocumentRepository;
}): DeclineAuthorOutcome {
  if (args.request.supplier_did !== args.nodeDid) {
    return { ok: false, refusal: 'this node is not the request supplier' };
  }
  if (args.repository.answersTo(args.request.request_digest).length > 0) {
    return { ok: false, refusal: 'the request already has a decline' };
  }
  const draft = {
    protocol_version: args.request.protocol_version,
    decline_id: `dec-${bytesToHex(randomBytes(6))}`,
    request_id: args.request.request_id,
    request_digest: args.request.request_digest,
    buyer_did: args.request.buyer_did,
    supplier_did: args.request.supplier_did,
    reason_code: args.reasonCode,
    issued_at: new Date(args.nowMs).toISOString(),
  };
  const decline = {
    ...draft,
    decline_digest: tradeRecordDigest('quote_decline', draft, hash),
  } as QuoteDecline;
  const shapeError = validateQuoteDecline(decline, hash);
  if (shapeError) return { ok: false, refusal: shapeError };
  const bindError = verifyQuoteDeclineAgainstRequest(decline, args.request);
  if (bindError) return { ok: false, refusal: bindError };

  args.repository.put({
    recordDigest: decline.decline_digest,
    counterpartyDid: args.request.buyer_did,
    requestDigest: args.request.request_digest,
    direction: 'outbound',
    recordJson: JSON.stringify(decline),
    evidenceJson: '{}',
    createdAt: args.nowMs,
  });
  return { ok: true, document: decline };
}
