/**
 * The draft store (§6, §10 item 8).
 *
 * DRIVEN AGAINST REAL SQLITE, not only the in-memory double. The whole reason
 * this table exists is that the lane suspends on a human twice and must
 * survive a restart — a suite that only exercised a `Map` would prove nothing
 * about the property the store was built for, and the double is the thing most
 * likely to disagree with the database.
 *
 * Every test here therefore runs against both, from one body, so a divergence
 * between them fails rather than hides. That matters more than usual: the
 * double returns deep copies precisely so it cannot let a caller mutate stored
 * state through a returned reference, which SQLite could not do anyway.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemoryCatalogDraftRepository,
  SQLiteCatalogDraftRepository,
  type CatalogDraft,
  type CatalogDraftRepository,
} from '../../src/commerce/catalog_draft_store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { CatalogItem } from '@dina/commerce-protocol';

const SUPPLIER = 'did:plc:chairmaker99';
const CATALOG = 'chairmaker-main';

function item(): CatalogItem {
  return {
    product: { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: SUPPLIER },
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    item_revision: 'rev-1',
    name: 'Oak dining chair',
    category_ids: ['furniture.seating'],
    pack: { sell_unit: { value: '1', unit_code: 'each' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    freshness: { generated_at: '2026-08-13T09:00:00.000Z' },
  };
}

function draft(overrides: Partial<CatalogDraft> = {}): CatalogDraft {
  return {
    draftId: 'draft-1',
    catalogId: CATALOG,
    state: 'created',
    provenanceClass: 'model_derived',
    defaultScheme: 'sku',
    publishClaim: null,
    extraction: { model: 'test-extractor', schemaVersion: '1' },
    photoExtraction: null,
    contentRevision: 0,
    // The shape the INGRESS produces. The fixture used to be a flat
    // `{ sku, name }` record — a shape nothing in production writes — so the
    // round-trip case passed while the real one lost every cell.
    rows: [{ row: 2, cells: { sku: 'CHAIR-1', name: 'Oak dining chair' } }],
    findings: [],
    provenance: { '0': { name: 'proposed', category_ids: 'not_model_derived' } },
    items: [],
    generatedAtIso: '',
    itemRevision: '',
    receipt: null,
    held: null,
    approval: null,
    publication: null,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    ...overrides,
  };
}

/** Run one body against BOTH implementations so they cannot diverge quietly. */
function forEachRepo(name: string, body: (repo: CatalogDraftRepository) => void): void {
  describe(name, () => {
    let dir: string;
    let adapter: NodeSQLiteAdapter;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'catalog-drafts-'));
      adapter = new NodeSQLiteAdapter({
        path: path.join(dir, 'identity.sqlite'),
        passphraseHex: randomBytes(32).toString('hex'),
      });
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
    });
    afterEach(() => {
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('sqlite', () => {
      body(new SQLiteCatalogDraftRepository(adapter));
    });
    it('in-memory double', () => {
      body(new InMemoryCatalogDraftRepository());
    });
  });
}

