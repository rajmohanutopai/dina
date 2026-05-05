/**
 * Node-only file I/O for the wrapped-seed binary format. The portable
 * encode/decode pair lives in `./seed_file.ts`. This adapter is only
 * reachable through the `@dina/core/node` subpath; portable Core source
 * may not import it.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { WrappedSeed } from '../crypto/aesgcm';
import { serializeWrappedSeed, deserializeWrappedSeed } from './seed_file';

/**
 * Write a WrappedSeed to a file.
 * Creates parent directories if they don't exist.
 */
export function writeWrappedSeed(filePath: string, ws: WrappedSeed): void {
  if (!filePath) {
    throw new Error('seed_file: file path required');
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const data = serializeWrappedSeed(ws);

  // Atomic write: write to temp file, then rename.
  // Prevents partial files if process crashes mid-write.
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

/**
 * Read a WrappedSeed from a file.
 *
 * @throws if file doesn't exist or content is invalid
 */
export function readWrappedSeed(filePath: string): WrappedSeed {
  if (!filePath) {
    throw new Error('seed_file: file path required');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`seed_file: file not found — ${filePath}`);
  }
  const data = fs.readFileSync(filePath);
  return deserializeWrappedSeed(new Uint8Array(data));
}

/**
 * Check if a wrapped seed file exists.
 */
export function wrappedSeedExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
