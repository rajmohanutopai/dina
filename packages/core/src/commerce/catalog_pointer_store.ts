/**
 * What THIS node has published, and the swap value the next publication needs
 * (§10.2 — WS-7.8).
 *
 * The pointer lives in the repo. Reading it back from there needs a network
 * round trip on a surface an owner opens to see what they sell, and — worse —
 * the CAS the next publication CASes on is the CID of the row currently there.
 * Before this, the publish route took `expected_pointer_cid` from the CALLER,
 * which made the caller the authority on this node's own publication history.
 * That is a fact this node should not have to be told, and a caller that got it
 * wrong lost a race it had no way to understand.
 *
 * ONE ROW PER CATALOG, because the pointer IS the head and a second row would
 * be a second head — the same reason the repo key is the catalog id.
 *
 * THIS IS A CACHE OF OUR OWN WRITES, not a claim about the repo. The repo is
 * still the authority: a CAS that fails means this row is stale, and the honest
 * response is to re-read the repo, not to argue. What the row buys is that the
 * ordinary path — publish, look at what you published, publish again — needs no
 * round trip and no caller bookkeeping.
 */

import { rehydrateCatalogPointer } from './rehydrate';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { CatalogPointer } from '@dina/commerce-protocol';

export interface PublishedCatalogPointer {
  catalogId: string;
  pointer: CatalogPointer;
  /** Repo CID of the published row — the next publication's swap value. */
  pointerCid: string;
  /** Empty on a withdrawal: a tombstone names no snapshot. */
  snapshotDigest: string;
  withdrawn: boolean;
  publishedAtMs: number;
}

export interface CatalogPointerRepository {
  get(catalogId: string): PublishedCatalogPointer | null;
  /**
   * Is there a ROW for this catalog, readable or not?
   *
   * `get` collapses "never published" and "the row cannot be read" into null,
   * and the caller must not: the first authorizes a GENESIS publication at
   * sequence 1, and doing that over a live chain is the failure the whole
   * pointer store exists to prevent. A row that is present and unreadable
   * fails closed instead.
   */
  has(catalogId: string): boolean;
  /** Every catalog this node has published, newest first. */
  list(): PublishedCatalogPointer[];
  /** Record a publication. Last write wins: this tracks OUR OWN latest write. */
  put(record: PublishedCatalogPointer): void;
}

function toRecord(row: DBRow): PublishedCatalogPointer | null {
  // Through the SAME validator a consumer runs against a pointer it fetched
  // from the repo, in `rehydrate.ts` where every stored-record read lives. A
  // row this build cannot read the way a buyer would is a row this node must
  // not act on either.
  //
  // Reported as ABSENT rather than as an empty publication, because "you have
  // published nothing" and "the record is unreadable" send an operator to
  // different places — and the caller distinguishes them by the row still
  // being there.
  const pointer = rehydrateCatalogPointer(String(row.pointer_json));
  if (!pointer.ok) return null;
  return {
    catalogId: String(row.catalog_id),
    pointer: pointer.value,
    pointerCid: String(row.pointer_cid),
    snapshotDigest: String(row.snapshot_digest ?? ''),
    withdrawn: Number(row.withdrawn) === 1,
    publishedAtMs: Number(row.published_at_ms),
  };
}

export class SQLiteCatalogPointerRepository implements CatalogPointerRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  get(catalogId: string): PublishedCatalogPointer | null {
    const rows = this.db.query(`SELECT * FROM commerce_catalog_pointers WHERE catalog_id = ?`, [
      catalogId,
    ]);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  has(catalogId: string): boolean {
    return (
      this.db.query(`SELECT 1 FROM commerce_catalog_pointers WHERE catalog_id = ?`, [catalogId])
        .length > 0
    );
  }

  list(): PublishedCatalogPointer[] {
    const rows = this.db.query(
      // Newest first, then by id so two publications in the same millisecond
      // do not shuffle between reads.
      `SELECT * FROM commerce_catalog_pointers ORDER BY published_at_ms DESC, catalog_id ASC`,
      [],
    );
    return rows.map(toRecord).filter((r): r is PublishedCatalogPointer => r !== null);
  }

