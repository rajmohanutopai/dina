/**
 * Task 4.38 — sealed-box push envelope tests.
 */

import { mnemonicToSeed, generateMnemonic } from '@dina/core';
import { deriveIdentity } from '../src/identity/derivations';
import {
  buildPushEnvelope,
  openPushEnvelope,
  PUSH_ENVELOPE_TYPE,
  PUSH_ENVELOPE_VERSION,
} from '../src/ws/push_envelope';

function fixedIdentity() {
  return deriveIdentity({ masterSeed: mnemonicToSeed(generateMnemonic()) });
}

const DEVICE_DID = 'did:key:z6Mkdevice';

describe('buildPushEnvelope (task 4.38)', () => {
  it('produces a frame whose type + v match the canonical constants', () => {
    const device = fixedIdentity();
    const frame = buildPushEnvelope({
      recipientDid: DEVICE_DID,
      recipientEd25519Pub: device.root.publicKey,
      plaintext: new TextEncoder().encode('hello'),
    });
    expect(frame.type).toBe(PUSH_ENVELOPE_TYPE);
    expect(frame.v).toBe(PUSH_ENVELOPE_VERSION);
    expect(frame.to).toBe(DEVICE_DID);
    expect(frame.sealed_hex).toMatch(/^[0-9a-f]+$/);
  });

  it('sealed length = 32 (eph pub) + 16 (MAC) + plaintext length', () => {
    const device = fixedIdentity();
    const plaintext = new TextEncoder().encode('exactly-20-character');
    const frame = buildPushEnvelope({
      recipientDid: DEVICE_DID,
      recipientEd25519Pub: device.root.publicKey,
      plaintext,
    });
    // sealed_hex is 2× the byte count; bytes = 32 + 16 + plaintext.length = 68
    expect(frame.sealed_hex.length).toBe((32 + 16 + plaintext.length) * 2);
  });

  it('ciphertext is non-deterministic (fresh ephemeral key per call)', () => {
    const device = fixedIdentity();
    const input = {
      recipientDid: DEVICE_DID,
      recipientEd25519Pub: device.root.publicKey,
      plaintext: new TextEncoder().encode('same plaintext'),
    };
    const a = buildPushEnvelope(input);
    const b = buildPushEnvelope(input);
    expect(a.sealed_hex).not.toBe(b.sealed_hex);
  });

  it('round-trips: open yields the original plaintext', () => {
    const device = fixedIdentity();
    const plaintext = new TextEncoder().encode('the medium is the message');
    const frame = buildPushEnvelope({
      recipientDid: DEVICE_DID,
      recipientEd25519Pub: device.root.publicKey,
      plaintext,
    });
    const recovered = openPushEnvelope(frame, device.root.privateKey, device.root.publicKey);
    expect(Array.from(recovered)).toEqual(Array.from(plaintext));
  });

  it('wrong-key open rejects (Poly1305 MAC fail)', () => {
    const deviceA = fixedIdentity();
    const deviceB = fixedIdentity(); // a different device
    const frame = buildPushEnvelope({
      recipientDid: DEVICE_DID,
      recipientEd25519Pub: deviceA.root.publicKey,
      plaintext: new TextEncoder().encode('for A only'),
    });
    expect(() =>
      openPushEnvelope(frame, deviceB.root.privateKey, deviceB.root.publicKey),
    ).toThrow();
  });

  it('empty plaintext round-trips (push envelope with no body is meaningful)', () => {
    const device = fixedIdentity();
    const frame = buildPushEnvelope({
      recipientDid: DEVICE_DID,
      recipientEd25519Pub: device.root.publicKey,
      plaintext: new Uint8Array(0),
    });
    const recovered = openPushEnvelope(frame, device.root.privateKey, device.root.publicKey);
    expect(recovered.length).toBe(0);
  });

  describe('input validation', () => {
    it('rejects empty recipientDid', () => {
      const device = fixedIdentity();
      expect(() =>
        buildPushEnvelope({
          recipientDid: '',
          recipientEd25519Pub: device.root.publicKey,
          plaintext: new Uint8Array(0),
        }),
      ).toThrow(/recipientDid is required/);
    });

    it('rejects wrong-length pubkey', () => {
      expect(() =>
        buildPushEnvelope({
          recipientDid: DEVICE_DID,
          recipientEd25519Pub: new Uint8Array(31),
          plaintext: new Uint8Array(0),
        }),
      ).toThrow(/must be 32 bytes/);
    });
  });

  describe('openPushEnvelope safety rails', () => {
    it('rejects wrong frame type', () => {
      const device = fixedIdentity();
      const frame = buildPushEnvelope({
        recipientDid: DEVICE_DID,
        recipientEd25519Pub: device.root.publicKey,
        plaintext: new Uint8Array(0),
      });
      const bogus = { ...frame, type: 'not_a_push_envelope' as typeof PUSH_ENVELOPE_TYPE };
      expect(() =>
        openPushEnvelope(bogus, device.root.privateKey, device.root.publicKey),
      ).toThrow(/wrong frame type/);
    });

    it('rejects future envelope version', () => {
      const device = fixedIdentity();
      const frame = buildPushEnvelope({
        recipientDid: DEVICE_DID,
        recipientEd25519Pub: device.root.publicKey,
        plaintext: new Uint8Array(0),
      });
      const bogus = { ...frame, v: 99 as typeof PUSH_ENVELOPE_VERSION };
      expect(() =>
        openPushEnvelope(bogus, device.root.privateKey, device.root.publicKey),
      ).toThrow(/unsupported envelope version 99/);
    });
  });
});
