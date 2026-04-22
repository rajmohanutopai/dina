/**
 * T6.19 — D2D message view: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 6.19
 */

import {
  getQuarantinedMessages,
  acceptFromQuarantine,
  blockFromQuarantine,
  composeReply,
  getQuarantineBadge,
  registerSenderLabel,
  resetD2DMessages,
} from '../../src/hooks/useD2DMessages';
import { quarantineMessage, resetQuarantineState } from '../../../core/src/d2d/quarantine';
import { resetThreads, getThread } from '../../../brain/src/chat/thread';

describe('D2D Message View Hook (6.19)', () => {
  beforeEach(() => {
    resetD2DMessages();
    resetThreads();
  });

  describe('quarantined messages', () => {
    it('returns empty when no quarantined messages', () => {
      expect(getQuarantinedMessages()).toHaveLength(0);
    });

    it('lists quarantined messages with sender info', () => {
      quarantineMessage('did:key:z6MkAlice', 'social.update', 'Hello from Alice');
      registerSenderLabel('did:key:z6MkAlice', 'Alice');

      const msgs = getQuarantinedMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].senderLabel).toBe('Alice');
      expect(msgs[0].messageType).toBe('social.update');
      expect(msgs[0].isQuarantined).toBe(true);
      expect(msgs[0].trustLevel).toBe('unknown');
    });

    it('shortens DID when no label registered', () => {
      quarantineMessage('did:key:z6MkLongDIDStringHere1234567890', 'social.update', 'Hi');

      const msgs = getQuarantinedMessages();
      expect(msgs[0].senderLabel).toContain('...');
    });
  });

  describe('acceptFromQuarantine', () => {
    it('accepts a quarantined message', () => {
      const q = quarantineMessage('did:key:z6MkAlice', 'social.update', 'Hello');

      const result = acceptFromQuarantine(q.id);
      expect(result.action).toBe('accepted');
      expect(result.senderDID).toBe('did:key:z6MkAlice');
    });

    it('returns error for nonexistent quarantine', () => {
      const result = acceptFromQuarantine('nonexistent');
      expect(result.action).toBe('error');
    });
  });

  describe('blockFromQuarantine', () => {
    it('blocks a quarantined sender', () => {
      const q = quarantineMessage('did:key:z6MkSpam', 'promo.offer', 'Buy now');

      const result = blockFromQuarantine(q.id);
      expect(result.action).toBe('blocked');
      expect(result.senderDID).toBe('did:key:z6MkSpam');
    });

    it('returns error for nonexistent', () => {
      const result = blockFromQuarantine('nonexistent');
      expect(result.action).toBe('error');
    });
  });

  describe('composeReply', () => {
    it('adds reply to chat thread', () => {
      const reply = composeReply('did:key:z6MkAlice', 'Thanks for the message!', 'main');

      expect(reply.type).toBe('user');
      expect(reply.content).toBe('Thanks for the message!');

      const thread = getThread('main');
      expect(thread).toHaveLength(1);
    });
  });

  describe('getQuarantineBadge', () => {
    it('returns 0 when empty', () => {
      expect(getQuarantineBadge()).toBe(0);
    });

    it('counts quarantined messages', () => {
      quarantineMessage('did:key:z6MkA', 'social.update', 'a');
      quarantineMessage('did:key:z6MkB', 'social.update', 'b');
      expect(getQuarantineBadge()).toBe(2);
    });
  });

  describe('time formatting', () => {
    it('formats recent message as "Just now"', () => {
      quarantineMessage('did:key:z6MkA', 'social.update', 'test');
      const msgs = getQuarantinedMessages();
      expect(msgs[0].timeLabel).toBe('Just now');
    });
  });
});
