/**
 * The SKU reservation ledger (PHOTO_COMMERCE_LANES_DESIGN §4.2).
 *
 * CORE'S HALF of the mint decision, and only that half: the durable atomic
 * reservation primitive. The POLICY — which rows mint, what shape, when —
 * lives with the pack's importer/assembler in `sku_mint.ts`, honouring the
 * lane doc's §9 ownership rule that no product policy enters the kernel.
 *
 * WHY A CLAIM AND NOT A CHECK. A read-only check is a time-of-check gap: a
 * printed `P-0001` on a photographed page, or two concurrent edits
 * introducing one value, both pass a check before either assignment
 * persists — and the ledger then holds a collision it existed to prevent.
 * So EVERY identifier entering a clean draft claims atomically, keyed to
 * the product's immutable `assignment_id`:
 *
 *   - unclaimed value            -> claim won, row inserted
 *   - held by the SAME assignment -> idempotent success (an SKU edit and a
 *     republication are both re-claims by the owner)
 *   - held by ANOTHER assignment -> refusal naming the owning catalog,
 *     routed through repair like any other finding
 *
 * WHY THE HIGH-WATER MARK NEVER REWINDS. Releasing an abandoned draft's
 * claims frees the VALUES for that seller's reuse of the ledger — but the
 * mint counter only advances, so a minted number is never issued twice
 * even across a release. "Never re-issued" is a property of the counter,
 * not of the claim table.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import type { DatabaseAdapter } from '../storage/db_adapter';

/** Immutable internal product identity. Minted once, never re-derived. */
export function newAssignmentId(): string {
  return `asg_${bytesToHex(randomBytes(16))}`;
}

export interface SkuClaimInput {
  issuerDid: string;
  scheme: string;
  value: string;
  assignmentId: string;
  catalogId: string;
  draftId: string;
  nowMs: number;
}

export type SkuClaimOutcome =
  | { outcome: 'claimed' }
  | { outcome: 'already_owned' }
  | { outcome: 'refused'; owningCatalogId: string; owningAssignmentId: string };

export interface SkuLedgerRepository {
  /**
   * The atomic claim. Runs inside the caller's transaction when one is
   * open — assignment creation, the claim, and the draft mutation commit
   * together, so a crash between them is unobservable.
   */
  claim(input: SkuClaimInput): SkuClaimOutcome;
  /**
   * Next minted value for this issuer: bumps the high-water mark and skips
   * every claimed value, so the mint can never issue a value a
   * photographed row already carries.
   */
  mintNextValue(issuerDid: string, scheme: string): string;
  /** Claims held by never-published assignments of this draft are released. */
  releaseUnpublished(draftId: string): void;
  /** The draft published: its claims survive for ever. */
  markPublished(draftId: string): void;
  /** The claim currently holding a value, if any. */
  holder(
    issuerDid: string,
    scheme: string,
    value: string,
  ): { assignmentId: string; catalogId: string; published: boolean } | null;
  highWater(issuerDid: string): number;
}

