/**
 * SHELF_SPACE_NEGOTIATION and the move to a new machine (user story 08): the
 * term engine's whole state travels in the export archive. A restored store
 * keeps its private floors and holdings, the deals it signed, the answers it
 * gave (so a resend is answered as before, never decided afresh), and the
 * send intents still owed a receipt.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  createArchive,
  importArchive,
  setArchiveDataSource,
  type ArchiveDataSource,
} from '../../../src/export/archive';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

import { publishListing , BRAND_DID, Fleet, juicePolicy, STORE_DID } from './term_harness';


const PASS = 'archive passphrase for shelf space';
const TERM_TABLES = [
  'commerce_term_documents',
  'commerce_term_outbox',
  'commerce_term_answers',
  'commerce_term_held',
  'commerce_term_policy',
  'commerce_term_listings',
  'commerce_term_negotiations',
  'commerce_term_cards',
  'commerce_term_floor_authorizations',
];

function source(identity: NodeSQLiteAdapter): ArchiveDataSource {
  return {
    identityAdapter: () => identity,
    personaSources: async () => [],
    openPersonaForRestore: async () => {
      throw new Error('no persona in this archive');
    },
    hasExistingUserData: async () => false,
  };
}

function rows(db: NodeSQLiteAdapter, table: string): unknown[] {
  return db.query(`SELECT * FROM ${table} ORDER BY 1`);
}

describe('the term engine in the export archive', () => {
  let fleet: Fleet;
  let dir: string;
  let target: NodeSQLiteAdapter | null = null;
  beforeEach(() => {
    fleet = new Fleet();
    dir = mkdtempSync(path.join(tmpdir(), 'dina-term-archive-'));
  });
  afterEach(() => {
    setArchiveDataSource(null);
    target?.close();
    target = null;
    fleet.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a store and a brand moved to new machines hold every term row they held before', async () => {
    const store = fleet.add(STORE_DID);
    const set = store.engine.setPolicy(
      juicePolicy({
        manual_holdings: [
          {
            holding_id: 'h1',
            tag: 'beverages.juice',
            start: '2027-01-01T00:00:00Z',
            end: '2027-12-01T00:00:00Z',
          },
        ],
      }),
    );
    if (!set.ok) throw new Error(set.refusal);
    const published = publishListing(store, {
      listingId: 'slot-3',
      resourceRef: 'slot-3',
      kind: 'shelf',
      region: { scheme: 'postal_area', value: 'IN-560034' },
      tags: ['beverages.juice'],
    });
    if (!published.ok) throw new Error(published.refusal);
    const brand = fleet.add(BRAND_DID);
    const started = brand.engine.startNegotiation({
      listing: published.listing,
      listingUri: published.uri,
      tag: 'beverages.juice',
      attributes: { skus: 4 },
      start: '2027-02-01T00:00:00Z',
      end: '2027-08-01T00:00:00Z',
      policy: {
        currency: 'INR',
        targets: { fee: '170000', share_bps: '600' },
        ceilings: { fee: '300000', share_bps: '1000' },
        max_rounds: 3,
        deadline_seconds: 3 * 24 * 60 * 60,
      },
    });
    if (!started.ok) throw new Error(started.refusal);
    fleet.pump();
    // Between them the two nodes have a row in every table but the two that
    // fill only on rarer paths (held documents, floor authorisations): the
    // store's policy, listing, offers, answers and outbox; the brand's
    // request, negotiation and its card for the offer Dina found.
    for (const table of TERM_TABLES) {
      if (table === 'commerce_term_held' || table === 'commerce_term_floor_authorizations')
        continue;
      const held = rows(store.db(), table).length + rows(brand.db(), table).length;
      expect([table, held > 0]).toEqual([table, true]);
    }

    for (const [index, node] of [store, brand].entries()) {
      setArchiveDataSource(source(node.db()));
      const archive = await createArchive(PASS);
      target?.close();
      target = new NodeSQLiteAdapter({
        path: path.join(dir, `restored-${String(index)}.sqlite`),
        passphraseHex: randomBytes(32).toString('hex'),
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      });
      applyMigrations(target, IDENTITY_MIGRATIONS);
      setArchiveDataSource(source(target));
      await importArchive(archive, PASS);
      for (const table of TERM_TABLES) {
        expect([node.did, table, rows(target, table)]).toEqual([
          node.did,
          table,
          rows(node.db(), table),
        ]);
      }
    }
  });
});
