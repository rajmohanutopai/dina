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

import type { CatalogPointer, CatalogSnapshot, Sha256Fn } from '@dina/commerce-protocol';

const hash: Sha256Fn = (data) => sha256(data);
const SUPPLIER = 'did:plc:chairmaker99';
const CATALOG_ID = 'chairmaker-main';

/** Every write attempted, in order, with what it CAS'd on. */
/**
 * `swapRecord` is `undefined` when the property was ABSENT — a different
 * instruction to the repo than `null`, and the distinction this double exists
 * to record.
 */
let writes: { collection: string; rkey: string; swapRecord?: string | null }[];

function publication(
  items: Record<string, unknown>[],
  previous: { pointer: CatalogPointer; snapshotDigest: string } | null = null,
): { pointer: CatalogPointer; snapshot: CatalogSnapshot } {
  const built = buildCatalogSnapshot({
    supplierDid: SUPPLIER,
    catalogId: CATALOG_ID,
    protocolVersion: '1.0',
    publishedAt: '2026-08-09T09:00:00.000Z',
    items,
    previous,
    sha256: hash,
  });
  if (!built.ok || built.snapshot === undefined) throw new Error('fixture failed to build');
  return { pointer: built.pointer, snapshot: built.snapshot };
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