/** The minted shape: `P-0001`, zero-padded, growing past 4 digits freely. */
export function renderMintedValue(counter: number): string {
  return `P-${String(counter).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export class SQLiteSkuLedgerRepository implements SkuLedgerRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  claim(input: SkuClaimInput): SkuClaimOutcome {
    let result: SkuClaimOutcome = { outcome: 'claimed' };
    this.db.transaction(() => {
      const rows = this.db.query<{ assignment_id: string; catalog_id: string }>(
        `SELECT assignment_id, catalog_id FROM commerce_sku_assignments
          WHERE issuer_did = ? AND scheme = ? AND value = ?`,
        [input.issuerDid, input.scheme, input.value],
      );
      const held = rows[0];
      if (held === undefined) {
        this.db.run(
          `INSERT INTO commerce_sku_assignments
             (issuer_did, scheme, value, assignment_id, catalog_id, draft_id,
              published, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
          [
            input.issuerDid,
            input.scheme,
            input.value,
            input.assignmentId,
            input.catalogId,
            input.draftId,
            input.nowMs,
          ],
        );
        result = { outcome: 'claimed' };
        return;
      }
      if (String(held.assignment_id) === input.assignmentId) {
        // Idempotent re-claim — a republication draft takes over the claim
        // so release-by-draft follows the LIVING draft, not the erased one.
        this.db.run(
          `UPDATE commerce_sku_assignments SET draft_id = ?
            WHERE issuer_did = ? AND scheme = ? AND value = ?`,
          [input.draftId, input.issuerDid, input.scheme, input.value],
        );
        result = { outcome: 'already_owned' };
        return;
      }
      result = {
        outcome: 'refused',
        owningCatalogId: String(held.catalog_id),
        owningAssignmentId: String(held.assignment_id),
      };
    });
    return result;
  }

  mintNextValue(issuerDid: string, scheme: string): string {
    let value = '';
    this.db.transaction(() => {
      const rows = this.db.query<{ high_water: number }>(
        `SELECT high_water FROM commerce_sku_highwater WHERE issuer_did = ?`,
        [issuerDid],
      );
      let counter = Number(rows[0]?.high_water ?? 0);
      // Skip every claimed value — a photographed row may already carry a
      // printed value inside the minted namespace.
      for (;;) {
        counter += 1;
        value = renderMintedValue(counter);
        const held = this.db.query<{ value: string }>(
          `SELECT value FROM commerce_sku_assignments
            WHERE issuer_did = ? AND scheme = ? AND value = ?`,
          [issuerDid, scheme, value],
        );
        if (held[0] === undefined) break;
      }
      this.db.run(
        `INSERT INTO commerce_sku_highwater (issuer_did, high_water) VALUES (?, ?)
           ON CONFLICT(issuer_did) DO UPDATE SET high_water = excluded.high_water`,
        [issuerDid, counter],
      );
    });
    return value;
  }

  releaseUnpublished(draftId: string): void {
    this.db.run(`DELETE FROM commerce_sku_assignments WHERE draft_id = ? AND published = 0`, [
      draftId,
    ]);
  }

  markPublished(draftId: string): void {
    this.db.run(`UPDATE commerce_sku_assignments SET published = 1 WHERE draft_id = ?`, [draftId]);
  }

  holder(
    issuerDid: string,
    scheme: string,
    value: string,
  ): { assignmentId: string; catalogId: string; published: boolean } | null {
    const rows = this.db.query<{ assignment_id: string; catalog_id: string; published: number }>(
      `SELECT assignment_id, catalog_id, published FROM commerce_sku_assignments
        WHERE issuer_did = ? AND scheme = ? AND value = ?`,
      [issuerDid, scheme, value],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          assignmentId: String(row.assignment_id),
          catalogId: String(row.catalog_id),
          published: Number(row.published) === 1,
        };
  }

  highWater(issuerDid: string): number {
    const rows = this.db.query<{ high_water: number }>(
      `SELECT high_water FROM commerce_sku_highwater WHERE issuer_did = ?`,
      [issuerDid],
    );
    return Number(rows[0]?.high_water ?? 0);
  }
}

// ---------------------------------------------------------------------------
// In-memory double
// ---------------------------------------------------------------------------

export class InMemorySkuLedgerRepository implements SkuLedgerRepository {
  private readonly claims = new Map<
    string,
    { assignmentId: string; catalogId: string; draftId: string; published: boolean }
  >();
  private readonly water = new Map<string, number>();

  private key(issuerDid: string, scheme: string, value: string): string {
    return `${issuerDid}\n${scheme}\n${value}`;
  }

  claim(input: SkuClaimInput): SkuClaimOutcome {
    const key = this.key(input.issuerDid, input.scheme, input.value);
    const held = this.claims.get(key);
    if (held === undefined) {
      this.claims.set(key, {
        assignmentId: input.assignmentId,
        catalogId: input.catalogId,
        draftId: input.draftId,
        published: false,
      });
      return { outcome: 'claimed' };
    }
    if (held.assignmentId === input.assignmentId) {
      held.draftId = input.draftId;
      return { outcome: 'already_owned' };
    }
    return {
      outcome: 'refused',
      owningCatalogId: held.catalogId,
      owningAssignmentId: held.assignmentId,
    };
  }

  mintNextValue(issuerDid: string, scheme: string): string {
    let counter = this.water.get(issuerDid) ?? 0;
    let value = '';
    for (;;) {
      counter += 1;
      value = renderMintedValue(counter);
      if (!this.claims.has(this.key(issuerDid, scheme, value))) break;
    }
    this.water.set(issuerDid, counter);
    return value;
  }

  releaseUnpublished(draftId: string): void {
    for (const [key, held] of this.claims) {
      if (held.draftId === draftId && !held.published) this.claims.delete(key);
    }
  }

  markPublished(draftId: string): void {
    for (const held of this.claims.values()) {
      if (held.draftId === draftId) held.published = true;
    }
  }

  holder(
    issuerDid: string,
    scheme: string,
    value: string,
  ): { assignmentId: string; catalogId: string; published: boolean } | null {
    const held = this.claims.get(this.key(issuerDid, scheme, value));
    return held === undefined
      ? null
      : { assignmentId: held.assignmentId, catalogId: held.catalogId, published: held.published };
  }

  highWater(issuerDid: string): number {
    return this.water.get(issuerDid) ?? 0;
  }
}
