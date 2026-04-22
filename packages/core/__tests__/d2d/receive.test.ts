/**
 * T6.12 — D2D receive: stage incoming message to vault.
 *
 * Source: ARCHITECTURE.md Tasks 6.10–6.12
 */

import { receiveAndStage, evaluateSenderTrust } from '../../src/d2d/receive';
import { getItem, resetStagingState } from '../../src/staging/service';

describe('D2D Receive — Stage Memory', () => {
  beforeEach(() => resetStagingState());

  describe('receiveAndStage', () => {
    it('stages social.update from trusted sender as relationship_note', () => {
      const result = receiveAndStage(
        'social.update',
        'did:plc:alice',
        'trusted',
        '{"text":"I arrived safely"}',
        'msg-001',
        true,
      );
      expect(result.action).toBe('staged');
      expect(result.vaultItemType).toBe('relationship_note');
      expect(result.stagingId).toMatch(/^stg-/);
    });

    it('stages trust.vouch.response as trust_attestation', () => {
      const result = receiveAndStage(
        'trust.vouch.response',
        'did:plc:bob',
        'verified',
        '{"rating":85}',
        'msg-002',
        true,
      );
      expect(result.action).toBe('staged');
      expect(result.vaultItemType).toBe('trust_attestation');
    });

    it('unknown message type uses original type', () => {
      const result = receiveAndStage(
        'custom.type',
        'did:plc:alice',
        'trusted',
        '{"data":"test"}',
        'msg-003',
        true,
      );
      expect(result.action).toBe('staged');
      expect(result.vaultItemType).toBe('custom.type');
    });

    it('ephemeral type (presence.signal) not staged', () => {
      const result = receiveAndStage(
        'presence.signal',
        'did:plc:alice',
        'trusted',
        '{}',
        'msg-004',
      );
      expect(result.action).toBe('ephemeral');
      expect(result.stagingId).toBeUndefined();
    });

    it('blocked sender → dropped silently', () => {
      const result = receiveAndStage(
        'social.update',
        'did:plc:blocked',
        'blocked',
        '{"text":"spam"}',
        'msg-005',
      );
      expect(result.action).toBe('dropped');
    });

    it('non-contact → quarantined', () => {
      const result = receiveAndStage(
        'social.update',
        'did:plc:stranger',
        'unknown',
        '{"text":"hello"}',
        'msg-006',
        false,
      );
      expect(result.action).toBe('quarantined');
      expect(result.vaultItemType).toBe('relationship_note');
    });

    it('contact with trust_level=unknown → ACCEPTED (Go EvaluateIngress)', () => {
      const result = receiveAndStage(
        'social.update',
        'did:plc:newcontact',
        'unknown',
        '{"text":"hi"}',
        'msg-006b',
        true,
      );
      expect(result.action).toBe('staged');
    });

    it('safety.alert always passes regardless of trust', () => {
      const result = receiveAndStage(
        'safety.alert',
        'did:plc:unknown',
        'unknown',
        '{"alert":"emergency"}',
        'msg-007',
      );
      expect(result.action).toBe('staged'); // not quarantined
    });

    it('staged item appears in staging inbox', () => {
      const result = receiveAndStage(
        'social.update',
        'did:plc:alice',
        'trusted',
        '{"text":"test"}',
        'msg-008',
        true,
      );
      const item = getItem(result.stagingId!);
      expect(item).not.toBeNull();
      expect(item!.source).toBe('d2d');
      expect(item!.data.sender_did).toBe('did:plc:alice');
      expect(item!.data.type).toBe('relationship_note');
    });

    it('dedup prevents double-staging', () => {
      const r1 = receiveAndStage('social.update', 'did:plc:a', 'trusted', '{}', 'msg-dup', true);
      const r2 = receiveAndStage('social.update', 'did:plc:a', 'trusted', '{}', 'msg-dup', true);
      expect(r1.stagingId).toBe(r2.stagingId); // same staging ID
    });
  });

  describe('evaluateSenderTrust', () => {
    it('blocked → dropped', () => {
      expect(evaluateSenderTrust('blocked')).toBe('dropped');
    });

    it('unknown → quarantined', () => {
      expect(evaluateSenderTrust('unknown')).toBe('quarantined');
    });

    it('trusted → staged', () => {
      expect(evaluateSenderTrust('trusted')).toBe('staged');
    });

    it('verified → staged', () => {
      expect(evaluateSenderTrust('verified')).toBe('staged');
    });

    it('contact_ring1 → staged', () => {
      expect(evaluateSenderTrust('contact_ring1')).toBe('staged');
    });
  });
});
