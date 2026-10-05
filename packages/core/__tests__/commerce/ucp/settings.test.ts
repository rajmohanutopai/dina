/**
 * The owner's UCP settings (UCP plan §4.2 U1, T-U1-13): which merchants Dina
 * may use, and which context fields leave with a search.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  ALLOWED_MERCHANTS_MAX,
  chooseMerchants,
  EMPTY_UCP_SETTINGS,
  readUcpSettings,
  UcpSettingsStore,
} from '../../../src/commerce/ucp/settings';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

const A = 'https://a-shop.example';
const B = 'https://b-shop.example';

describe('reading the owner’s settings', () => {
  it('normalises merchants to sorted, distinct origins and keeps only the context fields given', () => {
    expect(
      readUcpSettings({
        merchants: ['https://B-Shop.example', A, `${A}/`],
        context: { address_country: 'DE', language: 'de-DE', address_region: '', postal_code: '' },
      }),
    ).toEqual({
      ok: true,
      settings: {
        merchants: [A, B],
        context: { address_country: 'DE', language: 'de-DE' },
        order_webhooks: true,
      },
    });
  });

  it('a postal code leaves only when the owner entered one (that is the opt-in)', () => {
    const without = readUcpSettings({ merchants: [], context: { address_country: 'US' } });
    expect(without).toEqual({
      ok: true,
      settings: { merchants: [], context: { address_country: 'US' }, order_webhooks: true },
    });
    const withPostal = readUcpSettings({ merchants: [], context: { postal_code: '94043' } });
    expect(withPostal).toMatchObject({ ok: true, settings: { context: { postal_code: '94043' } } });
  });

  it('order webhooks are on unless the owner turns them off', () => {
    expect(readUcpSettings({ merchants: [] })).toMatchObject({
      settings: { order_webhooks: true },
    });
    expect(readUcpSettings({ merchants: [], order_webhooks: false })).toMatchObject({
      settings: { order_webhooks: false },
    });
    expect(readUcpSettings({ merchants: [], order_webhooks: 'no' })).toEqual({
      ok: false,
      field: 'order_webhooks',
    });
  });

  it('refuses each field that does not read, and anything it does not know', () => {
    const bad: [unknown, string][] = [
      [null, 'shape'],
      [{ merchants: [], extra: 1 }, 'shape'],
      [{ merchants: 'x' }, 'merchants'],
      [{ merchants: ['http://plain.example'] }, 'merchants'],
      [{ merchants: [1] }, 'merchants'],
      // A merchant is an origin: a page under it is not.
      [{ merchants: ['https://a-shop.example/products'] }, 'merchants'],
      [
        {
          merchants: Array.from(
            { length: ALLOWED_MERCHANTS_MAX + 1 },
            (_, i) => `https://s${i}.example`,
          ),
        },
        'merchants',
      ],
      [{ merchants: [], context: { address_country: 'Germany' } }, 'address_country'],
      [{ merchants: [], context: { address_country: 'de' } }, 'address_country'],
      [{ merchants: [], context: { language: 'english please' } }, 'language'],
      [{ merchants: [], context: { postal_code: '94043; DROP' } }, 'postal_code'],
      [{ merchants: [], context: { address_region: 'x'.repeat(65) } }, 'address_region'],
      [{ merchants: [], context: { latitude: 1 } }, 'shape'],
      [{ merchants: [], context: { signals: {} } }, 'shape'],
    ];
    for (const [value, field] of bad)
      expect([value, readUcpSettings(value)]).toEqual([value, { ok: false, field }]);
  });
});

describe('the store', () => {
  let dir: string;
  let db: NodeSQLiteAdapter;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ucp-settings-'));
    db = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: 'ee'.repeat(32),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(db, IDENTITY_MIGRATIONS);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('nothing saved is no merchants and no context; a save replaces the whole', () => {
    const store = new UcpSettingsStore(db);
    expect(store.get()).toEqual(EMPTY_UCP_SETTINGS);
    store.set({ merchants: [A, B], context: { address_country: 'DE' } }, 1);
    store.set({ merchants: [A], context: {} }, 2);
    expect(store.get()).toEqual({ merchants: [A], context: {}, order_webhooks: true });
    store.set({ merchants: [A], context: {}, order_webhooks: false }, 3);
    expect(store.get().order_webhooks).toBe(false);
    expect(db.query('SELECT COUNT(*) AS n FROM ucp_owner_settings')[0]?.n).toBe(1);
  });

  it('a shop saved under the older, looser rule is dropped on its own; the other shops and the context stay', () => {
    db.run(`INSERT INTO ucp_owner_settings (id, settings_json, updated_at) VALUES (1, ?, 1)`, [
      JSON.stringify({
        merchants: ['https://tea-shop', 'https://rice.example'],
        context: { address_country: 'DE' },
        order_webhooks: true,
      }),
    ]);
    expect(new UcpSettingsStore(db).get()).toEqual({
      merchants: ['https://rice.example'],
      context: { address_country: 'DE' },
      order_webhooks: true,
    });
  });

  it('a row that no longer reads is treated as nothing saved', () => {
    db.run(
      `INSERT INTO ucp_owner_settings (id, settings_json, updated_at) VALUES (1, '{"merchants":["http://x"]}', 1)`,
    );
    expect(new UcpSettingsStore(db).get()).toEqual(EMPTY_UCP_SETTINGS);
  });
});

describe('which merchants a search goes to', () => {
  const allowed = (merchants: string[]) => ({ merchants, context: {} });

  it('none allowed: no search', () => {
    expect(chooseMerchants([], allowed([]))).toEqual({ ok: false, reason: 'no_merchants_allowed' });
  });

  it('none named: every allowed merchant, when there are at most ten; with more, Brain must choose', () => {
    expect(chooseMerchants([], allowed([A, B]))).toEqual({ ok: true, merchants: [A, B] });
    const eleven = Array.from({ length: 11 }, (_, i) => `https://s${i}.example`);
    expect(chooseMerchants([], allowed(eleven))).toEqual({ ok: false, reason: 'choose_merchants' });
  });

  it('named: each must be allowed, however Brain spells it', () => {
    expect(chooseMerchants(['https://A-SHOP.example/'], allowed([A, B]))).toEqual({
      ok: true,
      merchants: [A],
    });
    expect(chooseMerchants(['https://elsewhere.example'], allowed([A]))).toEqual({
      ok: false,
      reason: 'merchant_not_allowed',
    });
    expect(chooseMerchants(['not a url'], allowed([A]))).toEqual({
      ok: false,
      reason: 'bad_merchants',
    });
  });
});
