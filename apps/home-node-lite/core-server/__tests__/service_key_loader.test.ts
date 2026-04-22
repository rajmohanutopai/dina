/**
 * Task 5.8 — service key loader tests.
 */

import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BRAIN_KEY_FILENAME,
  ED25519_SEED_BYTES,
  FINGERPRINT_HEX_LENGTH,
  loadServiceKey,
  type ServiceKeyLoadInput,
  type ServiceKeyLoadOutcome,
} from '../src/brain/service_key_loader';

function seed(byteValue = 0x7): Uint8Array {
  const b = new Uint8Array(ED25519_SEED_BYTES);
  for (let i = 0; i < b.length; i++) b[i] = (byteValue + i) & 0xff;
  return b;
}

/** In-memory `readFileFn` that serves a map of path → bytes; emulates ENOENT. */
function memReader(map: Map<string, Uint8Array>): ServiceKeyLoadInput['readFileFn'] {
  return async (path: string) => {
    const bytes = map.get(path);
    if (!bytes) {
      const e: NodeJS.ErrnoException = new Error(`ENOENT: ${path}`);
      e.code = 'ENOENT';
      throw e;
    }
    return bytes;
  };
}

describe('constants (task 5.8)', () => {
  it('ED25519_SEED_BYTES is 32', () => {
    expect(ED25519_SEED_BYTES).toBe(32);
  });
  it('DEFAULT_BRAIN_KEY_FILENAME is brain.ed25519', () => {
    expect(DEFAULT_BRAIN_KEY_FILENAME).toBe('brain.ed25519');
  });
  it('FINGERPRINT_HEX_LENGTH is 16 (8 bytes rendered as hex)', () => {
    expect(FINGERPRINT_HEX_LENGTH).toBe(16);
  });
});

describe('loadServiceKey input validation (task 5.8)', () => {
  it.each([
    ['null input', null, 'input is required'],
    ['non-object input', 'bogus', 'input is required'],
  ] as const)('%s → invalid_input', async (_label, value, detail) => {
    const r = (await loadServiceKey(value as unknown as ServiceKeyLoadInput)) as Extract<
      ServiceKeyLoadOutcome,
      { ok: false }
    >;
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_input');
    expect(r.detail).toBe(detail);
  });

  it.each([
    ['missing keyDir', {}],
    ['empty keyDir', { keyDir: '' }],
    ['non-string keyDir', { keyDir: 42 as unknown as string }],
  ] as const)('%s → invalid_input', async (_label, input) => {
    const r = (await loadServiceKey(input as ServiceKeyLoadInput)) as Extract<
      ServiceKeyLoadOutcome,
      { ok: false }
    >;
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_input');
    expect(r.detail).toMatch(/keyDir/);
  });

  it.each([
    ['empty fileName', ''],
    ['non-string fileName', 42 as unknown as string],
  ] as const)('%s → invalid_input', async (_label, fileName) => {
    const r = (await loadServiceKey({
      keyDir: '/opt/dina/keys',
      fileName,
    } as ServiceKeyLoadInput)) as Extract<ServiceKeyLoadOutcome, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_input');
    expect(r.detail).toMatch(/fileName/);
  });
});

