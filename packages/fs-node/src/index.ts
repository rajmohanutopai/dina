/**
 * `@dina/fs-node` — filesystem adapter for the Node build target.
 *
 * Thin, async wrappers over `node:fs/promises` covering the handful
 * of operations Dina's core + brain actually need: read / write /
 * mkdir / stat / exists / chmod / readdir. Keeps the I/O surface
 * small enough to port to an Expo equivalent (`@dina/fs-expo`) or a
 * browser equivalent without shape drift.
 *
 * **Write safety.** `writeFile` writes to a sibling temp path then
 * `rename()`s into place. On POSIX, `rename(2)` within the same
 * filesystem is atomic — a crash mid-write leaves the previous file
 * intact. Callers that need durability across the rename should call
 * `fsync` on the directory afterwards (not implemented here; add if
 * a consumer needs it).
 *
 * **FsPort pending.** When `@dina/core` declares an official `FsPort`
 * interface (Phase 2 task 2.1c), this module's `FsAdapter` will
 * re-export under the canonical name + satisfy it. For now the shape
 * lives here; adapters in `fs-expo` / a future browser variant should
 * mirror this interface.
 *
 * **Zero runtime deps.** Only pulls `node:fs/promises` + `node:path`
 * (both Node built-ins). Keeps the adapter light and the dep-hygiene
 * story honest — `@dina/core` shouldn't pull this accidentally.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 3c (task 3.31/3.32/3.33).
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

/**
 * File-stat view surfaced by `stat()`. Minimal by design — wraps
 * `node:fs.Stats` but hides the non-portable fields (`ino`, `dev`,
 * etc.) so a future Expo/browser backend can implement the same
 * shape without faking POSIX internals.
 */
export interface FsStat {
  /** Size in bytes. */
  size: number;
  /** Last-modified time, Unix millis. */
  mtimeMs: number;
  /** Whether the path is a regular file. */
  isFile: boolean;
  /** Whether the path is a directory. */
  isDirectory: boolean;
  /**
   * Unix permission bits (octal, e.g. 0o600). On non-POSIX platforms
   * this may be a best-effort approximation; callers should treat
   * the low 9 bits as advisory rather than a security boundary.
   */
  mode: number;
}

export interface FsAdapter {
  /** Read a file as raw bytes. Throws if missing. */
  readFile(path: string): Promise<Uint8Array>;
  /** Read a file as UTF-8 text. Throws if missing. */
  readFileText(path: string): Promise<string>;
  /**
   * Write a file safely. Content goes to a sibling temp path then
   * `rename()`s into place — crash between write and rename leaves
   * the prior file (if any) intact. Caller supplies bytes OR a
   * UTF-8 string.
   */
  writeFile(filePath: string, data: Uint8Array | string): Promise<void>;
  /** Create a directory. `recursive: true` creates parents as needed. */
  mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void>;
  /** Stat a path. Throws if missing. */
  stat(path: string): Promise<FsStat>;
  /** True iff the path exists and is reachable. Never throws. */
  exists(path: string): Promise<boolean>;
  /** Set file mode (POSIX permission bits, e.g. 0o600). */
  chmod(path: string, mode: number): Promise<void>;
  /** List directory entries (names only, non-recursive). Throws if
   *  the path is not a directory. */
  readdir(path: string): Promise<string[]>;
}

/**
 * Production `FsAdapter` — thin wrappers over `node:fs/promises`.
 * Intended for the Node build target of Dina (Fastify Core + Fastify
 * Brain) where the filesystem is genuinely available. Tests instantiate
 * this against a tmpdir rather than mocking — `node:fs/promises` is
 * plenty fast and faithful.
 */
export class NodeFsAdapter implements FsAdapter {
  async readFile(filePath: string): Promise<Uint8Array> {
    const buf = await fs.readFile(filePath);
    // `fs.readFile` returns a Node `Buffer`; slice into a plain
    // Uint8Array view so callers that extend the prototype don't
    // accidentally touch Buffer-only methods.
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async readFileText(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf8');
  }

  async writeFile(filePath: string, data: Uint8Array | string): Promise<void> {
    // Temp path lives in the target's parent directory so the final
    // rename stays on the same filesystem (POSIX atomicity guarantee
    // requires same-FS). PID + hrtime keeps two concurrent writers
    // from colliding.
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tmpPath = path.join(
      dir,
      `.${base}.tmp-${process.pid}-${process.hrtime.bigint().toString(36)}`,
    );
    const payload =
      typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    try {
      await fs.writeFile(tmpPath, payload);
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      // Best-effort cleanup of tmp on failure — missing tmp is fine
      // (rename succeeded and THEN we hit an unrelated error).
      await fs.rm(tmpPath, { force: true }).catch(() => {
        /* swallow cleanup failure; the primary error above is what matters */
      });
      throw err;
    }
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(dirPath, { recursive: options?.recursive === true });
  }

  async stat(filePath: string): Promise<FsStat> {
    const st = await fs.stat(filePath);
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      mode: st.mode & 0o777,
    };
  }

  async exists(filePath: string): Promise<boolean> {
    // `fs.access` with no mode argument = F_OK (existence check).
    // Unlike `fs.existsSync` (which is the recommended sync check
    // and DOES exist in fs/promises' older pre-Node-19 absence), this
    // works on every Node version we support.
    try {
      await fs.access(filePath, fsSync.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    await fs.chmod(filePath, mode);
  }

  async readdir(dirPath: string): Promise<string[]> {
    return fs.readdir(dirPath);
  }
}
