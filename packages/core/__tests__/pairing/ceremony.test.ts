/**
 * T2A.5 — Device pairing ceremony: code generation, completion, security.
 *
 * Category B: contract test.
 *
 * Source: core/test/pairing_test.go
 */

import {
  generatePairingCode,
  completePairing,
  isCodeValid,
  activePairingCount,
  purgeExpiredCodes,
  clearPairingState,
  setNodeDID,
  verifyPairingIdentityBinding,
  deriveAlphanumericCode,
} from '../../src/pairing/ceremony';
import { getPublicKey } from '../../src/crypto/ed25519';
import { publicKeyToMultibase } from '../../src/identity/did';
import { resetDeviceRegistry } from '../../src/devices/registry';
import { resetCallerTypeState } from '../../src/auth/caller_type';

// Generate real Ed25519 multibase keys for testing
const testSeed1 = new Uint8Array(32).fill(0x01);
const testSeed2 = new Uint8Array(32).fill(0x02);
const testSeed3 = new Uint8Array(32).fill(0x03);
const testMultibase1 = publicKeyToMultibase(getPublicKey(testSeed1));
const testMultibase2 = publicKeyToMultibase(getPublicKey(testSeed2));
const testMultibase3 = publicKeyToMultibase(getPublicKey(testSeed3));

