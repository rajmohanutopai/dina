/**
 * The vouch-attribution boundary (TRADE_FIRST_STRATEGY §6.4).
 *
 * WHY A BOUNDARY AT ALL. A v1 vouch receipt, content receipt or approval
 * carries nothing proving its age: on a node with staff, an attacker
 * could mint an UNATTRIBUTED record tomorrow and present it as
 * pre-staff history — the downgrade §6.4 exists to close. So the
 * migration boundary is a DURABLE fact with an immutable index:
 * creating the node's FIRST staff grant writes, in one transaction, the
 * digests of every v1 record then in the store. From that transaction
 * on, minting and ingest are v2-exclusive; a v1 digest outside the
 * index is refused; grandfathered digests stay readable for ever.
 *
 * The index is append-once: `cross` writes it exactly once and refuses
 * a second crossing, and nothing here updates or deletes a row.
 */

import type { CatalogDraftRepository } from './catalog_draft_store';
import type { OrderApprovalRepository } from './order_approvals';
import type { OrderDraftRepository } from './order_draft_store';
import type { DatabaseAdapter } from '../storage/db_adapter';

export type GrandfatheredKind = 'vouch_receipt' | 'content_receipt' | 'approval';

export interface GrandfatheredRecord {
  digest: string;
  kind: GrandfatheredKind;
}

export interface AttributionBoundaryRepository {
  /** When the boundary was crossed, or null on a pre-staff node. */
  crossedAt(): number | null;
  /**
   * Cross the boundary, writing the immutable index. False when already
   * crossed — the first crossing stands and a second must not rewrite
   * history. Runs inside the caller's transaction: the boundary and the
   * first staff grant commit together or not at all.
   */
  cross(nowMs: number, records: readonly GrandfatheredRecord[]): boolean;
  isGrandfathered(digest: string): boolean;
}

export class SQLiteAttributionBoundaryRepository implements AttributionBoundaryRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  crossedAt(): number | null {
    const rows = this.db.query<{ crossed_at: number }>(
      `SELECT crossed_at FROM commerce_attribution_boundary WHERE id = 1`,
    );
    return rows[0] === undefined ? null : Number(rows[0].crossed_at);
  }

  cross(nowMs: number, records: readonly GrandfatheredRecord[]): boolean {
    if (this.crossedAt() !== null) return false;
    this.db.run(`INSERT INTO commerce_attribution_boundary (id, crossed_at) VALUES (1, ?)`, [
      nowMs,
    ]);
    for (const record of records) {
      // OR IGNORE: one digest may be reachable through two entries (a
      // ceremony's receipt is shared by every line it vouched) — one
      // index row per digest is the fact that matters.
      this.db.run(
        `INSERT OR IGNORE INTO commerce_attribution_grandfather
           (record_digest, kind, created_at) VALUES (?, ?, ?)`,
        [record.digest, record.kind, nowMs],
      );
    }
    return true;
  }

  isGrandfathered(digest: string): boolean {
    if (digest === '') return false;
    const rows = this.db.query<{ record_digest: string }>(
      `SELECT record_digest FROM commerce_attribution_grandfather WHERE record_digest = ?`,
      [digest],
    );
    return rows[0] !== undefined;
  }
}

/** Test double. A production caller would be the bug. */
export class InMemoryAttributionBoundaryRepository implements AttributionBoundaryRepository {
  private crossed: number | null = null;
  private readonly digests = new Set<string>();

  crossedAt(): number | null {
    return this.crossed;
  }

  cross(nowMs: number, records: readonly GrandfatheredRecord[]): boolean {
    if (this.crossed !== null) return false;
    this.crossed = nowMs;
    for (const record of records) this.digests.add(record.digest);
    return true;
  }

  isGrandfathered(digest: string): boolean {
    return digest !== '' && this.digests.has(digest);
  }
}

/**
 * Enumerate every v1 record the boundary must grandfather — the walk the
 * first-grant transaction takes. No version filtering is needed: v2
 * minting begins only AFTER the crossing, so at crossing time every
 * receipt and approval in the store is v1 by construction. (Even were a
 * v2 digest swept in, it could not double as a v1 admission — the two
 * families commit under different domain strings, so no v1 bytes can
 * reproduce a v2 digest.)
 */
export function enumerateV1Records(stores: {
  catalogDrafts: CatalogDraftRepository;
  orderDrafts: OrderDraftRepository;
  orderApprovals: OrderApprovalRepository;
}): GrandfatheredRecord[] {
  const records: GrandfatheredRecord[] = [];
  const seen = new Set<string>();
  const add = (digest: string, kind: GrandfatheredKind): void => {
    if (digest === '' || seen.has(digest)) return;
    seen.add(digest);
    records.push({ digest, kind });
  };

  for (const digest of stores.catalogDrafts.listReceiptDigests()) {
    add(digest, 'content_receipt');
  }
  for (const draft of stores.orderDrafts.list()) {
    for (const line of draft.lines) {
      if (line.vouch !== null) add(line.vouch.receiptDigest, 'vouch_receipt');
    }
    for (const requirement of draft.requirements) {
      if (requirement.vouch !== null) add(requirement.vouch.receiptDigest, 'vouch_receipt');
    }
  }
  for (const digest of stores.orderApprovals.listApprovalDigests()) {
    add(digest, 'approval');
  }
  return records;
}

/**
 * §6.4's read rule in one place: may a record with NO attribution be
 * believed? Yes before the boundary (v1 is simply the current shape),
 * and after it only when its digest is in the immutable index.
 */
export function v1RecordAdmissible(
  boundary: AttributionBoundaryRepository,
  digest: string,
): boolean {
  if (boundary.crossedAt() === null) return true;
  return boundary.isGrandfathered(digest);
}
