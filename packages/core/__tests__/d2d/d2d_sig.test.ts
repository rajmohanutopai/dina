/**
 * T1D.4 — D2D message signature: sign plaintext, verify against multiple keys.
 *
 * Source: core/test/transport_d2d_sig_test.go
 */

import { signMessage, verifyMessage, verifyMessageSingle } from '../../src/d2d/signature';
import { getPublicKey } from '../../src/crypto/ed25519';
import type { DinaMessage } from '../../src/d2d/envelope';
import { TEST_ED25519_SEED } from '@dina/test-harness';

describe('D2D Message Signature', () => {
  const msg: DinaMessage = {
    id: 'msg_sig_test_001',
    type: 'social.update',
    from: 'did:plc:sender123',
    to: 'did:plc:recipient456',
    created_time: 1740000000,
    body: JSON.stringify({ text: 'Hello from Sancho' }),
  };

  const senderPriv = TEST_ED25519_SEED;
  const senderPub = getPublicKey(senderPriv);
  const wrongPub = getPublicKey(new Uint8Array(32).fill(0x99));

  describe('signMessage', () => {
    it('produces a 128-char hex signature', () => {
      const sig = signMessage(msg, senderPriv);
      expect(sig).toMatch(/^[0-9a-f]{128}$/);
    });

    it('is deterministic', () => {
      expect(signMessage(msg, senderPriv)).toBe(signMessage(msg, senderPriv));
    });

    it('different messages produce different signatures', () => {
      const other = { ...msg, body: 'different body' };
      expect(signMessage(msg, senderPriv)).not.toBe(signMessage(other, senderPriv));
    });

    it('different keys produce different signatures', () => {
      const otherKey = new Uint8Array(32).fill(0x42);
      expect(signMessage(msg, senderPriv)).not.toBe(signMessage(msg, otherKey));
    });
  });

  describe('verifyMessageSingle', () => {
    it('returns true for valid signature + correct key', () => {
      const sig = signMessage(msg, senderPriv);
      expect(verifyMessageSingle(msg, sig, senderPub)).toBe(true);
    });

    it('returns false for tampered message', () => {
      const sig = signMessage(msg, senderPriv);
      const tampered = { ...msg, body: 'tampered' };
      expect(verifyMessageSingle(tampered, sig, senderPub)).toBe(false);
    });

    it('returns false for wrong public key', () => {
      const sig = signMessage(msg, senderPriv);
      expect(verifyMessageSingle(msg, sig, wrongPub)).toBe(false);
    });

    it('returns false for corrupted signature', () => {
      expect(verifyMessageSingle(msg, 'corrupted', senderPub)).toBe(false);
    });
  });

  describe('verifyMessage (multi-key, key rotation)', () => {
    it('verifies against first matching key', () => {
      const sig = signMessage(msg, senderPriv);
      expect(verifyMessage(msg, sig, [wrongPub, senderPub])).toBe(true);
    });

    it('returns false when no key matches', () => {
      const sig = signMessage(msg, senderPriv);
      expect(verifyMessage(msg, sig, [wrongPub])).toBe(false);
    });

    it('returns false for empty key list', () => {
      const sig = signMessage(msg, senderPriv);
      expect(verifyMessage(msg, sig, [])).toBe(false);
    });

    it('works with correct key at any position', () => {
      const sig = signMessage(msg, senderPriv);
      const otherPub = getPublicKey(new Uint8Array(32).fill(0x88));
      expect(verifyMessage(msg, sig, [wrongPub, otherPub, senderPub])).toBe(true);
    });
  });
});
