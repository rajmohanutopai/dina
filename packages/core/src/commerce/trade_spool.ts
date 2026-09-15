/**
 * The khata SPOOL (RESEARCHER_KERNEL §5.B1 Cut 3) — mail held for a closed
 * money line. A `commerce.trade` document that arrives while no Commerce Pack
 * is active may not touch the ledger, but it must not be lost either: the
 * relay already accepted it, the sender's outbox will not retry, and for an
 * ANSWER (a receipt, an ack, a settlement decision) nothing on either side
 * would ever re-send it. So the ingress parks the document here exactly as it
 * arrived — the transport-authenticated sender, the body, the sealed envelope
 * evidence — and replays it through the SAME verifiers once the pack is active.
 *
 * Mail, not ledger: nothing here is believed. Insertion-ordered so replay
 * preserves arrival order; bounded so a closed node cannot be filled without
 * limit (senders are known contacts — the D2D contact gate runs first — but a
 * bound is still a bound); a row is deleted on replay whatever the verdict.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

/** Rows held at most. Past this the newest document is refused, the oldest kept. */
export const MAX_TRADE_SPOOL_ROWS = 1000;

export interface TradeSpoolRow {
  spoolId: number;
  senderDid: string;
  bodyJson: string;
  evidenceJson: string;
  receivedAt: number;
}

export interface TradeSpoolRepository {
  /** Park a document. False when the spool is full (the document is refused). */
  put(row: Omit<TradeSpoolRow, 'spoolId'>): boolean;
  /** Oldest first, up to `limit`. */
  oldest(limit: number): TradeSpoolRow[];
  remove(spoolId: number): void;
  count(): number;
}

export class SQLiteTradeSpoolRepository implements TradeSpoolRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(row: Omit<TradeSpoolRow, 'spoolId'>): boolean {
    if (this.count() >= MAX_TRADE_SPOOL_ROWS) return false;
    this.db.run(
      `INSERT INTO commerce_trade_spool (sender_did, body_json, evidence_json, received_at)
       VALUES (?, ?, ?, ?)`,
      [row.senderDid, row.bodyJson, row.evidenceJson, row.receivedAt],
    );
    return true;
  }

  oldest(limit: number): TradeSpoolRow[] {
    return this.db
      .query(`SELECT * FROM commerce_trade_spool ORDER BY spool_id ASC LIMIT ?`, [limit])
      .map(rowFromDb);
  }

  remove(spoolId: number): void {
    this.db.run(`DELETE FROM commerce_trade_spool WHERE spool_id = ?`, [spoolId]);
  }

  count(): number {
    const rows = this.db.query(`SELECT COUNT(*) AS n FROM commerce_trade_spool`);
    return Number(rows[0]?.n ?? 0);
  }
}

function rowFromDb(row: DBRow): TradeSpoolRow {
  return {
    spoolId: Number(row.spool_id),
    senderDid: String(row.sender_did),
    bodyJson: String(row.body_json),
    evidenceJson: String(row.evidence_json),
    receivedAt: Number(row.received_at),
  };
}

export class InMemoryTradeSpoolRepository implements TradeSpoolRepository {
  private readonly rows: TradeSpoolRow[] = [];
  private nextId = 1;

  put(row: Omit<TradeSpoolRow, 'spoolId'>): boolean {
    if (this.rows.length >= MAX_TRADE_SPOOL_ROWS) return false;
    this.rows.push({ ...row, spoolId: this.nextId++ });
    return true;
  }

  oldest(limit: number): TradeSpoolRow[] {
    return this.rows.slice(0, limit).map((row) => ({ ...row }));
  }

  remove(spoolId: number): void {
    const index = this.rows.findIndex((row) => row.spoolId === spoolId);
    if (index >= 0) this.rows.splice(index, 1);
  }

  count(): number {
    return this.rows.length;
  }
}