forEachRepo('round trip', (repo) => {
  const d = draft({
    state: 'approved',
    contentRevision: 3,
    // A LIVE claim, because the lease's whole point is surviving the restart
    // that a process death causes. With the default `null` here, the two claim
    // columns were only ever compared as empty — they could stop being written
    // or stop being read and this comparison would not notice.
    publishClaim: { token: 'pcl_9f2c', atMs: 1_800_000_500_000 },
    items: [item()],
    generatedAtIso: '2026-08-13T09:00:00.000Z',
    itemRevision: 'rev-1',
    receipt: { digest: 'a'.repeat(64), revision: 3, vouchedBy: null },
    held: {
      snapshot: {
        supplier_did: SUPPLIER,
        catalog_id: CATALOG,
        snapshot_sequence: 1,
        protocol_version: '1.0',
        published_at: '2026-08-13T09:00:00.000Z',
        page_digests: ['b'.repeat(64)],
        item_count: 1,
        payload_root: 'c'.repeat(64),
        snapshot_digest: 'd'.repeat(64),
      },
      pages: [
        {
          catalog_id: CATALOG,
          snapshot_sequence: 1,
          page_index: 0,
          items: [item()],
          page_digest: 'b'.repeat(64),
        },
      ],
      pointer: {
        supplier_did: SUPPLIER,
        catalog_id: CATALOG,
        snapshot_sequence: 1,
        protocol_version: '1.0',
        published_at: '2026-08-13T09:00:00.000Z',
        snapshot_digest: 'd'.repeat(64),
        snapshot_rkey: 'd'.repeat(64),
        service_rkey: 'listing-2',
      },
      expectedPointerCid: 'cid-head',
      revision: 3,
    },
    approval: { digest: 'd'.repeat(64), revision: 3 },
  });
  repo.put(d);

  const read = repo.get('draft-1');
  expect(read).not.toBeNull();
  // EVERY field, compared whole. Spot-checking three would let a column that
  // is written and never read back through — the defect this codebase has
  // produced twice in the same file.
  expect(read).toEqual(d);
});

forEachRepo('a v2-ATTRIBUTED receipt survives the round trip (§6.4)', (repo) => {
  // The round-trip fixture above pins vouchedBy: null (the v1 shape);
  // this one pins the OTHER arm — a staff-attributed receipt whose
  // voucher column could otherwise stop being written or read back
  // with every test still green.
  const d = draft({
    state: 'approved',
    contentRevision: 4,
    receipt: { digest: 'e'.repeat(64), revision: 4, vouchedBy: 'did:key:zstaffclerk' },
  });
  repo.put(d);
  const read = repo.get('draft-1');
  expect(read?.receipt).toEqual({
    digest: 'e'.repeat(64),
    revision: 4,
    vouchedBy: 'did:key:zstaffclerk',
  });
});

forEachRepo('the held snapshot survives a round trip intact', (repo) => {
  // The point of the table. If the held bytes did not survive, publish would
  // rebuild them, re-mint `published_at`, and publish a digest the owner never
  // approved.
  const held = {
    snapshot: {
      supplier_did: SUPPLIER,
      catalog_id: CATALOG,
      snapshot_sequence: 7,
      protocol_version: '1.0',
      published_at: '2026-08-13T09:00:00.000Z',
      page_digests: ['b'.repeat(64)],
      item_count: 1,
      payload_root: 'c'.repeat(64),
      snapshot_digest: 'd'.repeat(64),
    },
    pages: [
      {
        catalog_id: CATALOG,
        snapshot_sequence: 7,
        page_index: 0,
        items: [item()],
        page_digest: 'b'.repeat(64),
      },
    ],
    pointer: {
      supplier_did: SUPPLIER,
      catalog_id: CATALOG,
      snapshot_sequence: 2,
      protocol_version: '1.0',
      published_at: '2026-08-13T09:00:00.000Z',
      snapshot_digest: 'd'.repeat(64),
      snapshot_rkey: 'd'.repeat(64),
      // The two fields that live ONLY on the pointer, so a round trip that
      // dropped them would show here.
      previous_snapshot_digest: 'e'.repeat(64),
      service_rkey: 'listing-2',
    },
    expectedPointerCid: 'cid-head',
    revision: 2,
  };
  repo.put(draft({ state: 'approved', contentRevision: 2, held }));
  expect(repo.get('draft-1')?.held).toEqual(held);
});

forEachRepo('absence is preserved as absence, not as an empty object', (repo) => {
  // `null` and "an empty snapshot" send a reader to different places: the
  // first says the review has not happened, the second says it produced
  // nothing. The state machine reads them differently, so the store must not
  // collapse them.
  repo.put(draft());
  const read = repo.get('draft-1');
  expect(read?.receipt).toBeNull();
  expect(read?.held).toBeNull();
  expect(read?.approval).toBeNull();
  expect(read?.publication).toBeNull();
});

