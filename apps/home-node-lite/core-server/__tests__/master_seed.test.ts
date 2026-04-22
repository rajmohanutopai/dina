/**
 * Task 4.51 + 4.52 — master seed load/generate + keyfile tests.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadOrGenerateSeed,
  KEYFILE_MODE,
  KEYFILE_NAME,
  WRAPPED_SEED_NAME,
  SEED_LEN_BYTES,
} from '../src/identity/master_seed';
import { validateMnemonic, mnemonicToSeed } from '@dina/core';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'seed-test-'));
}

describe('loadOrGenerateSeed (tasks 4.51 + 4.52)', () => {
  describe('first-boot generation', () => {
    it('generates a valid BIP-39 mnemonic + 64-byte seed when vaultDir is empty', async () => {
      const dir = await mkTmpDir();
      try {
        const res = await loadOrGenerateSeed(dir);
        expect(res.kind).toBe('generated');
        if (res.kind !== 'generated') return;
        expect(validateMnemonic(res.mnemonic)).toBe(true);
        expect(res.seed.length).toBe(SEED_LEN_BYTES);
        // Seed is derived deterministically from the mnemonic — recomputing
        // must give the same bytes.
        expect(Array.from(mnemonicToSeed(res.mnemonic))).toEqual(Array.from(res.seed));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('persists the seed as raw 64 bytes in `<vaultDir>/keyfile`', async () => {
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

    it('rejects keyfile of the wrong length', async () => {
      const dir = await mkTmpDir();
      try {
        await fs.writeFile(path.join(dir, KEYFILE_NAME), Buffer.alloc(32), {
          mode: KEYFILE_MODE,
        });
        await expect(loadOrGenerateSeed(dir)).rejects.toThrow(
          /keyfile length is 32 bytes, expected 64/,
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

  describe('input validation', () => {
    it('rejects empty vaultDir', async () => {
      await expect(loadOrGenerateSeed('')).rejects.toThrow(/vaultDir is required/);
    });
  });
});
