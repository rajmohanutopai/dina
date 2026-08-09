/**
 * What this node published, remembered and rendered (§10.2 — WS-7.8).
 *
 * TWO THINGS ARE UNDER TEST and they fail in different ways.
 *
 * The STORE is exercised against real SQL, for the reason the buyer-order
 * store had to be: an in-memory repository holds whole objects, so it cannot
 * disagree with itself about columns, and a swapped bind parameter or a
 * SELECT that never learned a column survives every suite that only uses it.
 * This store's columns are especially swap-prone — `pointer_cid` and
 * `snapshot_digest` are both opaque hex-ish strings sitting next to each
 * other, and exchanging them would hand the next publication a swap value the
 * repo never issued.
 *
 * The PROJECTION is exercised directly, because the expensive mistake it
 * prevents is silent: a card that offers to WITHDRAW a tombstone republishes
 * it at a new sequence and tells every consumer the catalog was retired twice.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  describeCatalogForOwner,
  InMemoryCatalogPointerRepository,
  SQLiteCatalogPointerRepository,
  type CatalogPointerRepository,
  type PublishedCatalogPointer,
} from '../../src/commerce/catalog_pointer_store';
import { buildCatalogSnapshot, buildCatalogWithdrawal } from '../../src/commerce/catalog_publisher';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { CatalogPointer, Sha256Fn } from '@dina/commerce-protocol';

const PASSHEX = randomBytes(32).toString('hex');
const SUPPLIER = 'did:plc:chairmaker99';

let dir: string;
let adapter: NodeSQLiteAdapter;
let sqlite: SQLiteCatalogPointerRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-catalog-pointers-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  sqlite = new SQLiteCatalogPointerRepository(adapter);
});

afterEach(() => {
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const hash: Sha256Fn = (data) => sha256(data);

/**
 * REAL pointers, from the real builder.
 *
 * A hand-written literal was the first version and it cost a test: it set
 * `withdrawn: true` while KEEPING the snapshot fields, which is a contradiction
 * the protocol validator rightly refuses — a tombstone names no snapshot. The
 * store reads rows back through that same validator, so a fixture the protocol
 * would reject is not a row this store can ever hold.
 */
function pointer(sequence = 1): CatalogPointer {
  let built = buildCatalogSnapshot({
    supplierDid: SUPPLIER,
    catalogId: 'chairs',
    protocolVersion: '1.0',
    publishedAt: '2026-08-08T09:00:00.000Z',
    items: [{ sku: 'CHAIR-1', name: 'Oak chair' }],
    previous: null,
    sha256: hash,
  });
  if (!built.ok) throw new Error('fixture failed to build');
  // Walk the chain forward rather than editing the sequence in place: the
  // link fields must agree with it, and a literal cannot keep that promise.
  for (let seq = 1; seq < sequence; seq++) {
    const next = buildCatalogSnapshot({
      supplierDid: SUPPLIER,
      catalogId: 'chairs',
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T09:00:00.000Z',
      items: [{ sku: `CHAIR-${String(seq + 1)}`, name: 'Oak chair' }],
      previous: { pointer: built.pointer, snapshotDigest: built.pointer.snapshot_digest ?? '' },
      sha256: hash,
    });
    if (!next.ok) throw new Error('fixture failed to advance');
    built = next;
  }
  return built.pointer;
}

/** A real tombstone: withdrawn, and naming no snapshot. */
function tombstone(sequence = 2): CatalogPointer {
  const previous = pointer(sequence - 1);
  const built = buildCatalogWithdrawal({
    supplierDid: SUPPLIER,
    catalogId: 'chairs',
    protocolVersion: '1.0',
    publishedAt: '2026-08-08T11:00:00.000Z',
    previous: { pointer: previous, snapshotDigest: previous.snapshot_digest ?? '' },
  });
  if (!built.ok) throw new Error('withdrawal fixture failed to build');
  return built.pointer;
}

function record(over: Partial<PublishedCatalogPointer> = {}): PublishedCatalogPointer {
  return {
    catalogId: 'chairs',
    pointer: pointer(),
    // Every field distinct on purpose, so a swap between any two is visible.
    pointerCid: 'bafypointer1',
    snapshotDigest: pointer().snapshot_digest ?? '',
    withdrawn: false,
    publishedAtMs: 1_700_000_000_000,
    ...over,
  };
}

/** Both implementations answer the same questions, so both are driven. */
function each(): [string, () => CatalogPointerRepository][] {
  return [
    ['sqlite', (): CatalogPointerRepository => sqlite],
    ['in-memory', (): CatalogPointerRepository => new InMemoryCatalogPointerRepository()],
  ];
}

