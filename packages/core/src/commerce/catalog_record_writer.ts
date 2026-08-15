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

import {
  CATALOG_POINTER_NSID,
  CATALOG_SNAPSHOT_NSID,
  catalogPointerRecord,
  catalogSnapshotRecord,
  type CatalogPointer,
  type CatalogPointerRecord,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
  type CatalogSnapshotRecord,
} from '@dina/commerce-protocol';

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
  /**
   * EXACTLY the two §10.2 record kinds, not an open bag of fields.
   *
   * It was `Record<string, unknown>`, which accepted any object at all — so
   * the writer could be handed a flat snapshot missing its pages and the
   * compiler had nothing to say. The shapes are the contract; typing them here
   * is what makes a malformed record a build error rather than a record
   * AppView silently refuses.
   */
  record: CatalogPointerRecord | CatalogSnapshotRecord;
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

/**
 * §10.2 collections — RE-EXPORTED, not redeclared.
 *
 * They were declared here, and the pointer's name disagreed with the one
 * AppView indexes on. Keeping the exports (callers and tests import them from
 * here) while sourcing the values from `@dina/commerce-protocol` means there
 * is now one place the name can be changed and both sides follow.
 */
export { CATALOG_SNAPSHOT_NSID, CATALOG_POINTER_NSID };

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
  | 'withdrawal_names_a_snapshot'
  /** A snapshot arrived without the pages its `payload_root` commits to. */
  | 'snapshot_without_pages'
  /** A live (non-withdrawn) pointer identified no snapshot at all. */
  | 'pointer_names_no_snapshot';

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
  /**
   * The snapshot's pages, REQUIRED whenever a snapshot is published.
   *
   * §10.3 v1 carries pages inline, and the snapshot's `payload_root` commits
   * to their digests — so a snapshot published without them commits to bytes
   * no consumer can fetch, and AppView refuses it as "pages missing". The
   * builder returns them and this function used not to accept them, so they
   * were computed and dropped at the call site.
   */
  pages?: readonly CatalogSnapshotPage[];
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
  if (args.pointer.withdrawn !== true && args.snapshot === undefined) {
    // A LIVE POINTER MUST NAME A SNAPSHOT — but not necessarily publish one.
    // Omitting the snapshot is the documented recovery: the snapshot write
    // landed, the head write did not, and a retry rewrites only the head. That
    // path stays open. What is refused is a live pointer that names nothing at
    // all, which publishes a head consumers resolve to a record that was never
    // identified, and cannot tell from a supplier mid-publish.
    if (
      typeof args.pointer.snapshot_digest !== 'string' ||
      args.pointer.snapshot_digest === '' ||
      typeof args.pointer.snapshot_rkey !== 'string' ||
      args.pointer.snapshot_rkey === ''
    ) {
      return {
        ok: false,
        refusal: 'pointer_names_no_snapshot',
        error: 'catalog: a live pointer names its snapshot (§10.2)',
      };
    }
  }

  let snapshotCid: string | undefined;
  if (args.snapshot !== undefined) {
    // FAIL CLOSED. Publishing a snapshot that does not carry the payload it
    // commits to puts a record on the wire that every consumer rejects, and
    // the pointer written after it names that record as current.
    //
    // THE CHECK IS AGAINST `page_digests`, NOT AGAINST PRESENCE. The first
    // version asked only whether `pages` was `undefined`, which a caller
    // passing `pages: []` for a snapshot committing to three pages walked
    // straight past — an absent argument was refused while an empty one was
    // published. Presence is not the property; agreeing with the commitment
    // is. The routes always pass the builder's own pages, so this guards the
    // exported boundary rather than the shipped callers.
    const pageDigests = args.snapshot.page_digests;
    const pages = args.pages;
    if (pages === undefined || pages.length !== pageDigests.length) {
      return {
        ok: false,
        refusal: 'snapshot_without_pages',
        error: `catalog: a snapshot publishes its pages inline (§10.3) — committed to ${String(pageDigests.length)}, given ${pages === undefined ? 'none' : String(pages.length)}`,
      };
    }
    // ORDER IS PART OF THE COMMITMENT: `payload_root` is a commitment over the
    // digests IN SEQUENCE, so the same pages shuffled are a different payload.
    const misordered = pageDigests.findIndex((d, i) => pages[i]?.page_digest !== d);
    if (misordered !== -1) {
      return {
        ok: false,
        refusal: 'snapshot_without_pages',
        error: `catalog: page ${String(misordered)} does not match the snapshot's commitment (§10.3)`,
      };
    }
    try {
      const written = await writer({
        collection: CATALOG_SNAPSHOT_NSID,
        // Content-addressed: the digest IS the key, so a retry writes the same
        // record at the same place rather than a second copy.
        rkey: args.snapshot.snapshot_digest,
        record: catalogSnapshotRecord(args.snapshot, pages),
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
      record: catalogPointerRecord(args.pointer),
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
