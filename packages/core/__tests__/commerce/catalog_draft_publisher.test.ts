/**
 * §5 step 10, driven directly.
 *
 * EVERY CASE HERE WAS UNREACHABLE BEFORE. The publish step lived as an
 * anonymous closure inside a route that wires `userPresent: () => false` and a
 * suite that installs no record writer, so nothing could call it — and three
 * defects sat in it: the §16.2 fence was never re-asked before the head write,
 * a successful publication was never recorded in this node's pointer store,
 * and every failure was reported as "not a lost swap", which made the
 * lost-swap recovery in the state machine unreachable in production.
 */

import {
  CATALOG_POINTER_NSID,
  installCatalogRecordReader,
  installCatalogRecordWriter,
} from '../../src/commerce/catalog_record_writer';
import { publishHeldDraft } from '../../src/commerce/catalog_draft_publisher';

import type { CatalogDraft } from '../../src/commerce/catalog_draft_store';
import type { CatalogPointer } from '@dina/commerce-protocol';

const SUPPLIER = 'did:plc:chairmaker99';
const CATALOG = 'chairmaker-main';
const DIGEST = 'a'.repeat(64);
const PREVIOUS = 'b'.repeat(64);

function pointer(): CatalogPointer {
  return {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    snapshot_sequence: 2,
    protocol_version: '1.0',
    published_at: '2026-08-13T09:00:00.000Z',
    snapshot_digest: DIGEST,
    snapshot_rkey: DIGEST,
    previous_snapshot_digest: PREVIOUS,
    service_rkey: 'listing-2',
  };
}

