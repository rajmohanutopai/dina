/**
 * The credential store, against a real SQLCipher database (§8.3 — WS-9.3).
 *
 * REAL SQL, NOT A FAKE. The rotation path is an `ON CONFLICT DO UPDATE` that
 * resets two columns, and the read paths name their columns so a `SELECT *`
 * can never carry the material into a caller. Neither of those is a claim an
 * in-memory double can check: a fake that stores objects would pass whatever
 * the SQL actually did.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemoryCredentialStore,
  SQLiteCredentialStore,
  type RotatableCredentialStore,
} from '../../src/commerce/credential_store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const PASSHEX = randomBytes(32).toString('hex');
const SECRET = 'sk-live-erp-token-0123456789abcd';

let dir: string;
let adapter: NodeSQLiteAdapter;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-credentials-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
});

afterEach(() => {
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Both implementations, so the double cannot drift from the real one. */
function stores(): [string, () => RotatableCredentialStore][] {
  return [
    ['sqlite', (): RotatableCredentialStore => new SQLiteCredentialStore(adapter)],
    ['in-memory', (): RotatableCredentialStore => new InMemoryCredentialStore()],
  ];
}

describe.each(stores())('credential store (%s)', (_name, make) => {
  it('stores material that only useSecret can reach', async () => {
    const store = make();
    store.rotate({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['read_catalog'],
      material: SECRET,
      nowMs: 1_000,
    });

    let seen: string | null = null;
    await store.useSecret('erp.primary', async (secret) => {
      seen = secret;
      return null;
    });
    expect(seen).toBe(SECRET);

    // Every OTHER read, serialised whole, and none of them carries it.
    expect(JSON.stringify(store.describe('erp.primary'))).not.toContain(SECRET);
    expect(JSON.stringify(store.list())).not.toContain(SECRET);
  });

  it('describes what an owner may know and nothing more', () => {
    const store = make();
    store.rotate({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['read_catalog', 'submit_purchase_order'],
      material: SECRET,
      nowMs: 4_200,
    });
    expect(store.describe('erp.primary')).toEqual({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['read_catalog', 'submit_purchase_order'],
      rotatedAtMs: 4_200,
      lastResult: 'never_used',
      lastCheckedAtMs: null,
    });
  });

  it('answers null for a resource it does not have', () => {
    expect(make().describe('nothing.here')).toBeNull();
  });

  it('refuses material that authenticates nothing', () => {
    const store = make();
    expect(
      store.rotate({
        resource: 'erp.primary',
        installId: 'install-1',
        operations: ['read_catalog'],
        material: '',
        nowMs: 1_000,
      }),
    ).toEqual({ ok: false, refusal: 'empty_material', error: expect.any(String) });
    expect(store.describe('erp.primary')).toBeNull();
  });

  it('refuses a credential granted no operations', () => {
    // All of the risk of holding a secret and none of the use.
    const store = make();
    expect(
      store.rotate({
        resource: 'erp.primary',
        installId: 'install-1',
        operations: [],
        material: SECRET,
        nowMs: 1_000,
      }),
    ).toMatchObject({ ok: false, refusal: 'no_operations' });
  });

  it('refuses a credential belonging to nobody', () => {
    const store = make();
    expect(
      store.rotate({
        resource: 'erp.primary',
        installId: '',
        operations: ['read_catalog'],
        material: SECRET,
        nowMs: 1_000,
      }),
    ).toMatchObject({ ok: false, refusal: 'empty_install' });
    expect(
      store.rotate({
        resource: '',
        installId: 'install-1',
        operations: ['read_catalog'],
        material: SECRET,
        nowMs: 1_000,
      }),
    ).toMatchObject({ ok: false, refusal: 'empty_resource' });
  });

  it('replaces rather than versions, so a rotated-away credential is gone', async () => {
    const store = make();
    store.rotate({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['read_catalog'],
      material: SECRET,
      nowMs: 1_000,
    });
    store.rotate({
      resource: 'erp.primary',
      installId: 'install-2',
      operations: ['submit_purchase_order'],
      material: 'sk-live-replacement-000000000000',
      nowMs: 2_000,
    });

    const seen: string[] = [];
    await store.useSecret('erp.primary', async (secret) => {
      seen.push(secret);
      return null;
    });
    expect(seen).toEqual(['sk-live-replacement-000000000000']);
    expect(store.describe('erp.primary')).toMatchObject({
      installId: 'install-2',
      operations: ['submit_purchase_order'],
      rotatedAtMs: 2_000,
    });
    // ONE row, not two. Keeping the old material "just in case" is how a
    // revoked credential keeps working.
    expect(store.list()).toHaveLength(1);
  });

  it('resets the verdict on rotation', () => {
    const store = make();
    store.rotate({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['read_catalog'],
      material: SECRET,
      nowMs: 1_000,
    });
    store.recordResult('erp.primary', true, 1_500);
    expect(store.describe('erp.primary')).toMatchObject({ lastResult: 'ok' });

    store.rotate({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['read_catalog'],
      material: 'sk-live-replacement-000000000000',
      nowMs: 2_000,
    });
    expect(store.describe('erp.primary')).toMatchObject({
      lastResult: 'never_used',
      lastCheckedAtMs: null,
    });
  });

  it('distinguishes forgetting something from forgetting nothing', () => {
    const store = make();
    store.rotate({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['read_catalog'],
      material: SECRET,
      nowMs: 1_000,
    });
    expect(store.forget('erp.primary')).toBe(true);
    expect(store.forget('erp.primary')).toBe(false);
    expect(store.describe('erp.primary')).toBeNull();
  });

  it('throws rather than running an operation with no credential', async () => {
    await expect(make().useSecret('erp.primary', async () => null)).rejects.toThrow(
      /not configured/,
    );
  });

  it('lists in a stable order', () => {
    const store = make();
    for (const resource of ['zed.last', 'alpha.first', 'mid.one']) {
      store.rotate({
        resource,
        installId: 'install-1',
        operations: ['read_catalog'],
        material: SECRET,
        nowMs: 1_000,
      });
    }
    expect(store.list().map((status) => status.resource)).toEqual([
      'alpha.first',
      'mid.one',
      'zed.last',
    ]);
  });

  it('recording against a resource that is gone changes nothing', () => {
    const store = make();
    store.recordResult('never.existed', false, 5_000);
    expect(store.list()).toEqual([]);
  });
});

