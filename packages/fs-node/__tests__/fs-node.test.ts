/**
 * `@dina/fs-node` smoke — against real filesystem in a tmpdir.
 *
 * Keeping tests against a real FS (not mocked) because the adapter
 * is a thin wrapper over `node:fs/promises`; the contract worth
 * verifying is "the wrapper correctly passes arguments + preserves
 * semantics" — mocks would just re-implement the wrapper.
 *
 * Each test gets its own tmpdir to stay isolated.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeFsAdapter } from '../src';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fs-node-test-'));
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('NodeFsAdapter', () => {
  let tmp: string;
  let adapter: NodeFsAdapter;

  beforeEach(async () => {
    tmp = await makeTmpDir();
    adapter = new NodeFsAdapter();
  });

  afterEach(async () => {
    await rmrf(tmp);
  });

  describe('writeFile + readFile', () => {
    it('round-trips string content', async () => {
      const p = path.join(tmp, 'hello.txt');
      await adapter.writeFile(p, 'hello world');
      expect(await adapter.readFileText(p)).toBe('hello world');
    });

    it('round-trips Uint8Array content', async () => {
      const p = path.join(tmp, 'bytes.bin');
      const src = new Uint8Array([0, 1, 2, 3, 4, 255]);
      await adapter.writeFile(p, src);
      const read = await adapter.readFile(p);
      expect(Array.from(read)).toEqual(Array.from(src));
    });

    it('overwrites an existing file atomically', async () => {
      const p = path.join(tmp, 'over.txt');
      await adapter.writeFile(p, 'v1');
      await adapter.writeFile(p, 'v2');
      expect(await adapter.readFileText(p)).toBe('v2');
    });

    it('leaves no .tmp-* litter after a successful write', async () => {
      const p = path.join(tmp, 'clean.txt');
      await adapter.writeFile(p, 'ok');
      const names = await fs.readdir(tmp);
      // Only the committed file, no tmp siblings.
      expect(names).toEqual(['clean.txt']);
    });

    it('writes to a new directory path only after mkdir', async () => {
      const p = path.join(tmp, 'sub', 'nested.txt');
      // Directory doesn't exist yet — write should fail cleanly.
      await expect(adapter.writeFile(p, 'x')).rejects.toThrow();
      await adapter.mkdir(path.join(tmp, 'sub'));
      await adapter.writeFile(p, 'ok');
      expect(await adapter.readFileText(p)).toBe('ok');
    });
  });

  describe('mkdir', () => {
    it('creates a single directory', async () => {
      const d = path.join(tmp, 'single');
      await adapter.mkdir(d);
      expect((await adapter.stat(d)).isDirectory).toBe(true);
    });

    it('creates nested directories with recursive:true', async () => {
      const d = path.join(tmp, 'a', 'b', 'c');
      await adapter.mkdir(d, { recursive: true });
      expect((await adapter.stat(d)).isDirectory).toBe(true);
    });

    it('throws on nested path without recursive:true', async () => {
      const d = path.join(tmp, 'a', 'b');
      await expect(adapter.mkdir(d)).rejects.toThrow();
    });
  });

  describe('stat', () => {
    it('reports size + isFile for a regular file', async () => {
      const p = path.join(tmp, 'size.txt');
      await adapter.writeFile(p, '12345');
      const st = await adapter.stat(p);
      expect(st.size).toBe(5);
      expect(st.isFile).toBe(true);
      expect(st.isDirectory).toBe(false);
    });

    it('reports isDirectory for a directory', async () => {
      const st = await adapter.stat(tmp);
      expect(st.isDirectory).toBe(true);
      expect(st.isFile).toBe(false);
    });

    it('throws on missing path', async () => {
      await expect(adapter.stat(path.join(tmp, 'ghost'))).rejects.toThrow();
    });

    it('returns mode within low 9 bits', async () => {
      const p = path.join(tmp, 'mode.txt');
      await adapter.writeFile(p, 'x');
      const st = await adapter.stat(p);
      // Low 9 bits only — no setuid/setgid/sticky leakage.
      expect(st.mode & ~0o777).toBe(0);
    });
  });

  describe('exists', () => {
    it('returns true for an existing file', async () => {
      const p = path.join(tmp, 'here.txt');
      await adapter.writeFile(p, 'x');
      expect(await adapter.exists(p)).toBe(true);
    });

    it('returns false for a missing file', async () => {
      expect(await adapter.exists(path.join(tmp, 'nope.txt'))).toBe(false);
    });

    it('returns true for an existing directory', async () => {
      expect(await adapter.exists(tmp)).toBe(true);
    });

    it('never throws', async () => {
      // A deeply-nested non-existent path — some fs.access variants
      // can throw ENOTDIR instead of ENOENT. exists() must swallow
      // both and return false.
      const weird = path.join(tmp, 'a', 'b', 'c', 'd');
      expect(await adapter.exists(weird)).toBe(false);
    });
  });

  describe('chmod', () => {
    it('sets permission bits on a file', async () => {
      const p = path.join(tmp, 'secret');
      await adapter.writeFile(p, 'shh');
      await adapter.chmod(p, 0o600);
      expect((await adapter.stat(p)).mode).toBe(0o600);
    });
  });

  describe('readdir', () => {
    it('lists entries non-recursively', async () => {
      await adapter.writeFile(path.join(tmp, 'a.txt'), 'a');
      await adapter.writeFile(path.join(tmp, 'b.txt'), 'b');
      await adapter.mkdir(path.join(tmp, 'sub'));
      const names = (await adapter.readdir(tmp)).sort();
      expect(names).toEqual(['a.txt', 'b.txt', 'sub']);
    });

    it('throws when called on a file, not a directory', async () => {
      const p = path.join(tmp, 'f.txt');
      await adapter.writeFile(p, 'x');
      await expect(adapter.readdir(p)).rejects.toThrow();
    });
  });
});