describe('loadServiceKey happy path (task 5.8)', () => {
  it('loads a 32-byte seed + returns fingerprint + path', async () => {
    const keyBytes = seed(0x42);
    const dir = '/opt/dina/keys';
    const path = join(dir, 'brain.ed25519');
    const reader = memReader(new Map([[path, keyBytes]]));

    const r = (await loadServiceKey({
      keyDir: dir,
      readFileFn: reader,
    })) as Extract<ServiceKeyLoadOutcome, { ok: true }>;

    expect(r.ok).toBe(true);
    expect(r.seed.byteLength).toBe(32);
    expect(Array.from(r.seed)).toEqual(Array.from(keyBytes));
    expect(r.path).toBe(path);
    expect(r.fingerprint).toHaveLength(FINGERPRINT_HEX_LENGTH);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('same seed produces deterministic fingerprint', async () => {
    const keyBytes = seed(0x11);
    const reader = memReader(
      new Map([[join('/k', 'brain.ed25519'), keyBytes]]),
    );
    const r1 = (await loadServiceKey({
      keyDir: '/k',
      readFileFn: reader,
    })) as Extract<ServiceKeyLoadOutcome, { ok: true }>;
    const r2 = (await loadServiceKey({
      keyDir: '/k',
      readFileFn: reader,
    })) as Extract<ServiceKeyLoadOutcome, { ok: true }>;
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it('different seeds produce different fingerprints', async () => {
    const reader = memReader(
      new Map([
        [join('/a', 'brain.ed25519'), seed(0x01)],
        [join('/b', 'brain.ed25519'), seed(0x02)],
      ]),
    );
    const r1 = (await loadServiceKey({ keyDir: '/a', readFileFn: reader })) as Extract<
      ServiceKeyLoadOutcome,
      { ok: true }
    >;
    const r2 = (await loadServiceKey({ keyDir: '/b', readFileFn: reader })) as Extract<
      ServiceKeyLoadOutcome,
      { ok: true }
    >;
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it('honours custom fileName', async () => {
    const keyBytes = seed(0x05);
    const reader = memReader(
      new Map([[join('/k', 'custom.ed25519'), keyBytes]]),
    );
    const r = (await loadServiceKey({
      keyDir: '/k',
      fileName: 'custom.ed25519',
      readFileFn: reader,
    })) as Extract<ServiceKeyLoadOutcome, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/k/custom.ed25519');
  });

  it('returned seed is decoupled from the reader buffer (mutation isolation)', async () => {
    const underlying = seed(0xaa);
    const reader: ServiceKeyLoadInput['readFileFn'] = async () => underlying;
    const r = (await loadServiceKey({
      keyDir: '/k',
      readFileFn: reader,
    })) as Extract<ServiceKeyLoadOutcome, { ok: true }>;
    // Mutate the buffer the reader returned — the outcome's seed must
    // be unaffected, otherwise a misbehaving reader could rewrite our
    // cached key material after load.
    underlying[0] = 0xff;
    expect(r.seed[0]).toBe(0xaa);
  });

  it('honours injected sha256Fn', async () => {
    const keyBytes = seed(0x33);
    const reader = memReader(new Map([[join('/k', 'brain.ed25519'), keyBytes]]));
    // Injected "hash" that returns a fixed pattern — proves the
    // fingerprint is derived via the injected function.
    const canned = new Uint8Array(32);
    canned[0] = 0xde;
    canned[1] = 0xad;
    canned[2] = 0xbe;
    canned[3] = 0xef;
    const r = (await loadServiceKey({
      keyDir: '/k',
      readFileFn: reader,
      sha256Fn: () => canned,
    })) as Extract<ServiceKeyLoadOutcome, { ok: true }>;
    expect(r.fingerprint.startsWith('deadbeef')).toBe(true);
  });
});

describe('loadServiceKey error paths (task 5.8)', () => {
  it('ENOENT → not_found', async () => {
    const reader = memReader(new Map());
    const r = (await loadServiceKey({ keyDir: '/nowhere', readFileFn: reader })) as Extract<
      ServiceKeyLoadOutcome,
      { ok: false }
    >;
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
    expect(r.detail).toContain('ENOENT');
  });

  it('ENOTDIR → not_found (parent is a file, not a dir)', async () => {
    const reader: ServiceKeyLoadInput['readFileFn'] = async () => {
      const e: NodeJS.ErrnoException = new Error('ENOTDIR');
      e.code = 'ENOTDIR';
      throw e;
    };
    const r = (await loadServiceKey({ keyDir: '/k', readFileFn: reader })) as Extract<
      ServiceKeyLoadOutcome,
      { ok: false }
    >;
    expect(r.reason).toBe('not_found');
  });

  it('non-ENOENT read error → read_failed', async () => {
    const reader: ServiceKeyLoadInput['readFileFn'] = async () => {
      const e: NodeJS.ErrnoException = new Error('EACCES permission denied');
      e.code = 'EACCES';
      throw e;
    };
    const r = (await loadServiceKey({ keyDir: '/k', readFileFn: reader })) as Extract<
      ServiceKeyLoadOutcome,
      { ok: false }
    >;
    expect(r.reason).toBe('read_failed');
    expect(r.detail).toContain('EACCES');
  });

  it('non-Error thrown value → read_failed with stringified detail', async () => {
    const reader: ServiceKeyLoadInput['readFileFn'] = async () => {
      throw 'weird string throw'; // eslint-disable-line @typescript-eslint/no-throw-literal
    };
    const r = (await loadServiceKey({ keyDir: '/k', readFileFn: reader })) as Extract<
      ServiceKeyLoadOutcome,
      { ok: false }
    >;
    expect(r.reason).toBe('read_failed');
    expect(r.detail).toContain('weird string throw');
  });

  it.each([
    ['too short', 31],
    ['too long', 33],
    ['empty', 0],
    ['off by large amount', 64],
  ] as const)('wrong length: %s bytes → wrong_length', async (_label, len) => {
    const reader: ServiceKeyLoadInput['readFileFn'] = async () =>
      new Uint8Array(len);
    const r = (await loadServiceKey({ keyDir: '/k', readFileFn: reader })) as Extract<
      ServiceKeyLoadOutcome,
      { ok: false }
    >;
    expect(r.reason).toBe('wrong_length');
    expect(r.detail).toMatch(/expected 32 bytes/);
    expect(r.detail).toMatch(new RegExp(`got ${len}`));
  });
});

describe('loadServiceKey integration against real fs (task 5.8)', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'dina-keydir-'));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reads a real 0600 file from disk + produces a valid outcome', async () => {
    const keyBytes = seed(0x7e);
    const path = join(tmp, 'brain.ed25519');
    await writeFile(path, keyBytes);
    await chmod(path, 0o600);

    const r = (await loadServiceKey({ keyDir: tmp })) as Extract<
      ServiceKeyLoadOutcome,
      { ok: true }
    >;
    expect(r.ok).toBe(true);
    expect(Array.from(r.seed)).toEqual(Array.from(keyBytes));
    expect(r.path).toBe(path);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('missing file on real fs → not_found', async () => {
    const r = (await loadServiceKey({ keyDir: tmp, fileName: 'nope.ed25519' })) as Extract<
      ServiceKeyLoadOutcome,
      { ok: false }
    >;
    expect(r.reason).toBe('not_found');
  });
});
