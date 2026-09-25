/**
 * Task 4.51 + 4.52 — master seed load/generate + keyfile tests.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { validateMnemonic, mnemonicToEntropy } from '@dina/core';

import {
  loadOrGenerateSeed,
  recoveryPhraseFromWrapped,
  wrappedSeedPathOf,
  KEYFILE_MODE,
  KEYFILE_NAME,
  WRAPPED_SEED_NAME,
  RECOVERY_PHRASE_NAME,
  SEED_LEN_BYTES,
  LEGACY_SEED_LEN_BYTES,
} from '../src/identity/master_seed';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'seed-test-'));
}

describe('loadOrGenerateSeed (tasks 4.51 + 4.52)', () => {
  describe('first-boot generation', () => {
    it('generates a valid BIP-39 mnemonic + 32-byte entropy when vaultDir is empty', async () => {
      const dir = await mkTmpDir();
      try {
        const res = await loadOrGenerateSeed(dir);
        expect(res.kind).toBe('generated');
        if (res.kind !== 'generated') return;
        expect(validateMnemonic(res.mnemonic)).toBe(true);
        expect(res.seed.length).toBe(SEED_LEN_BYTES);
        // Seed is derived deterministically from the mnemonic — recomputing
        // must give the same bytes.
        expect(Array.from(mnemonicToEntropy(res.mnemonic))).toEqual(Array.from(res.seed));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('persists the seed as raw 32-byte entropy in `<vaultDir>/keyfile`', async () => {
      const dir = await mkTmpDir();
      try {
        const res = await loadOrGenerateSeed(dir);
        if (res.kind !== 'generated') throw new Error('expected generated');
        const buf = await fs.readFile(path.join(dir, KEYFILE_NAME));
        expect(buf.length).toBe(SEED_LEN_BYTES);
        expect(Array.from(new Uint8Array(buf))).toEqual(Array.from(res.seed));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('keyfile is written with mode 0o600 (owner-only)', async () => {
      const dir = await mkTmpDir();
      try {
        await loadOrGenerateSeed(dir);
        const stat = await fs.stat(path.join(dir, KEYFILE_NAME));
        expect(stat.mode & 0o777).toBe(KEYFILE_MODE);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('creates the vault dir if it does not exist', async () => {
      const parent = await mkTmpDir();
      const dir = path.join(parent, 'not-yet-created');
      try {
        const res = await loadOrGenerateSeed(dir);
        expect(res.kind).toBe('generated');
        const stat = await fs.stat(path.join(dir, KEYFILE_NAME));
        expect(stat.size).toBe(SEED_LEN_BYTES);
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    });

    it('no .tmp- residue after successful write', async () => {
      const dir = await mkTmpDir();
      try {
        await loadOrGenerateSeed(dir);
        const entries = await fs.readdir(dir);
        expect(entries.some((e) => e.startsWith('.keyfile.tmp-'))).toBe(false);
        expect(entries.some((e) => e.startsWith(`.${RECOVERY_PHRASE_NAME}.tmp-`))).toBe(false);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('recovery phrase (item 1 — mnemonic never logged, written 0600)', () => {
    it('writes the recovery phrase to a 0o600 file and returns its path', async () => {
      const dir = await mkTmpDir();
      try {
        const res = await loadOrGenerateSeed(dir);
        if (res.kind !== 'generated') throw new Error('expected generated');
        const expected = path.join(dir, RECOVERY_PHRASE_NAME);
        expect(res.recoveryPhrasePath).toBe(expected);
        const stat = await fs.stat(expected);
        expect(stat.mode & 0o777).toBe(KEYFILE_MODE);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('the file contains the exact generated mnemonic plus a save-and-delete warning', async () => {
      const dir = await mkTmpDir();
      try {
        const res = await loadOrGenerateSeed(dir);
        if (res.kind !== 'generated' || res.recoveryPhrasePath === undefined) {
          throw new Error('expected a convenience-mode first boot');
        }
        const contents = await fs.readFile(res.recoveryPhrasePath, 'utf8');
        expect(contents).toContain(res.mnemonic);
        expect(contents).toMatch(/delete this file/i);
        expect(contents).toMatch(/never .*log/i);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('is NOT written when loading an existing convenience keyfile', async () => {
      const dir = await mkTmpDir();
      try {
        await loadOrGenerateSeed(dir); // first boot writes it
        await fs.rm(path.join(dir, RECOVERY_PHRASE_NAME)); // operator deletes it
        const second = await loadOrGenerateSeed(dir); // subsequent boot
        expect(second.kind).toBe('loaded_convenience');
        // A load must not re-create the phrase file — the seed already exists.
        await expect(fs.stat(path.join(dir, RECOVERY_PHRASE_NAME))).rejects.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('load on subsequent boot', () => {
    it('round-trips the same seed on generate → load', async () => {
      const dir = await mkTmpDir();
      try {
        const first = await loadOrGenerateSeed(dir);
        if (first.kind !== 'generated') throw new Error('expected generated');
        const second = await loadOrGenerateSeed(dir);
        expect(second.kind).toBe('loaded_convenience');
        if (second.kind !== 'loaded_convenience') return;
        expect(Array.from(second.seed)).toEqual(Array.from(first.seed));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects keyfile with loosened mode (0o644) — does NOT silently re-tighten', async () => {
      const dir = await mkTmpDir();
      try {
        await loadOrGenerateSeed(dir); // create the keyfile
        await fs.chmod(path.join(dir, KEYFILE_NAME), 0o644);
        await expect(loadOrGenerateSeed(dir)).rejects.toThrow(
          /keyfile mode is 644, expected 600/,
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects keyfile with world-readable mode (0o604)', async () => {
      const dir = await mkTmpDir();
      try {
        await loadOrGenerateSeed(dir);
        await fs.chmod(path.join(dir, KEYFILE_NAME), 0o604);
        await expect(loadOrGenerateSeed(dir)).rejects.toThrow(
          /keyfile mode is 604, expected 600/,
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('loads a legacy 64-byte seed unchanged so its identity does not rotate', async () => {
      const dir = await mkTmpDir();
      try {
        const legacySeed = Buffer.from(
          Array.from({ length: LEGACY_SEED_LEN_BYTES }, (_, index) => index),
        );
        await fs.writeFile(path.join(dir, KEYFILE_NAME), legacySeed, {
          mode: KEYFILE_MODE,
        });
        const result = await loadOrGenerateSeed(dir);
        expect(result.kind).toBe('loaded_convenience');
        if (result.kind !== 'loaded_convenience') return;
        expect(Array.from(result.seed)).toEqual(Array.from(legacySeed));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects keyfile of an unsupported length', async () => {
      const dir = await mkTmpDir();
      try {
        await fs.writeFile(path.join(dir, KEYFILE_NAME), Buffer.alloc(31), {
          mode: KEYFILE_MODE,
        });
        await expect(loadOrGenerateSeed(dir)).rejects.toThrow(
          /keyfile length is 31 bytes, expected 32 or legacy 64/,
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('wrapped-seed placeholder (task 4.53 handoff)', () => {
    it('returns {kind: "wrapped", wrappedPath} when wrapped_seed.bin exists', async () => {
      const dir = await mkTmpDir();
      try {
        const wrappedPath = path.join(dir, WRAPPED_SEED_NAME);
        await fs.writeFile(wrappedPath, Buffer.from([0xde, 0xad]), { mode: 0o600 });
        const res = await loadOrGenerateSeed(dir);
        expect(res).toEqual({ kind: 'wrapped', wrappedPath });
        expect(wrappedSeedPathOf(res)).toBe(wrappedPath);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('wrapped_seed.bin takes precedence over a stray keyfile', async () => {
      const dir = await mkTmpDir();
      try {
        // Simulate an operator who migrated to wrapped-seed but
        // forgot to delete the old keyfile. Wrapped wins; we never
        // silently fall back to the less-secure convenience seed.
        await fs.writeFile(path.join(dir, KEYFILE_NAME), Buffer.alloc(SEED_LEN_BYTES), { mode: 0o600 });
        await fs.writeFile(path.join(dir, WRAPPED_SEED_NAME), Buffer.from([1, 2]), { mode: 0o600 });
        const res = await loadOrGenerateSeed(dir);
        expect(res.kind).toBe('wrapped');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('security mode from the first boot (JIFFY review item 11)', () => {
    const saved = process.env.DINA_UNLOCK_PASSPHRASE;
    afterEach(() => {
      if (saved === undefined) delete process.env.DINA_UNLOCK_PASSPHRASE;
      else process.env.DINA_UNLOCK_PASSPHRASE = saved;
    });

    it('writes only the wrapped seed (0600, no keyfile) and later boots unwrap the same seed', async () => {
      const dir = await mkTmpDir();
      try {
        process.env.DINA_UNLOCK_PASSPHRASE = 'correct horse battery staple';
        const first = await loadOrGenerateSeed(dir);
        if (first.kind !== 'generated') throw new Error(`expected generated, got ${first.kind}`);
        const wrappedPath = path.join(dir, WRAPPED_SEED_NAME);
        expect(first.wrappedPath).toBe(wrappedPath);
        expect((await fs.stat(wrappedPath)).mode & 0o777).toBe(0o600);
        await expect(fs.access(path.join(dir, KEYFILE_NAME))).rejects.toThrow();
        // No plain copy of the seed anywhere: no keyfile, no phrase file.
        expect(first.recoveryPhrasePath).toBeUndefined();
        await expect(fs.access(path.join(dir, RECOVERY_PHRASE_NAME))).rejects.toThrow();
        const bytes = await fs.readFile(wrappedPath);
        expect(bytes.includes(Buffer.from(first.seed))).toBe(false);
        // The phrase comes back from the wrapped seed and the passphrase.
        expect(await recoveryPhraseFromWrapped(dir, 'correct horse battery staple')).toBe(
          first.mnemonic,
        );
        await expect(recoveryPhraseFromWrapped(dir, 'wrong')).rejects.toThrow();

        // Presence is provable from this first boot, not only after a restart.
        expect(wrappedSeedPathOf(first)).toBe(wrappedPath);

        const again = await loadOrGenerateSeed(dir);
        expect(again).toEqual({ kind: 'loaded_wrapped', seed: first.seed, wrappedPath });
        expect(wrappedSeedPathOf(again)).toBe(wrappedPath);

        delete process.env.DINA_UNLOCK_PASSPHRASE;
        expect(await loadOrGenerateSeed(dir)).toEqual({ kind: 'wrapped', wrappedPath });

        process.env.DINA_UNLOCK_PASSPHRASE = 'not the passphrase';
        await expect(loadOrGenerateSeed(dir)).rejects.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }, 60_000);

    it('without a passphrase the first boot writes the keyfile and no presence path', async () => {
      const dir = await mkTmpDir();
      try {
        delete process.env.DINA_UNLOCK_PASSPHRASE;
        const first = await loadOrGenerateSeed(dir);
        expect(first.kind).toBe('generated');
        expect(wrappedSeedPathOf(first)).toBeUndefined();
        await expect(fs.access(path.join(dir, WRAPPED_SEED_NAME))).rejects.toThrow();
        expect(wrappedSeedPathOf(await loadOrGenerateSeed(dir))).toBeUndefined();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('input validation', () => {
    it('rejects empty vaultDir', async () => {
      await expect(loadOrGenerateSeed('')).rejects.toThrow(/vaultDir is required/);
    });
  });
});
