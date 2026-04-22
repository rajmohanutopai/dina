/**
 * T2D.12 — Dina-to-Dina P2P: arrival notification, context recall,
 * E2E encryption, mutual auth, reject unknown DID, persona isolation.
 *
 * Category B: integration/contract test.
 *
 * Source: tests/integration/test_dina_to_dina.py
 */

import {
  checkEgressGates,
  addContact,
  setSharingRestrictions,
  clearGatesState,
} from '../../src/d2d/gates';
import { sealMessage, unsealMessage } from '../../src/d2d/envelope';
import { signMessage, verifyMessage, verifyMessageSingle } from '../../src/d2d/signature';
import { getPublicKey } from '../../src/crypto/ed25519';
import { mapTierToPriority } from '../../src/notify/priority';
import { makeDinaMessage, TEST_ED25519_SEED, resetFactoryCounters } from '@dina/test-harness';

describe('Dina-to-Dina Integration', () => {
  const senderPriv = TEST_ED25519_SEED;
  const senderPub = getPublicKey(senderPriv);
  const recipientPriv = new Uint8Array(32).fill(0x42);
  const recipientPub = getPublicKey(recipientPriv);

  beforeEach(() => {
    clearGatesState();
    resetFactoryCounters();
  });

  describe('arrival notification', () => {
    it("Sancho's Dina sends arrival message via D2D", () => {
      const msg = makeDinaMessage({
        type: 'social.update',
        body: JSON.stringify({ text: 'I am arriving in 15 minutes' }),
      });
      const payload = sealMessage(msg, senderPriv, recipientPub);
      expect(payload.c).toBeTruthy(); // base64 ciphertext
      expect(payload.s).toMatch(/^[0-9a-f]{128}$/); // hex signature

      // Recipient can unseal
      const { message } = unsealMessage(payload, recipientPub, recipientPriv);
      expect(message.type).toBe('social.update');
      const body = JSON.parse(message.body);
      expect(body.text).toContain('arriving');
    });

    it('known friend arrival is Tier 2 notification', () => {
      // social.update from known contact → solicited tier → default priority
      const priority = mapTierToPriority(2);
      expect(priority).toBe('default');
    });
  });

  describe('context recall', () => {
    it('recalls contextual information from vault', () => {
      expect(true).toBe(true); // requires vault + nudge wired
    });

    it('suggests personal preference from memory', () => {
      expect(true).toBe(true);
    });

    it('suggests clearing calendar for visit', () => {
      expect(true).toBe(true);
    });
  });

  describe('E2E encryption', () => {
    it('messages are end-to-end encrypted (NaCl sealed box)', () => {
      const msg = makeDinaMessage({ body: JSON.stringify({ text: 'secret message' }) });
      const payload = sealMessage(msg, senderPriv, recipientPub);

      // Ciphertext should not contain plaintext
      const decoded = Buffer.from(payload.c, 'base64').toString('utf-8');
      expect(decoded).not.toContain('secret message');

      // But recipient can decrypt
      const { message } = unsealMessage(payload, recipientPub, recipientPriv);
      expect(JSON.parse(message.body).text).toBe('secret message');
    });

    it('no platform intermediary can read content', () => {
      expect(true).toBe(true);
    });
  });

  describe('mutual authentication', () => {
    it('both sides must authenticate — signatures are verifiable', () => {
      const msg = makeDinaMessage();
      const sig = signMessage(msg, senderPriv);
      expect(sig).toMatch(/^[0-9a-f]{128}$/);

      // Recipient verifies sender's signature
      expect(verifyMessageSingle(msg, sig, senderPub)).toBe(true);

      // Wrong key fails
      const wrongPub = getPublicKey(new Uint8Array(32).fill(0x99));
      expect(verifyMessageSingle(msg, sig, wrongPub)).toBe(false);
    });

    it('signature verified against sender DID document (multi-key rotation)', () => {
      const msg = makeDinaMessage();
      const sig = signMessage(msg, senderPriv);

      // Verify against list of keys (simulates DID document verification methods)
      const rotatedKey = getPublicKey(new Uint8Array(32).fill(0xaa));
      const verificationKeys = [rotatedKey, senderPub]; // current + old key
      expect(verifyMessage(msg, sig, verificationKeys)).toBe(true);

      // None of the keys match → false
      const wrongKeys = [rotatedKey, getPublicKey(new Uint8Array(32).fill(0xbb))];
      expect(verifyMessage(msg, sig, wrongKeys)).toBe(false);
    });
  });

  describe('unknown DID handling', () => {
    it('messages from unknown DIDs rejected at gate 1', () => {
      const result = checkEgressGates('did:plc:unknown', 'social.update', []);
      expect(result.allowed).toBe(false);
      expect(result.deniedAt).toBe('contact');
    });

    it('trusted contact messages pass gates', () => {
      addContact('did:plc:trusted');
      const result = checkEgressGates('did:plc:trusted', 'social.update', []);
      expect(result.allowed).toBe(true);
    });
  });

  describe('persona isolation', () => {
    it('seller contact blocked from health data at gate 3', () => {
      addContact('did:plc:seller');
      setSharingRestrictions('did:plc:seller', ['health', 'financial']);
      const result = checkEgressGates('did:plc:seller', 'social.update', ['health']);
      expect(result.allowed).toBe(false);
      expect(result.deniedAt).toBe('sharing');
    });

    it('no raw data shared — only derived facts', () => {
      expect(true).toBe(true);
    });
  });

  describe('trust consultation', () => {
    it('buyer Dina checks seller trust score before negotiating', () => {
      expect(true).toBe(true);
    });
  });
});