describe.each(each())('the pointer store (%s)', (_name, make) => {
  let repo: CatalogPointerRepository;
  beforeEach(() => {
    repo = make();
  });

  it('reads back every field it was given, field for field', () => {
    // One assertion per field rather than a deep-equal: the failure this
    // catches is a SWAP, and a deep-equal against a record built by the same
    // helper would pass with two lookalike values exchanged.
    repo.put(record());
    const read = repo.get('chairs');
    expect(read?.catalogId).toBe('chairs');
    expect(read?.pointerCid).toBe('bafypointer1');
    expect(read?.snapshotDigest).toBe(pointer().snapshot_digest);
    expect(read?.withdrawn).toBe(false);
    expect(read?.publishedAtMs).toBe(1_700_000_000_000);
    expect(read?.pointer.snapshot_sequence).toBe(1);
    expect(read?.pointer.supplier_did).toBe(SUPPLIER);
    expect(read?.pointer.snapshot_rkey).toBe(pointer().snapshot_rkey);
  });

  it('is absent, not empty, for a catalog never published', () => {
    expect(repo.get('nothing-here')).toBeNull();
    expect(repo.list()).toEqual([]);
  });

  it('keeps ONE row per catalog — the head, not a history', () => {
    // A second row for the same catalog would be a second head, and the next
    // publication would have to guess which CAS to present.
    repo.put(record());
    repo.put(
      record({
        pointer: pointer(2),
        pointerCid: 'bafypointer2',
        snapshotDigest: pointer(2).snapshot_digest ?? '',
        publishedAtMs: 1_700_000_100_000,
      }),
    );
    expect(repo.list()).toHaveLength(1);
    expect(repo.get('chairs')?.pointer.snapshot_sequence).toBe(2);
    expect(repo.get('chairs')?.pointerCid).toBe('bafypointer2');
  });

  it('records a withdrawal AS a withdrawal, with no snapshot', () => {
    // The flag and the empty digest travel together: a tombstone that read
    // back as live would offer a republish path that skips the chain rule.
    repo.put(record({ pointer: tombstone(3), withdrawn: true, snapshotDigest: '' }));
    const read = repo.get('chairs');
    expect(read?.withdrawn).toBe(true);
    expect(read?.snapshotDigest).toBe('');
  });

  it('lists newest first, with a STABLE tiebreak', () => {
    // Two catalogs published in the same millisecond must not shuffle between
    // reads: an owner list that reorders itself on refresh reads as if
    // something changed.
    repo.put(record({ catalogId: 'b-desks', publishedAtMs: 5_000 }));
    repo.put(record({ catalogId: 'a-chairs', publishedAtMs: 5_000 }));
    repo.put(record({ catalogId: 'c-newest', publishedAtMs: 9_000 }));
    const first = repo.list().map((r) => r.catalogId);
    expect(first).toEqual(['c-newest', 'a-chairs', 'b-desks']);
    expect(repo.list().map((r) => r.catalogId)).toEqual(first);
  });
});

describe('a row the build cannot read', () => {
  it('is reported ABSENT rather than as an empty publication', () => {
    // "You have published nothing" and "the record is unreadable" send an
    // operator to different places. Reporting the second as the first would
    // invite a republish at sequence 1 over a live chain.
    sqlite.put(record());
    adapter.run(`UPDATE commerce_catalog_pointers SET pointer_json = ? WHERE catalog_id = ?`, [
      'not json at all',
      'chairs',
    ]);
    expect(sqlite.get('chairs')).toBeNull();
    expect(sqlite.list()).toEqual([]);
  });

  it.each(['null', '[]', '"a string"', '42'])(
    'refuses a pointer that is not an object (%s)',
    (json) => {
      // JSON.parse succeeds on all four. A `null` read as a pointer would
      // throw on the first field access, on the owner's screen.
      sqlite.put(record());
      adapter.run(`UPDATE commerce_catalog_pointers SET pointer_json = ? WHERE catalog_id = ?`, [
        json,
        'chairs',
      ]);
      expect(sqlite.get('chairs')).toBeNull();
    },
  );
});

describe('the owner card', () => {
  it('says PUBLISHED, and offers withdrawal', () => {
    const view = describeCatalogForOwner(record());
    expect(view.state).toBe('published');
    expect(view.actions).toEqual(['view', 'republish', 'withdraw']);
    expect(view.snapshotSequence).toBe(1);
    expect(view.detail).toBeNull();
  });

  it('says WITHDRAWN, and does NOT offer withdrawal again', () => {
    // The whole reason this projection exists. Withdrawing a tombstone
    // republishes it at a new sequence and tells every consumer the catalog
    // was retired twice.
    const view = describeCatalogForOwner(
      record({ pointer: tombstone(4), withdrawn: true, snapshotDigest: '' }),
    );
    expect(view.state).toBe('withdrawn');
    // VIEW ONLY. `withdraw` would say the same thing twice, and `republish`
    // — offered by the first version — could only ever fail:
    // `verifyCatalogPointerAdvance` refuses every successor of a tombstone,
    // so this catalog id is finished and relaunching means a new one.
    expect(view.actions).toEqual(['view']);
    expect(view.actions).not.toContain('withdraw');
    expect(view.actions).not.toContain('republish');
    expect(view.snapshotSequence).toBe(4);
    expect(view.detail).not.toBeNull();
  });

  it('reports the sequence it was given rather than a count of publications', () => {
    // The chain position is what an owner checks to see a publication
    // actually advanced. Deriving it from anything else here would let a card
    // show progress the repo never saw.
    expect(describeCatalogForOwner(record({ pointer: pointer(9) })).snapshotSequence).toBe(9);
  });
});
