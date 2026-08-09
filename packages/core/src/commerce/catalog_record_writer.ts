/**
 * Publishing a catalog to this node's own repo (§10.2 — WS-5.1).
 *
 * `buildCatalogSnapshot` produces the records; nothing wrote them. The routes
 * hand back "here is what to publish" and the publication stopped there, which
 * is a supplier who has decided what to sell and told nobody.
 *
 * WHAT IS HERE AND WHAT IS NOT. Core owns the ORDER, because the order is the
 * rule; the composition root owns the WRITE, because writing to a repo is I/O
 * and Core does none. Same split as the ingest half, and for the same reason: a
 * Core that reached for a repo client would be a Core that could reach for
 * anything.
 *
 * THE ORDER IS THE WHOLE POINT.
 *
 *   1. The SNAPSHOT first. It is immutable and content-addressed — writing it
 *      twice is writing the same bytes, so a retry is free and a crash after
 *      it costs nothing.
 *   2. The POINTER last, and only if the snapshot landed. The pointer is the
 *      mutable head: publishing it names a snapshot as current. A pointer
 *      naming a snapshot that is not there is the one failure a consumer
 *      cannot work around — it fetches, gets nothing, and cannot tell a
 *      supplier who is mid-publish from one who is broken.
 *
 * The reverse order is what an implementation written from the data model
 * rather than the failure model produces, because the pointer is the smaller
 * record and the obvious first thing to update.
 */

import type { CatalogPointer, CatalogSnapshot } from '@dina/commerce-protocol';

/**
 * Write one record into this node's own repo. Injected: the root owns the
 * repo client, its session, and its retries.
 *
 * `swapRecord` carries the CAS the pointer needs, and it has THREE states
 * because the repo does:
 *
 *   a CID  — replace exactly that record, or lose the race
 *   null   — write only if NOTHING is there (a first publication)
 *   ABSENT — blind overwrite, no condition at all
 *
 * The third is not a convenience: the SNAPSHOT is content-addressed, so a
 * retry writes identical bytes to the same key, and any condition at all makes
 * that retry fail ON SUCCESS. Passing `null` there — which the first version
 * did, reading it as "no CAS" — meant the documented recovery from a lost
 * pointer write ("the snapshot is durable, just write the head again") was
 * rejected by the repo as `InvalidSwap` and reported as `snapshot_write_failed`,
 * a message that would have been false.
 */
export type CatalogRecordWriter = (args: {
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
  swapRecord?: string | null;
}) => Promise<{ cid: string }>;

/**
 * READ one record back from this node's own repo, with the CID the repo holds.
 *
 * The counterpart of the writer, and it exists for one job: adoption after the
 * local head and the repo diverge. Injected for the same reason the writer is —
 * Core does no I/O — but the split matters more here, because the alternative
 * that shipped first was to let the OPERATOR supply what the repo says. That
 * makes a caller the authority on the one fact the whole pointer store exists
 * to hold, and a caller who pairs the live CID with a fabricated high-sequence
 * pointer gets a CAS that SUCCEEDS while publishing a successor to a record
 * that never existed.
 *
 * Null means "no record at that key", which is a real answer: a catalog this
 * node has never published.
 */
export type CatalogRecordReader = (args: {
  collection: string;
  rkey: string;
}) => Promise<{ record: unknown; cid: string } | null>;

let recordReader: CatalogRecordReader | null = null;

export function installCatalogRecordReader(value: CatalogRecordReader | null): void {
  recordReader = value;
}

export function getCatalogRecordReader(): CatalogRecordReader | null {
  return recordReader;
}

/** §10.2 collections. */
export const CATALOG_SNAPSHOT_NSID = 'com.dinakernel.commerce.catalogSnapshot';
export const CATALOG_POINTER_NSID = 'com.dinakernel.commerce.catalogPointer';

/**
 * The pointer's rkey. ONE per catalog, because the pointer IS the mutable head
 * and a second key would be a second head.
 */
export function catalogPointerRkey(catalogId: string): string {
  return catalogId;
}

export type CatalogPublishRefusal =
  | 'no_record_writer'
  /** §16.2 superseded this node between the snapshot and the head. */
  | 'fenced_before_pointer'
  /** The snapshot did not land, so the pointer was deliberately not written. */
  | 'snapshot_write_failed'
  /** The snapshot landed and the head did not; a retry republishes safely. */
  | 'pointer_write_failed'
  /** A withdrawal names no snapshot, so there is nothing to publish under it. */
  | 'withdrawal_names_a_snapshot';