function draft(): CatalogDraft {
  return {
    draftId: 'draft-1',
    catalogId: CATALOG,
    state: 'approved',
    provenanceClass: 'model_derived',
    defaultScheme: 'sku',
    publishClaim: null,
    extraction: { model: 'test-extractor', schemaVersion: '1' },
    contentRevision: 1,
    rows: [],
    findings: [],
    provenance: {},
    items: [],
    generatedAtIso: '2026-08-13T09:00:00.000Z',
    itemRevision: 'rev-1',
    receipt: { digest: 'c'.repeat(64), revision: 1 },
    held: {
      snapshot: {
        supplier_did: SUPPLIER,
        catalog_id: CATALOG,
        snapshot_sequence: 2,
        protocol_version: '1.0',
        published_at: '2026-08-13T09:00:00.000Z',
        page_digests: ['d'.repeat(64)],
        item_count: 1,
        payload_root: 'e'.repeat(64),
        snapshot_digest: DIGEST,
      },
      pages: [
        {
          catalog_id: CATALOG,
          snapshot_sequence: 2,
          page_index: 0,
          items: [{ name: 'Oak dining chair' }],
          page_digest: 'd'.repeat(64),
        },
      ],
      pointer: pointer(),
      expectedPointerCid: 'cid-head',
      revision: 1,
    },
    approval: { digest: DIGEST, revision: 1 },
    publication: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

interface Recorded {
  catalogId: string;
  pointer: CatalogPointer;
  pointerCid: string;
}

afterEach(() => {
  installCatalogRecordWriter(null);
  installCatalogRecordReader(null);
});

function deps(fence: () => unknown | null = () => null): {
  deps: { fence: () => unknown | null; recordPublication: (c: string, p: CatalogPointer, cid: string) => void };
  recorded: Recorded[];
} {
  const recorded: Recorded[] = [];
  return {
    deps: {
      fence,
      recordPublication: (catalogId, ptr, pointerCid) =>
        recorded.push({ catalogId, pointer: ptr, pointerCid }),
    },
    recorded,
  };
}

describe('a publication the repo accepts', () => {
  it('records the head it just wrote, with the pointer as built', async () => {
    // WITHOUT THIS the node's memory of its own chain is wrong: the next
    // `prepare` reads a stale head, re-issues the sequence just published and
    // CASes against a superseded CID, so a catalog publishes exactly once.
    const written: { collection: string; swapRecord: string | null }[] = [];
    installCatalogRecordWriter(async (args) => {
      written.push({ collection: args.collection, swapRecord: args.swapRecord ?? null });
      return { cid: args.collection === CATALOG_POINTER_NSID ? 'cid-new-head' : 'cid-snapshot' };
    });
    const { deps: d, recorded } = deps();

    const result = await publishHeldDraft(d, draft());
    expect(result).toMatchObject({ ok: true, pointerCid: 'cid-new-head' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.catalogId).toBe(CATALOG);
    expect(recorded[0]?.pointerCid).toBe('cid-new-head');
    // The chain link and the listing binding survive to the store as well as
    // to the wire.
    expect(recorded[0]?.pointer.previous_snapshot_digest).toBe(PREVIOUS);
    expect(recorded[0]?.pointer.service_rkey).toBe('listing-2');
    // And the head write CASed against the CID the draft was holding.
    expect(written.at(-1)?.swapRecord).toBe('cid-head');
  });
});

describe('the §16.2 fence between the snapshot and the head', () => {
  it('is asked AFTER the snapshot write, and stops the head', async () => {
    // The service checks the fence before the first write. This is the second
    // check: a restore can supersede this node during the snapshot's awaited
    // round trip, and a fence consulted only at the start is one consulted at
    // the single moment it could not yet have failed.
    let snapshotWritten = false;
    installCatalogRecordWriter(async (args) => {
      if (args.collection !== CATALOG_POINTER_NSID) {
        snapshotWritten = true;
        return { cid: 'cid-snapshot' };
      }
      throw new Error('the head must not be written once the fence is up');
    });
    const { deps: d, recorded } = deps(() => (snapshotWritten ? 'superseded' : null));

    const result = await publishHeldDraft(d, draft());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error).toContain('§16.2');
    // NOT a lost swap: nothing raced us, this node lost authority.
    expect(result.lostSwap).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe('a head write that fails', () => {
  /** Snapshot succeeds, pointer throws — what the repo does for all three cases. */
  function writerThatFailsTheHead(): void {
    installCatalogRecordWriter(async (args) => {
      if (args.collection === CATALOG_POINTER_NSID) throw new Error('InvalidSwap');
      return { cid: 'cid-snapshot' };
    });
  }

  it('is ALREADY PUBLISHED when the live head carries our digest', async () => {
    // The write was accepted and the answer was lost — a crash between the two.
    // Republishing here would be a second publication of a catalog already on
    // the wire, so this reports success and lets the draft go terminal.
    writerThatFailsTheHead();
    installCatalogRecordReader(async () => ({ record: { ...pointer() }, cid: 'cid-accepted' }));
    const { deps: d, recorded } = deps();

    const result = await publishHeldDraft(d, draft());
    expect(result).toMatchObject({ ok: true, pointerCid: 'cid-accepted' });
    // And the head is recorded, so the NEXT publication chains from it.
    expect(recorded[0]?.pointerCid).toBe('cid-accepted');
  });

  it('is ALREADY PUBLISHED when the head names ours as its PREDECESSOR', async () => {
    // §5 step 10 states exactly two comparisons, and this is the second. Our
    // write was accepted and ONE further publication has happened since, so
    // the head has moved on but still names us as what it replaced. Treating
    // that as a lost swap would discard an approval and rebuild a catalog that
    // is already in the public chain.
    writerThatFailsTheHead();
    installCatalogRecordReader(async () => ({
      record: {
        ...pointer(),
        snapshot_sequence: 3,
        snapshot_digest: 'f'.repeat(64),
        previous_snapshot_digest: DIGEST,
      },
      cid: 'cid-two-ahead',
    }));
    const { deps: d, recorded } = deps();

    const result = await publishHeldDraft(d, draft());
    expect(result).toMatchObject({ ok: true, pointerCid: 'cid-two-ahead' });
    expect(recorded).toHaveLength(1);
    // THE LIVE POINTER, NOT THE HELD ONE. The head is at sequence 3 and the
    // CID belongs to it; recording our sequence-2 pointer beside that CID
    // would give this node a head that never existed, and the next `prepare`
    // would re-issue sequence 3 while CASing against sequence 3's CID.
    expect(recorded[0]?.pointer.snapshot_sequence).toBe(3);
    expect(recorded[0]?.pointer.snapshot_digest).toBe('f'.repeat(64));
    expect(recorded[0]?.pointer.previous_snapshot_digest).toBe(DIGEST);
    expect(recorded[0]?.pointerCid).toBe('cid-two-ahead');
  });

  it('is TRANSIENT when the head names ours but is not a readable pointer', async () => {
    // We know our bytes are out there and cannot say from what. That is the
    // same position as an unreadable head, so it must not be reported as a
    // race — and a malformed record must certainly not become this node's
    // memory of its own chain.
    writerThatFailsTheHead();
    installCatalogRecordReader(async () => ({
      record: { previous_snapshot_digest: DIGEST, snapshot_sequence: 'three' },
      cid: 'cid-bad',
    }));
    const { deps: d, recorded } = deps();

    const result = await publishHeldDraft(d, draft());
    expect(result).toMatchObject({ ok: false, lostSwap: false });
    expect(recorded).toEqual([]);
  });

  it('is INCONCLUSIVE, not a plain lost swap, when the head carries neither digest', async () => {
    // Two more publications and the answer is no longer in the records: §5
    // step 10 calls that inconclusive and says it must not silently
    // republish. It goes back for a rebuild and a fresh owner review, and the
    // message says why rather than blaming a race that may not have happened.
    writerThatFailsTheHead();
    installCatalogRecordReader(async () => ({
      record: {
        ...pointer(),
        snapshot_digest: 'f'.repeat(64),
        previous_snapshot_digest: 'e'.repeat(64),
      },
      cid: 'cid-far-ahead',
    }));
    const { deps: d, recorded } = deps();

    const result = await publishHeldDraft(d, draft());
    expect(result).toMatchObject({ ok: false, lostSwap: true });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error).toContain('cannot be determined');
    expect(recorded).toEqual([]);
  });

  it('is a LOST SWAP when the head moved to something else', async () => {
    // Another writer advanced the head first, so the held bytes name a
    // predecessor that is no longer current: rebuild and re-review.
    writerThatFailsTheHead();
    installCatalogRecordReader(async () => ({
      record: { ...pointer(), snapshot_digest: 'f'.repeat(64) },
      cid: 'cid-someone-else',
    }));
    const { deps: d, recorded } = deps();

    const result = await publishHeldDraft(d, draft());
    expect(result).toMatchObject({ ok: false, lostSwap: true });
    expect(recorded).toEqual([]);
  });

  it('is TRANSIENT when the head is still the one we expected', async () => {
    // The write failed and nothing moved. A retry of exactly these bytes is
    // right, so the owner's approval must NOT be voided.
    writerThatFailsTheHead();
    installCatalogRecordReader(async () => ({
      record: { ...pointer(), snapshot_digest: 'f'.repeat(64) },
      cid: 'cid-head',
    }));
    const { deps: d } = deps();

    const result = await publishHeldDraft(d, draft());
    expect(result).toMatchObject({ ok: false, lostSwap: false });
  });

  it('is TRANSIENT when the head cannot be read at all', async () => {
    // Not knowing is not the same as losing. Reporting a lost swap on a guess
    // would void an owner's approval because a reader was unavailable.
    writerThatFailsTheHead();
    installCatalogRecordReader(async () => {
      throw new Error('reader unavailable');
    });
    const { deps: d } = deps();

    const result = await publishHeldDraft(d, draft());
    expect(result).toMatchObject({ ok: false, lostSwap: false });
  });
});
