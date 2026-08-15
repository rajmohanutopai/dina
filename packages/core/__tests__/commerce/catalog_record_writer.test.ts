/**
 * Publishing a catalog to this node's own repo (§10.2 — WS-5.1).
 *
 * The routes built the records and handed them back; nothing wrote them, which
 * is a supplier who has decided what to sell and told nobody.
 *
 * EVERY TEST HERE IS ABOUT ORDER. The snapshot is immutable and
 * content-addressed; the pointer is the mutable head. Writing the head first is
 * what an implementation derived from the data model produces — the pointer is
 * the smaller record and the obvious thing to update — and it is the one
 * failure a consumer cannot work around: it fetches the snapshot the head
 * names, gets nothing, and cannot tell a supplier mid-publish from a broken one.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { buildCatalogSnapshot, buildCatalogWithdrawal } from '../../src/commerce/catalog_publisher';
import {
  CATALOG_POINTER_NSID,
  CATALOG_SNAPSHOT_NSID,
  installCatalogRecordWriter,
  publishCatalogRecords,
} from '../../src/commerce/catalog_record_writer';

import type {
  CatalogPointer,
  CatalogSnapshot,
  CatalogSnapshotPage,
  Sha256Fn,
} from '@dina/commerce-protocol';

const hash: Sha256Fn = (data) => sha256(data);
const SUPPLIER = 'did:plc:chairmaker99';
const CATALOG_ID = 'chairmaker-main';

/** Every write attempted, in order, with what it CAS'd on. */
/**
 * `swapRecord` is `undefined` when the property was ABSENT — a different
 * instruction to the repo than `null`, and the distinction this double exists
 * to record.
 */
let writes: {
  collection: string;
  rkey: string;
  swapRecord?: string | null;
  /**
   * THE RECORD BODY, which this double used to throw away.
   *
   * That omission is why a malformed snapshot survived every test in this
   * file: the double asserted where a record went and never what it was, so
   * the writer could publish a flat snapshot with no pages and still satisfy
   * "the snapshot is written before the pointer".
   */
  record: unknown;
}[];

function publication(
  items: Record<string, unknown>[],
  previous: { pointer: CatalogPointer; snapshotDigest: string } | null = null,
  /** Forced only where a test needs MORE THAN ONE page to mean anything. */
  pageSize?: number,
): { pointer: CatalogPointer; snapshot: CatalogSnapshot; pages: readonly CatalogSnapshotPage[] } {
  const built = buildCatalogSnapshot({
    supplierDid: SUPPLIER,
    catalogId: CATALOG_ID,
    protocolVersion: '1.0',
    publishedAt: '2026-08-09T09:00:00.000Z',
    items,
    previous,
    ...(pageSize === undefined ? {} : { pageSize }),
    sha256: hash,
  });
  if (!built.ok || built.snapshot === undefined || built.pages === undefined) {
    throw new Error('fixture failed to build');
  }
  return { pointer: built.pointer, snapshot: built.snapshot, pages: built.pages };
}

/** A repo that records every write and can be told to fail one collection. */
function repo(failOn?: string): void {
  installCatalogRecordWriter(async (write) => {
    const { collection, rkey } = write;
    // Recorded through the ARGUMENT OBJECT so an absent property stays
    // absent: destructuring to `undefined` and re-adding the key would erase
    // the very distinction under test.
    writes.push({
      collection,
      rkey,
      record: write.record,
      ...('swapRecord' in write ? { swapRecord: write.swapRecord } : {}),
    });
    if (collection === failOn) throw new Error(`${collection} is unavailable`);
    return { cid: `cid-${collection}-${rkey}` };
  });
}

beforeEach(() => {
  writes = [];
  installCatalogRecordWriter(null);
});
afterEach(() => installCatalogRecordWriter(null));

