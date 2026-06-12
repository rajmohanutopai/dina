/**
 * Real-adapter tests: SQLite ledger on a real database, the ES256
 * DeviceCheck JWT against node:crypto verification, DeviceCheck
 * response handling, and OpenRouter response extraction — everything
 * verifiable without live credentials.
 */

import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDeviceCheckJWT, DeviceCheckClient } from '../src/devicecheck';
import { SqliteGrantLedger } from '../src/ledger';
import { extractKey } from '../src/openrouter_provisioner';

describe('SqliteGrantLedger (real sqlite)', () => {
  let dir: string;
  let ledger: SqliteGrantLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'grants-test-'));
    ledger = new SqliteGrantLedger(join(dir, 'ledger.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts and counts within the window', () => {
    const t0 = 1_000_000;
    ledger.insert({ grantId: 'g1', orKeyId: 'k1', platform: 'ios', grantedAt: t0 });
    ledger.insert({ grantId: 'g2', orKeyId: 'k2', platform: 'ios', grantedAt: t0 + 10 });
    ledger.insert({ grantId: 'g3', orKeyId: 'k3', platform: 'ios', grantedAt: t0 + 20 });
    expect(ledger.countSince(t0 + 10)).toBe(2);
    expect(ledger.countSince(t0 + 21)).toBe(0);
    expect(ledger.countSince(0)).toBe(3);
  });

  it('rejects duplicate grant ids (primary key)', () => {
    ledger.insert({ grantId: 'g1', orKeyId: 'k1', platform: 'ios', grantedAt: 1 });
    expect(() =>
      ledger.insert({ grantId: 'g1', orKeyId: 'k2', platform: 'ios', grantedAt: 2 }),
    ).toThrow();
  });

  it('schema is identity-free: exactly the four ops columns', () => {
    // Pin the privacy property structurally — adding a did/device/ip
    // column fails this test and forces a conscious spec change.
    const db = (ledger as unknown as { db: import('better-sqlite3').Database }).db;
    const cols = db.prepare("PRAGMA table_info('grants')").all() as { name: string }[];
    expect(cols.map((c) => c.name).sort()).toEqual([
      'grant_id',
      'granted_at',
      'or_key_id',
      'platform',
    ]);
  });
});

describe('buildDeviceCheckJWT (ES256, no JWT library)', () => {
  it('produces a verifiable ES256 JWT with kid/iss/iat', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const jwt = buildDeviceCheckJWT({
      teamId: '9DCZ8PHCDP',
      keyId: 'KEYID12345',
      privateKeyPem: pem,
      nowMs: 1_750_000_000_000,
    });

    const [h, p, s] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(header).toEqual({ alg: 'ES256', kid: 'KEYID12345' });
    expect(payload).toEqual({ iss: '9DCZ8PHCDP', iat: 1_750_000_000 });

    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    expect(ok).toBe(true);
  });
});

describe('DeviceCheckClient response handling', () => {
  function makeClient(responses: { status: number; body: string }[]): DeviceCheckClient {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const queue = [...responses];
    const fetchImpl = (async () => {
      const r = queue.shift();
      if (r === undefined) throw new Error('unexpected extra fetch');
      return new Response(r.body, { status: r.status });
    }) as typeof fetch;
    return new DeviceCheckClient({
      teamId: 'T',
      keyId: 'K',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      env: 'development',
      fetchImpl,
    });
  }

  it('200 with bit0=true → claimed', async () => {
    const c = makeClient([{ status: 200, body: '{"bit0":true,"bit1":false}' }]);
    expect(await c.check('tok')).toEqual({ claimed: true });
  });

  it('200 with bit0=false → not claimed', async () => {
    const c = makeClient([{ status: 200, body: '{"bit0":false,"bit1":false}' }]);
    expect(await c.check('tok')).toEqual({ claimed: false });
  });

  it('200 with non-JSON "no bit state" message → valid device, not claimed', async () => {
    const c = makeClient([{ status: 200, body: 'Failed to find bit state' }]);
    expect(await c.check('tok')).toEqual({ claimed: false });
  });

  it('400 (bad token) → invalid (terminal)', async () => {
    const c = makeClient([{ status: 400, body: 'Missing or incorrectly formatted device token' }]);
    expect(await c.check('tok')).toBe('invalid');
  });

  it.each([[500], [503], [429], [401]])(
    'Apple %s → unavailable (transient — never bricks a real device)',
    async (status) => {
      const c = makeClient([{ status, body: 'trouble' }]);
      expect(await c.check('tok')).toBe('unavailable');
    },
  );

  it('network error reaching Apple → unavailable', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const c = new DeviceCheckClient({
      teamId: 'T',
      keyId: 'K',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      env: 'development',
      fetchImpl: (async () => {
        throw new Error('ECONNRESET');
      }) as typeof fetch,
    });
    expect(await c.check('tok')).toBe('unavailable');
  });

  it('setClaimed throws on non-200 (pipeline logs the bounded double-grant)', async () => {
    const c = makeClient([{ status: 500, body: 'oops' }]);
    await expect(c.setClaimed('tok')).rejects.toThrow('HTTP 500');
  });
});

describe('extractKey (OpenRouter response tolerance)', () => {
  it('documented shape: { key, data: { hash } }', () => {
    expect(extractKey({ key: 'sk-or-v1-x', data: { hash: 'h1' } })).toEqual({
      key: 'sk-or-v1-x',
      orKeyId: 'h1',
    });
  });

  it('flat variant: { key, hash }', () => {
    expect(extractKey({ key: 'sk', hash: 'h2' })).toEqual({ key: 'sk', orKeyId: 'h2' });
  });

  it('nested key variant: { data: { key, id } }', () => {
    expect(extractKey({ data: { key: 'sk2', id: 'id3' } })).toEqual({
      key: 'sk2',
      orKeyId: 'id3',
    });
  });

  it('missing key → null (pipeline fails closed as provisioning_unavailable)', () => {
    expect(extractKey({ data: { hash: 'h' } })).toBeNull();
    expect(extractKey('nope')).toBeNull();
    expect(extractKey(null)).toBeNull();
  });

  it('missing key id FAILS CLOSED — a grant we cannot later revoke must not mint', () => {
    expect(extractKey({ key: 'sk' })).toBeNull();
  });
});
