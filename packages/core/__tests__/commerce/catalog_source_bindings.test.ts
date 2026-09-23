/**
 * The catalogue's remembered connector source (JIFFY_MERCHANT_INTEGRATION_PLAN
 * §3.1, A1): one row per catalogue, replaced on re-bind, both backends alike,
 * and the v47 table admits exactly the networked kinds.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemoryCatalogRefreshCommandRepository,
  SQLiteCatalogRefreshCommandRepository,
  type CatalogRefreshCommandRepository,
} from '../../src/commerce/catalog_refresh_commands';
import {
  InMemoryCatalogSourceBindingRepository,
  SQLiteCatalogSourceBindingRepository,
  isRefreshableConnectorKind,
  type CatalogSourceBindingRepository,
} from '../../src/commerce/catalog_source_bindings';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

const T0 = 1_800_000_000_000;

interface Backend {
  name: string;
  make: () => {
    repo: CatalogSourceBindingRepository;
    adapter: DatabaseAdapter | null;
    close: () => void;
  };
}
const backends: Backend[] = [
  {
    name: 'sqlite',
    make: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-bindings-'));
      const adapter = new NodeSQLiteAdapter({
        path: path.join(dir, 'identity.sqlite'),
        passphraseHex: randomBytes(32).toString('hex'),
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      });
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      return {
        repo: new SQLiteCatalogSourceBindingRepository(adapter),
        adapter,
        close: () => {
          adapter.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'memory',
    make: () => ({
      repo: new InMemoryCatalogSourceBindingRepository(),
      adapter: null,
      close: () => undefined,
    }),
  },
];

describe.each(backends)('catalog source bindings ($name)', ({ make }) => {
  let repo: CatalogSourceBindingRepository;
  let adapter: DatabaseAdapter | null;
  let close: () => void;
  beforeEach(() => {
    ({ repo, adapter, close } = make());
  });
  afterEach(() => close());

  it('round-trips, replaces on re-bind, returns copies, and deletes', () => {
    expect(repo.get('cat-1')).toBeNull();
    repo.put({
      catalogId: 'cat-1',
      kind: 'rest',
      credentialResource: 'catalog.source',
      operation: 'read_catalog',
      defaultScheme: 'sku',
      serviceRkey: null,
      boundAt: T0,
    });
    const first = repo.get('cat-1');
    expect(first).toEqual({
      catalogId: 'cat-1',
      kind: 'rest',
      credentialResource: 'catalog.source',
      operation: 'read_catalog',
      defaultScheme: 'sku',
      serviceRkey: null,
      boundAt: T0,
    });
    repo.put({
      catalogId: 'cat-1',
      kind: 'spreadsheet_url',
      credentialResource: null,
      operation: 'read_catalog',
      defaultScheme: 'gtin',
      serviceRkey: 'shop-1',
      boundAt: T0 + 1,
    });
    expect(repo.get('cat-1')).toEqual({
      catalogId: 'cat-1',
      kind: 'spreadsheet_url',
      credentialResource: null,
      operation: 'read_catalog',
      defaultScheme: 'gtin',
      serviceRkey: 'shop-1',
      boundAt: T0 + 1,
    });
    // A copy: mutating what came back changes nothing stored.
    const copy = repo.get('cat-1');
    if (copy !== null) copy.operation = 'mutated';
    expect(repo.get('cat-1')?.operation).toBe('read_catalog');
    repo.delete('cat-1');
    expect(repo.get('cat-1')).toBeNull();
  });

  it('the table admits only the networked kinds (sqlite)', () => {
    const db = adapter;
    if (db === null) return;
    expect(() =>
      db.run(
        `INSERT INTO commerce_catalog_source_bindings (catalog_id, kind, credential_resource, operation, default_scheme, service_rkey, bound_at) VALUES ('c', 'spreadsheet_upload', NULL, 'read_catalog', 'sku', NULL, 1)`,
        [],
      ),
    ).toThrow();
  });
});

describe('isRefreshableConnectorKind', () => {
  it('an upload has no source to pull again', () => {
    expect(isRefreshableConnectorKind('rest')).toBe(true);
    expect(isRefreshableConnectorKind('spreadsheet_url')).toBe(true);
    expect(isRefreshableConnectorKind('spreadsheet_upload')).toBe(false);
  });
});

describe.each(backends)('catalog refresh commands ($name)', ({ make }) => {
  let commands: CatalogRefreshCommandRepository;
  let close: () => void;
  beforeEach(() => {
    const made = make();
    close = made.close;
    commands =
      made.adapter === null
        ? new InMemoryCatalogRefreshCommandRepository()
        : new SQLiteCatalogRefreshCommandRepository(made.adapter);
  });
  afterEach(() => close());

  it('remembers what one command minted; the first writer wins; a null precondition round-trips as null', () => {
    expect(commands.get('cmd-1')).toBeNull();
    const first = {
      commandId: 'cmd-1',
      catalogId: 'cat-1',
      expectedSourceDigest: null,
      pullDigest: 'a'.repeat(64),
      draftId: 'cdr_int_1',
      createdAt: T0,
    };
    commands.put(first);
    expect(commands.get('cmd-1')).toEqual(first);
    commands.put({ ...first, catalogId: 'cat-other', draftId: 'cdr_int_2' });
    expect(commands.get('cmd-1')).toEqual(first);
    const pinned = {
      commandId: 'cmd-2',
      catalogId: 'cat-1',
      expectedSourceDigest: 'b'.repeat(64),
      pullDigest: 'b'.repeat(64),
      draftId: 'cdr_int_3',
      createdAt: T0 + 1,
    };
    commands.put(pinned);
    expect(commands.get('cmd-2')).toEqual(pinned);
    // Returned copies never alias the store.
    const read = commands.get('cmd-2');
    if (read !== null) read.draftId = 'tampered';
    expect(commands.get('cmd-2')?.draftId).toBe('cdr_int_3');
  });
});
