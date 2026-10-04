/**
 * The listing config revision (A2A design §7.2 step 9, §9): an inbound
 * execution snapshot pins it, so every write to `config_json` bumps it — the
 * repository's upsert and the plugin-update rebind alike — and a timestamp
 * never stands in for it. On an install that gains the column, existing rows
 * start at 0 and the next write moves them on.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { rebindListingsForUpdate } from '../../src/service/listing_rebind';
import { SQLiteServiceConfigRepository } from '../../src/service/service_config_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { ServiceConfig } from '@dina/protocol';

let dir: string;
let db: NodeSQLiteAdapter;

function open(): NodeSQLiteAdapter {
  return new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: 'cd'.repeat(32),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'config-revision-'));
  db = open();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const revisionOf = (rkey: string) =>
  db.query<{ revision: number }>('SELECT revision FROM service_configs WHERE rkey = ?', [rkey])[0]?.revision;

const listing = (cid: string): ServiceConfig => ({
  isDiscoverable: true,
  name: 'Shop',
  capabilities: {
    order_status: {
      responsePolicy: 'auto',
      pluginInstallId: 'inst-1',
      pluginManifestCid: cid,
      pluginCapabilityId: 'com.acme.order_status',
    },
  },
});

describe('service_configs.revision', () => {
  it('starts at 1 on the first save and counts every save', async () => {
    applyMigrations(db, IDENTITY_MIGRATIONS);
    const repo = new SQLiteServiceConfigRepository(db);
    await repo.put('self', JSON.stringify(listing('bafy-a')), 1_000);
    expect(revisionOf('self')).toBe(1);
    await repo.put('self', JSON.stringify(listing('bafy-a')), 1_000);
    await repo.put('self', JSON.stringify(listing('bafy-b')), 2_000);
    expect(revisionOf('self')).toBe(3);
  });

  it('a listing deleted and made again keeps counting up', async () => {
    applyMigrations(db, IDENTITY_MIGRATIONS);
    const repo = new SQLiteServiceConfigRepository(db);
    await repo.put('self', JSON.stringify(listing('bafy-a')), 1_000);
    await repo.put('self', JSON.stringify(listing('bafy-a')), 1_000);
    await repo.remove('self');
    await repo.put('self', JSON.stringify(listing('bafy-b')), 2_000);
    expect(revisionOf('self')).toBe(3);
    await repo.remove('self');
    await repo.remove('self');
    await repo.put('self', JSON.stringify(listing('bafy-c')), 3_000);
    expect(revisionOf('self')).toBe(4);
  });

  it('a plugin-update rebind bumps the listings it rewrites, and only those', async () => {
    applyMigrations(db, IDENTITY_MIGRATIONS);
    const repo = new SQLiteServiceConfigRepository(db);
    await repo.put('self', JSON.stringify(listing('bafy-old')), 1_000);
    await repo.put('other', JSON.stringify(listing('bafy-unrelated')), 1_000);
    const result = rebindListingsForUpdate(db, { installId: 'inst-1', fromCid: 'bafy-old', toCid: 'bafy-new' });
    expect(result.rebound).toEqual(['self']);
    expect(revisionOf('self')).toBe(2);
    expect(revisionOf('other')).toBe(1);
  });

  it('an install that gains the column starts existing rows at 0, and the next write moves them on', async () => {
    applyMigrations(db, IDENTITY_MIGRATIONS.filter((m) => m.version < 56));
    db.execute(
      `INSERT INTO service_configs (rkey, config_json, created_at, updated_at) VALUES ('self', ?, 1, 1)`,
      [JSON.stringify(listing('bafy-a'))],
    );
    applyMigrations(db, IDENTITY_MIGRATIONS);
    expect(revisionOf('self')).toBe(0);
    await new SQLiteServiceConfigRepository(db).put('self', JSON.stringify(listing('bafy-a')), 2);
    expect(revisionOf('self')).toBe(1);
  });
});
