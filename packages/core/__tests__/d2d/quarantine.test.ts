/**
 * T6.13 — Quarantine management: list, un-quarantine, block, TTL expiry.
 *
 * Source: ARCHITECTURE.md Task 6.13
 */

import {
  quarantineMessage,
  listQuarantined,
  listBySender,
  unquarantineSender,
  blockSender,
  deleteQuarantined,
  sweepExpired,
  quarantineSize,
  getQuarantined,
  getQuarantinedSenders,
  resetQuarantineState,
} from '../../src/d2d/quarantine';

describe('Quarantine Management', () => {
  beforeEach(() => resetQuarantineState());

  describe('quarantineMessage', () => {
    it('adds message with generated ID', () => {
      const msg = quarantineMessage('did:plc:stranger', 'social.update', '{"text":"hi"}');
      expect(msg.id).toMatch(/^q-\d+$/);
      expect(msg.senderDID).toBe('did:plc:stranger');
      expect(msg.messageType).toBe('social.update');
    });

    it('sets 30-day TTL', () => {
      const now = Date.now();
      const msg = quarantineMessage('did:plc:x', 'social.update', '{}', now);
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      expect(msg.expiresAt).toBe(now + thirtyDays);
    });

    it('increments quarantine size', () => {
      quarantineMessage('did:plc:a', 'social.update', '{}');
      quarantineMessage('did:plc:b', 'social.update', '{}');
      expect(quarantineSize()).toBe(2);
    });
  });

  describe('listQuarantined', () => {
    it('returns all messages sorted newest first', () => {
      const now = Date.now();
      quarantineMessage('did:plc:a', 'x', '{}', now);
      quarantineMessage('did:plc:b', 'x', '{}', now + 1000);
      const list = listQuarantined();
      expect(list).toHaveLength(2);
      expect(list[0].senderDID).toBe('did:plc:b'); // newer first
    });

    it('returns empty when no quarantined messages', () => {
      expect(listQuarantined()).toEqual([]);
    });
  });

  describe('listBySender', () => {
    it('filters by sender DID', () => {
      quarantineMessage('did:plc:alice', 'social.update', '1');
      quarantineMessage('did:plc:bob', 'social.update', '2');
      quarantineMessage('did:plc:alice', 'trust.vouch.request', '3');
      expect(listBySender('did:plc:alice')).toHaveLength(2);
      expect(listBySender('did:plc:bob')).toHaveLength(1);
    });
  });

  describe('unquarantineSender', () => {
    it('removes and returns messages for sender', () => {
      quarantineMessage('did:plc:alice', 'social.update', '{"text":"hi"}');
      quarantineMessage('did:plc:alice', 'trust.vouch.request', '{}');
      quarantineMessage('did:plc:bob', 'social.update', '{}');

      const removed = unquarantineSender('did:plc:alice');
      expect(removed).toHaveLength(2);
      expect(quarantineSize()).toBe(1); // only bob's message remains
    });

    it('returns empty for unknown sender', () => {
      expect(unquarantineSender('did:plc:nobody')).toEqual([]);
    });

    it('returned messages can be staged to vault', () => {
      quarantineMessage('did:plc:alice', 'social.update', '{"text":"hello"}');
      const removed = unquarantineSender('did:plc:alice');
      expect(removed[0].body).toBe('{"text":"hello"}');
      expect(removed[0].messageType).toBe('social.update');
    });
  });

  describe('blockSender', () => {
    it('deletes all messages from blocked sender', () => {
      quarantineMessage('did:plc:spammer', 'social.update', '1');
      quarantineMessage('did:plc:spammer', 'social.update', '2');
      quarantineMessage('did:plc:legit', 'social.update', '3');
      const deleted = blockSender('did:plc:spammer');
      expect(deleted).toBe(2);
      expect(quarantineSize()).toBe(1);
    });

    it('returns 0 for unknown sender', () => {
      expect(blockSender('did:plc:nobody')).toBe(0);
    });
  });

  describe('deleteQuarantined', () => {
    it('deletes by message ID', () => {
      const msg = quarantineMessage('did:plc:x', 'social.update', '{}');
      expect(deleteQuarantined(msg.id)).toBe(true);
      expect(quarantineSize()).toBe(0);
    });

    it('returns false for unknown ID', () => {
      expect(deleteQuarantined('q-999')).toBe(false);
    });
  });

  describe('sweepExpired', () => {
    it('purges messages past 30-day TTL', () => {
      const now = Date.now();
      quarantineMessage('did:plc:old', 'x', '{}', now);
      const thirtyOneDays = 31 * 24 * 60 * 60 * 1000;
      expect(sweepExpired(now + thirtyOneDays)).toBe(1);
      expect(quarantineSize()).toBe(0);
    });

    it('keeps non-expired messages', () => {
      quarantineMessage('did:plc:recent', 'x', '{}');
      expect(sweepExpired()).toBe(0);
      expect(quarantineSize()).toBe(1);
    });
  });

  describe('getQuarantined / getQuarantinedSenders', () => {
    it('retrieves message by ID', () => {
      const msg = quarantineMessage('did:plc:x', 'social.update', '{}');
      expect(getQuarantined(msg.id)!.senderDID).toBe('did:plc:x');
    });

    it('returns null for unknown ID', () => {
      expect(getQuarantined('q-missing')).toBeNull();
    });

    it('lists unique sender DIDs', () => {
      quarantineMessage('did:plc:alice', 'x', '{}');
      quarantineMessage('did:plc:alice', 'y', '{}');
      quarantineMessage('did:plc:bob', 'x', '{}');
      const senders = getQuarantinedSenders();
      expect(senders).toHaveLength(2);
      expect(senders).toContain('did:plc:alice');
      expect(senders).toContain('did:plc:bob');
    });
  });
});
