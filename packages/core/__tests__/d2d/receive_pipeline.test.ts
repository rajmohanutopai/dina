/**
 * T6.8–6.12 — Full D2D receive pipeline: unseal → verify → trust → scenario → stage.
 *
 * Source: ARCHITECTURE.md Tasks 6.8–6.12
 */

import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { addContact, setScenarioDeny, clearGatesState } from '../../src/d2d/gates';
import { resetStagingState } from '../../src/staging/service';
import { resetAuditState, queryAudit } from '../../src/audit/service';
import { resetQuarantineState, quarantineSize } from '../../src/d2d/quarantine';
import { clearReplayCache } from '../../src/transport/adversarial';
import { getPublicKey } from '../../src/crypto/ed25519';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const senderPriv = TEST_ED25519_SEED;
const senderPub = getPublicKey(senderPriv);
const recipientPriv = new Uint8Array(32).fill(0x42);
const recipientPub = getPublicKey(recipientPriv);

function buildSealed(overrides?: Partial<DinaMessage>) {
  const msg: DinaMessage = {
    id: 'msg-001',
    type: 'social.update',
    from: 'did:plc:sender',
    to: 'did:plc:recipient',
    created_time: Date.now(),
    body: '{"text":"hello"}',
    ...overrides,
  };
  return sealMessage(msg, senderPriv, recipientPub);
}

