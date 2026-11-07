/**
 * T2A.13 — Adversarial transport: malformed payloads, oversized messages,
 * replay detection.
 *
 * Category B: contract test.
 *
 * Source: core/test/transport_adversarial_test.go
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  validateInboundPayload,
  isPayloadOversized,
  isReplayedMessage,
  recordMessageId,
  purgeReplayCache,
  clearReplayCache,
  isStaleMessage,
} from '../../src/transport/adversarial';
import { SQLiteReplayRepository, setReplayRepository } from '../../src/transport/replay_repository';

describe('Transport Adversarial', () => {
  beforeEach(() => {
    clearReplayCache();
  });

  describe('validateInboundPayload', () => {
    it('accepts valid payload', () => {
      const payload = new Uint8Array(100).fill(0xab);
      const result = validateInboundPayload(payload);
      expect(result.valid).toBe(true);
    });

    it('rejects empty payload', () => {
      const result = validateInboundPayload(new Uint8Array(0));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('empty');
    });

    it('rejects oversized payload (> 1 MiB)', () => {
      const oversized = new Uint8Array(1024 * 1024 + 1);
      const result = validateInboundPayload(oversized);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('exceeds');
    });

    it('accepts exactly 1 MiB payload', () => {
      const exact = new Uint8Array(1024 * 1024);
      expect(validateInboundPayload(exact).valid).toBe(true);
    });
  });

  describe('isPayloadOversized', () => {
    it('returns false for payload under limit', () => {
      expect(isPayloadOversized(new Uint8Array(100))).toBe(false);
    });

    it('returns true for payload over 1 MiB', () => {
      expect(isPayloadOversized(new Uint8Array(1024 * 1024 + 1))).toBe(true);
    });

    it('returns false for exactly 1 MiB (boundary)', () => {
      expect(isPayloadOversized(new Uint8Array(1024 * 1024))).toBe(false);
    });

    it('respects custom maxBytes', () => {
      expect(isPayloadOversized(new Uint8Array(500), 256)).toBe(true);
      expect(isPayloadOversized(new Uint8Array(200), 256)).toBe(false);
    });
  });

  describe('replay detection', () => {
    it('fresh message ID is not replayed', () => {
      expect(isReplayedMessage('msg-fresh-001')).toBe(false);
    });

    it('recorded message ID is replayed', () => {
      recordMessageId('msg-replay-001');
      expect(isReplayedMessage('msg-replay-001')).toBe(true);
    });

    it('different IDs are independent', () => {
      recordMessageId('msg-A');
      expect(isReplayedMessage('msg-A')).toBe(true);
      expect(isReplayedMessage('msg-B')).toBe(false);
    });
  });

  describe('replay window', () => {
    const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(T0);
      clearReplayCache();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('accepts a message from now, in milliseconds or seconds', () => {
      expect(isStaleMessage(T0)).toBe(false);
      expect(isStaleMessage(Math.floor(T0 / 1000))).toBe(false);
    });

    it('refuses a message older than a day, and one with no number', () => {
      expect(isStaleMessage(T0 - 86_401_000)).toBe(true);
      expect(isStaleMessage(Math.floor(T0 / 1000) - 86_401)).toBe(true);
      expect(isStaleMessage(undefined)).toBe(true);
      expect(isStaleMessage(Number.NaN)).toBe(true);
    });

    it('keeps a seen key while its message could still be accepted', () => {
      recordMessageId('peer|m1', T0);
      jest.setSystemTime(T0 + 86_000_000);
      expect(purgeReplayCache()).toBe(0);
      expect(isReplayedMessage('peer|m1')).toBe(true);
    });

    it('purges a key once its message is too old to accept', () => {
      recordMessageId('peer|m1', T0);
      jest.setSystemTime(T0 + 86_400_000 + 301_000);
      expect(isStaleMessage(T0)).toBe(true);
      expect(purgeReplayCache()).toBe(1);
      expect(isReplayedMessage('peer|m1')).toBe(false);
    });

    it('holds a key longer for a sender whose clock runs ahead', () => {
      const ahead = T0 + 6 * 3_600_000;
      recordMessageId('peer|m2', ahead);
      // Past the plain hold, but the message itself is still in the window.
      jest.setSystemTime(T0 + 86_400_000 + 3_600_000);
      expect(isStaleMessage(ahead)).toBe(false);
      expect(isReplayedMessage('peer|m2')).toBe(true);
    });
  });

  describe('seen keys survive a restart (SQLite store)', () => {
    afterEach(() => {
      setReplayRepository(null);
    });

    it('a key recorded before the restart is still a replay after it', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-replay-'));
      const dbPath = path.join(dir, 'identity.sqlite');
      const passphraseHex = randomBytes(32).toString('hex');
      const open = (): NodeSQLiteAdapter => {
        const db = new NodeSQLiteAdapter({ path: dbPath, passphraseHex, journalMode: 'WAL', synchronous: 'NORMAL' });
        applyMigrations(db, IDENTITY_MIGRATIONS);
        return db;
      };
      try {
        let db = open();
        setReplayRepository(new SQLiteReplayRepository(db));
        recordMessageId('did:plc:peer|d2d-1', Date.now());
        db.close();

        db = open();
        setReplayRepository(new SQLiteReplayRepository(db));
        expect(isReplayedMessage('did:plc:peer|d2d-1')).toBe(true);
        expect(isReplayedMessage('did:plc:peer|d2d-2')).toBe(false);
        db.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