export type CatalogPublishOutcome =
  | {
      ok: true;
      /** Absent on a withdrawal — a tombstone publishes no snapshot. */
      snapshotCid?: string;
      pointerCid: string;
    }
  | { ok: false; refusal: CatalogPublishRefusal; error: string };

let recordWriter: CatalogRecordWriter | null = null;

/**
 * Install how this node WRITES its own repo records.
 *
 * Null is not a degraded mode: a node with no repo cannot publish, and says so
 * rather than reporting a publication that never happened.
 */
export function installCatalogRecordWriter(value: CatalogRecordWriter | null): void {
  recordWriter = value;
}

/**
 * Whether this node can write its own repo, and what with.
 *
 * Exposed so a composition test can assert that a root INSTALLED one — the
 * phone shipped without it and the gap was invisible, because every catalog
 * test installed its own writer directly.
 */
export function getCatalogRecordWriter(): CatalogRecordWriter | null {
  return recordWriter;
}

/**
 * Publish a built catalog publication, snapshot before pointer.
 *
 * `expectedPointerCid` is what this node believes is currently published — the
 * CAS the repo enforces. Getting it wrong is a lost race, not a corruption:
 * the snapshot is already durable and content-addressed, so re-reading the head
 * and republishing costs one more pointer write and nothing else.
 */
export async function publishCatalogRecords(args: {
  pointer: CatalogPointer;
  /** Absent on a withdrawal. */
  snapshot?: CatalogSnapshot;
  expectedPointerCid: string | null;
  /**
   * Asked again immediately before the head write, after the snapshot's
   * awaited round trip. Returning anything but null abandons the publication
   * with the snapshot already durable — the safe half, because consumers still
   * see the previous head and a retry only rewrites the pointer.
   */
  beforePointer?: () => unknown | null;
}): Promise<CatalogPublishOutcome> {
  // Through the accessor, so there is ONE way to ask whether this node can
  // write its own repo — the same question a composition test asks.
  const writer = getCatalogRecordWriter();
  if (writer === null) {
    return {
      ok: false,
      refusal: 'no_record_writer',
      error: 'catalog: this node has no repo to publish to',
    };
  }
  if (args.pointer.withdrawn === true && args.snapshot !== undefined) {
    // A tombstone that also published a snapshot would be saying two things at
    // once, and a consumer would have to guess which.
    return {
      ok: false,
      refusal: 'withdrawal_names_a_snapshot',
      error: 'catalog: a withdrawal publishes no snapshot (§10.2)',
    };
  }

  let snapshotCid: string | undefined;
  if (args.snapshot !== undefined) {
    try {
      const written = await writer({
        collection: CATALOG_SNAPSHOT_NSID,
        // Content-addressed: the digest IS the key, so a retry writes the same
        // record at the same place rather than a second copy.
        rkey: args.snapshot.snapshot_digest,
        record: { ...args.snapshot, $type: CATALOG_SNAPSHOT_NSID },
        // NO CONDITION AT ALL — the property is absent, not null. An immutable
        // record either is not there or is already exactly these bytes, and
        // `null` would mean "only if nothing is there", which refuses the
        // second case and turns a safe retry into a reported failure.
      });
      snapshotCid = written.cid;
    } catch (err) {
      return {
        ok: false,
        refusal: 'snapshot_write_failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (args.beforePointer !== undefined && args.beforePointer() !== null) {
    return {
      ok: false,
      refusal: 'fenced_before_pointer',
      error: 'catalog: this node lost authority to publish before the head was written (§16.2)',
    };
  }

  try {
    const written = await writer({
      collection: CATALOG_POINTER_NSID,
      rkey: catalogPointerRkey(args.pointer.catalog_id),
      record: { ...args.pointer, $type: CATALOG_POINTER_NSID },
      swapRecord: args.expectedPointerCid,
    });
    return {
      ok: true,
      ...(snapshotCid === undefined ? {} : { snapshotCid }),
      pointerCid: written.cid,
    };
  } catch (err) {
    // The snapshot is durable and the head is not. That is the SAFE half of
    // the ordering: consumers still see the previous publication, which is a
    // real one, and a retry only has to write the pointer again.
    return {
      ok: false,
      refusal: 'pointer_write_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