forEachRepo('put is an upsert — the same draft advances rather than duplicating', (repo) => {
  repo.put(draft({ state: 'created' }));
  repo.put(draft({ state: 'confirmed', contentRevision: 1, updatedAtMs: 1_800_000_001_000 }));
  expect(repo.get('draft-1')?.state).toBe('confirmed');
  expect(repo.listByCatalog(CATALOG)).toHaveLength(1);
});

forEachRepo('lists a catalog’s drafts, most recently touched first', (repo) => {
  repo.put(draft({ draftId: 'older', updatedAtMs: 1_800_000_000_000 }));
  repo.put(draft({ draftId: 'newer', updatedAtMs: 1_800_000_009_000 }));
  repo.put(draft({ draftId: 'other-catalog', catalogId: 'something-else' }));
  expect(repo.listByCatalog(CATALOG).map((d) => d.draftId)).toEqual(['newer', 'older']);
});

forEachRepo('a returned draft cannot be mutated back into the store', (repo) => {
  // SQLite could not leak a reference; a `Map` can. Without this the double
  // would be quietly more permissive than the database, and the revision rules
  // this store exists to enforce are exactly what an aliasing bug defeats.
  repo.put(draft());
  const read = repo.get('draft-1');
  if (read === null) throw new Error('expected a draft');
  (read as { state: string }).state = 'published';
  expect(repo.get('draft-1')?.state).toBe('created');
});

forEachRepo('delete removes it', (repo) => {
  repo.put(draft());
  repo.delete('draft-1');
  expect(repo.get('draft-1')).toBeNull();
});

forEachRepo('an unknown draft id reads as null, not as a blank draft', (repo) => {
  expect(repo.get('never-existed')).toBeNull();
});