describe('a tampered row is read toward refusing (sqlite)', () => {
  it('an unreadable operations list authorizes nothing', () => {
    const store = new SQLiteCredentialStore(adapter);
    store.rotate({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['read_catalog'],
      material: SECRET,
      nowMs: 1_000,
    });
    // BOTH failures, because they take different branches: one throws out of
    // the parser, the other parses cleanly into the wrong shape. An earlier
    // version of this test covered only the first, and a mutation that made
    // the second read as unrestricted survived.
    for (const tampered of ['not json', '{"read_catalog": true}', '"read_catalog"', 'null']) {
      adapter.execute(`UPDATE commerce_credentials SET operations_json = ? WHERE resource = ?`, [
        tampered,
        'erp.primary',
      ]);
      // Empty, so every brokered call refuses `operation_not_declared`.
      // Believing a partially parsed list would let a corrupted row widen what
      // a secret is good for.
      expect(store.describe('erp.primary')?.operations).toEqual([]);
    }

    // A list carrying non-strings keeps only the strings, for the same reason.
    adapter.execute(`UPDATE commerce_credentials SET operations_json = ? WHERE resource = ?`, [
      '["read_catalog", 7, null, {"op": "submit"}]',
      'erp.primary',
    ]);
    expect(store.describe('erp.primary')?.operations).toEqual(['read_catalog']);
  });

  it('an unrecognised verdict reads as never used, not as working', () => {
    const store = new SQLiteCredentialStore(adapter);
    store.rotate({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['read_catalog'],
      material: SECRET,
      nowMs: 1_000,
    });
    adapter.execute(`UPDATE commerce_credentials SET last_result = ? WHERE resource = ?`, [
      'probably-fine',
      'erp.primary',
    ]);
    expect(store.describe('erp.primary')?.lastResult).toBe('never_used');
  });

  it('keeps the material out of the row a status read returns', () => {
    const store = new SQLiteCredentialStore(adapter);
    store.rotate({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['read_catalog'],
      material: SECRET,
      nowMs: 1_000,
    });
    // The column IS there — this is the store that owns it.
    const raw = adapter.query(`SELECT material FROM commerce_credentials`) as unknown as {
      material: string;
    }[];
    expect(raw[0]?.material).toBe(SECRET);
    // And no status read has a field it could travel in.
    const status = store.describe('erp.primary');
    expect(status).not.toBeNull();
    expect(Object.keys(status ?? {})).toEqual([
      'resource',
      'installId',
      'operations',
      'rotatedAtMs',
      'lastResult',
      'lastCheckedAtMs',
    ]);
  });
});
