/**
 * T2A.5 — Device pairing ceremony: code generation, completion, security.
 *
 * Category B: contract test.
 *
 * Source: core/test/pairing_test.go
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { resetCallerTypeState } from '../../src/auth/caller_type';
import { getPublicKey } from '../../src/crypto/ed25519';
import { listDevices, resetDeviceRegistry } from '../../src/devices/registry';
import { publicKeyToMultibase } from '../../src/identity/did';
import {
  generatePairingCode,
  completePairing,
  getPairingIntent,
  isCodeValid,
  restorePairingCode,
  activePairingCount,
  purgeExpiredCodes,
  clearPairingState,
  setNodeDID,
  verifyPairingIdentityBinding,
  deriveAlphanumericCode,
} from '../../src/pairing/ceremony';
import { SQLitePluginInstallRepository, setPluginInstallRepository } from '../../src/plugins/registry';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

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

    it('round-15 #6: a malformed key does NOT consume the code (retry succeeds)', () => {
      const { code } = generatePairingCode();
      // A malformed public key makes multibaseToPublicKey throw mid-ceremony —
      // a client error, not a code guess, so the single-use code must survive.
      expect(() => completePairing(code, 'Phone', 'not-a-valid-multibase-key')).toThrow();
      expect(isCodeValid(code)).toBe(true);
      // A corrected retry with a valid key completes and THEN consumes the code.
      const result = completePairing(code, 'Phone', testMultibase1);
      expect(result.deviceId).toBeTruthy();
      expect(isCodeValid(code)).toBe(false);
    });

    it('PLG-28 #20: repeated MALFORMED keys count against the 3-attempt budget and burn the code', () => {
      const { code } = generatePairingCode();
      // Each malformed key now records a failed attempt (previously the decode
      // threw before any attempt was counted, so a held valid code could take
      // unlimited malformed guesses until expiry).
      expect(() => completePairing(code, 'Phone', 'bad-key-1')).toThrow();
      expect(isCodeValid(code)).toBe(true); // 1 < 3
      expect(() => completePairing(code, 'Phone', 'bad-key-2')).toThrow();
      expect(isCodeValid(code)).toBe(true); // 2 < 3
      expect(() => completePairing(code, 'Phone', 'bad-key-3')).toThrow();
      // 3rd malformed attempt hits the budget → the code is burned.
      expect(isCodeValid(code)).toBe(false);
      // Even a VALID key is now refused.
      expect(() => completePairing(code, 'Phone', testMultibase1)).toThrow(
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

    it('Item C — threads the initiate-time agent_scope onto the paired device', () => {
      const { getByPublicKey } = require('../../src/devices/registry');
      // Initiate stamps scope='coding' (as the bootstrap capability does).
      const { code } = generatePairingCode({
        role: 'agent',
        scope: 'coding',
        deviceName: 'coding-plugin',
      });
      // The intent carries it (the /complete route reads this — authoritative).
      expect(getPairingIntent(code)?.scope).toBe('coding');
      // Redeem with the authoritative scope from the intent.
      completePairing(code, 'coding-plugin', testMultibase1, 'agent', 'coding');
      const device = getByPublicKey(testMultibase1);
      expect(device!.role).toBe('agent');
      expect(device!.scope).toBe('coding');
    });

    it('Item C — a non-agent pairing carries no scope', () => {
      const { getByPublicKey } = require('../../src/devices/registry');
      const { code } = generatePairingCode({ role: 'rich', deviceName: 'phone' });
      expect(getPairingIntent(code)?.scope).toBeUndefined();
      completePairing(code, 'phone', testMultibase1, 'rich');
      expect(getByPublicKey(testMultibase1)!.scope).toBeUndefined();
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

  describe('runner codes bind in Core (PLUGIN_ARCHITECTURE §15.3)', () => {
    const NOW = 1_750_000_000_000;
    let installs: SQLitePluginInstallRepository;
    let adapter: NodeSQLiteAdapter;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'ceremony-plugins-'));
      adapter = new NodeSQLiteAdapter({
        path: path.join(dir, 'identity.sqlite'),
        passphraseHex: randomBytes(32).toString('hex'),
      });
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      installs = new SQLitePluginInstallRepository(adapter);
      setPluginInstallRepository(installs);
    });
    afterEach(() => {
      setPluginInstallRepository(null);
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    });

    function pendingRunner(expiresInSec = 900): string {
      return installs.createPending({
        publisherDid: 'did:plc:acme',
        pluginId: 'com.acme.widget',
        label: '',
        executionMode: 'runner',
        currentCid: 'bafyreicid1',
        currentVersion: '1.0.0',
        manifest: {
          $type: 'com.dinakernel.plugin.release',
          plugin_id: 'com.acme.widget',
          version: '1.0.0',
          display_name: 'Widget',
          execution: { mode: 'runner' },
          capabilities: [],
        } as never,
        installScopeHash: 's'.repeat(64),
        capabilityHashes: {},
        behaviorHash: 'b'.repeat(64),
        presentationHash: 'p'.repeat(64),
        trustAnchor: { kind: 'repo_proof' },
        pendingExpiresAtSec: Math.floor(Date.now() / 1000) + expiresInSec,
        nowMs: NOW,
      });
    }

    it('the device that uses the code is bound to exactly that pending install, before the code is spent', () => {
      const installId = pendingRunner();
      const { code } = generatePairingCode({ role: 'plugin', scope: 'runner', pluginInstallId: installId });
      expect(getPairingIntent(code)?.pluginInstallId).toBe(installId);

      completePairing(code, 'runner', testMultibase1, 'plugin', 'runner');
      expect(installs.getById(installId)?.deviceDid).toBe(`did:key:${testMultibase1}`);
      expect(isCodeValid(code)).toBe(false);
    });

    it('a code whose install is gone, expired, or held by another runner refuses to pair and registers nothing', () => {
      // Gone.
      const gone = pendingRunner();
      const { code: goneCode } = generatePairingCode({ role: 'plugin', scope: 'runner', pluginInstallId: gone });
      installs.remove(gone);
      expect(() => completePairing(goneCode, 'runner', testMultibase1, 'plugin', 'runner')).toThrow(/no longer pending/);
      expect(isCodeValid(goneCode)).toBe(false);

      // Expired install (the code itself is still fresh).
      const expired = pendingRunner(-1);
      const { code: expiredCode } = generatePairingCode({ role: 'plugin', scope: 'runner', pluginInstallId: expired });
      expect(() => completePairing(expiredCode, 'runner', testMultibase2, 'plugin', 'runner')).toThrow(/expired/);

      // Already bound to another runner.
      const held = pendingRunner();
      const { code: first } = generatePairingCode({ role: 'plugin', scope: 'runner', pluginInstallId: held });
      const { code: second } = generatePairingCode({ role: 'plugin', scope: 'runner', pluginInstallId: held });
      completePairing(first, 'runner', testMultibase2, 'plugin', 'runner');
      expect(() => completePairing(second, 'runner', testMultibase3, 'plugin', 'runner')).toThrow(/already bound/);
      expect(installs.getById(held)?.deviceDid).toBe(`did:key:${testMultibase2}`);

      // Only the one successful runner exists as a device.
      expect(listDevices().filter((d) => !d.revoked).map((d) => d.publicKeyMultibase)).toEqual([testMultibase2]);
    });

    it('a storage fault during the bind rolls the device back and keeps the code live for a retry', () => {
      const installId = pendingRunner();
      const { code } = generatePairingCode({ role: 'plugin', scope: 'runner', pluginInstallId: installId });
      // A repository whose bind throws (SQLITE_BUSY / I/O), wrapped around the real one.
      let faultOnce = true;
      setPluginInstallRepository(
        new Proxy(installs, {
          get(target, prop, receiver) {
            if (prop === 'bindPendingDevice') {
              return (...args: [string, string, number]) => {
                if (faultOnce) {
                  faultOnce = false;
                  throw new Error('SQLITE_BUSY');
                }
                return target.bindPendingDevice(...args);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }),
      );
      expect(() => completePairing(code, 'runner', testMultibase1, 'plugin', 'runner')).toThrow(/bind failed/);
      // No unreferenced plugin device survives, and the code was NOT spent.
      expect(listDevices().filter((d) => !d.revoked)).toEqual([]);
      expect(installs.getById(installId)?.deviceDid).toBeUndefined();
      expect(isCodeValid(code)).toBe(true);
      // The same runner retries the same code and binds.
      completePairing(code, 'runner', testMultibase1, 'plugin', 'runner');
      expect(installs.getById(installId)?.deviceDid).toBe(`did:key:${testMultibase1}`);
    });

    it('restorePairingCode does not revive a runner code whose install is gone', () => {
      const installId = pendingRunner();
      const { code } = generatePairingCode({ role: 'plugin', scope: 'runner', pluginInstallId: installId });
      completePairing(code, 'runner', testMultibase1, 'plugin', 'runner');
      // The durable-persist rollback's cascade removes the pending install.
      installs.remove(installId);
      restorePairingCode(code);
      expect(isCodeValid(code)).toBe(false);
      // A plain (non-runner) code is restored as before.
      const { code: plain } = generatePairingCode({ role: 'agent', scope: 'coding' });
      completePairing(plain, 'agent', testMultibase2, 'agent', 'coding');
      restorePairingCode(plain);
      expect(isCodeValid(plain)).toBe(true);
    });

    it('the same runner may retry its own code binding (idempotent for the same device)', () => {
      const installId = pendingRunner();
      installs.bindPendingDevice(installId, `did:key:${testMultibase1}`, NOW);
      const { code } = generatePairingCode({ role: 'plugin', scope: 'runner', pluginInstallId: installId });
      expect(() => completePairing(code, 'runner', testMultibase1, 'plugin', 'runner')).not.toThrow();
    });
  });
});