describe('a row this build cannot read', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'catalog-drafts-bad-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
  });
  afterEach(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is reported as ABSENT when its state is not one this build knows', () => {
    // Reading an unknown state as `created` would rewind a published draft and
    // authorize a second publication of a catalog already on the wire. Absent
    // is the fail-closed answer.
    adapter.run(
      `INSERT INTO commerce_catalog_drafts (draft_id, catalog_id, state, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      ['weird', CATALOG, 'transcendent', 1, 1],
    );
    expect(new SQLiteCatalogDraftRepository(adapter).get('weird')).toBeNull();
  });

  it('reads an UNKNOWN provenance class as the strictest one', () => {
    // This column decides whether a draft needs a content receipt, so an
    // unvalidated read is a way to skip confirmation. It used to be
    // `String(...) as ProvenanceClass`, which would have taken this row at its
    // word. `model_derived` is the fail-closed answer because it DEMANDS a
    // receipt; guessing permissively would publish unconfirmed values under
    // the seller's key.
    adapter.run(
      `INSERT INTO commerce_catalog_drafts (draft_id, catalog_id, state, provenance_class, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['forged', CATALOG, 'created', 'owner_authored ', 1, 1],
    );
    expect(new SQLiteCatalogDraftRepository(adapter).get('forged')?.provenanceClass).toBe(
      'model_derived',
    );
  });

  it('still reads the three REAL classes as themselves', () => {
    // The mirror. Without it, "always return model_derived" would satisfy the
    // test above and quietly make the exemption unreachable for every
    // legitimately owner-authored or connector-parsed catalog.
    const repo = new SQLiteCatalogDraftRepository(adapter);
    for (const cls of ['owner_authored', 'source_parsed', 'model_derived'] as const) {
      adapter.run(
        `INSERT INTO commerce_catalog_drafts (draft_id, catalog_id, state, provenance_class, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`d-${cls}`, CATALOG, 'created', cls, 1, 1],
      );
      expect(repo.get(`d-${cls}`)?.provenanceClass).toBe(cls);
    }
  });

  it('treats an unparseable held snapshot as no held snapshot', () => {
    // Not as a snapshot-shaped null a caller would then dereference. Publish
    // reads `held` to decide whether the reviewed bytes exist.
    adapter.run(
      `INSERT INTO commerce_catalog_drafts (draft_id, catalog_id, state, held_snapshot_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['bad-held', CATALOG, 'approved', '{not json', 1, 1],
    );
    expect(new SQLiteCatalogDraftRepository(adapter).get('bad-held')?.held).toBeNull();
  });

  it('does not return half a draft when its JSON is corrupt', () => {
    // The items column decides what gets signed. Unparseable means empty, and
    // the state machine refuses to publish a draft with no items — so a
    // corrupt row fails closed rather than publishing a truncated catalog.
    adapter.run(
      `INSERT INTO commerce_catalog_drafts (draft_id, catalog_id, state, items_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['corrupt', CATALOG, 'prepared', '{not json', 1, 1],
    );
    expect(new SQLiteCatalogDraftRepository(adapter).get('corrupt')?.items).toEqual([]);
  });

  /**
   * WELL-FORMED JSON THAT IS NOT A VALID ITEM — the case the corrupt-JSON test
   * above cannot reach, because `parseJson`'s try/catch catches `'{not json'`
   * one layer earlier and the validator never runs.
   *
   * That mattered more than a missing case usually does: `boundary.test.ts`
   * exempts this file from "no commerce source parses a stored record outside
   * the rehydration module" ON THE GROUNDS that every stored item is re-derived
   * through `validateCatalogItem`. The exemption was certified by a guard
   * nothing exercised — replace the loop with a bare cast and the whole suite
   * stayed green while a tampered item flowed into `prepare`, was paginated,
   * digested and signed.
   */
  it('reads an unrecognised per-field provenance as PROPOSED, not as confirmed', () => {
    // THE ONE DIRECTION THIS LANE MUST NEVER FAIL IN. The column was cast, not
    // validated, and the enforcement point blocks only the exact string
    // `proposed` — so one corrupted byte turning `proposed` into `proposd` read
    // as a field somebody had vouched for, and it published. Missing already
    // blocked; unrecognised did not.
    adapter.run(
      `INSERT INTO commerce_catalog_drafts (draft_id, catalog_id, state, provenance_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'bent',
        CATALOG,
        'created',
        JSON.stringify({ '0': { name: 'proposd', pack: 'ACCEPTED', description: 42 } }),
        1,
        1,
      ],
    );
    const read = new SQLiteCatalogDraftRepository(adapter).get('bent');
    expect(read?.provenance['0']).toEqual({
      name: 'proposed',
      // Case matters: the vocabulary is exact, so `ACCEPTED` is not `accepted`.
      pack: 'proposed',
      description: 'proposed',
    });
  });

  it('still reads the four REAL states as themselves', () => {
    // The other direction, so the reader is not simply always-proposed.
    adapter.run(
      `INSERT INTO commerce_catalog_drafts (draft_id, catalog_id, state, provenance_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'good-prov',
        CATALOG,
        'created',
        JSON.stringify({
          '0': {
            a: 'proposed',
            b: 'accepted',
            c: 'edited',
            d: 'not_model_derived',
          },
        }),
        1,
        1,
      ],
    );
    expect(new SQLiteCatalogDraftRepository(adapter).get('good-prov')?.provenance['0']).toEqual({
      a: 'proposed',
      b: 'accepted',
      c: 'edited',
      d: 'not_model_derived',
    });
  });

  it('reads a half-written extraction as NO extraction', () => {
    // A model with no schema version is half an attribution. Reading it as
    // present would let `confirm` hash it into a receipt that claims to say
    // which model read the values while being unable to say against what.
    for (const [id, model, version] of [
      ['half-a', 'gemini', ''],
      ['half-b', '', 'catalog-rows-1'],
    ]) {
      adapter.run(
        `INSERT INTO commerce_catalog_drafts
           (draft_id, catalog_id, state, extraction_model, extraction_schema_version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, CATALOG, 'created', model, version, 1, 1],
      );
      expect(new SQLiteCatalogDraftRepository(adapter).get(id)?.extraction).toBeNull();
    }

    // And a whole one still reads as itself.
    adapter.run(
      `INSERT INTO commerce_catalog_drafts
         (draft_id, catalog_id, state, extraction_model, extraction_schema_version, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['whole', CATALOG, 'created', 'gemini', 'catalog-rows-1', 1, 1],
    );
    expect(new SQLiteCatalogDraftRepository(adapter).get('whole')?.extraction).toEqual({
      model: 'gemini',
      schemaVersion: 'catalog-rows-1',
    });
  });

  it('refuses items that parse but do not validate', () => {
    const tampered = { ...item(), pack: { sell_unit: { value: '1', unit_code: 'furlong' } } };
    adapter.run(
      `INSERT INTO commerce_catalog_drafts (draft_id, catalog_id, state, items_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['tampered', CATALOG, 'prepared', JSON.stringify([tampered]), 1, 1],
    );
    expect(new SQLiteCatalogDraftRepository(adapter).get('tampered')?.items).toEqual([]);
  });

  it('drops the WHOLE set when one item is bad, never a partial catalog', () => {
    // A snapshot is full state, so publishing the items that happened to
    // validate would silently withdraw the rest.
    const tampered = { ...item(), category_ids: [] };
    adapter.run(
      `INSERT INTO commerce_catalog_drafts (draft_id, catalog_id, state, items_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['mixed', CATALOG, 'prepared', JSON.stringify([item(), tampered]), 1, 1],
    );
    expect(new SQLiteCatalogDraftRepository(adapter).get('mixed')?.items).toEqual([]);
  });

  it('and a valid stored item still comes back, so the guard is not always-empty', () => {
    adapter.run(
      `INSERT INTO commerce_catalog_drafts (draft_id, catalog_id, state, items_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['good', CATALOG, 'prepared', JSON.stringify([item()]), 1, 1],
    );
    expect(new SQLiteCatalogDraftRepository(adapter).get('good')?.items).toEqual([item()]);
  });
});

/**
 * The claim columns, at the boundary the lease actually depends on.
 *
 * The service tests drive two `CatalogDraftService` instances over one
 * repository, which proves the claim is not held in a closure — but not that
 * it survives serialization. A claim that never reached SQLite would leave
 * every one of them green and the real restart unprotected.
 */
describe('the publication claim across the SQLite boundary', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'catalog-drafts-claim-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
  });
  afterEach(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives a NEW repository over the same database', () => {
    new SQLiteCatalogDraftRepository(adapter).put(
      draft({ publishClaim: { token: 'pcl_survivor', atMs: 1_800_000_500_000 } }),
    );

    // A second repository object — the restart, as far as this layer can see.
    const reopened = new SQLiteCatalogDraftRepository(adapter).get('draft-1');
    expect(reopened?.publishClaim).toEqual({ token: 'pcl_survivor', atMs: 1_800_000_500_000 });
  });

  it('reads a HALF-WRITTEN claim as no claim at all', () => {
    // Both halves or neither. A token with no timestamp can never expire, and
    // a timestamp with no token can never be released by its owner — either
    // one alone would wedge the draft, so the fail-closed reading here is the
    // one that leaves it editable rather than the one that looks safer.
    const repo = new SQLiteCatalogDraftRepository(adapter);
    repo.put(draft({ publishClaim: { token: 'pcl_half', atMs: 1_800_000_500_000 } }));

    adapter.run('UPDATE commerce_catalog_drafts SET publish_claimed_at_ms = 0 WHERE draft_id = ?', [
      'draft-1',
    ]);
    expect(new SQLiteCatalogDraftRepository(adapter).get('draft-1')?.publishClaim).toBeNull();

    repo.put(draft({ publishClaim: { token: 'pcl_half', atMs: 1_800_000_500_000 } }));
    adapter.run("UPDATE commerce_catalog_drafts SET publish_claim_token = '' WHERE draft_id = ?", [
      'draft-1',
    ]);
    expect(new SQLiteCatalogDraftRepository(adapter).get('draft-1')?.publishClaim).toBeNull();
  });
});

