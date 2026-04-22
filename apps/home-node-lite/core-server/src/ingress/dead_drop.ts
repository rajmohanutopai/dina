/**
 * Task 4.34 — Dead Drop spool for messages that arrive while the
 * vault is locked.
 *
 * When a DIDComm / MsgBox / D2D message lands and the recipient's
 * vault is locked, we can't decrypt it in-process, but we mustn't
 * drop it either — the sender deserves at-least-once delivery. The
 * Dead Drop writes the opaque (still-encrypted) blob to a spool
 * directory. When the vault unlocks, the sweeper (task 4.35+) drains
 * the spool, decrypts, and routes each blob.
 *
 * **Design constraints** (mirror Go `core/internal/ingress/deaddrop.go`):
 *
 *   - **Blobs are opaque** — no metadata, no sender DID visible while
 *     locked. The blob itself is already sealed by the sender.
 *   - **Atomic writes** — write to `.tmp-<id>` then `rename()` to
 *     `<id>.blob`. Prevents half-written files on crash.
 *   - **Capacity caps** — `maxBlobs` (count) + `maxBytes` (total size)
 *     form the two valves that prevent disk exhaustion under
 *     sustained delivery to a long-locked vault.
 *   - **Random 16-byte hex filename** — prevents filename-based
 *     sender enumeration + ordering leaks.
 *   - **Consume-once `read()`** — removes the blob after returning it
 *     so the sweeper can't double-process. `peek()` + `ack()` gives
 *     callers explicit two-phase commit when they need crash-safe
 *     processing.
 *   - **Directory permissions 0o700** — only the running user reads
 *     the spool. Blobs are already encrypted but defence-in-depth.
 *
 * **Filesystem-backed** on purpose — the vault can stay locked across
 * process restarts (passphrase tier), so in-memory would lose the
 * queued blobs. Node's `fs/promises` API is sufficient; no
 * SQLCipher dependency.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4e task 4.34.
 */

import { randomBytes } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

export const BLOB_EXTENSION = '.blob';
export const TMP_PREFIX = '.tmp-';
export const ID_BYTES = 16;
export const SPOOL_DIR_MODE = 0o700;
export const SPOOL_FILE_MODE = 0o600;

export type DeadDropErrorReason =
  | 'spool_full_blobs'
  | 'spool_full_bytes'
  | 'not_found'
  | 'invalid_id';

export class DeadDropError extends Error {
  constructor(
    public readonly reason: DeadDropErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'DeadDropError';
  }
}

export interface DeadDropOptions {
  /**
   * Hard cap on the number of blobs in the spool. Reject stores past
   * this; prevents unbounded disk usage on a long-locked vault.
   */
  maxBlobs: number;
  /**
   * Hard cap on the total byte size of the spool. Same rationale as
   * `maxBlobs` but in the disk-space dimension.
   */
  maxBytes: number;
  /**
   * Byte source for id generation. Default `node:crypto.randomBytes`.
   * Tests pass deterministic bytes to exercise edge cases.
   */
  randomBytesFn?: (n: number) => Uint8Array;
}

export interface DeadDropStats {
  blobs: number;
  bytes: number;
}

export class DeadDropSpool {
  readonly dir: string;
  readonly maxBlobs: number;
  readonly maxBytes: number;
  private readonly randomBytesFn: (n: number) => Uint8Array;
  // Serialises store/read/ack across concurrent awaiters within the
  // same process. Filesystem atomicity handles cross-process safety,
  // but intra-process races (simultaneous stores racing the capacity
  // check) are handled here.
  private mutex: Promise<void> = Promise.resolve();

  constructor(dir: string, opts: DeadDropOptions) {
    if (!dir || typeof dir !== 'string') {
      throw new Error('DeadDropSpool: dir is required');
    }
    if (!Number.isInteger(opts.maxBlobs) || opts.maxBlobs <= 0) {
      throw new Error(
        `DeadDropSpool: maxBlobs must be a positive integer (got ${opts.maxBlobs})`,
      );
    }
    if (!Number.isInteger(opts.maxBytes) || opts.maxBytes <= 0) {
      throw new Error(
        `DeadDropSpool: maxBytes must be a positive integer (got ${opts.maxBytes})`,
      );
    }
    this.dir = dir;
    this.maxBlobs = opts.maxBlobs;
    this.maxBytes = opts.maxBytes;
    this.randomBytesFn =
      opts.randomBytesFn ?? ((n: number) => new Uint8Array(randomBytes(n)));
  }

  /**
   * Store an opaque blob. Returns the id (hex string). Throws
   * `DeadDropError` with `spool_full_blobs` or `spool_full_bytes`
   * when a capacity cap is hit.
   *
   * Atomic: writes to `<dir>/.tmp-<id>` then renames to
   * `<dir>/<id>.blob`. A crash between write + rename leaves the
   * tmp file which the caller can garbage-collect on startup (task
   * 4.35 sweeper).
   */
  async store(blob: Uint8Array): Promise<{ id: string }> {
    return this.withLock(async () => {
      await this.ensureDir();
      const stats = await this.statsUnlocked();
      if (stats.blobs >= this.maxBlobs) {
        throw new DeadDropError(
          'spool_full_blobs',
          `DeadDropSpool: blob count limit reached (${this.maxBlobs})`,
        );
      }
      if (stats.bytes + blob.length > this.maxBytes) {
        throw new DeadDropError(
          'spool_full_bytes',
          `DeadDropSpool: byte size limit reached (${this.maxBytes})`,
        );
      }

      const id = this.generateId();
      const tmpPath = join(this.dir, TMP_PREFIX + id + BLOB_EXTENSION);
      const finalPath = join(this.dir, id + BLOB_EXTENSION);

      try {
        await fsPromises.writeFile(tmpPath, blob, { mode: SPOOL_FILE_MODE });
        await fsPromises.rename(tmpPath, finalPath);
      } catch (err) {
        // Best-effort cleanup of the tmp file.
        try {
          await fsPromises.unlink(tmpPath);
        } catch {
          // ignore — either the tmp write failed before create, or the
          // rename already consumed the tmp.
        }
        throw err;
      }
      return { id };
    });
  }