describe('the order of publication', () => {
  it('writes the SNAPSHOT before the POINTER', async () => {
    repo();
    const pub = publication([{ sku: 'oak-chair' }]);
    const outcome = await publishCatalogRecords({ ...pub, expectedPointerCid: null });

    expect(outcome.ok).toBe(true);
    expect(writes.map((w) => w.collection)).toEqual([CATALOG_SNAPSHOT_NSID, CATALOG_POINTER_NSID]);
  });

  it('does NOT publish the head when the snapshot did not land', async () => {
    // The failure the ordering exists to prevent: a pointer naming a snapshot
    // that is not there. A consumer fetching it gets nothing and cannot tell a
    // supplier mid-publish from a broken one.
    repo(CATALOG_SNAPSHOT_NSID);
    const pub = publication([{ sku: 'oak-chair' }]);
    const outcome = await publishCatalogRecords({ ...pub, expectedPointerCid: null });

    expect(outcome).toMatchObject({ ok: false, refusal: 'snapshot_write_failed' });
    expect(writes.map((w) => w.collection)).toEqual([CATALOG_SNAPSHOT_NSID]);
  });

  it('reports a lost head honestly, leaving the snapshot durable', async () => {
    // The SAFE half of the ordering. Consumers still see the previous
    // publication, which is a real one, and a retry only has to write the
    // pointer again — the snapshot is content-addressed and already there.
    repo(CATALOG_POINTER_NSID);
    const pub = publication([{ sku: 'oak-chair' }]);
    const outcome = await publishCatalogRecords({ ...pub, expectedPointerCid: null });

    expect(outcome).toMatchObject({ ok: false, refusal: 'pointer_write_failed' });
    expect(writes.map((w) => w.collection)).toEqual([CATALOG_SNAPSHOT_NSID, CATALOG_POINTER_NSID]);
  });
});

describe('what each record is keyed and CAS-ed on', () => {
  it('keys the snapshot by its own digest, and does not CAS it', async () => {
    // Content-addressed: a retry writes the same bytes to the same place. A
    // CAS here would make the second attempt fail on success.
    //
    // Published against a NON-NULL expected head on purpose. With `null` the
    // claim is untestable — the pointer's CAS is null too, so "the snapshot is
    // not CAS'd" and "the snapshot is CAS'd on the same value" are the same
    // bytes, and a mutation swapping one for the other survived.
    repo();
    const pub = publication([{ sku: 'oak-chair' }]);
    await publishCatalogRecords({ ...pub, expectedPointerCid: 'cid-previous-head' });

    const snapshotWrite = writes[0];
    expect(snapshotWrite?.rkey).toBe(pub.snapshot.snapshot_digest);
    // ABSENT, not null. `null` means "only if nothing is there", which would
    // refuse a retry writing the same content-addressed bytes and report it as
    // `snapshot_write_failed` — a message that would be false, on the exact
    // recovery path the ordering exists to make safe.
    expect(snapshotWrite).not.toHaveProperty('swapRecord', null);
    expect(snapshotWrite?.swapRecord).toBeUndefined();
  });

  it('keys the pointer by the catalog, and CASes it on the expected head', async () => {
    // ONE pointer per catalog, because the pointer IS the head and a second
    // key would be a second head. The CAS is what stops a publisher racing
    // itself into a fork.
    repo();
    const pub = publication([{ sku: 'oak-chair' }]);
    await publishCatalogRecords({ ...pub, expectedPointerCid: 'cid-previous-head' });

    const pointerWrite = writes[1];
    expect(pointerWrite?.rkey).toBe(CATALOG_ID);
    expect(pointerWrite?.swapRecord).toBe('cid-previous-head');
  });
});