/**
 * The claim, driven against BOTH repositories from one body.
 *
 * The liveness rule is written twice — once as `claimIsLive`, which the double
 * calls, and once as a WHERE clause, because SQLite cannot call a TypeScript
 * function. Two expressions of one rule is exactly the shape that drifts, and
 * `forEachRepo` is the mechanism that stops it: a divergence fails here rather
 * than shipping as one behaviour on a phone and another on a server.
 */
const TTL = 5 * 60 * 1000;
const T0 = 1_800_000_500_000;

forEachRepo('a claim is taken when nobody holds one', (repo) => {
  repo.put(draft());
  expect(repo.claimForPublish('draft-1', 'tok-a', T0, TTL)).toBe(true);
  expect(repo.get('draft-1')?.publishClaim).toEqual({ token: 'tok-a', atMs: T0 });
});

forEachRepo('a second claimant is refused while the first is live', (repo) => {
  repo.put(draft());
  expect(repo.claimForPublish('draft-1', 'tok-a', T0, TTL)).toBe(true);
  expect(repo.claimForPublish('draft-1', 'tok-b', T0 + TTL - 1, TTL)).toBe(false);
  // AND THE HOLDER IS UNCHANGED. A refusal that still wrote would be worse
  // than one that let the second through, because both would think they won.
  expect(repo.get('draft-1')?.publishClaim).toEqual({ token: 'tok-a', atMs: T0 });
});