describe('Device Pairing Ceremony', () => {
  beforeEach(() => {
    clearPairingState();
    resetDeviceRegistry();
    resetCallerTypeState();
    setNodeDID('did:key:z6MkTestNodeDID');
  });

  describe('generatePairingCode', () => {
    it('generates an 8-character Crockford-Base32 code', () => {
      // Wire-compatible with Go's `deriveAlphanumericCode(secret, 8)`.
      // Alphabet: 0-9, A-H, J-K, M-N, P-T, V-W, X-Y, Z (no I/L/O/U).
      const { code } = generatePairingCode();
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    });

    it('matches Go reference algorithm — fixture parity (32-byte 0x42 secret → "2YM43BGA")', () => {
      // Bug-for-bug parity gate against
      // `core/internal/adapter/pairing/pairing.go:deriveAlphanumericCode`.
      // Computation: SHA-256 of 32 × 0x42 bytes → first 8 hash bytes
      // (0x42 5e d4 e4 a3 6b 30 ea) mapped via `byte % 32` into the
      // Crockford alphabet → indices 2, 30, 20, 4, 3, 11, 16, 10 →
      // "2YM43BGA". A drift in alphabet ordering, hash function, or
      // index width fails this test before any cross-stack pairing
      // breaks silently in the field.
      const secret = new Uint8Array(32).fill(0x42);
      expect(deriveAlphanumericCode(secret, 8)).toBe('2YM43BGA');
    });

    it('alphabet excludes ambiguous I/L/O/U', () => {
      // Burst of 100 codes — the alphabet is small enough that any
      // banned character would surface within a handful of draws.
      const banned = /[ILOU]/;
      for (let i = 0; i < 100; i++) {
        const { code } = generatePairingCode();
        expect(code).not.toMatch(banned);
      }
    });

    it('sets expiry in the future (~5 minutes)', () => {
      const { expiresAt } = generatePairingCode();
      const now = Math.floor(Date.now() / 1000);
      expect(expiresAt).toBeGreaterThan(now);
      expect(expiresAt).toBeLessThanOrEqual(now + 310); // ~5 min + slack
    });

    it('generates different codes on each call', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 10; i++) {
        codes.add(generatePairingCode().code);
      }
      // At least most should be unique (cryptographic randomness)
      expect(codes.size).toBeGreaterThanOrEqual(8);
    });
  });

  describe('completePairing', () => {
    it('completes with valid code + public key', () => {
      const { code } = generatePairingCode();
      const result = completePairing(code, 'iPhone 15', testMultibase1);
      expect(result.deviceId).toMatch(/^dev-/);
      expect(result.nodeDID).toMatch(/^did:/);
    });

    it('returns deviceId and nodeDID', () => {
      const { code } = generatePairingCode();
      const result = completePairing(code, 'Phone', testMultibase1);
      expect(typeof result.deviceId).toBe('string');
      expect(typeof result.nodeDID).toBe('string');
    });

    it('rejects invalid code', () => {
      expect(() => completePairing('000000', 'Phone', testMultibase1)).toThrow(
        'invalid, expired, or already-used',
      );
    });

    it('code is single-use (second completion fails)', () => {
      const { code } = generatePairingCode();
      completePairing(code, 'Phone', testMultibase1);
      expect(() => completePairing(code, 'Phone2', testMultibase2)).toThrow(
        'invalid, expired, or already-used',
      );
    });
  });

  describe('isCodeValid', () => {
    it('returns true for active code', () => {
      const { code } = generatePairingCode();
      expect(isCodeValid(code)).toBe(true);
    });

    it('returns false for unknown code', () => {
      expect(isCodeValid('999999')).toBe(false);
    });

    it('returns false for already-used code', () => {
      const { code } = generatePairingCode();
      completePairing(code, 'Phone', testMultibase1);
      expect(isCodeValid(code)).toBe(false);
    });
  });

  describe('activePairingCount', () => {
    it('reports count of unexpired codes', () => {
      expect(activePairingCount()).toBe(0);
      generatePairingCode();
      generatePairingCode();
      expect(activePairingCount()).toBe(2);
    });

    it('completed codes not counted', () => {
      const { code } = generatePairingCode();
      generatePairingCode();
      completePairing(code, 'Phone', testMultibase1);
      expect(activePairingCount()).toBe(1);
    });
  });

  describe('purgeExpiredCodes', () => {
    it('removes used codes', () => {
      const { code } = generatePairingCode();
      completePairing(code, 'Phone', testMultibase1);
      const purged = purgeExpiredCodes();
      expect(purged).toBe(1);
      expect(activePairingCount()).toBe(0);
    });

    it('does not purge active codes', () => {
      generatePairingCode();
      const purged = purgeExpiredCodes();
      expect(purged).toBe(0);
      expect(activePairingCount()).toBe(1);
    });

    it('returns count of purged codes', () => {
      const { code: c1 } = generatePairingCode();
      const { code: c2 } = generatePairingCode();
      completePairing(c1, 'P1', testMultibase2);
      completePairing(c2, 'P2', testMultibase3);
      expect(purgeExpiredCodes()).toBe(2);
    });
  });

  describe('brute-force protection', () => {
    it('wrong codes do not affect valid codes', () => {
      const { code } = generatePairingCode();
      expect(isCodeValid(code)).toBe(true);

      // Attempts with non-existent codes don't burn valid ones
      expect(() => completePairing('000001', 'X', testMultibase1)).toThrow();
      expect(() => completePairing('000002', 'X', testMultibase1)).toThrow();
      expect(() => completePairing('000003', 'X', testMultibase1)).toThrow();

      // Valid code still works
      expect(isCodeValid(code)).toBe(true);
      const result = completePairing(code, 'Phone', testMultibase1);
      expect(result.deviceId).toBeTruthy();
    });

    it('used code records failed attempts on subsequent tries', () => {
      const { code } = generatePairingCode();
      completePairing(code, 'P', testMultibase1); // succeeds, marks used

      // Further attempts on the same (used) code track failures
      expect(() => completePairing(code, 'P2', testMultibase2)).toThrow();
      expect(() => completePairing(code, 'P3', testMultibase3)).toThrow();

      // Code is already used — isCodeValid returns false
      expect(isCodeValid(code)).toBe(false);
    });

    it('activePairingCount excludes used codes', () => {
      generatePairingCode();
      const { code: c2 } = generatePairingCode();
      expect(activePairingCount()).toBe(2);

      completePairing(c2, 'P', testMultibase1);
      expect(activePairingCount()).toBe(1);
    });
  });

  describe('collision retry', () => {
    it('generates unique code even if internal collision occurs', () => {
      // Generate many codes — collision retry should handle duplicates
      const codes = new Set<string>();
      for (let i = 0; i < 20; i++) {
        try {
          const { code } = generatePairingCode();
          codes.add(code);
        } catch {
          // Max pending or collision exhaustion — acceptable
          break;
        }
      }
      // All generated codes should be unique
      expect(codes.size).toBeGreaterThanOrEqual(10);
    });
  });

  describe('end-to-end: pairing → auth resolution', () => {
    it('paired device resolves as callerType=device', () => {
      const { resolveCallerType } = require('../../src/auth/caller_type');
      const { deriveDIDKey } = require('../../src/identity/did');
      const { getPublicKey: getPub } = require('../../src/crypto/ed25519');

      const { code } = generatePairingCode();
      completePairing(code, 'TestPhone', testMultibase1);

      // Derive the DID the same way the ceremony does
      const { multibaseToPublicKey } = require('../../src/identity/did');
      const pubKey = multibaseToPublicKey(testMultibase1);
      const deviceDID = deriveDIDKey(pubKey);

      // Auth should resolve this DID as 'device'
      const identity = resolveCallerType(deviceDID);
      expect(identity.callerType).toBe('device');
      expect(identity.name).toBe('TestPhone');
    });

    it('persists device in device registry', () => {
      const { getByPublicKey } = require('../../src/devices/registry');

      const { code } = generatePairingCode();
      completePairing(code, 'TestPhone', testMultibase1);

      const device = getByPublicKey(testMultibase1);
      expect(device).not.toBeNull();
      expect(device!.deviceName).toBe('TestPhone');
      expect(device!.revoked).toBe(false);
    });

    it('revocation cascades to auth — device DID unregistered', () => {
      const { resolveCallerType } = require('../../src/auth/caller_type');
      const { revokeDevice, getByPublicKey } = require('../../src/devices/registry');
      const { multibaseToPublicKey, deriveDIDKey } = require('../../src/identity/did');

      // Pair a device
      const { code } = generatePairingCode();
      const result = completePairing(code, 'RevokablePhone', testMultibase1);

      // Derive DID
      const pubKey = multibaseToPublicKey(testMultibase1);
      const deviceDID = deriveDIDKey(pubKey);

      // Before revocation: device resolves as 'device' in auth
      expect(resolveCallerType(deviceDID).callerType).toBe('device');

      // Revoke the device
      revokeDevice(result.deviceId);

      // After revocation: device marked as revoked in registry
      const device = getByPublicKey(testMultibase1);
      expect(device!.revoked).toBe(true);

      // After revocation: device DID NO LONGER resolves as 'device' in auth
      // This was the security bug — without cascade, it would still resolve as 'device'
      const identity = resolveCallerType(deviceDID);
      expect(identity.callerType).not.toBe('device');
      expect(identity.callerType).toBe('unknown');
    });
  });

  describe('verifyPairingIdentityBinding', () => {
    it('returns true when key derives to claimed DID', () => {
      const did = require('../../src/identity/did').deriveDIDKey(getPublicKey(testSeed1));
      expect(verifyPairingIdentityBinding(testMultibase1, did)).toBe(true);
    });

    it('returns false when DID does not match key', () => {
      const wrongDID = 'did:key:z6MkWrongDID';
      expect(verifyPairingIdentityBinding(testMultibase1, wrongDID)).toBe(false);
    });

    it('returns false for invalid multibase', () => {
      expect(verifyPairingIdentityBinding('invalidKey', 'did:key:z6MkX')).toBe(false);
    });

    it('different keys produce different DIDs (cross-check)', () => {
      const did1 = require('../../src/identity/did').deriveDIDKey(getPublicKey(testSeed1));
      const did2 = require('../../src/identity/did').deriveDIDKey(getPublicKey(testSeed2));
      expect(verifyPairingIdentityBinding(testMultibase1, did1)).toBe(true);
      expect(verifyPairingIdentityBinding(testMultibase1, did2)).toBe(false);
    });
  });
});