describe('withdrawal', () => {
  it('publishes the tombstone alone', async () => {
    repo();
    const first = publication([{ sku: 'oak-chair' }]);
    const tombstone = buildCatalogWithdrawal({
      supplierDid: SUPPLIER,
      catalogId: CATALOG_ID,
      protocolVersion: '1.0',
      publishedAt: '2026-08-09T10:00:00.000Z',
      previous: { pointer: first.pointer, snapshotDigest: first.snapshot.snapshot_digest },
    });
    if (!tombstone.ok) throw new Error('fixture failed to withdraw');

    const outcome = await publishCatalogRecords({
      pointer: tombstone.pointer,
      expectedPointerCid: 'cid-previous-head',
    });
    expect(outcome.ok).toBe(true);
    expect(writes.map((w) => w.collection)).toEqual([CATALOG_POINTER_NSID]);
  });

  it('refuses a tombstone that also carries a snapshot', async () => {
    // It would be saying two things at once, and a consumer would have to
    // guess which.
    repo();
    const pub = publication([{ sku: 'oak-chair' }]);
    const outcome = await publishCatalogRecords({
      pointer: { ...pub.pointer, withdrawn: true },
      snapshot: pub.snapshot,
      expectedPointerCid: null,
    });
    expect(outcome).toMatchObject({ ok: false, refusal: 'withdrawal_names_a_snapshot' });
    expect(writes).toEqual([]);
  });
});

describe('a node with no repo', () => {
  it('says so rather than reporting a publication that never happened', async () => {
    const pub = publication([{ sku: 'oak-chair' }]);
    const outcome = await publishCatalogRecords({ ...pub, expectedPointerCid: null });
    expect(outcome).toMatchObject({ ok: false, refusal: 'no_record_writer' });
  });
});

/**
 * WHAT GOES ON THE WIRE — the half no test in this file used to look at.
 *
 * Every test above asserts ORDER, and order was never the defect. The writer
 * published the pointer to a collection AppView does not index, and published
 * the snapshot in a shape AppView cannot read, and the whole file stayed green
 * because the repo double recorded where each record went and discarded what
 * it was.
 *
 * These assert against `@dina/commerce-protocol`, which is the package AppView
 * reads its collection names and record shapes from too. Asserting against a
 * literal spelled here would reproduce the original bug in the test: two
 * independent spellings that agree until someone changes one.
 */