forEachRepo('a claim exactly at the TTL is abandoned, one millisecond earlier is not', (repo) => {
  // The boundary in both directions, because an off-by-one here is the
  // difference between a wedged draft and a lease that never holds.
  repo.put(draft());
  expect(repo.claimForPublish('draft-1', 'tok-a', T0, TTL)).toBe(true);
  expect(repo.claimForPublish('draft-1', 'tok-b', T0 + TTL - 1, TTL)).toBe(false);
  expect(repo.claimForPublish('draft-1', 'tok-c', T0 + TTL, TTL)).toBe(true);
  expect(repo.get('draft-1')?.publishClaim).toEqual({ token: 'tok-c', atMs: T0 + TTL });
});

forEachRepo('a claim stamped in the future is abandoned', (repo) => {
  repo.put(draft({ publishClaim: { token: 'from-the-future', atMs: T0 + 60 * 60 * 1000 } }));
  expect(repo.claimForPublish('draft-1', 'tok-a', T0, TTL)).toBe(true);
});

forEachRepo('a half-written claim is no claim', (repo) => {
  // The reader treats either half alone as absent, and acquisition has to
  // agree with the reader or a draft could read as free and refuse the claim.
  repo.put(draft({ publishClaim: { token: '', atMs: T0 } }));
  expect(repo.claimForPublish('draft-1', 'tok-a', T0, TTL)).toBe(true);
  repo.put(draft({ publishClaim: { token: 'tok-x', atMs: 0 } }));
  expect(repo.claimForPublish('draft-1', 'tok-b', T0, TTL)).toBe(true);
});

forEachRepo('a claim on a draft that does not exist is refused', (repo) => {
  expect(repo.claimForPublish('no-such-draft', 'tok-a', T0, TTL)).toBe(false);
});

forEachRepo('release clears our own claim', (repo) => {
  repo.put(draft());
  repo.claimForPublish('draft-1', 'tok-a', T0, TTL);
  repo.releaseClaim('draft-1', 'tok-a');
  expect(repo.get('draft-1')?.publishClaim).toBeNull();
});

forEachRepo('release leaves a claim that is NOT ours', (repo) => {
  // The overrun: we lost the claim to a successor while we were still
  // running, and dropping theirs on the way out would put both of us back
  // inside the window the lease exists to close.
  repo.put(draft());
  repo.claimForPublish('draft-1', 'tok-a', T0, TTL);
  repo.claimForPublish('draft-1', 'tok-b', T0 + TTL, TTL);
  repo.releaseClaim('draft-1', 'tok-a');
  expect(repo.get('draft-1')?.publishClaim).toEqual({ token: 'tok-b', atMs: T0 + TTL });
});

