/**
 * Task 4.34 — Dead Drop spool tests.
 *
 * Uses a unique per-test tmpdir to keep tests hermetic + parallel-safe.
 */

import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BLOB_EXTENSION,
  DeadDropError,
  DeadDropSpool,
  ID_BYTES,
  TMP_PREFIX,
} from '../src/ingress/dead_drop';

async function mktmp(): Promise<string> {
  const dir = await fsPromises.mkdtemp(join(tmpdir(), 'deaddrop-test-'));
  return dir;
}

async function rmrf(dir: string): Promise<void> {
  await fsPromises.rm(dir, { recursive: true, force: true });
}

function seed(byte: number): number[] {
  return Array.from({ length: ID_BYTES }, () => byte);
}

function scriptedRandom(scripts: number[][]): (n: number) => Uint8Array {
  let i = 0;
  return (n) => {
    const next = scripts[i++];
    if (next === undefined) throw new Error(`scriptedRandom exhausted at ${i}`);
    if (next.length !== n) throw new Error(`scripted ${next.length} != ${n}`);
    return new Uint8Array(next);
  };
}

describe('DeadDropSpool (task 4.34)', () => {
  describe('construction validation', () => {
    it('rejects empty dir', () => {
      expect(
        () => new DeadDropSpool('', { maxBlobs: 10, maxBytes: 1024 }),
      ).toThrow(/dir is required/);
    });

    it('rejects non-positive maxBlobs', () => {
      expect(
        () => new DeadDropSpool('/tmp/x', { maxBlobs: 0, maxBytes: 1024 }),
      ).toThrow(/maxBlobs/);
      expect(
        () => new DeadDropSpool('/tmp/x', { maxBlobs: 1.5, maxBytes: 1024 }),
      ).toThrow(/maxBlobs/);
    });

    it('rejects non-positive maxBytes', () => {
      expect(
        () => new DeadDropSpool('/tmp/x', { maxBlobs: 10, maxBytes: 0 }),
      ).toThrow(/maxBytes/);
    });
  });

  describe('store + read round-trip', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mktmp();
    });
    afterEach(async () => {
      await rmrf(dir);
    });

    it('stores a blob and returns a hex id', async () => {
      const spool = new DeadDropSpool(dir, { maxBlobs: 10, maxBytes: 1024 });
      const { id } = await spool.store(new Uint8Array([1, 2, 3, 4]));
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('read returns blob bytes and removes the file (consume-once)', async () => {
      const spool = new DeadDropSpool(dir, { maxBlobs: 10, maxBytes: 1024 });
      const blob = new Uint8Array([1, 2, 3, 4]);
      const { id } = await spool.store(blob);
      const out = await spool.read(id);
      expect(Array.from(out)).toEqual([1, 2, 3, 4]);
      // Second read → not_found.
      await expect(spool.read(id)).rejects.toThrow(/not found/);
    });

    it('peek returns blob without removing; ack removes it', async () => {
      const spool = new DeadDropSpool(dir, { maxBlobs: 10, maxBytes: 1024 });
      const { id } = await spool.store(new Uint8Array([9, 9, 9]));
      const a = await spool.peek(id);
      const b = await spool.peek(id);
      expect(Array.from(a)).toEqual([9, 9, 9]);
      expect(Array.from(b)).toEqual([9, 9, 9]); // not consumed
      await spool.ack(id);
      await expect(spool.peek(id)).rejects.toThrow(/not found/);
    });

    it('creates the dir with 0o700 mode on first store', async () => {
      const sub = join(dir, 'sub/nested');
      const spool = new DeadDropSpool(sub, { maxBlobs: 10, maxBytes: 1024 });
      await spool.store(new Uint8Array([1]));
      const st = await fsPromises.stat(sub);
      expect(st.isDirectory()).toBe(true);
      // Mode check — mask to the permission bits.
      expect((st.mode & 0o777).toString(8)).toBe('700');
    });
  });

  describe('list + stats', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mktmp();
    });
    afterEach(async () => {
      await rmrf(dir);
    });

    it('list is sorted + excludes tmp files', async () => {
      const spool = new DeadDropSpool(dir, {
        maxBlobs: 10,
        maxBytes: 1024,
        randomBytesFn: scriptedRandom([seed(0x11), seed(0x22), seed(0x33)]),
      });
      await spool.store(new Uint8Array([1]));
      await spool.store(new Uint8Array([2]));
      await spool.store(new Uint8Array([3]));
      // Write a stray tmp file — must be ignored.
      await fsPromises.writeFile(
        join(dir, TMP_PREFIX + 'deadbeef' + BLOB_EXTENSION),
        Buffer.from([9]),
      );
      const ids = await spool.list();
      expect(ids).toEqual([
        '11'.repeat(16),
        '22'.repeat(16),
        '33'.repeat(16),
      ]);
    });

    it('list excludes non-.blob filenames + non-hex names', async () => {
      const spool = new DeadDropSpool(dir, { maxBlobs: 10, maxBytes: 1024 });
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(join(dir, 'readme.txt'), '');
      await fsPromises.writeFile(join(dir, 'not-hex.blob'), '');
      await fsPromises.writeFile(join(dir, 'g'.repeat(32) + '.blob'), ''); // 32 chars but not hex
      expect(await spool.list()).toEqual([]);
    });

    it('stats reports count + total bytes', async () => {
      const spool = new DeadDropSpool(dir, { maxBlobs: 10, maxBytes: 1024 });
      await spool.store(new Uint8Array(10).fill(1));
      await spool.store(new Uint8Array(20).fill(2));
      const s = await spool.stats();
      expect(s.blobs).toBe(2);
      expect(s.bytes).toBe(30);
    });

    it('stats on missing dir is {blobs:0, bytes:0}', async () => {
      const spool = new DeadDropSpool(join(dir, 'never-created'), {
        maxBlobs: 10,
        maxBytes: 1024,
      });
      expect(await spool.stats()).toEqual({ blobs: 0, bytes: 0 });
    });
  });

  describe('capacity caps', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mktmp();
    });
    afterEach(async () => {
      await rmrf(dir);
    });

    it('rejects store when maxBlobs would be exceeded', async () => {
      const spool = new DeadDropSpool(dir, {
        maxBlobs: 2,
        maxBytes: 1024,
        randomBytesFn: scriptedRandom([seed(1), seed(2), seed(3)]),
      });
      await spool.store(new Uint8Array([1]));
      await spool.store(new Uint8Array([2]));
      await expect(spool.store(new Uint8Array([3]))).rejects.toMatchObject({
        reason: 'spool_full_blobs',
      });
    });

    it('rejects store when maxBytes would be exceeded', async () => {
      const spool = new DeadDropSpool(dir, {
        maxBlobs: 100,
        maxBytes: 10,
      });
      await spool.store(new Uint8Array(5).fill(1)); // uses 5 of 10
      await spool.store(new Uint8Array(5).fill(2)); // uses last 5 of 10
      await expect(spool.store(new Uint8Array([9]))).rejects.toMatchObject({
        reason: 'spool_full_bytes',
      });
    });

    it('draining a blob frees capacity for the next store', async () => {
      const spool = new DeadDropSpool(dir, {
        maxBlobs: 1,
        maxBytes: 1024,
        randomBytesFn: scriptedRandom([seed(1), seed(2)]),
      });
      const first = await spool.store(new Uint8Array([1]));
      await spool.read(first.id);
      await expect(spool.store(new Uint8Array([2]))).resolves.toBeDefined();
    });
  });

  describe('atomic write', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mktmp();
    });
    afterEach(async () => {
      await rmrf(dir);
    });

    it('the final file appears atomically (no half-written blob visible via list)', async () => {
      // This test relies on the implementation using tmp → rename. We
      // can't reliably crash the process mid-store, but we can assert
      // that `list()` on a completed store returns only the final
      // blob name (no `.tmp-*` leak).
      const spool = new DeadDropSpool(dir, {
        maxBlobs: 10,
        maxBytes: 1024,
        randomBytesFn: scriptedRandom([seed(0xab)]),
      });
      await spool.store(new Uint8Array([1, 2, 3]));
      const entries = await fsPromises.readdir(dir);
      expect(entries.filter((e) => e.startsWith(TMP_PREFIX))).toEqual([]);
      expect(entries.filter((e) => e.endsWith(BLOB_EXTENSION))).toHaveLength(1);
    });
  });

  describe('id validation (path-traversal guard)', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mktmp();
    });
    afterEach(async () => {
      await rmrf(dir);
    });

    it.each([
      ['too short', 'abc'],
      ['upper case', 'A'.repeat(32)],
      ['non-hex', 'g'.repeat(32)],
      ['path traversal', '../../../etc/passwd'],
      ['with slash', 'a/b/c'],
      ['empty', ''],
      ['too long', 'a'.repeat(64)],
    ])('rejects %s id', async (_label, id) => {
      const spool = new DeadDropSpool(dir, { maxBlobs: 10, maxBytes: 1024 });
      await expect(spool.peek(id)).rejects.toMatchObject({
        reason: 'invalid_id',
      });
      await expect(spool.read(id)).rejects.toMatchObject({
        reason: 'invalid_id',
      });
      await expect(spool.ack(id)).rejects.toMatchObject({
        reason: 'invalid_id',
      });
    });

    it('accepts a well-formed hex id (round-trip)', async () => {
      const spool = new DeadDropSpool(dir, {
        maxBlobs: 10,
        maxBytes: 1024,
        randomBytesFn: scriptedRandom([seed(0xfe)]),
      });
      const { id } = await spool.store(new Uint8Array([7]));
      await expect(spool.peek(id)).resolves.toBeDefined();
    });
  });

  describe('concurrent stores serialise correctly', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mktmp();
    });
    afterEach(async () => {
      await rmrf(dir);
    });

    it('under cap: 5 concurrent stores succeed', async () => {
      const scripts: number[][] = [];
      for (let i = 1; i <= 5; i++) scripts.push(seed(i));
      const spool = new DeadDropSpool(dir, {
        maxBlobs: 10,
        maxBytes: 1024,
        randomBytesFn: scriptedRandom(scripts),
      });
      const results = await Promise.all([
        spool.store(new Uint8Array([1])),
        spool.store(new Uint8Array([2])),
        spool.store(new Uint8Array([3])),
        spool.store(new Uint8Array([4])),
        spool.store(new Uint8Array([5])),
      ]);
      expect(results).toHaveLength(5);
      expect((await spool.stats()).blobs).toBe(5);
    });

    it('cap exceeded by concurrent stores: some succeed, rest fail with spool_full_blobs', async () => {
      const scripts: number[][] = [];
      for (let i = 1; i <= 6; i++) scripts.push(seed(i));
      const spool = new DeadDropSpool(dir, {
        maxBlobs: 3,
        maxBytes: 1024,
        randomBytesFn: scriptedRandom(scripts),
      });
      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          spool.store(new Uint8Array([i + 1])),
        ),
      );
      const ok = settled.filter((r) => r.status === 'fulfilled');
      const failed = settled.filter(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult[];
      expect(ok).toHaveLength(3);
      expect(failed).toHaveLength(3);
      for (const f of failed) {
        expect((f.reason as DeadDropError).reason).toBe('spool_full_blobs');
      }
    });
  });
});