  put(record: PublishedCatalogPointer): void {
    this.db.run(
      `INSERT INTO commerce_catalog_pointers
         (catalog_id, pointer_json, pointer_cid, snapshot_digest, withdrawn, published_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(catalog_id) DO UPDATE SET
         pointer_json = excluded.pointer_json,
         pointer_cid = excluded.pointer_cid,
         snapshot_digest = excluded.snapshot_digest,
         withdrawn = excluded.withdrawn,
         published_at_ms = excluded.published_at_ms`,
      [
        record.catalogId,
        JSON.stringify(record.pointer),
        record.pointerCid,
        record.snapshotDigest,
        record.withdrawn ? 1 : 0,
        record.publishedAtMs,
      ],
    );
  }
}

/** Test double. A production caller would be the bug. */
export class InMemoryCatalogPointerRepository implements CatalogPointerRepository {
  private readonly rows = new Map<string, PublishedCatalogPointer>();

  get(catalogId: string): PublishedCatalogPointer | null {
    const row = this.rows.get(catalogId);
    return row === undefined ? null : { ...row };
  }

  has(catalogId: string): boolean {
    return this.rows.has(catalogId);
  }

  list(): PublishedCatalogPointer[] {
    return [...this.rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => b.publishedAtMs - a.publishedAtMs || a.catalogId.localeCompare(b.catalogId));
  }

  put(record: PublishedCatalogPointer): void {
    this.rows.set(record.catalogId, { ...record });
  }
}

// ---------------------------------------------------------------------------
// The owner's card
// ---------------------------------------------------------------------------

export type OwnerCatalogState =
  /** Published and current. */
  | 'published'
  /** An explicit tombstone: retired, and consumers were told (§10.2). */
  | 'withdrawn';

export type OwnerCatalogAction = 'view' | 'republish' | 'withdraw';

export interface OwnerCatalogView {
  catalogId: string;
  state: OwnerCatalogState;
  headline: string;
  detail: string | null;
  actions: OwnerCatalogAction[];
  /** Chain position, so an owner can see a publication actually advanced. */
  snapshotSequence: number;
  publishedAtMs: number;
}

/**
 * Render one published catalog for its owner (FR-P10).
 *
 * The same one-projection rule as orders and quotes: two clients deriving
 * "published" from a stored row would eventually disagree about a withdrawal,
 * and the disagreement that matters is a card offering to WITHDRAW a catalog
 * that is already a tombstone — which republishes the tombstone at a new
 * sequence and tells every consumer the catalog was retired twice.
 */
export function describeCatalogForOwner(record: PublishedCatalogPointer): OwnerCatalogView {
  const base = {
    catalogId: record.catalogId,
    snapshotSequence: record.pointer.snapshot_sequence,
    publishedAtMs: record.publishedAtMs,
  };
  if (record.withdrawn) {
    return {
      ...base,
      state: 'withdrawn',
      headline: 'Retired. Buyers have been told this catalog is gone.',
      detail:
        'A withdrawal is a tombstone, not a deletion — the record stays so a consumer learns the catalog ended rather than merely stopping to hear about it. This catalog id is finished: selling these products again means publishing under a NEW catalog id, which is also the honest signal, because the old identity was publicly retired.',
      // VIEW ONLY, and both omissions are the chain rule rather than taste.
      // `withdraw` would say the same thing twice. `republish` was offered by
      // the first version and is worse: `verifyCatalogPointerAdvance` refuses
      // every successor of a tombstone, so the button could only ever fail —
      // and the copy beside it told an owner the chain moves forward from
      // here, which is the opposite of what §10.2 says.
      actions: ['view'],
    };
  }
  return {
    ...base,
    state: 'published',
    headline: 'Published. Buyers can see this catalog.',
    detail: null,
    actions: ['view', 'republish', 'withdraw'],
  };
}