  /**
   * List every blob id currently in the spool. Ordered
   * alphabetically (matches filesystem enumeration order on every
   * modern FS; sort-on-read eliminates `readdir` ordering drift).
   */
  async list(): Promise<string[]> {
    return this.withLock(async () => {
      const ids: string[] = [];
      for (const entry of await this.readDirSafe()) {
        const id = this.idFromFilename(entry);
        if (id !== null) ids.push(id);
      }
      ids.sort();
      return ids;
    });
  }

  /**
   * Read a blob WITHOUT removing it. Use with `ack()` for two-phase
   * commit — the sweeper peeks, processes, and only then acks.
   */
  async peek(id: string): Promise<Uint8Array> {
    this.validateId(id);
    return this.withLock(() => this.readBlobUnlocked(id));
  }

  /**
   * Read a blob AND remove it (consume-once). Fine for the common
   * case where processing is idempotent + crash-safe downstream.
   */
  async read(id: string): Promise<Uint8Array> {
    this.validateId(id);
    return this.withLock(async () => {
      const blob = await this.readBlobUnlocked(id);
      await fsPromises.unlink(join(this.dir, id + BLOB_EXTENSION));
      return blob;
    });
  }

  /**
   * Explicitly remove a blob (companion to `peek()`). Throws
   * `not_found` on unknown id.
   */
  async ack(id: string): Promise<void> {
    this.validateId(id);
    return this.withLock(async () => {
      try {
        await fsPromises.unlink(join(this.dir, id + BLOB_EXTENSION));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new DeadDropError(
            'not_found',
            `DeadDropSpool.ack: blob ${JSON.stringify(id)} not found`,
          );
        }
        throw err;
      }
    });
  }

  /** Count + total size of blobs in the spool. Fast + read-only. */
  async stats(): Promise<DeadDropStats> {
    return this.withLock(() => this.statsUnlocked());
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async ensureDir(): Promise<void> {
    await fsPromises.mkdir(this.dir, { recursive: true, mode: SPOOL_DIR_MODE });
  }

  private async readDirSafe(): Promise<string[]> {
    try {
      return await fsPromises.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async statsUnlocked(): Promise<DeadDropStats> {
    let count = 0;
    let totalBytes = 0;
    for (const entry of await this.readDirSafe()) {
      if (this.idFromFilename(entry) === null) continue;
      try {
        const st = await fsPromises.stat(join(this.dir, entry));
        if (st.isFile()) {
          count += 1;
          totalBytes += st.size;
        }
      } catch {
        // Racing unlink — skip.
      }
    }
    return { blobs: count, bytes: totalBytes };
  }

  private async readBlobUnlocked(id: string): Promise<Uint8Array> {
    const path = join(this.dir, id + BLOB_EXTENSION);
    try {
      const buf = await fsPromises.readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DeadDropError(
          'not_found',
          `DeadDropSpool: blob ${JSON.stringify(id)} not found`,
        );
      }
      throw err;
    }
  }

  private generateId(): string {
    const bytes = this.randomBytesFn(ID_BYTES);
    if (bytes.length !== ID_BYTES) {
      throw new Error(
        `DeadDropSpool: randomBytesFn returned ${bytes.length} bytes, expected ${ID_BYTES}`,
      );
    }
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
    }
    return out;
  }

  /**
   * Validate that `id` is 32-char hex (the format `generateId()`
   * produces). Rejects path-traversal attempts like `../../etc/passwd`
   * at the API boundary so the `join()` below can't escape the spool
   * directory.
   */
  private validateId(id: string): void {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) {
      throw new DeadDropError(
        'invalid_id',
        `DeadDropSpool: id must be 32-char hex (got ${JSON.stringify(id)})`,
      );
    }
  }

  /** Filename → id, or null if the entry is not a blob file. */
  private idFromFilename(name: string): string | null {
    if (name.startsWith(TMP_PREFIX)) return null;
    if (!name.endsWith(BLOB_EXTENSION)) return null;
    const id = name.slice(0, name.length - BLOB_EXTENSION.length);
    if (!/^[0-9a-f]{32}$/.test(id)) return null;
    return id;
  }

  /**
   * Serialise the enclosed async body against other `withLock` calls
   * on the same instance. Not a real cross-process mutex — the
   * filesystem's atomic rename is the cross-process story. This
   * prevents intra-process races (e.g. two concurrent `store()`
   * calls both passing the capacity check before either has
   * committed).
   */
  private async withLock<T>(body: () => Promise<T>): Promise<T> {
    const prior = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((r) => {
      release = r;
    });
    await prior;
    try {
      return await body();
    } finally {
      release();
    }
  }
}