describe('the records AppView has to be able to read', () => {
  it('publishes the pointer to the collection AppView indexes', async () => {
    repo();
    const pub = publication([{ sku: 'oak-chair' }]);
    await publishCatalogRecords({ ...pub, expectedPointerCid: null });

    const pointer = writes.find((w) => w.collection === CATALOG_POINTER_NSID);
    expect(pointer).toBeDefined();
    // The pointer's fields are FLAT, and `$type` names the same collection.
    expect(pointer?.record).toMatchObject({
      $type: CATALOG_POINTER_NSID,
      supplier_did: SUPPLIER,
      catalog_id: CATALOG_ID,
      snapshot_sequence: 1,
    });
  });

  it('publishes the snapshot as metadata AND its pages, not flattened', async () => {
    repo();
    const pub = publication([{ sku: 'oak-chair' }, { sku: 'elm-stool' }]);
    await publishCatalogRecords({ ...pub, expectedPointerCid: null });

    const snapshot = writes.find((w) => w.collection === CATALOG_SNAPSHOT_NSID);
    const record = snapshot?.record as {
      snapshot?: CatalogSnapshot;
      pages?: CatalogSnapshotPage[];
    };
    // NESTED under `snapshot`. A flat spread put `snapshot_digest` at the top
    // level, where AppView's `record.snapshot` found nothing and refused.
    expect(record.snapshot?.snapshot_digest).toBe(pub.snapshot.snapshot_digest);
    expect(record.pages).toHaveLength(pub.pages.length);
  });

  it('carries every page the snapshot committed to, in order', async () => {
    repo();
    const pub = publication([{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }]);
    await publishCatalogRecords({ ...pub, expectedPointerCid: null });

    const record = writes.find((w) => w.collection === CATALOG_SNAPSHOT_NSID)?.record as {
      snapshot: CatalogSnapshot;
      pages: CatalogSnapshotPage[];
    };
    // `payload_root` commits to these digests IN ORDER. Publishing a subset,
    // or the same pages reordered, is a commitment to bytes no consumer can
    // reassemble — and the pages were dropped entirely before this.
    expect(record.pages.map((p) => p.page_digest)).toEqual([...record.snapshot.page_digests]);
  });

  it('REFUSES pages that do not match the snapshot’s commitment', async () => {
    // An EMPTY array, not an absent one. The first version of this guard asked
    // only whether `pages` was undefined, so a caller passing `[]` for a
    // snapshot committing to real pages published a record committing to a
    // payload it did not carry — the absent case refused, the empty case
    // waved through.
    repo();
    const pub = publication([{ sku: 'a' }, { sku: 'b' }]);
    const outcome = await publishCatalogRecords({
      pointer: pub.pointer,
      snapshot: pub.snapshot,
      pages: [],
      expectedPointerCid: null,
    });
    expect(outcome).toMatchObject({ ok: false, refusal: 'snapshot_without_pages' });
    expect(writes).toEqual([]);
  });

  it('REFUSES MORE pages than the snapshot committed to', async () => {
    // THE CASE ONLY THE COUNT CHECK CATCHES, and the reason it is not
    // redundant with the ordering check below. Ordering walks `page_digests`,
    // so a trailing page beyond the commitment is never inspected: every
    // committed digest matches, `findIndex` returns -1, and an extra page
    // rides along inside a record whose `payload_root` says nothing about it.
    // Mutation-testing the count check is what surfaced this — with only the
    // too-few case covered, disabling the count check broke no test.
    repo();
    const pub = publication([{ sku: 'a' }, { sku: 'b' }], null, 1);
    const outcome = await publishCatalogRecords({
      pointer: pub.pointer,
      snapshot: pub.snapshot,
      pages: [...pub.pages, { ...pub.pages[0]!, page_index: pub.pages.length }],
      expectedPointerCid: null,
    });
    expect(outcome).toMatchObject({ ok: false, refusal: 'snapshot_without_pages' });
    expect(writes).toEqual([]);
  });

  it('REFUSES pages presented out of the committed order', async () => {
    // `payload_root` commits to the digests IN SEQUENCE, so the same pages
    // shuffled are a different payload than the one the snapshot names.
    repo();
    // PAGE SIZE 1, so three items really are three pages. At the default size
    // they would be one page, reversing a single-element array is a no-op, and
    // the test would pass whether or not the ordering check existed.
    const pub = publication([{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }], null, 1);
    expect(pub.pages.length).toBeGreaterThan(1);
    const outcome = await publishCatalogRecords({
      pointer: pub.pointer,
      snapshot: pub.snapshot,
      pages: [...pub.pages].reverse(),
      expectedPointerCid: null,
    });
    expect(outcome).toMatchObject({ ok: false, refusal: 'snapshot_without_pages' });
    expect(writes).toEqual([]);
  });

  it('REFUSES a live pointer that names no snapshot, while keeping the retry path open', async () => {
    repo();
    const pub = publication([{ sku: 'oak-chair' }]);

    // Named but not republished — the documented recovery after a lost head
    // write. This must still work.
    const retry = await publishCatalogRecords({
      pointer: pub.pointer,
      expectedPointerCid: 'cid-previous-head',
    });
    expect(retry.ok).toBe(true);

    // Naming nothing publishes a head that resolves to a record no consumer
    // can identify.
    const { snapshot_digest: _d, snapshot_rkey: _r, ...unnamed } = pub.pointer;
    const outcome = await publishCatalogRecords({
      pointer: unnamed,
      expectedPointerCid: null,
    });
    expect(outcome).toMatchObject({ ok: false, refusal: 'pointer_names_no_snapshot' });
  });

  it('REFUSES to publish a snapshot whose pages it was not given', async () => {
    repo();
    const pub = publication([{ sku: 'oak-chair' }]);
    const outcome = await publishCatalogRecords({
      pointer: pub.pointer,
      snapshot: pub.snapshot,
      // pages omitted — exactly what the route used to do.
      expectedPointerCid: null,
    });
    expect(outcome).toMatchObject({ ok: false, refusal: 'snapshot_without_pages' });
    // And NOTHING was written: no orphan snapshot, no head naming it.
    expect(writes).toEqual([]);
  });
});
