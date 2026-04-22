/**
 * Wrapped seed file storage — serialize/deserialize WrappedSeed to disk.
 *
 * Binary format (little-endian):
 *   [4] magic:       "DINA"
 *   [1] version:     0x01
 *   [2] salt_len:    length of Argon2id salt
 *   [N] salt:        salt bytes
 *   [4] wrapped_len: length of wrapped blob (nonce + ciphertext + tag)
 *   [N] wrapped:     wrapped bytes
 *   [4] memory:      Argon2id memory in KiB (uint32 LE)
 *   [4] iterations:  Argon2id iterations (uint32 LE)
 *   [4] parallelism: Argon2id parallelism (uint32 LE)
 *
 * Total overhead: 4 + 1 + 2 + 4 + 4 + 4 + 4 = 23 bytes + salt + wrapped
 *
 * Source of truth: mobile-only (server stores wrapped seed differently)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WrappedSeed } from '../crypto/aesgcm';

const MAGIC = new Uint8Array([0x44, 0x49, 0x4e, 0x41]); // "DINA"
const FORMAT_VERSION = 0x01;
const HEADER_SIZE = 4 + 1; // magic + version

/**
 * Serialize a WrappedSeed to binary format.
 */
export function serializeWrappedSeed(ws: WrappedSeed): Uint8Array {
  const saltLen = ws.salt.length;
  const wrappedLen = ws.wrapped.length;
  const totalLen = HEADER_SIZE + 2 + saltLen + 4 + wrappedLen + 4 + 4 + 4;

  const buf = new Uint8Array(totalLen);
  const dv = new DataView(buf.buffer);
  let offset = 0;

  // Magic
  buf.set(MAGIC, offset);
  offset += 4;
  // Version
  buf[offset] = FORMAT_VERSION;
  offset += 1;
  // Salt length (uint16 LE)
  dv.setUint16(offset, saltLen, true);
  offset += 2;
  // Salt
  buf.set(ws.salt, offset);
  offset += saltLen;
  // Wrapped length (uint32 LE)
  dv.setUint32(offset, wrappedLen, true);
  offset += 4;
  // Wrapped
  buf.set(ws.wrapped, offset);
  offset += wrappedLen;
  // Params
  dv.setUint32(offset, ws.params.memory, true);
  offset += 4;
  dv.setUint32(offset, ws.params.iterations, true);
  offset += 4;
  dv.setUint32(offset, ws.params.parallelism, true);
  offset += 4;

  return buf;
}

/**
 * Deserialize a WrappedSeed from binary format.
 *
 * @throws if data is too short, magic is wrong, or version is unsupported
 */
export function deserializeWrappedSeed(data: Uint8Array): WrappedSeed {
  if (!data || data.length < HEADER_SIZE + 2 + 4 + 12) {
    throw new Error('seed_file: data too short');
  }

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Validate magic
  for (let i = 0; i < 4; i++) {
    if (data[offset + i] !== MAGIC[i]) {
      throw new Error('seed_file: invalid magic — not a Dina wrapped seed file');
    }
  }
  offset += 4;

  // Validate version
  const version = data[offset];
  offset += 1;
  if (version !== FORMAT_VERSION) {
    throw new Error(`seed_file: unsupported version ${version} (expected ${FORMAT_VERSION})`);
  }

  // Salt
  const saltLen = dv.getUint16(offset, true);
  offset += 2;
  if (offset + saltLen > data.length) {
    throw new Error('seed_file: truncated salt');
  }
  const salt = data.slice(offset, offset + saltLen);
  offset += saltLen;

  // Wrapped
  if (offset + 4 > data.length) {
    throw new Error('seed_file: truncated wrapped length');
  }
  const wrappedLen = dv.getUint32(offset, true);
  offset += 4;
  if (offset + wrappedLen > data.length) {
    throw new Error('seed_file: truncated wrapped data');
  }
  const wrapped = data.slice(offset, offset + wrappedLen);
  offset += wrappedLen;

  // Params
  if (offset + 12 > data.length) {
    throw new Error('seed_file: truncated params');
  }
  const memory = dv.getUint32(offset, true);
  offset += 4;
  const iterations = dv.getUint32(offset, true);
  offset += 4;
  const parallelism = dv.getUint32(offset, true);
  offset += 4;

  return {
    salt,
    wrapped,
    params: { memory, iterations, parallelism },
  };
}

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
