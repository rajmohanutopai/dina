/**
 * Dead drop spool — file-based message buffer.
 *
 * Stores D2D messages as individual files when the target persona vault
 * is locked. Messages are drained (read + deleted) when the persona unlocks.
 *
 * Each message is stored as `{id}.blob` in the spool directory.
 * Size cap (default 500 MB) prevents unbounded disk usage.
 *
 * Source of truth: core/internal/adapter/transport/inbox.go
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

export interface SpoolMessage {
  id: string;
  blob: Uint8Array;
}

export class DeadDropSpool {
  private readonly dir: string;
  private readonly maxBytes: number;

  constructor(dir: string, maxBytes: number = DEFAULT_MAX_BYTES) {
    if (!dir) {
      throw new Error('spool: directory path required');
    }
    if (maxBytes <= 0) {
      throw new Error('spool: maxBytes must be positive');
    }
    this.dir = dir;
    this.maxBytes = maxBytes;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Store a message blob in the spool.
   *
   * @param id - Unique message identifier (safe for filenames)
   * @param blob - Raw message bytes
   * @throws if spool is full (exceeds maxBytes cap)
   * @throws if id is empty or contains path separators
   */
  spoolMessage(id: string, blob: Uint8Array): void {
    if (!id || id.length === 0) {
      throw new Error('spool: empty message id');
    }
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error('spool: invalid message id (path traversal)');
    }
    if (!blob) {
      throw new Error('spool: blob required');
    }

    // Check cap before writing
    const currentSize = this.spoolSize();
    if (currentSize + blob.length > this.maxBytes) {
      throw new Error(`spool: full (${currentSize} + ${blob.length} > ${this.maxBytes} bytes)`);
    }

    const filePath = path.join(this.dir, `${id}.blob`);
    fs.writeFileSync(filePath, blob);
  }

  /**
   * Drain all spooled messages: read + delete each file atomically.
   * Returns messages sorted by filename (creation order if ids are time-based).
   */
  drainSpool(): SpoolMessage[] {
    const entries = this.listEntries();
    const messages: SpoolMessage[] = [];

    for (const entry of entries) {
      const filePath = path.join(this.dir, entry);
      try {
        const data = fs.readFileSync(filePath);
        const id = entry.replace(/\.blob$/, '');
        messages.push({ id, blob: new Uint8Array(data) });
        fs.unlinkSync(filePath);
      } catch {
        // File may have been drained concurrently — skip
      }
    }

    return messages;
  }

  /**
   * Total size in bytes of all spooled messages.
   */
  spoolSize(): number {
    const entries = this.listEntries();
    let total = 0;
    for (const entry of entries) {
      try {
        const stat = fs.statSync(path.join(this.dir, entry));
        total += stat.size;
      } catch {
        // File may have been deleted concurrently
      }
    }
    return total;
  }

  /**
   * True if the spool has reached its size cap.
   */
  isSpoolFull(): boolean {
    return this.spoolSize() >= this.maxBytes;
  }

  /**
   * Number of messages currently in the spool.
   */
  messageCount(): number {
    return this.listEntries().length;
  }

  /** List .blob file entries sorted by name. */
  private listEntries(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.blob'))
        .sort();
    } catch {
      return [];
    }
  }
}
