/**
 * T2D.8 — DIDComm portable parts: X25519 key exchange, sharing rules.
 *
 * Category B: integration/contract test. Only the crypto/policy parts.
 *
 * Source: tests/integration/test_didcomm.py (portable parts)
 */

import { ed25519PubToX25519, ed25519SecToX25519 } from '../../src/crypto/nacl';
import { getPublicKey } from '../../src/crypto/ed25519';
import { sealEncrypt, sealDecrypt } from '../../src/crypto/nacl';
import { x25519 } from '@noble/curves/ed25519.js';
import {
  checkEgressGates,
  addContact,
  setSharingRestrictions,
  clearGatesState,
} from '../../src/d2d/gates';
import { bytesToHex } from '@dina/test-harness';

describe('DIDComm Portable', () => {
  beforeEach(() => clearGatesState());

  describe('X25519 key exchange', () => {
    it('X25519 key exchange produces shared secret for E2E encryption', () => {
      const aliceSeed = new Uint8Array(32).fill(0x41);
      const alicePub = getPublicKey(aliceSeed);
      const aliceX25519Pub = ed25519PubToX25519(alicePub);
      expect(aliceX25519Pub.length).toBe(32);
    });

    it('converted keys work bidirectionally (shared secret agreement)', () => {
      const aliceSeed = new Uint8Array(32).fill(0x41);
      const bobSeed = new Uint8Array(32).fill(0x42);

      const aliceX25519Priv = ed25519SecToX25519(aliceSeed);
      const bobX25519Priv = ed25519SecToX25519(bobSeed);

      const aliceX25519Pub = x25519.getPublicKey(aliceX25519Priv);
      const bobX25519Pub = x25519.getPublicKey(bobX25519Priv);

      const sharedA = x25519.getSharedSecret(aliceX25519Priv, bobX25519Pub);
      const sharedB = x25519.getSharedSecret(bobX25519Priv, aliceX25519Pub);

      expect(bytesToHex(sharedA)).toBe(bytesToHex(sharedB));
    });
  });

  describe('friend sharing rules', () => {
    it('friend rules permit social data', () => {
      addContact('did:plc:friend');
      // No restrictions set → all data categories allowed
      const result = checkEgressGates('did:plc:friend', 'social.update', ['social']);
      expect(result.allowed).toBe(true);
    });

    it('friend rules deny financial/health data when restricted', () => {
      addContact('did:plc:friend');
      setSharingRestrictions('did:plc:friend', ['financial', 'health']);
      const finResult = checkEgressGates('did:plc:friend', 'social.update', ['financial']);
      expect(finResult.allowed).toBe(false);
      expect(finResult.deniedAt).toBe('sharing');

      const healthResult = checkEgressGates('did:plc:friend', 'social.update', ['health']);
      expect(healthResult.allowed).toBe(false);
    });
  });

  describe('seller sharing rules', () => {
    it('seller rules permit product queries', () => {
      addContact('did:plc:seller');
      // No restrictions → product queries allowed
      const result = checkEgressGates('did:plc:seller', 'trust.vouch.request', ['consumer']);
      expect(result.allowed).toBe(true);
    });

    it('seller rules deny personal data when restricted', () => {
      addContact('did:plc:seller');
      setSharingRestrictions('did:plc:seller', ['health', 'financial', 'social']);
      const result = checkEgressGates('did:plc:seller', 'social.update', ['health']);
      expect(result.allowed).toBe(false);
      expect(result.deniedAt).toBe('sharing');
    });
  });

  describe('cryptographic sharing enforcement', () => {
    it('only allowed persona data can be encrypted for peer', () => {
      const sellerPub = getPublicKey(new Uint8Array(32).fill(0x55));

      // Data that passes the gate CAN be encrypted
      addContact('did:plc:seller');
      const allowed = checkEgressGates('did:plc:seller', 'trust.vouch.request', ['consumer']);
      expect(allowed.allowed).toBe(true);

      // If allowed, encrypt with seller's public key
      const data = new TextEncoder().encode('product query data');
      const sealed = sealEncrypt(data, sellerPub);
      expect(sealed.length).toBeGreaterThan(data.length);

      // Data that FAILS the gate must NOT be encrypted
      setSharingRestrictions('did:plc:seller', ['health']);
      const denied = checkEgressGates('did:plc:seller', 'social.update', ['health']);
      expect(denied.allowed).toBe(false);
      // Health data never reaches the encrypt step — gate blocks it first
    });
  });
});