// ---------------------------------------------------------------------------
// §2.1 photo-extraction group
// ---------------------------------------------------------------------------

const PAGE_HASH = 'a'.repeat(64);
const EXTRACTION_DIGEST = 'b'.repeat(64);

function photoGroup(draftId = 'draft-1'): NonNullable<CatalogDraft['photoExtraction']> {
  return {
    manifest: [
      { artifact_id: 'img-1', content_hash: PAGE_HASH, page_index: 0 },
      { artifact_id: 'img-2', content_hash: 'c'.repeat(64), page_index: 1 },
    ],
    extractionDigest: EXTRACTION_DIGEST,
    binding: {
      binding_version: 1,
      draft_id: draftId,
      content_revision: 1,
      extraction_digest: EXTRACTION_DIGEST,
    },
  };
}

forEachRepo('the photo-extraction group survives a round trip whole', (repo) => {
  repo.put(draft({ photoExtraction: photoGroup() }));
  const read = repo.get('draft-1');
  expect(read?.photoExtraction).toEqual(photoGroup());
});

forEachRepo('absence of the group is preserved as null', (repo) => {
  repo.put(draft());
  expect(repo.get('draft-1')?.photoExtraction).toBeNull();
});

describe('photo-extraction fail-closed hydration (sqlite rows edited after writing)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let repo: SQLiteCatalogDraftRepository;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'catalog-drafts-photo-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    repo = new SQLiteCatalogDraftRepository(adapter);
    repo.put(draft({ photoExtraction: photoGroup() }));
  });
  afterEach(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function corrupt(column: string, value: string): void {
    adapter.run(`UPDATE commerce_catalog_drafts SET ${column} = ? WHERE draft_id = ?`, [
      value,
      'draft-1',
    ]);
  }

  it('a binding naming ANOTHER draft reads as absent', () => {
    // The binding is the chain link; a link to a different draft chains
    // nothing here, and half-believing it would defeat the cross-draft
    // property the digest exists for.
    corrupt(
      'extraction_binding_json',
      JSON.stringify({
        binding_version: 1,
        draft_id: 'draft-OTHER',
        content_revision: 1,
        extraction_digest: EXTRACTION_DIGEST,
      }),
    );
    expect(repo.get('draft-1')?.photoExtraction).toBeNull();
  });

  it('a binding naming a DIFFERENT digest reads as absent', () => {
    corrupt(
      'extraction_binding_json',
      JSON.stringify({
        binding_version: 1,
        draft_id: 'draft-1',
        content_revision: 1,
        extraction_digest: 'd'.repeat(64),
      }),
    );
    expect(repo.get('draft-1')?.photoExtraction).toBeNull();
  });

  it('a half-written group (digest without binding) reads as absent', () => {
    corrupt('extraction_binding_json', '');
    expect(repo.get('draft-1')?.photoExtraction).toBeNull();
  });

  it('a manifest whose page order was shuffled reads as absent', () => {
    // The manifest is ordered and the order is the commitment.
    corrupt(
      'extraction_manifest_json',
      JSON.stringify([
        { artifact_id: 'img-2', content_hash: 'c'.repeat(64), page_index: 1 },
        { artifact_id: 'img-1', content_hash: PAGE_HASH, page_index: 0 },
      ]),
    );
    expect(repo.get('draft-1')?.photoExtraction).toBeNull();
  });

  it('a corrupted digest column reads as absent', () => {
    corrupt('extraction_digest', 'not-hex');
    expect(repo.get('draft-1')?.photoExtraction).toBeNull();
  });

  it('the rest of the draft still hydrates when the group is refused', () => {
    // Fail-closed on the GROUP, not the draft: the seller can still open
    // it, see the chain is gone, and re-extract — a draft that vanished
    // would look like data loss.
    corrupt('extraction_digest', 'not-hex');
    const read = repo.get('draft-1');
    expect(read).not.toBeNull();
    expect(read?.rows.length).toBe(1);
  });
});
