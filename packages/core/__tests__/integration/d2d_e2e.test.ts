/**
 * D2D End-to-End Integration — complete send + receive pipeline.
 *
 * Exercises every module in the D2D chain:
 *   Send: gates → buildMessage → signMessage → sealMessage → deliver → audit → outbox
 *   Receive: unseal → verify → trust → scenario → stage/quarantine → audit
 *
 * Source: ARCHITECTURE.md Tasks 6.3–6.12 combined
 */

import { sendD2D } from '../../src/d2d/send';
import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { sealMessage, unsealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { signMessage, verifyMessage } from '../../src/d2d/signature';
import { addContact, setScenarioDeny, clearGatesState } from '../../src/d2d/gates';
import { getItem as getStagingItem, resetStagingState } from '../../src/staging/service';
import { clearOutbox, outboxSize } from '../../src/transport/outbox';
import { setDeliveryFetchFn, resetDeliveryDeps } from '../../src/transport/delivery';
import { resetAuditState, queryAudit, auditCount } from '../../src/audit/service';
import {
  resetQuarantineState,
  quarantineSize,
  listQuarantined,
  unquarantineSender,
} from '../../src/d2d/quarantine';
import { getPublicKey } from '../../src/crypto/ed25519';
import { TEST_ED25519_SEED } from '@dina/test-harness';

// Alice (sender) and Bob (recipient) key pairs
const alicePriv = TEST_ED25519_SEED;
const alicePub = getPublicKey(alicePriv);
const aliceDID = 'did:plc:alice';

const bobPriv = new Uint8Array(32).fill(0x42);
const bobPub = getPublicKey(bobPriv);
const bobDID = 'did:plc:bob';

describe('D2D End-to-End Integration', () => {
  beforeEach(() => {
    clearGatesState();
    resetStagingState();
    clearOutbox();
    resetAuditState();
    resetQuarantineState();
    resetDeliveryDeps();
  });

  describe('happy path: Alice sends → Bob receives', () => {
    it('complete flow: send → seal → deliver → unseal → verify → stage', async () => {
      // === Setup: Alice and Bob know each other ===
      addContact(bobDID); // Alice knows Bob (for sending)

      // Mock delivery to capture the sealed payload
      let capturedPayload: Uint8Array | null = null;
      setDeliveryFetchFn(async (_url: any, opts: any) => {
        capturedPayload =
          opts.body instanceof Uint8Array ? opts.body : new TextEncoder().encode(String(opts.body));
        return {
          ok: true,
          json: async () => ({ status: 'delivered', msg_id: 'mx-1' }),
        } as Response;
      });

      // === Alice sends ===
      const sendResult = await sendD2D({
        recipientDID: bobDID,
        messageType: 'social.update',
        body: '{"text":"I arrived safely!"}',
        senderDID: aliceDID,
        senderPrivateKey: alicePriv,
        recipientPublicKey: bobPub,
        serviceType: 'DinaMsgBox',
        endpoint: 'wss://mailbox.dinakernel.com',
      });

      expect(sendResult.sent).toBe(true);
      expect(sendResult.delivered).toBe(true);
      expect(sendResult.messageId).toMatch(/^d2d-/);

      // === Verify: sealed payload was captured ===
      expect(capturedPayload).not.toBeNull();

      // === Bob receives: unseal + verify + stage ===
      // Parse the D2D payload from the captured delivery
      const payloadJSON = JSON.parse(new TextDecoder().decode(capturedPayload!));
      const receiveResult = receiveD2D(
        payloadJSON,
        bobPub,
        bobPriv,
        [alicePub], // Alice's verification keys
        'trusted', // Bob trusts Alice
      );

      expect(receiveResult.action).toBe('staged');
      expect(receiveResult.signatureValid).toBe(true);
      expect(receiveResult.messageType).toBe('social.update');
      expect(receiveResult.senderDID).toBe(aliceDID);
      expect(receiveResult.stagingId).toMatch(/^stg-/);

      // === Verify: staging item contains the message ===
      const staged = getStagingItem(receiveResult.stagingId!);
      expect(staged).not.toBeNull();
      expect(staged!.source).toBe('d2d');

      // === Verify: audit trail on both sides ===
      expect(auditCount()).toBeGreaterThanOrEqual(2); // send + receive
    });
  });

  describe('unknown sender → quarantine flow', () => {
    it('message from stranger quarantined, then un-quarantined when added as contact', () => {
      // Alice sends to Bob, but Bob doesn't know Alice
      const msg: DinaMessage = {
        id: 'msg-stranger',
        type: 'social.update',
        from: aliceDID,
        to: bobDID,
        created_time: Date.now(),
        body: '{"text":"Hi, I am Alice!"}',
      };

      const payload = sealMessage(msg, alicePriv, bobPub);

      // Bob receives — Alice is a stranger (empty trust = not a contact) → quarantined
      const result = receiveD2D(payload, bobPub, bobPriv, [alicePub], '');
      expect(result.action).toBe('quarantined');
      expect(quarantineSize()).toBe(1);

      // Bob adds Alice as contact → un-quarantine
      const unquarantined = unquarantineSender(aliceDID);
      expect(unquarantined).toHaveLength(1);
      expect(unquarantined[0].body).toContain('Alice');
      expect(quarantineSize()).toBe(0);
    });
  });

  describe('blocked sender → silent drop', () => {
    it('message from blocked sender dropped with no trace', () => {
      const msg: DinaMessage = {
        id: 'msg-blocked',
        type: 'social.update',
        from: 'did:plc:spammer',
        to: bobDID,
        created_time: Date.now(),
        body: '{"text":"spam"}',
      };

      const payload = sealMessage(msg, alicePriv, bobPub);
      const result = receiveD2D(payload, bobPub, bobPriv, [alicePub], 'blocked');
      expect(result.action).toBe('dropped');
      expect(quarantineSize()).toBe(0); // not quarantined
    });
  });

  describe('scenario policy enforcement', () => {
    it('denied message type dropped even from trusted sender', () => {
      addContact(aliceDID);
      setScenarioDeny(aliceDID, ['social.update']); // Block social updates from Alice

      const msg: DinaMessage = {
        id: 'msg-denied',
        type: 'social.update',
        from: aliceDID,
        to: bobDID,
        created_time: Date.now(),
        body: '{"text":"update"}',
      };

      const payload = sealMessage(msg, alicePriv, bobPub);
      const result = receiveD2D(payload, bobPub, bobPriv, [alicePub], 'trusted');
      expect(result.action).toBe('dropped');
      expect(result.reason).toContain('Scenario');
    });

    it('safety.alert always passes regardless of scenario policy', () => {
      addContact(aliceDID);
      setScenarioDeny(aliceDID, ['safety.alert']); // Try to block safety alerts

      const msg: DinaMessage = {
        id: 'msg-alert',
        type: 'safety.alert',
        from: aliceDID,
        to: bobDID,
        created_time: Date.now(),
        body: '{"alert":"emergency!"}',
      };

      const payload = sealMessage(msg, alicePriv, bobPub);
      const result = receiveD2D(payload, bobPub, bobPriv, [alicePub], 'trusted');
      expect(result.action).toBe('staged'); // Cannot block safety.alert
    });
  });

  describe('signature security', () => {
    it('message with wrong signing key is rejected', () => {
      addContact(aliceDID);
      const wrongPriv = new Uint8Array(32).fill(0x99);
      const wrongPub = getPublicKey(wrongPriv);

      const msg: DinaMessage = {
        id: 'msg-forged',
        type: 'social.update',
        from: aliceDID,
        to: bobDID,
        created_time: Date.now(),
        body: '{"text":"forged"}',
      };

      // Seal with wrong key
      const payload = sealMessage(msg, wrongPriv, bobPub);
      // Bob verifies against Alice's real key → fails
      const result = receiveD2D(payload, bobPub, bobPriv, [alicePub], 'trusted');
      expect(result.action).toBe('dropped');
      expect(result.signatureValid).toBe(false);
    });
  });

  describe('delivery failure → outbox → retry', () => {
    it('network failure queues in outbox', async () => {
      addContact(bobDID);
      setDeliveryFetchFn(async () => {
        throw new Error('ECONNREFUSED');
      });

      const result = await sendD2D({
        recipientDID: bobDID,
        messageType: 'social.update',
        body: '{"text":"retry me"}',
        senderDID: aliceDID,
        senderPrivateKey: alicePriv,
        recipientPublicKey: bobPub,
        serviceType: 'DinaMsgBox',
        endpoint: 'wss://mailbox.dinakernel.com',
      });

      expect(result.queued).toBe(true);
      expect(outboxSize()).toBe(1);
    });
  });
});
