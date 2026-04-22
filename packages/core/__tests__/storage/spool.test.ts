/**
 * T1B.10 — Dead drop spool (file-based).
 *
 * Category B: contract test. Verifies:
 * - spool → drain round-trip recovers blobs
 * - 500 MB cap enforced
 * - drainSpool reads all then deletes
 * - empty spool returns empty array
 * - path traversal rejected
 *
 * Source: core/test/transport_test.go (TestInboxSpool_*)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DeadDropSpool } from '../../src/storage/spool';

describe('Dead Drop Spool', () => {
  let spoolDir: string;
  let spool: DeadDropSpool;

  beforeEach(() => {
    spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-spool-'));
    spool = new DeadDropSpool(spoolDir);
  });

  afterEach(() => {
    fs.rmSync(spoolDir, { recursive: true, force: true });
  });

  describe('spoolMessage', () => {
    it('stores a message blob as a file', () => {
      const blob = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
      spool.spoolMessage('msg-001', blob);

      const filePath = path.join(spoolDir, 'msg-001.blob');
      expect(fs.existsSync(filePath)).toBe(true);
      const data = fs.readFileSync(filePath);
      expect(Buffer.from(data).equals(Buffer.from(blob))).toBe(true);
    });

    it('stores multiple messages', () => {
      spool.spoolMessage('a', new Uint8Array([1]));
      spool.spoolMessage('b', new Uint8Array([2]));
      spool.spoolMessage('c', new Uint8Array([3]));
      expect(spool.messageCount()).toBe(3);
    });

    it('rejects empty message id', () => {
      expect(() => spool.spoolMessage('', new Uint8Array([1]))).toThrow('empty message id');
    });

    it('rejects path traversal in id', () => {
      expect(() => spool.spoolMessage('../etc/passwd', new Uint8Array([1]))).toThrow(
        'path traversal',
      );
      expect(() => spool.spoolMessage('foo/bar', new Uint8Array([1]))).toThrow('path traversal');
    });

    it('rejects null blob', () => {
      expect(() => spool.spoolMessage('x', null as any)).toThrow('blob required');
    });

    it('allows empty blob (zero-length message)', () => {
      spool.spoolMessage('empty', new Uint8Array(0));
      expect(spool.messageCount()).toBe(1);
    });
  });

  describe('drainSpool', () => {
    it('returns all spooled messages', () => {
      spool.spoolMessage('msg-1', new Uint8Array([0x01]));
      spool.spoolMessage('msg-2', new Uint8Array([0x02, 0x03]));
      spool.spoolMessage('msg-3', new Uint8Array([0x04, 0x05, 0x06]));

      const drained = spool.drainSpool();
      expect(drained.length).toBe(3);
      expect(drained[0].id).toBe('msg-1');
      expect(drained[0].blob).toEqual(new Uint8Array([0x01]));
      expect(drained[2].id).toBe('msg-3');
      expect(drained[2].blob).toEqual(new Uint8Array([0x04, 0x05, 0x06]));
    });

    it('deletes all files after draining', () => {
      spool.spoolMessage('a', new Uint8Array([1]));
      spool.spoolMessage('b', new Uint8Array([2]));

      spool.drainSpool();

      expect(spool.messageCount()).toBe(0);
      expect(spool.spoolSize()).toBe(0);
    });

    it('returns empty array when spool is empty', () => {
      const drained = spool.drainSpool();
      expect(drained).toEqual([]);
    });

    it('second drain after first returns empty', () => {
      spool.spoolMessage('x', new Uint8Array([0xff]));
      const first = spool.drainSpool();
      expect(first.length).toBe(1);

      const second = spool.drainSpool();
      expect(second.length).toBe(0);
    });
  });

  describe('spoolSize', () => {
    it('returns 0 for empty spool', () => {
      expect(spool.spoolSize()).toBe(0);
    });

    it('returns total bytes of all messages', () => {
      spool.spoolMessage('a', new Uint8Array(100));
      spool.spoolMessage('b', new Uint8Array(200));
      expect(spool.spoolSize()).toBe(300);
    });
  });

  describe('isSpoolFull', () => {
    it('returns false when under cap', () => {
      expect(spool.isSpoolFull()).toBe(false);
    });

    it('returns true when at or over cap', () => {
      // Create spool with tiny 10-byte cap
      const tinySpool = new DeadDropSpool(spoolDir, 10);
      tinySpool.spoolMessage('a', new Uint8Array(10));
      expect(tinySpool.isSpoolFull()).toBe(true);
    });
  });

  describe('500MB cap enforcement', () => {
    it('rejects message that would exceed cap', () => {
      // Create spool with 100-byte cap
      const smallSpool = new DeadDropSpool(spoolDir, 100);
      smallSpool.spoolMessage('a', new Uint8Array(60));

      expect(() => smallSpool.spoolMessage('b', new Uint8Array(50))).toThrow('spool: full');
    });

    it('allows message right at the cap', () => {
      const smallSpool = new DeadDropSpool(spoolDir, 100);
      smallSpool.spoolMessage('exact', new Uint8Array(100));
      expect(smallSpool.spoolSize()).toBe(100);
    });

    it('accepts new messages after drain frees space', () => {
      const smallSpool = new DeadDropSpool(spoolDir, 100);
      smallSpool.spoolMessage('a', new Uint8Array(80));

      // Full — can't add 30 bytes
      expect(() => smallSpool.spoolMessage('b', new Uint8Array(30))).toThrow('spool: full');

      // Drain frees space
      smallSpool.drainSpool();

      // Now it fits
      smallSpool.spoolMessage('c', new Uint8Array(30));
      expect(smallSpool.messageCount()).toBe(1);
    });
  });

  describe('round-trip fidelity', () => {
    it('preserves exact blob bytes through spool → drain', () => {
      // Random-looking data
      const blob = new Uint8Array(256);
      for (let i = 0; i < 256; i++) blob[i] = i;

      spool.spoolMessage('roundtrip', blob);
      const drained = spool.drainSpool();

      expect(drained.length).toBe(1);
      expect(drained[0].id).toBe('roundtrip');
      expect(drained[0].blob).toEqual(blob);
    });

    it('preserves large blob (64KB)', () => {
      const large = new Uint8Array(65536);
      for (let i = 0; i < large.length; i++) large[i] = i & 0xff;

      spool.spoolMessage('large', large);
      const [msg] = spool.drainSpool();
      expect(msg.blob).toEqual(large);
    });
  });

  describe('constructor validation', () => {
    it('creates spool directory if it does not exist', () => {
      const newDir = path.join(spoolDir, 'nested', 'spool');
      const s = new DeadDropSpool(newDir);
      expect(fs.existsSync(newDir)).toBe(true);
      s.spoolMessage('t', new Uint8Array([1]));
      expect(s.messageCount()).toBe(1);
    });

    it('rejects empty directory path', () => {
      expect(() => new DeadDropSpool('')).toThrow('directory path required');
    });

    it('rejects non-positive maxBytes', () => {
      expect(() => new DeadDropSpool(spoolDir, 0)).toThrow('maxBytes must be positive');
      expect(() => new DeadDropSpool(spoolDir, -1)).toThrow('maxBytes must be positive');
    });
  });
});
