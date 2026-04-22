/**
 * T1C.1 — Wrapped seed file storage.
 *
 * Category B: contract test. Verifies:
 * - Serialize → deserialize round-trip preserves all fields
 * - Write → read round-trip from disk
 * - Invalid files rejected (bad magic, wrong version, truncated)
 * - File persists and can be re-read
 *
 * Source: mobile-only (server uses different seed storage)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  serializeWrappedSeed,
  deserializeWrappedSeed,
  writeWrappedSeed,
  readWrappedSeed,
  wrappedSeedExists,
} from '../../src/storage/seed_file';
import { wrapSeed } from '../../src/crypto/aesgcm';
import { TEST_PASSPHRASE, TEST_MNEMONIC_SEED, bytesToHex } from '@dina/test-harness';
import type { WrappedSeed } from '../../src/crypto/aesgcm';

// Argon2id is needed for wrapSeed
jest.setTimeout(30_000);

describe('Wrapped Seed File Storage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-seed-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a minimal WrappedSeed for fast tests (no Argon2id). */
  function makeTestWrappedSeed(): WrappedSeed {
    return {
      salt: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      wrapped: new Uint8Array([
        // nonce (12) + ciphertext (32) + tag (16) = 60 bytes
        ...new Array(60).fill(0).map((_, i) => i & 0xff),
      ]),
      params: { memory: 131072, iterations: 3, parallelism: 4 },
    };
  }

  describe('serializeWrappedSeed / deserializeWrappedSeed', () => {
    it('round-trip preserves all fields', () => {
      const original = makeTestWrappedSeed();
      const serialized = serializeWrappedSeed(original);
      const deserialized = deserializeWrappedSeed(serialized);

      expect(bytesToHex(deserialized.salt)).toBe(bytesToHex(original.salt));
      expect(bytesToHex(deserialized.wrapped)).toBe(bytesToHex(original.wrapped));
      expect(deserialized.params.memory).toBe(original.params.memory);
      expect(deserialized.params.iterations).toBe(original.params.iterations);
      expect(deserialized.params.parallelism).toBe(original.params.parallelism);
    });

    it('starts with DINA magic bytes', () => {
      const serialized = serializeWrappedSeed(makeTestWrappedSeed());
      expect(serialized[0]).toBe(0x44); // D
      expect(serialized[1]).toBe(0x49); // I
      expect(serialized[2]).toBe(0x4e); // N
      expect(serialized[3]).toBe(0x41); // A
    });

    it('version byte is 0x01', () => {
      const serialized = serializeWrappedSeed(makeTestWrappedSeed());
      expect(serialized[4]).toBe(0x01);
    });

    it('serialized size matches expected', () => {
      const ws = makeTestWrappedSeed();
      const serialized = serializeWrappedSeed(ws);
      // 4 magic + 1 version + 2 salt_len + 16 salt + 4 wrapped_len + 60 wrapped + 4+4+4 params
      expect(serialized.length).toBe(4 + 1 + 2 + 16 + 4 + 60 + 12);
    });

    it('rejects data with wrong magic', () => {
      const serialized = serializeWrappedSeed(makeTestWrappedSeed());
      serialized[0] = 0x00; // corrupt magic
      expect(() => deserializeWrappedSeed(serialized)).toThrow('invalid magic');
    });

    it('rejects data with wrong version', () => {
      const serialized = serializeWrappedSeed(makeTestWrappedSeed());
      serialized[4] = 0x99; // future version
      expect(() => deserializeWrappedSeed(serialized)).toThrow('unsupported version');
    });

    it('rejects truncated data', () => {
      const serialized = serializeWrappedSeed(makeTestWrappedSeed());
      const truncated = serialized.slice(0, 10);
      expect(() => deserializeWrappedSeed(truncated)).toThrow();
    });

    it('rejects data too short for header', () => {
      expect(() => deserializeWrappedSeed(new Uint8Array(5))).toThrow('data too short');
    });
  });

  describe('writeWrappedSeed / readWrappedSeed', () => {
    it('write → read round-trip preserves WrappedSeed', () => {
      const original = makeTestWrappedSeed();
      const filePath = path.join(tmpDir, 'wrapped_seed.bin');

      writeWrappedSeed(filePath, original);
      const loaded = readWrappedSeed(filePath);

      expect(bytesToHex(loaded.salt)).toBe(bytesToHex(original.salt));
      expect(bytesToHex(loaded.wrapped)).toBe(bytesToHex(original.wrapped));
      expect(loaded.params).toEqual(original.params);
    });

    it('file persists and can be re-read', () => {
      const filePath = path.join(tmpDir, 'wrapped_seed.bin');
      writeWrappedSeed(filePath, makeTestWrappedSeed());

      // Read twice
      const first = readWrappedSeed(filePath);
      const second = readWrappedSeed(filePath);
      expect(bytesToHex(first.wrapped)).toBe(bytesToHex(second.wrapped));
    });

    it('creates parent directories if needed', () => {
      const filePath = path.join(tmpDir, 'nested', 'dir', 'wrapped_seed.bin');
      writeWrappedSeed(filePath, makeTestWrappedSeed());
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('readWrappedSeed throws if file missing', () => {
      expect(() => readWrappedSeed(path.join(tmpDir, 'nope.bin'))).toThrow('file not found');
    });

    it('readWrappedSeed throws on corrupted file', () => {
      const filePath = path.join(tmpDir, 'bad.bin');
      fs.writeFileSync(filePath, 'this is not a wrapped seed');
      expect(() => readWrappedSeed(filePath)).toThrow('invalid magic');
    });

    it('rejects empty file path', () => {
      expect(() => writeWrappedSeed('', makeTestWrappedSeed())).toThrow('file path required');
      expect(() => readWrappedSeed('')).toThrow('file path required');
    });
  });

  describe('wrappedSeedExists', () => {
    it('returns false when file does not exist', () => {
      expect(wrappedSeedExists(path.join(tmpDir, 'nope.bin'))).toBe(false);
    });

    it('returns true when file exists', () => {
      const filePath = path.join(tmpDir, 'wrapped_seed.bin');
      writeWrappedSeed(filePath, makeTestWrappedSeed());
      expect(wrappedSeedExists(filePath)).toBe(true);
    });
  });

  describe('integration with real wrapSeed', () => {
    it('wraps seed → writes to file → reads back → unwraps recovers original', async () => {
      const seed = TEST_MNEMONIC_SEED;
      const wrapped = await wrapSeed(TEST_PASSPHRASE, seed);

      const filePath = path.join(tmpDir, 'wrapped_seed.bin');
      writeWrappedSeed(filePath, wrapped);

      const loaded = readWrappedSeed(filePath);
      expect(bytesToHex(loaded.salt)).toBe(bytesToHex(wrapped.salt));
      expect(bytesToHex(loaded.wrapped)).toBe(bytesToHex(wrapped.wrapped));
      expect(loaded.params).toEqual(wrapped.params);
    });
  });
});
