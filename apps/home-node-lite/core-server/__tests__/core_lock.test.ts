/**
 * Item 2c — core.lock discovery + single-owner guard tests.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  LOCK_FILE_NAME,
  isPidAlive,
  readLock,
  writeLock,
  assertNoLiveForeignLock,
  releaseLock,
  type LockInfo,
} from '../src/core_lock';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lock-test-'));
}

function lockInfo(overrides: Partial<LockInfo> = {}): LockInfo {
  return {
    pid: process.pid,
    host: '127.0.0.1',
    port: 8100,
    nodeDid: 'did:key:z6MkExample',
    startedAtMs: 1000,
    ...overrides,
  };
}

describe('core.lock (item 2c)', () => {
  describe('isPidAlive', () => {
    it('true for our own pid, false for a never-existent pid', () => {
      expect(isPidAlive(process.pid)).toBe(true);
      expect(isPidAlive(2_000_000_000)).toBe(false); // ESRCH
    });
    it('false for invalid pids', () => {
      expect(isPidAlive(0)).toBe(false);
      expect(isPidAlive(-1)).toBe(false);
      expect(isPidAlive(1.5)).toBe(false);
    });
    it('true for pid 1 (init/launchd — always alive, EPERM as non-root)', () => {
      expect(isPidAlive(1)).toBe(true);
    });
  });

  describe('writeLock / readLock', () => {
    it('round-trips the lock info and leaves no .tmp residue', async () => {
      const dir = await mkTmpDir();
      try {
        writeLock(dir, lockInfo({ port: 54321 }));
        expect(readLock(dir)).toEqual(lockInfo({ port: 54321 }));
        const entries = await fs.readdir(dir);
        expect(entries).toEqual([LOCK_FILE_NAME]);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('readLock returns null for a missing or malformed file', async () => {
      const dir = await mkTmpDir();
      try {
        expect(readLock(dir)).toBeNull();
        await fs.writeFile(path.join(dir, LOCK_FILE_NAME), 'not json');
        expect(readLock(dir)).toBeNull();
        await fs.writeFile(path.join(dir, LOCK_FILE_NAME), '{"host":"x"}'); // no pid
        expect(readLock(dir)).toBeNull();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('assertNoLiveForeignLock', () => {
    it('does not throw when there is no lock', async () => {
      const dir = await mkTmpDir();
      try {
        expect(() => assertNoLiveForeignLock(dir)).not.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('ignores our own lock (idempotent restart)', async () => {
      const dir = await mkTmpDir();
      try {
        writeLock(dir, lockInfo({ pid: process.pid }));
        expect(() => assertNoLiveForeignLock(dir)).not.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('ignores a stale lock (dead foreign pid)', async () => {
      const dir = await mkTmpDir();
      try {
        writeLock(dir, lockInfo({ pid: 2_000_000_000 }));
        expect(() => assertNoLiveForeignLock(dir)).not.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('THROWS when a live foreign Core owns the vault', async () => {
      const dir = await mkTmpDir();
      try {
        writeLock(dir, lockInfo({ pid: 1, port: 8100 })); // pid 1 is alive and not us
        expect(() => assertNoLiveForeignLock(dir)).toThrow(/another Dina Core .*already owns/);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('releaseLock', () => {
    it('removes only our own lock', async () => {
      const dir = await mkTmpDir();
      try {
        writeLock(dir, lockInfo({ pid: process.pid }));
        releaseLock(dir);
        expect(readLock(dir)).toBeNull();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('leaves a foreign lock untouched', async () => {
      const dir = await mkTmpDir();
      try {
        writeLock(dir, lockInfo({ pid: 1 }));
        releaseLock(dir);
        expect(readLock(dir)?.pid).toBe(1);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });
});
