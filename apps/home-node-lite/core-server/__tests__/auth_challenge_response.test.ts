/**
 * Task 4.42 — Ed25519 challenge-response tests.
 */

import { mnemonicToSeed, generateMnemonic, verify as ed25519Verify } from '@dina/core';
import { AUTH_CHALLENGE, AUTH_RESPONSE, type AuthChallengeFrame } from '@dina/protocol';
import { deriveIdentity } from '../src/identity/derivations';
import {
  buildAuthResponse,
  buildAuthRelayPayload,
  AUTH_RELAY_PREFIX,
} from '../src/msgbox/auth_challenge_response';

function fixedIdentity() {
  return deriveIdentity({ masterSeed: mnemonicToSeed(generateMnemonic()) });
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const DID = 'did:plc:homenode';

function validChallenge(overrides: Partial<AuthChallengeFrame> = {}): AuthChallengeFrame {
  return {
    type: AUTH_CHALLENGE,
    nonce: 'abcd1234',
    ts: 1_745_270_000,
    ...overrides,
  };
}

describe('buildAuthResponse (task 4.42)', () => {
  describe('happy path', () => {
    it('emits an auth_response frame with did/sig/pub', () => {
      const id = fixedIdentity();
      const frame = buildAuthResponse({
        challenge: validChallenge(),
        did: DID,
        privateKey: id.root.privateKey,
        publicKey: id.root.publicKey,
      });
      expect(frame.type).toBe(AUTH_RESPONSE);
      expect(frame.did).toBe(DID);
      expect(frame.sig).toMatch(/^[0-9a-f]{128}$/); // 64-byte Ed25519 sig
      expect(frame.pub).toMatch(/^[0-9a-f]{64}$/); // 32-byte Ed25519 pub
    });

    it('the signature verifies against the canonical AUTH_RELAY payload', () => {
      const id = fixedIdentity();
      const challenge = validChallenge({ nonce: 'deadbeef', ts: 1_745_270_999 });
      const frame = buildAuthResponse({
        challenge,
        did: DID,
        privateKey: id.root.privateKey,
        publicKey: id.root.publicKey,
      });

      // Recompute the canonical payload + verify independently.
      const payload = new TextEncoder().encode(
        buildAuthRelayPayload(challenge.nonce, challenge.ts),
      );
      // `@dina/core.verify` signature: (publicKey, message, signature) → boolean.
      expect(ed25519Verify(hexToBytes(frame.pub), payload, hexToBytes(frame.sig))).toBe(true);
    });

    it('frame.pub matches the supplied publicKey byte-for-byte', () => {
      const id = fixedIdentity();
      const frame = buildAuthResponse({
        challenge: validChallenge(),
        did: DID,
        privateKey: id.root.privateKey,
        publicKey: id.root.publicKey,
      });
      expect(Array.from(hexToBytes(frame.pub))).toEqual(Array.from(id.root.publicKey));
    });
  });

  describe('canonical payload shape', () => {
    it('AUTH_RELAY_PREFIX = "AUTH_RELAY"', () => {
      expect(AUTH_RELAY_PREFIX).toBe('AUTH_RELAY');
    });

    it('payload format is `AUTH_RELAY\\n{nonce}\\n{ts}` (3 lines)', () => {
      expect(buildAuthRelayPayload('abc', 42)).toBe('AUTH_RELAY\nabc\n42');
    });

    it('different nonces produce different signatures', () => {
      const id = fixedIdentity();
      const a = buildAuthResponse({
        challenge: validChallenge({ nonce: 'aaaa' }),
        did: DID,
        privateKey: id.root.privateKey,
        publicKey: id.root.publicKey,
      });
      const b = buildAuthResponse({
        challenge: validChallenge({ nonce: 'bbbb' }),
        did: DID,
        privateKey: id.root.privateKey,
        publicKey: id.root.publicKey,
      });
      expect(a.sig).not.toBe(b.sig);
    });

    it('different timestamps produce different signatures (replay protection at the relay)', () => {
      const id = fixedIdentity();
      const a = buildAuthResponse({
        challenge: validChallenge({ ts: 1_000_000 }),
        did: DID,
        privateKey: id.root.privateKey,
        publicKey: id.root.publicKey,
      });
      const b = buildAuthResponse({
        challenge: validChallenge({ ts: 2_000_000 }),
        did: DID,
        privateKey: id.root.privateKey,
        publicKey: id.root.publicKey,
      });
      expect(a.sig).not.toBe(b.sig);
    });

    it('signature is deterministic (RFC 8032 Ed25519) — same inputs → same sig', () => {
      const id = fixedIdentity();
      const a = buildAuthResponse({
        challenge: validChallenge(),
        did: DID,
        privateKey: id.root.privateKey,
        publicKey: id.root.publicKey,
      });
      const b = buildAuthResponse({
        challenge: validChallenge(),
        did: DID,
        privateKey: id.root.privateKey,
        publicKey: id.root.publicKey,
      });
      expect(a.sig).toBe(b.sig);
    });
  });

  describe('cross-check with pairing: different keypairs → different pub + sig', () => {
    it('two identities signing the same challenge produce different responses', () => {
      const idA = fixedIdentity();
      const idB = fixedIdentity();
      const challenge = validChallenge({ nonce: 'shared-nonce', ts: 1_745_270_000 });
      const a = buildAuthResponse({
        challenge,
        did: 'did:plc:A',
        privateKey: idA.root.privateKey,
        publicKey: idA.root.publicKey,
      });
      const b = buildAuthResponse({
        challenge,
        did: 'did:plc:B',
        privateKey: idB.root.privateKey,
        publicKey: idB.root.publicKey,
      });
      expect(a.pub).not.toBe(b.pub);
      expect(a.sig).not.toBe(b.sig);
    });
  });

  describe('input validation', () => {
    it('rejects wrong challenge type', () => {
      const id = fixedIdentity();
      expect(() =>
        buildAuthResponse({
          challenge: { type: 'not_a_challenge', nonce: 'x', ts: 1 } as unknown as AuthChallengeFrame,
          did: DID,
          privateKey: id.root.privateKey,
          publicKey: id.root.publicKey,
        }),
      ).toThrow(/challenge.type must be "auth_challenge"/);
    });

    it('rejects empty nonce', () => {
      const id = fixedIdentity();
      expect(() =>
        buildAuthResponse({
          challenge: validChallenge({ nonce: '' }),
          did: DID,
          privateKey: id.root.privateKey,
          publicKey: id.root.publicKey,
        }),
      ).toThrow(/challenge.nonce is required/);
    });

    it('rejects NaN / Infinity timestamp', () => {
      const id = fixedIdentity();
      for (const bad of [NaN, Infinity, -Infinity]) {
        expect(() =>
          buildAuthResponse({
            challenge: validChallenge({ ts: bad }),
            did: DID,
            privateKey: id.root.privateKey,
            publicKey: id.root.publicKey,
          }),
        ).toThrow(/challenge.ts must be a finite number/);
      }
    });

    it('rejects empty did', () => {
      const id = fixedIdentity();
      expect(() =>
        buildAuthResponse({
          challenge: validChallenge(),
          did: '',
          privateKey: id.root.privateKey,
          publicKey: id.root.publicKey,
        }),
      ).toThrow(/did is required/);
    });

    it('rejects wrong-length privateKey / publicKey', () => {
      const id = fixedIdentity();
      expect(() =>
        buildAuthResponse({
          challenge: validChallenge(),
          did: DID,
          privateKey: new Uint8Array(31),
          publicKey: id.root.publicKey,
        }),
      ).toThrow(/privateKey must be 32 bytes/);
      expect(() =>
        buildAuthResponse({
          challenge: validChallenge(),
          did: DID,
          privateKey: id.root.privateKey,
          publicKey: new Uint8Array(33),
        }),
      ).toThrow(/publicKey must be 32 bytes/);
    });
  });
});
