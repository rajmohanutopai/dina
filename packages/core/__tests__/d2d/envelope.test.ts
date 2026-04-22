/**
 * T1D.1 — D2D message envelope: build, parse, seal, unseal.
 *
 * Source: core/test/transport_d2d_sig_test.go
 */

import { buildMessage, parseMessage, sealMessage, unsealMessage } from '../../src/d2d/envelope';
import { verifyMessageSingle } from '../../src/d2d/signature';
import { getPublicKey } from '../../src/crypto/ed25519';
import type { DinaMessage } from '../../src/d2d/envelope';
import { TEST_ED25519_SEED, bytesToHex } from '@dina/test-harness';

describe('D2D Envelope', () => {
  const testMsg: DinaMessage = {
    id: 'msg_20260409_abc123',
    type: 'social.update',
    from: 'did:plc:sender123',
    to: 'did:plc:recipient456',
    created_time: 1740000000,
    body: JSON.stringify({ text: 'I am arriving in 15 minutes' }),
  };

  describe('buildMessage', () => {
    it('serializes a DinaMessage to JSON', () => {
      const json = buildMessage(testMsg);
      expect(typeof json).toBe('string');
      const parsed = JSON.parse(json);
      expect(parsed.id).toBe('msg_20260409_abc123');
    });

    it('includes all required fields', () => {
      const json = buildMessage(testMsg);
      const parsed = JSON.parse(json);
      expect(parsed.id).toBeDefined();
      expect(parsed.type).toBeDefined();
      expect(parsed.from).toBeDefined();
      expect(parsed.to).toBeDefined();
      expect(parsed.created_time).toBeDefined();
      expect(parsed.body).toBeDefined();
    });

    it('is deterministic', () => {
      expect(buildMessage(testMsg)).toBe(buildMessage(testMsg));
    });
  });

  describe('parseMessage', () => {
    it('parses valid DinaMessage JSON', () => {
      const msg = parseMessage(JSON.stringify(testMsg));
      expect(msg.id).toBe('msg_20260409_abc123');
      expect(msg.type).toBe('social.update');
    });

    it('rejects JSON missing required fields', () => {
      expect(() => parseMessage('{}')).toThrow('missing required');
    });

    it('rejects invalid JSON', () => {
      expect(() => parseMessage('not json')).toThrow('invalid JSON');
    });

    it('rejects JSON with wrong types', () => {
      expect(() => parseMessage('{"id": 123}')).toThrow();
    });

    it('round-trips: build → parse', () => {
      const json = buildMessage(testMsg);
      const parsed = parseMessage(json);
      expect(parsed.id).toBe(testMsg.id);
      expect(parsed.body).toBe(testMsg.body);
    });
  });

  describe('sealMessage + unsealMessage', () => {
    // Use a real keypair for the recipient
    const recipientPriv = TEST_ED25519_SEED;
    const recipientPub = getPublicKey(recipientPriv);
    const senderPriv = new Uint8Array(32).fill(0x42);
    const senderPub = getPublicKey(senderPriv);

    it('produces a D2DPayload with c and s fields', () => {
      const payload = sealMessage(testMsg, senderPriv, recipientPub);
      expect(payload.c).toBeTruthy();
      expect(payload.s).toBeTruthy();
      expect(payload.s).toMatch(/^[0-9a-f]{128}$/);
    });

    it('c field is base64-encoded', () => {
      const payload = sealMessage(testMsg, senderPriv, recipientPub);
      expect(() => Buffer.from(payload.c, 'base64')).not.toThrow();
    });

    it('seal → unseal recovers original message', () => {
      const payload = sealMessage(testMsg, senderPriv, recipientPub);
      const { message, signatureHex } = unsealMessage(payload, recipientPub, recipientPriv);
      expect(message.id).toBe(testMsg.id);
      expect(message.type).toBe(testMsg.type);
      expect(message.body).toBe(testMsg.body);
    });

    it('returns the signature for separate verification', () => {
      const payload = sealMessage(testMsg, senderPriv, recipientPub);
      const { message, signatureHex } = unsealMessage(payload, recipientPub, recipientPriv);
      expect(signatureHex).toBe(payload.s);
      expect(verifyMessageSingle(message, signatureHex, senderPub)).toBe(true);
    });

    it('wrong recipient cannot unseal', () => {
      const payload = sealMessage(testMsg, senderPriv, recipientPub);
      const wrongPriv = new Uint8Array(32).fill(0x99);
      const wrongPub = getPublicKey(wrongPriv);
      expect(() => unsealMessage(payload, wrongPub, wrongPriv)).toThrow();
    });
  });
});
