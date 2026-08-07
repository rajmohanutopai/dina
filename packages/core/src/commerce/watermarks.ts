/**
 * Counterparty epoch watermarks (spec §16.2): the highest
 * supplierEpoch seen per supplier DID. A newly signed quote or status
 * BELOW the watermark is a delayed write from a superseded
 * pre-restore node (or rollback) and is rejected as supplier fault; a
 * higher epoch raises the watermark.
 *
 * Watermarks only ever go up — `raiseTo` compares canonical integer
 * strings via BigInt inside a transaction (SQL text collation would
 * mis-order mixed-length integers).
 */

import type { DatabaseAdapter } from '../storage/db_adapter';

export interface CommerceEpochWatermarkRepository {
  /** Current watermark, or "0" when the supplier has never been seen. */
  get(supplierDid: string): string;
  /** Raise to `epoch` when higher; returns the effective watermark. */
  raiseTo(supplierDid: string, epoch: string, updatedAt: number): string;
}

export class SQLiteCommerceEpochWatermarkRepository implements CommerceEpochWatermarkRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  get(supplierDid: string): string {
    const rows = this.db.query<{ epoch: string }>(
      `SELECT epoch FROM commerce_epoch_watermarks WHERE supplier_did = ?`,
      [supplierDid],
    );
    return rows[0] ? String(rows[0].epoch) : '0';
  }

  raiseTo(supplierDid: string, epoch: string, updatedAt: number): string {
    let effective = epoch;
    this.db.transaction(() => {
      const current = this.get(supplierDid);
      if (BigInt(epoch) > BigInt(current)) {
        this.db.run(
          `INSERT INTO commerce_epoch_watermarks (supplier_did, epoch, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(supplier_did) DO UPDATE SET epoch = excluded.epoch, updated_at = excluded.updated_at`,
          [supplierDid, epoch, updatedAt],
        );
        effective = epoch;
      } else {
        effective = current;
      }
    });
    return effective;
  }
}

export class InMemoryCommerceEpochWatermarkRepository implements CommerceEpochWatermarkRepository {
  private readonly marks = new Map<string, string>();

  get(supplierDid: string): string {
    return this.marks.get(supplierDid) ?? '0';
  }

  raiseTo(supplierDid: string, epoch: string): string {
    const current = this.get(supplierDid);
    if (BigInt(epoch) > BigInt(current)) {
      this.marks.set(supplierDid, epoch);
      return epoch;
    }
    return current;
  }
}

let repository: CommerceEpochWatermarkRepository | null = null;

export function setCommerceEpochWatermarkRepository(
  repo: CommerceEpochWatermarkRepository | null,
): void {
  repository = repo;
}

export function getCommerceEpochWatermarkRepository(): CommerceEpochWatermarkRepository | null {
  return repository;
}
