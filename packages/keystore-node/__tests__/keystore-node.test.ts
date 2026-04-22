/**
 * `@dina/keystore-node` smoke — against real filesystem in a tmpdir.
 *
 * File backend covers the Dina default path. Keytar backend uses a
 * hand-rolled mock (keytar's native dep isn't installed in CI).
 * `createKeytarKeystore()` returns null on machines without keytar;
 * the missing-keytar branch is verified too.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FileKeystore,
  KeytarKeystore,
  createKeytarKeystore,
} from '../src';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'keystore-node-test-'));
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('FileKeystore', () => {
  let tmp: string;
  let ks: FileKeystore;

  beforeEach(async () => {
    tmp = await makeTmpDir();
    ks = new FileKeystore({ rootDir: path.join(tmp, 'ks') });
  });

  afterEach(async () => {
    await rmrf(tmp);
  });

  it('round-trips a secret', async () => {
    await ks.put('dina.identity.signing', 'deadbeef');
    expect(await ks.get('dina.identity.signing')).toBe('deadbeef');
  });

  it('returns null for a missing secret', async () => {
    expect(await ks.get('dina.never.set')).toBeNull();
  });

  it('overwrites an existing secret', async () => {
    await ks.put('dina.role', 'operator');
    await ks.put('dina.role', 'user');
    expect(await ks.get('dina.role')).toBe('user');
  });

  it('delete removes a stored secret', async () => {
    await ks.put('dina.token', 'x');
    await ks.delete('dina.token');
    expect(await ks.get('dina.token')).toBeNull();
  });

  it('delete is a no-op when the service does not exist', async () => {
    await expect(ks.delete('dina.ghost')).resolves.toBeUndefined();
  });

  it('list returns sorted service names', async () => {
    await ks.put('dina.c', '3');
    await ks.put('dina.a', '1');
    await ks.put('dina.b', '2');
    expect(await ks.list()).toEqual(['dina.a', 'dina.b', 'dina.c']);
  });

  it('list returns empty array when the root directory does not exist yet', async () => {
    // No put() calls — rootDir never created.
    const empty = new FileKeystore({ rootDir: path.join(tmp, 'never-created') });
    expect(await empty.list()).toEqual([]);
  });

  it('creates the root directory with mode 0o700 on first put', async () => {
    await ks.put('dina.first', 'v');
    const st = await fs.stat(path.join(tmp, 'ks'));
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('stores secrets as files with mode 0o600', async () => {
    await ks.put('dina.secret', 'shh');
    const st = await fs.stat(path.join(tmp, 'ks', 'dina.secret'));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('re-asserts mode 0o600 on overwrite', async () => {
    const filePath = path.join(tmp, 'ks', 'dina.looseperms');
    await ks.put('dina.looseperms', 'v1');
    // Simulate a looser mode (e.g. from a prior admin-tool touch).
    await fs.chmod(filePath, 0o666);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o666);
    // Overwrite should tighten back to 0o600.
    await ks.put('dina.looseperms', 'v2');
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  describe('service name validation', () => {
    it('rejects names containing a forward slash', async () => {
      await expect(ks.put('dina/evil', 'x')).rejects.toThrow(/forbidden chars/);
    });

    it('rejects names containing a backslash', async () => {
      await expect(ks.put('dina\\evil', 'x')).rejects.toThrow(/forbidden chars/);
    });

    it('rejects names containing a null byte', async () => {
      await expect(ks.put('dina\0evil', 'x')).rejects.toThrow(/forbidden chars/);
    });

    it('rejects empty service names', async () => {
      await expect(ks.put('', 'x')).rejects.toThrow(/1–256 chars/);
    });

    it('rejects names longer than 256 chars', async () => {
      const long = 'a'.repeat(257);
      await expect(ks.put(long, 'x')).rejects.toThrow(/1–256 chars/);
    });

    it('rejects traversal paths', async () => {
      await expect(ks.put('..', 'x')).rejects.toThrow(/traversal/);
      await expect(ks.put('.', 'x')).rejects.toThrow(/traversal/);
    });

    it('get / delete also validate (traversal-safe)', async () => {
      await expect(ks.get('..')).rejects.toThrow();
      await expect(ks.delete('../leak')).rejects.toThrow();
    });
  });

  it('preserves exact byte content on round-trip (no BOM / whitespace munging)', async () => {
    // Secrets may be JSON blobs or hex strings — any mangling breaks
    // them. Check a few edge cases.
    const cases: Array<[string, string]> = [
      ['hex', 'deadbeef'],
      ['leading-spaces', '  leading-spaces'],
      ['trailing-spaces', 'trailing-spaces  '],
      ['json', '{"json":true}'],
      ['empty', ''],
    ];
    for (const [name, value] of cases) {
      await ks.put(`dina.test.${name}`, value);
    }
    for (const [name, value] of cases) {
      expect(await ks.get(`dina.test.${name}`)).toBe(value);
    }
  });
});

describe('KeytarKeystore (mocked)', () => {
  type Row = { service: string; account: string; password: string };

  /** Stand-in for the native `keytar` module. */
  function mockKeytar(): {
    rows: Row[];
    mod: {
      getPassword: (service: string, account: string) => Promise<string | null>;
      setPassword: (service: string, account: string, password: string) => Promise<void>;
      deletePassword: (service: string, account: string) => Promise<boolean>;
      findCredentials: (
        service: string,
      ) => Promise<Array<{ account: string; password: string }>>;
    };
  } {
    const rows: Row[] = [];
    const mod = {
      async getPassword(service: string, account: string) {
        return rows.find((r) => r.service === service && r.account === account)?.password ?? null;
      },
      async setPassword(service: string, account: string, password: string) {
        const existing = rows.find((r) => r.service === service && r.account === account);
        if (existing) existing.password = password;
        else rows.push({ service, account, password });
      },
      async deletePassword(service: string, account: string) {
        const idx = rows.findIndex((r) => r.service === service && r.account === account);
        if (idx === -1) return false;
        rows.splice(idx, 1);
        return true;
      },
      async findCredentials(service: string) {
        return rows
          .filter((r) => r.service === service)
          .map(({ account, password }) => ({ account, password }));
      },
    };
    return { rows, mod };
  }

  it('round-trips a secret through the mock', async () => {
    const { mod } = mockKeytar();
    const ks = new KeytarKeystore(mod);
    await ks.put('dina.identity.signing', 'sigsecret');
    expect(await ks.get('dina.identity.signing')).toBe('sigsecret');
  });

  it('returns null on cache-miss', async () => {
    const { mod } = mockKeytar();
    const ks = new KeytarKeystore(mod);
    expect(await ks.get('dina.absent')).toBeNull();
  });

  it('delete removes the secret', async () => {
    const { mod } = mockKeytar();
    const ks = new KeytarKeystore(mod);
    await ks.put('dina.token', 'x');
    await ks.delete('dina.token');
    expect(await ks.get('dina.token')).toBeNull();
  });

  it('delete is a no-op on missing service (does not throw)', async () => {
    const { mod } = mockKeytar();
    const ks = new KeytarKeystore(mod);
    await expect(ks.delete('dina.never')).resolves.toBeUndefined();
  });

  it('uses the shared "dina" account for every row', async () => {
    const { rows, mod } = mockKeytar();
    const ks = new KeytarKeystore(mod);
    await ks.put('dina.a', '1');
    await ks.put('dina.b', '2');
    expect(rows.every((r) => r.account === 'dina')).toBe(true);
  });

  it('list() returns empty array (keytar has no bulk-list primitive)', async () => {
    // Documented limitation — this is a contract test, not a wish.
    const { mod } = mockKeytar();
    const ks = new KeytarKeystore(mod);
    await ks.put('dina.a', '1');
    expect(await ks.list()).toEqual([]);
  });
});

describe('createKeytarKeystore', () => {
  it('returns null when keytar is not installed', () => {
    // In this repo, keytar is NOT a regular dep (it's optional peer),
    // and CI doesn't install it. `require('keytar')` throws → the
    // factory returns null and callers fall back to FileKeystore.
    const result = createKeytarKeystore();
    expect(result).toBeNull();
  });
});