describe('D2D Receive Pipeline', () => {
  beforeEach(() => {
    clearGatesState();
    resetStagingState();
    resetAuditState();
    resetQuarantineState();
    clearReplayCache();
  });

  describe('full pipeline success', () => {
    it('unseals → verifies → stages trusted message', () => {
      addContact('did:plc:sender');
      const payload = buildSealed();
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged');
      expect(result.signatureValid).toBe(true);
      expect(result.messageId).toBe('msg-001');
      expect(result.messageType).toBe('social.update');
      expect(result.senderDID).toBe('did:plc:sender');
      expect(result.stagingId).toMatch(/^stg-/);
    });

    it('audit logs the receive', () => {
      addContact('did:plc:sender');
      receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'trusted');
      const audits = queryAudit({ action: 'd2d_recv_staged' });
      expect(audits.length).toBeGreaterThan(0);
    });
  });

  describe('unseal failure', () => {
    it('wrong recipient key → dropped', () => {
      const payload = buildSealed();
      const wrongPriv = new Uint8Array(32).fill(0x99);
      const wrongPub = getPublicKey(wrongPriv);
      const result = receiveD2D(payload, wrongPub, wrongPriv, [senderPub], 'trusted');
      expect(result.action).toBe('dropped');
      expect(result.signatureValid).toBe(false);
      expect(result.reason).toContain('Unseal failed');
    });
  });

  describe('signature verification', () => {
    it('valid signature passes', () => {
      addContact('did:plc:sender');
      const result = receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.signatureValid).toBe(true);
    });

    it('wrong verification keys → dropped', () => {
      const wrongKey = getPublicKey(new Uint8Array(32).fill(0x77));
      const result = receiveD2D(buildSealed(), recipientPub, recipientPriv, [wrongKey], 'trusted');
      expect(result.action).toBe('dropped');
      expect(result.signatureValid).toBe(false);
      expect(result.reason).toContain('Signature');
    });

    it('bad signature audit-logged', () => {
      const wrongKey = getPublicKey(new Uint8Array(32).fill(0x77));
      receiveD2D(buildSealed(), recipientPub, recipientPriv, [wrongKey], 'trusted');
      expect(queryAudit({ action: 'd2d_recv_bad_sig' }).length).toBeGreaterThan(0);
    });
  });

  describe('trust evaluation', () => {
    it('blocked sender → dropped', () => {
      const result = receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'blocked');
      expect(result.action).toBe('dropped');
    });

    it('unknown trust_level → quarantined (not a verified contact)', () => {
      // Fix: Codex #15 — 'unknown' trust means "not a verified contact" → quarantine.
      // Only explicit positive trust levels (verified, trusted, contact_ring1, etc.) proceed.
      addContact('did:plc:sender');
      const result = receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'unknown');
      expect(result.action).toBe('quarantined');
    });

    it('verified contact → accepted (staged)', () => {
      addContact('did:plc:sender');
      const result = receiveD2D(
        buildSealed(),
        recipientPub,
        recipientPriv,
        [senderPub],
        'verified',
      );
      expect(result.action).toBe('staged');
    });

    it('non-contact (empty trust) → quarantined', () => {
      // Sender NOT in contact directory → quarantine. Pass empty string for trust.
      const result = receiveD2D(
        buildSealed({ id: 'msg-non-contact' }),
        recipientPub,
        recipientPriv,
        [senderPub],
        '',
      );
      expect(result.action).toBe('quarantined');
      expect(result.quarantineId).toBeTruthy();
      expect(quarantineSize()).toBe(1);
    });
  });

  describe('scenario policy', () => {
    it('denied message type → dropped', () => {
      addContact('did:plc:sender');
      setScenarioDeny('did:plc:sender', ['social.update']);
      const result = receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('dropped');
      expect(result.reason).toContain('Scenario policy');
    });

    it('safety.alert always passes scenario check', () => {
      addContact('did:plc:sender');
      setScenarioDeny('did:plc:sender', ['safety.alert']);
      const payload = buildSealed({ type: 'safety.alert' });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged'); // safety.alert cannot be blocked
    });

    it('scenario denial audit-logged', () => {
      addContact('did:plc:sender');
      setScenarioDeny('did:plc:sender', ['social.update']);
      receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(queryAudit({ action: 'd2d_recv_scenario_denied' }).length).toBeGreaterThan(0);
    });
  });

  describe('ephemeral messages', () => {
    it('presence.signal → ephemeral (not staged)', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({ type: 'presence.signal' });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('ephemeral');
    });
  });

  describe('replay detection (SEC-HIGH-08)', () => {
    it('accepts first message, drops second with same ID', () => {
      addContact('did:plc:sender');
      const payload1 = buildSealed({ id: 'msg-replay-test' });

      // First delivery — accepted
      const result1 = receiveD2D(payload1, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result1.action).toBe('staged');

      // Second delivery of same message — rejected as replay
      const payload2 = buildSealed({ id: 'msg-replay-test' });
      const result2 = receiveD2D(payload2, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result2.action).toBe('dropped');
      expect(result2.reason).toContain('Replayed');
    });

    it('accepts different message IDs from same sender', () => {
      addContact('did:plc:sender');
      const p1 = buildSealed({ id: 'msg-a' });
      const p2 = buildSealed({ id: 'msg-b' });

      expect(receiveD2D(p1, recipientPub, recipientPriv, [senderPub], 'trusted').action).toBe(
        'staged',
      );
      expect(receiveD2D(p2, recipientPub, recipientPriv, [senderPub], 'trusted').action).toBe(
        'staged',
      );
    });

    it('accepts same message ID from different senders', () => {
      addContact('did:plc:sender');
      addContact('did:plc:other');
      const p1 = buildSealed({ id: 'msg-shared-id', from: 'did:plc:sender' });
      const p2 = buildSealed({ id: 'msg-shared-id', from: 'did:plc:other' });

      expect(receiveD2D(p1, recipientPub, recipientPriv, [senderPub], 'trusted').action).toBe(
        'staged',
      );
      // Different sender → different replay key → accepted (not a replay)
      expect(receiveD2D(p2, recipientPub, recipientPriv, [senderPub], 'trusted').action).toBe(
        'staged',
      );
    });

    it('audit logs replay detections', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({ id: 'msg-audit-replay' });

      receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');

      const logs = queryAudit({ action: 'd2d_recv_replay' });
      expect(logs.length).toBeGreaterThan(0);
    });
  });

  describe('V1 type enforcement', () => {
    it('drops non-V1 message types with audit', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({ id: 'msg-v1-reject', type: 'dina/query' });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');

      expect(result.action).toBe('dropped');
      expect(result.reason).toContain('Non-V1');
      expect(result.signatureValid).toBe(true); // sig was valid, type was not

      const logs = queryAudit({ action: 'd2d_recv_type_rejected' });
      expect(logs.length).toBeGreaterThan(0);
    });

    it('accepts valid V1 types', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({ id: 'msg-v1-accept', type: 'social.update' });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged');
    });
  });

  describe('body size validation', () => {
    it('accepts normal-sized bodies', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({
        id: 'msg-body-ok',
        body: 'x'.repeat(1000),
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged');
    });

    it('drops bodies exceeding 256 KB', () => {
      addContact('did:plc:sender');
      // 256 KB + 1 byte
      const payload = buildSealed({
        id: 'msg-body-oversized',
        body: 'x'.repeat(256 * 1024 + 1),
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('dropped');
      expect(result.reason).toContain('exceeds maximum size');
      expect(result.signatureValid).toBe(true);
    });

    it('audit logs oversized body rejections', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({
        id: 'msg-body-audit',
        body: 'x'.repeat(256 * 1024 + 1),
      });
      receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');

      const logs = queryAudit({ action: 'd2d_recv_body_oversized' });
      expect(logs.length).toBeGreaterThan(0);
    });
  });

  describe('stagedBody — UI fan-out hook', () => {
    it('exposes the verified body on staged actions', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({
        id: 'msg-staged-body',
        body: '{"text":"hello peer"}',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged');
      expect(result.stagedBody).toBe('{"text":"hello peer"}');
    });

    it('exposes the body on ephemeral actions (e.g. presence.signal)', () => {
      const payload = buildSealed({
        id: 'msg-presence',
        type: 'presence.signal',
        body: '{"online":true}',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('ephemeral');
      expect(result.stagedBody).toBe('{"online":true}');
    });

    it('omits the body on quarantined messages (unknown sender, no contact)', () => {
      const payload = buildSealed({
        id: 'msg-quarantine',
        body: '{"text":"from a stranger"}',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');
      expect(result.action).toBe('quarantined');
      expect(result.stagedBody).toBeUndefined();
    });

    it('omits the body on dropped messages (blocked sender)', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({
        id: 'msg-blocked',
        body: '{"text":"should not leak"}',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'blocked');
      expect(result.action).toBe('dropped');
      expect(result.stagedBody).toBeUndefined();
    });
  });
});
