/**
 * §4.2's reservation ledger — the named tests, by name.
 *
 * The design's four confirmation rounds each caught this machinery's
 * previous draft (per-draft counter, check-not-claim, undefined identity,
 * claims with no death), so every rule those rounds produced appears here
 * as a test: the claim, the idempotent re-claim, the refusal naming its
 * owner, the mint skipping claimed values, the monotonic high-water, the
 * release of unpublished claims, and the survival of published ones.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemorySkuLedgerRepository,
  newAssignmentId,
  renderMintedValue,
  SQLiteSkuLedgerRepository,
  type SkuLedgerRepository,
} from '../../src/commerce/sku_ledger';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const ISSUER = 'did:plc:pickleseller';
const T0 = 1_800_000_000_000;

function claimArgs(overrides: Partial<Parameters<SkuLedgerRepository['claim']>[0]> = {}) {
  return {
    issuerDid: ISSUER,
    scheme: 'manufacturer_sku',
    value: 'P-0001',
    assignmentId: 'asg_one',
    catalogId: 'pickles-main',
    draftId: 'draft-1',
    nowMs: T0,
    ...overrides,
  };
}

function forEachRepo(name: string, body: (repo: SkuLedgerRepository) => void): void {
  describe(name, () => {
    let dir: string;
    let adapter: NodeSQLiteAdapter;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'sku-ledger-'));
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
      body(new SQLiteSkuLedgerRepository(adapter));
    });
    it('in-memory double', () => {
      body(new InMemorySkuLedgerRepository());
    });
  });
}

forEachRepo('a fresh value claims; the same assignment re-claims idempotently', (repo) => {
  expect(repo.claim(claimArgs())).toEqual({ outcome: 'claimed' });
  // An SKU edit and a republication are both re-claims by the owner.
  expect(repo.claim(claimArgs({ draftId: 'draft-2' }))).toEqual({ outcome: 'already_owned' });
});

forEachRepo('EDIT COLLISION: a claim held by another assignment refuses, naming its owner', (repo) => {
  repo.claim(claimArgs());
  expect(repo.claim(claimArgs({ assignmentId: 'asg_two', draftId: 'draft-2' }))).toEqual({
    outcome: 'refused',
    owningCatalogId: 'pickles-main',
    owningAssignmentId: 'asg_one',
  });
});

forEachRepo('SECOND CATALOG: v1 one-catalog rule — the refusal names the owning catalog', (repo) => {
  repo.claim(claimArgs());
  const second = repo.claim(
    claimArgs({ assignmentId: 'asg_other', catalogId: 'pickles-secondary', draftId: 'draft-9' }),
  );
  // The same printed SKU in a second catalog's draft is a DIFFERENT
  // assignment (equality cannot be derived from editable values), so the
  // claim refuses and the finding can say which catalog owns it.
  expect(second).toEqual({
    outcome: 'refused',
    owningCatalogId: 'pickles-main',
    owningAssignmentId: 'asg_one',
  });
});

forEachRepo('TWO CONCURRENT EDITS claiming one value: exactly one wins', (repo) => {
  const a = repo.claim(claimArgs({ assignmentId: 'asg_a', draftId: 'draft-a' }));
  const b = repo.claim(claimArgs({ assignmentId: 'asg_b', draftId: 'draft-b' }));
  const outcomes = [a.outcome, b.outcome].sort();
  expect(outcomes).toEqual(['claimed', 'refused']);
});

forEachRepo('SOURCE ROW CARRYING P-0001 before the mint reaches it: the mint skips it', (repo) => {
  // A photographed page already carries a printed P-0001; the model read it
  // and the row claimed it. The allocator must never issue that value.
  repo.claim(claimArgs({ value: renderMintedValue(1) }));
  expect(repo.mintNextValue(ISSUER, 'manufacturer_sku')).toBe(renderMintedValue(2));
});

forEachRepo('INHERITED HIGH-WATER: inherit P-0003, mint next -> P-0004', (repo) => {
  // Draft 1 minted three values and published.
  for (let i = 1; i <= 3; i += 1) {
    const value = repo.mintNextValue(ISSUER, 'manufacturer_sku');
    repo.claim(claimArgs({ value, assignmentId: `asg_${String(i)}` }));
  }
  repo.markPublished('draft-1');
  // The republication draft (draft-2) inherits assignments AND the
  // high-water mark — its first new identifier-less row mints P-0004,
  // never a collision with its own inherited P-0001..P-0003.
  expect(repo.highWater(ISSUER)).toBe(3);
  const next = repo.mintNextValue(ISSUER, 'manufacturer_sku');
  expect(next).toBe(renderMintedValue(4));
  expect(repo.claim(claimArgs({ value: next, assignmentId: 'asg_4', draftId: 'draft-2' }))).toEqual(
    { outcome: 'claimed' },
  );
});

forEachRepo('DELETED-PRODUCT VALUE never re-issued: the high-water mark does not rewind', (repo) => {
  const value = repo.mintNextValue(ISSUER, 'manufacturer_sku');
  repo.claim(claimArgs({ value }));
  // The product is removed and its unpublished draft erased — the claim
  // releases, the number does not come back.
  repo.releaseUnpublished('draft-1');
  expect(repo.holder(ISSUER, 'manufacturer_sku', value)).toBeNull();
  expect(repo.mintNextValue(ISSUER, 'manufacturer_sku')).toBe(renderMintedValue(2));
});

forEachRepo('ERASE-UNPUBLISHED-THEN-REPHOTOGRAPH: every claim succeeds afterwards', (repo) => {
  // The seller's most ordinary recovery: give up on a half-repaired draft,
  // re-photograph the same page. The dead draft's claims must not wedge
  // the printed SKUs behind refusals.
  repo.claim(claimArgs({ value: 'JAR-RED-01', assignmentId: 'asg_dead1' }));
  repo.claim(claimArgs({ value: 'JAR-GRN-02', assignmentId: 'asg_dead2' }));
  repo.releaseUnpublished('draft-1');

  expect(
    repo.claim(claimArgs({ value: 'JAR-RED-01', assignmentId: 'asg_new1', draftId: 'draft-2' })),
  ).toEqual({ outcome: 'claimed' });
  expect(
    repo.claim(claimArgs({ value: 'JAR-GRN-02', assignmentId: 'asg_new2', draftId: 'draft-2' })),
  ).toEqual({ outcome: 'claimed' });
});

forEachRepo('a PUBLISHED claim survives its draft\'s erasure for ever', (repo) => {
  repo.claim(claimArgs());
  repo.markPublished('draft-1');
  repo.releaseUnpublished('draft-1');
  // Something public references it; the identity must not be reusable.
  expect(repo.holder(ISSUER, 'manufacturer_sku', 'P-0001')).toEqual({
    assignmentId: 'asg_one',
    catalogId: 'pickles-main',
    published: true,
  });
  expect(repo.claim(claimArgs({ assignmentId: 'asg_squatter', draftId: 'draft-9' }))).toMatchObject(
    { outcome: 'refused' },
  );
});

forEachRepo('SAME-ASSIGNMENT SKU EDIT: the new value claims cleanly, the old stays reserved', (repo) => {
  repo.claim(claimArgs({ value: 'P-0001' }));
  // The seller edits the cell — same product, new value.
  expect(repo.claim(claimArgs({ value: 'PICKLE-RED' }))).toEqual({ outcome: 'claimed' });
  // The superseded value remains reserved to the same assignment; a rival
  // product cannot squat on it and fork history.
  expect(
    repo.claim(claimArgs({ value: 'P-0001', assignmentId: 'asg_rival', draftId: 'draft-9' })),
  ).toMatchObject({ outcome: 'refused' });
});

forEachRepo('two issuers never see each other\'s ledgers', (repo) => {
  repo.claim(claimArgs());
  expect(
    repo.claim(claimArgs({ issuerDid: 'did:plc:chairmaker', assignmentId: 'asg_theirs' })),
  ).toEqual({ outcome: 'claimed' });
  expect(repo.mintNextValue('did:plc:chairmaker', 'manufacturer_sku')).toBe(renderMintedValue(2));
  expect(repo.highWater(ISSUER)).toBe(0);
});

describe('CRASH BETWEEN CLAIM AND PERSIST (sqlite): one transaction, nothing half-owned', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sku-ledger-txn-'));
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

  it('a claim inside a rolled-back outer transaction leaves no reservation', () => {
    const repo = new SQLiteSkuLedgerRepository(adapter);
    expect(() => {
      adapter.transaction(() => {
        repo.claim(claimArgs());
        // The draft mutation that would have recorded the assignment dies
        // here — and the claim must die with it, or a crash leaves a
        // reservation no draft can prove it owns.
        throw new Error('process died before the draft row was written');
      });
    }).toThrow('process died');
    expect(repo.holder(ISSUER, 'manufacturer_sku', 'P-0001')).toBeNull();
  });

  it('assignment ids are unguessable and distinct', () => {
    expect(newAssignmentId()).not.toBe(newAssignmentId());
    expect(newAssignmentId().startsWith('asg_')).toBe(true);
  });
});
