/**
 * Core-owned commerce receipt store (spec §16.2) — the durable
 * commercial memory. Workflow rows remain the execution engine and
 * are excluded from `.dina` archives; THESE rows are the canonical
 * quote chain, order, acknowledgement, status chain, cancellation,
 * reconciliation, and restore-fence records with their verification
 * evidence, retained across plugin pause, revoke, and uninstall, and
 * included in export/import.
 *
 * Idempotent on record digest: first writer wins, replays are no-ops.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type CommerceReceiptDomain =
  | 'projection'
  | 'request'
  | 'quote'
  | 'terms'
  | 'order'
  | 'acknowledgement'
  | 'status'
  | 'cancellation'
  | 'result'
  | 'epoch'
  | 'restore_fence_event';

export interface CommerceReceipt {
  recordDigest: string;
  domain: CommerceReceiptDomain;
  buyerDid: string;
  quoteId: string;
  purchaseOrderId: string;
  recordJson: string;
  evidenceJson: string;
  createdAt: number;
}

const VALID_DOMAINS: ReadonlySet<string> = new Set([
  'projection',
  'request',
  'quote',
  'terms',
  'order',
  'acknowledgement',
  'status',
  'cancellation',
  'result',
  'epoch',
  'restore_fence_event',
]);

export interface CommerceReceiptRepository {
  /** First-writer-wins on record digest. False when already stored. */
  put(receipt: CommerceReceipt): boolean;
  get(recordDigest: string): CommerceReceipt | null;
  listByOrder(buyerDid: string, purchaseOrderId: string): CommerceReceipt[];
  listByQuote(quoteId: string): CommerceReceipt[];
}

function rowToReceipt(row: DBRow): CommerceReceipt {
  return {
    recordDigest: String(row.record_digest),
    domain: String(row.domain) as CommerceReceiptDomain,
    buyerDid: String(row.buyer_did),
    quoteId: String(row.quote_id),
    purchaseOrderId: String(row.purchase_order_id),
    recordJson: String(row.record_json),
    evidenceJson: String(row.evidence_json),
    createdAt: Number(row.created_at),
  };
}

export class SQLiteCommerceReceiptRepository implements CommerceReceiptRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(receipt: CommerceReceipt): boolean {
    if (!VALID_DOMAINS.has(receipt.domain)) {
      throw new Error(`commerce receipt: unknown domain "${receipt.domain}"`);
    }
    const affected = this.db.run(
      `INSERT INTO commerce_receipts (
         record_digest, domain, buyer_did, quote_id, purchase_order_id,
         record_json, evidence_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(record_digest) DO NOTHING`,
      [
        receipt.recordDigest,
        receipt.domain,
        receipt.buyerDid,
        receipt.quoteId,
        receipt.purchaseOrderId,
        receipt.recordJson,
        receipt.evidenceJson,
        receipt.createdAt,
      ],
    );
    return affected > 0;
  }

  get(recordDigest: string): CommerceReceipt | null {
    const rows = this.db.query(`SELECT * FROM commerce_receipts WHERE record_digest = ?`, [
      recordDigest,
    ]);
    return rows[0] ? rowToReceipt(rows[0]) : null;
  }

  listByOrder(buyerDid: string, purchaseOrderId: string): CommerceReceipt[] {
    return this.db
      .query(
        `SELECT * FROM commerce_receipts
         WHERE buyer_did = ? AND purchase_order_id = ?
         ORDER BY created_at, record_digest`,
        [buyerDid, purchaseOrderId],
      )
      .map(rowToReceipt);
  }

  listByQuote(quoteId: string): CommerceReceipt[] {
    return this.db
      .query(
        `SELECT * FROM commerce_receipts WHERE quote_id = ? ORDER BY created_at, record_digest`,
        [quoteId],
      )
      .map(rowToReceipt);
  }
}

export class InMemoryCommerceReceiptRepository implements CommerceReceiptRepository {
  private readonly byDigest = new Map<string, CommerceReceipt>();

  put(receipt: CommerceReceipt): boolean {
    if (!VALID_DOMAINS.has(receipt.domain)) {
      throw new Error(`commerce receipt: unknown domain "${receipt.domain}"`);
    }
    if (this.byDigest.has(receipt.recordDigest)) return false;
    this.byDigest.set(receipt.recordDigest, { ...receipt });
    return true;
  }

  get(recordDigest: string): CommerceReceipt | null {
    const receipt = this.byDigest.get(recordDigest);
    return receipt ? { ...receipt } : null;
  }

  listByOrder(buyerDid: string, purchaseOrderId: string): CommerceReceipt[] {
    return [...this.byDigest.values()]
      .filter((r) => r.buyerDid === buyerDid && r.purchaseOrderId === purchaseOrderId)
      .sort((a, b) => a.createdAt - b.createdAt || a.recordDigest.localeCompare(b.recordDigest));
  }

  listByQuote(quoteId: string): CommerceReceipt[] {
    return [...this.byDigest.values()]
      .filter((r) => r.quoteId === quoteId)
      .sort((a, b) => a.createdAt - b.createdAt || a.recordDigest.localeCompare(b.recordDigest));
  }
}

let repository: CommerceReceiptRepository | null = null;

export function setCommerceReceiptRepository(repo: CommerceReceiptRepository | null): void {
  repository = repo;
}

export function getCommerceReceiptRepository(): CommerceReceiptRepository | null {
  return repository;
}
