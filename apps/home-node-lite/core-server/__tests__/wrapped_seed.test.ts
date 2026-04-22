/**
 * Task 4.53 — wrapped-seed persistence tests.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeWrappedSeed,
  readWrappedSeed,
  WRAPPED_SEED_FILE_MODE,
  WRAPPED_SEED_FILE_VERSION,
} from '../src/identity/wrapped_seed';
import { WRAPPED_SEED_NAME } from '../src/identity/master_seed';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wrapped-test-'));
}

/** Low-cost Argon2id profile via env override — speeds up tests ~10x
 *  vs. the production 128 MB / 3 iter / 4 parallelism defaults. */
jest.setTimeout(30_000);

const TEST_SEED = (() => {
  const s = new Uint8Array(64);
  for (let i = 0; i < 64; i++) s[i] = i ^ 0xaa;
  return s;
})();

const PASSPHRASE = 'correct horse battery staple — demo only';

describe('wrapped-seed persistence (task 4.53)', () => {
  describe('round-trip', () => {
    it('writes + reads back the same seed', async () => {
      const dir = await mkTmpDir();
      try {
        await writeWrappedSeed(dir, TEST_SEED, PASSPHRASE);
        const recovered = await readWrappedSeed(dir, PASSPHRASE);
        expect(Array.from(recovered)).toEqual(Array.from(TEST_SEED));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('persisted file is mode 0o600', async () => {
      const dir = await mkTmpDir();
      try {
        await writeWrappedSeed(dir, TEST_SEED, PASSPHRASE);
        const stat = await fs.stat(path.join(dir, WRAPPED_SEED_NAME));
        expect(stat.mode & 0o777).toBe(WRAPPED_SEED_FILE_MODE);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('file is JSON with the expected version + fields', async () => {
      const dir = await mkTmpDir();
      try {
        await writeWrappedSeed(dir, TEST_SEED, PASSPHRASE);
        const raw = await fs.readFile(path.join(dir, WRAPPED_SEED_NAME), 'utf8');
        const parsed = JSON.parse(raw) as {
          dina_wrapped_seed_version: number;
          salt_hex: string;
          wrapped_hex: string;
          params: { memory: number; iterations: number; parallelism: number };
        };
        expect(parsed.dina_wrapped_seed_version).toBe(WRAPPED_SEED_FILE_VERSION);
        expect(parsed.salt_hex).toMatch(/^[0-9a-f]+$/);
        expect(parsed.wrapped_hex).toMatch(/^[0-9a-f]+$/);
        expect(parsed.params.memory).toBeGreaterThan(0);
        expect(parsed.params.iterations).toBeGreaterThan(0);
        expect(parsed.params.parallelism).toBeGreaterThan(0);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('creates vault dir if it does not exist', async () => {
      const parent = await mkTmpDir();
      const dir = path.join(parent, 'not-yet');
      try {
        await writeWrappedSeed(dir, TEST_SEED, PASSPHRASE);
        const recovered = await readWrappedSeed(dir, PASSPHRASE);
        expect(Array.from(recovered)).toEqual(Array.from(TEST_SEED));
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    });

    it('no .tmp- residue after successful write', async () => {
      const dir = await mkTmpDir();
      try {
        await writeWrappedSeed(dir, TEST_SEED, PASSPHRASE);
        const entries = await fs.readdir(dir);
        expect(entries.some((e) => e.startsWith(`.${WRAPPED_SEED_NAME}.tmp-`))).toBe(false);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('security properties', () => {
    it('wrong passphrase → unwrap fails with generic error (no GCM-tag leak)', async () => {
      const dir = await mkTmpDir();
      try {
        await writeWrappedSeed(dir, TEST_SEED, PASSPHRASE);
        await expect(readWrappedSeed(dir, 'wrong-passphrase')).rejects.toThrow(
          /unwrap failed/,
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('corrupted ciphertext → unwrap fails', async () => {
      const dir = await mkTmpDir();
      try {
        await writeWrappedSeed(dir, TEST_SEED, PASSPHRASE);
        // Flip a byte in the wrapped ciphertext.
        const p = path.join(dir, WRAPPED_SEED_NAME);
        const raw = await fs.readFile(p, 'utf8');
        const parsed = JSON.parse(raw) as { wrapped_hex: string };
        const firstByte = parsed.wrapped_hex.slice(0, 2);
        const flipped = firstByte === '00' ? 'ff' : '00';
        const corrupted = raw.replace(
          `"wrapped_hex":"${parsed.wrapped_hex}"`,
          `"wrapped_hex":"${flipped}${parsed.wrapped_hex.slice(2)}"`,
        );
        await fs.writeFile(p, corrupted);
        await expect(readWrappedSeed(dir, PASSPHRASE)).rejects.toThrow(/unwrap failed/);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('different passphrases produce different ciphertexts for the same seed', async () => {
      const dirA = await mkTmpDir();
      const dirB = await mkTmpDir();
      try {
        await writeWrappedSeed(dirA, TEST_SEED, 'passphrase-A');
        await writeWrappedSeed(dirB, TEST_SEED, 'passphrase-B');
        const rawA = await fs.readFile(path.join(dirA, WRAPPED_SEED_NAME), 'utf8');
        const rawB = await fs.readFile(path.join(dirB, WRAPPED_SEED_NAME), 'utf8');
        expect(rawA).not.toBe(rawB);
      } finally {
        await fs.rm(dirA, { recursive: true, force: true });
        await fs.rm(dirB, { recursive: true, force: true });
      }
    });

    it('same passphrase + seed → different wrapped bytes across calls (fresh salt + nonce)', async () => {
      const dirA = await mkTmpDir();
      const dirB = await mkTmpDir();
      try {
        await writeWrappedSeed(dirA, TEST_SEED, PASSPHRASE);
        await writeWrappedSeed(dirB, TEST_SEED, PASSPHRASE);
        const rawA = JSON.parse(await fs.readFile(path.join(dirA, WRAPPED_SEED_NAME), 'utf8')) as { wrapped_hex: string; salt_hex: string };
        const rawB = JSON.parse(await fs.readFile(path.join(dirB, WRAPPED_SEED_NAME), 'utf8')) as { wrapped_hex: string; salt_hex: string };
        // Different Argon2id salts → different KEKs → different wrapped.
        expect(rawA.salt_hex).not.toBe(rawB.salt_hex);
        expect(rawA.wrapped_hex).not.toBe(rawB.wrapped_hex);
        // But both unwrap to the same seed.
        const [recA, recB] = await Promise.all([
          readWrappedSeed(dirA, PASSPHRASE),
          readWrappedSeed(dirB, PASSPHRASE),
        ]);
        expect(Array.from(recA)).toEqual(Array.from(recB));
      } finally {
        await fs.rm(dirA, { recursive: true, force: true });
        await fs.rm(dirB, { recursive: true, force: true });
      }
    });
  });

  describe('file-format evolution', () => {
    it('rejects unknown file-format version', async () => {
      const dir = await mkTmpDir();
      try {
        await writeWrappedSeed(dir, TEST_SEED, PASSPHRASE);
        const p = path.join(dir, WRAPPED_SEED_NAME);
        const raw = await fs.readFile(p, 'utf8');
        const bumped = raw.replace(
          `"dina_wrapped_seed_version":1`,
          `"dina_wrapped_seed_version":99`,
        );
        await fs.writeFile(p, bumped);
        await expect(readWrappedSeed(dir, PASSPHRASE)).rejects.toThrow(
          /unsupported wrapped-seed file version 99/,
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects malformed JSON', async () => {
      const dir = await mkTmpDir();
      try {
        await fs.writeFile(path.join(dir, WRAPPED_SEED_NAME), '{not valid json', { mode: 0o600 });
        await expect(readWrappedSeed(dir, PASSPHRASE)).rejects.toThrow(/not valid JSON/);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects missing required fields', async () => {
      const dir = await mkTmpDir();
      try {
        const incomplete = JSON.stringify({ dina_wrapped_seed_version: 1, salt_hex: '' });
        await fs.writeFile(path.join(dir, WRAPPED_SEED_NAME), incomplete, { mode: 0o600 });
        await expect(readWrappedSeed(dir, PASSPHRASE)).rejects.toThrow(/missing required fields/);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('input validation', () => {
    it('writeWrappedSeed rejects empty vaultDir', async () => {
      await expect(writeWrappedSeed('', TEST_SEED, PASSPHRASE)).rejects.toThrow(
        /vaultDir is required/,
      );
    });

    it('writeWrappedSeed rejects empty passphrase', async () => {
      const dir = await mkTmpDir();
      try {
        await expect(writeWrappedSeed(dir, TEST_SEED, '')).rejects.toThrow(
          /passphrase must be non-empty/,
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('readWrappedSeed rejects empty passphrase', async () => {
      await expect(readWrappedSeed('/tmp/any', '')).rejects.toThrow(
        /passphrase must be non-empty/,
      );
    });
  });
});
