/**
 * T1L.4 — Ed25519 keypair management (Python identity vectors).
 *
 * Category A: fixture-based. Verifies keypair generation, PEM serialization,
 * signing, verification, and service key file I/O.
 *
 * Source: tests/test_identity.py
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  generateKeypair,
  keypairToPEM,
  keypairFromPEM,
  signWithIdentity,
  verifyWithIdentity,
  writeServiceKey,
  loadServiceKey,
} from '../../src/identity/keypair';
import { TEST_MESSAGE, bytesToHex } from '@dina/test-harness';

describe('Ed25519 Keypair Management', () => {
  describe('generateKeypair', () => {
    it('generates a keypair with public and private keys', () => {
      const kp = generateKeypair();
      expect(kp.publicKey).toBeInstanceOf(Uint8Array);
      expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    });

    it('public key is 32 bytes', () => {
      expect(generateKeypair().publicKey.length).toBe(32);
    });

    it('private key seed is 32 bytes', () => {
      expect(generateKeypair().privateKey.length).toBe(32);
    });

    it('two calls produce different keys', () => {
      const a = generateKeypair();
      const b = generateKeypair();
      expect(bytesToHex(a.privateKey)).not.toBe(bytesToHex(b.privateKey));
      expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
    });
  });

  describe('PEM serialization', () => {
    it('produces valid PEM headers', () => {
      const kp = generateKeypair();
      const { privatePEM, publicPEM } = keypairToPEM(kp);
      expect(privatePEM).toContain('-----BEGIN PRIVATE KEY-----');
      expect(privatePEM).toContain('-----END PRIVATE KEY-----');
      expect(publicPEM).toContain('-----BEGIN PUBLIC KEY-----');
      expect(publicPEM).toContain('-----END PUBLIC KEY-----');
    });

    it('PEM lines do not exceed 64 characters', () => {
      const kp = generateKeypair();
      const { privatePEM } = keypairToPEM(kp);
      const lines = privatePEM.split('\n').filter((l) => !l.startsWith('-----') && l.length > 0);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(64);
      }
    });

    it('roundtrips: generate → PEM → fromPEM → same keys', () => {
      const original = generateKeypair();
      const pem = keypairToPEM(original);
      const restored = keypairFromPEM(pem.privatePEM, pem.publicPEM);
      expect(bytesToHex(restored.publicKey)).toBe(bytesToHex(original.publicKey));
      expect(bytesToHex(restored.privateKey)).toBe(bytesToHex(original.privateKey));
    });

    it('rejects PEM with mismatched public/private keys', () => {
      const kp1 = generateKeypair();
      const kp2 = generateKeypair();
      const pem1 = keypairToPEM(kp1);
      const pem2 = keypairToPEM(kp2);
      expect(() => keypairFromPEM(pem1.privatePEM, pem2.publicPEM)).toThrow('does not match');
    });

    it('rejects corrupted PEM', () => {
      expect(() => keypairFromPEM('not a pem', 'also not')).toThrow();
    });
  });

  describe('signWithIdentity', () => {
    const kp = generateKeypair();

    it('returns 64-byte signature', () => {
      const sig = signWithIdentity(TEST_MESSAGE, kp.privateKey);
      expect(sig).toBeInstanceOf(Uint8Array);
      expect(sig.length).toBe(64);
    });

    it('signs empty data', () => {
      const sig = signWithIdentity(new Uint8Array(0), kp.privateKey);
      expect(sig.length).toBe(64);
    });

    it('is deterministic', () => {
      const s1 = signWithIdentity(TEST_MESSAGE, kp.privateKey);
      const s2 = signWithIdentity(TEST_MESSAGE, kp.privateKey);
      expect(bytesToHex(s1)).toBe(bytesToHex(s2));
    });
  });

  describe('verifyWithIdentity', () => {
    const kp = generateKeypair();

    it('returns true for valid signature', () => {
      const sig = signWithIdentity(TEST_MESSAGE, kp.privateKey);
      expect(verifyWithIdentity(TEST_MESSAGE, sig, kp.publicKey)).toBe(true);
    });

    it('returns false for tampered data', () => {
      const sig = signWithIdentity(TEST_MESSAGE, kp.privateKey);
      const tampered = new Uint8Array(TEST_MESSAGE);
      tampered[0] ^= 0xff;
      expect(verifyWithIdentity(tampered, sig, kp.publicKey)).toBe(false);
    });

    it('returns false for wrong identity', () => {
      const sig = signWithIdentity(TEST_MESSAGE, kp.privateKey);
      const other = generateKeypair();
      expect(verifyWithIdentity(TEST_MESSAGE, sig, other.publicKey)).toBe(false);
    });

    it('full round-trip: generate → sign → PEM → reload → verify', () => {
      const sig = signWithIdentity(TEST_MESSAGE, kp.privateKey);
      const pem = keypairToPEM(kp);
      const restored = keypairFromPEM(pem.privatePEM, pem.publicPEM);
      expect(verifyWithIdentity(TEST_MESSAGE, sig, restored.publicKey)).toBe(true);
    });
  });

  describe('Service key file I/O', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-svc-keys-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes and loads service key PEM files', () => {
      const kp = generateKeypair();
      writeServiceKey(tmpDir, 'brain', kp);

      expect(fs.existsSync(path.join(tmpDir, 'brain.key'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'brain.pub'))).toBe(true);

      const loaded = loadServiceKey(tmpDir, 'brain');
      expect(bytesToHex(loaded.publicKey)).toBe(bytesToHex(kp.publicKey));
      expect(bytesToHex(loaded.privateKey)).toBe(bytesToHex(kp.privateKey));
    });

    it('loaded key can verify signatures from original', () => {
      const kp = generateKeypair();
      const sig = signWithIdentity(TEST_MESSAGE, kp.privateKey);
      writeServiceKey(tmpDir, 'core', kp);

      const loaded = loadServiceKey(tmpDir, 'core');
      expect(verifyWithIdentity(TEST_MESSAGE, sig, loaded.publicKey)).toBe(true);
    });

    it('throws if private key file missing', () => {
      expect(() => loadServiceKey(tmpDir, 'nope')).toThrow('private key file not found');
    });

    it('throws if public key file missing', () => {
      const kp = generateKeypair();
      const { privatePEM } = keypairToPEM(kp);
      fs.writeFileSync(path.join(tmpDir, 'half.key'), privatePEM);
      expect(() => loadServiceKey(tmpDir, 'half')).toThrow('public key file not found');
    });
  });
});
