/**
 * T4.12 — Chat nudge cards: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.12
 */

import {
  createNudge,
  dismissNudge,
  actOnNudge,
  getActiveNudges,
  getActiveNudgeCount,
  setDND,
  isDND,
  resetNudges,
} from '../../src/hooks/useChatNudges';
import { resetThreads, getThread } from '../../../brain/src/chat/thread';

describe('Chat Nudge Cards Hook (4.12)', () => {
  beforeEach(() => {
    resetNudges();
    resetThreads();
  });

  describe('createNudge', () => {
    it('creates a Tier 1 nudge (always delivered)', () => {
      const nudge = createNudge('health_alert', 'Lab Results', 'Your lab results are ready', 1);

      expect(nudge).not.toBeNull();
      expect(nudge!.kind).toBe('health_alert');
      expect(nudge!.title).toBe('Lab Results');
      expect(nudge!.body).toContain('lab results');
      expect(nudge!.tier).toBe(1);
      expect(nudge!.dismissed).toBe(false);
    });

    it('creates a Tier 2 nudge (solicited)', () => {
      const nudge = createNudge(
        'reconnection',
        'Alice',
        "You haven't talked to Alice in 3 weeks",
        2,
        {
          contactDID: 'did:key:z6MkAlice',
          contactName: 'Alice',
        },
      );

      expect(nudge).not.toBeNull();
      expect(nudge!.contactName).toBe('Alice');
      expect(nudge!.actionLabel).toBe('Send message');
      expect(nudge!.actionType).toBe('message');
    });

    it('suppresses Tier 3 nudge (Silence First)', () => {
      const nudge = createNudge('general', 'Tip', 'Some engagement tip', 3);
      expect(nudge).toBeNull();
    });

    it('suppresses Tier 3 when DND enabled', () => {
      setDND(true);
      const nudge = createNudge('reconnection', 'Bob', 'Chat with Bob', 3);
      expect(nudge).toBeNull();
    });

    it('health_alert overrides silence tier (fiduciary)', () => {
      // Tier 3 health alert should still show
      const nudge = createNudge('health_alert', 'Alert', 'Critical result', 3);
      expect(nudge).not.toBeNull();
    });

    it('adds nudge to chat thread', () => {
      createNudge('reconnection', 'Alice', 'Miss you', 2, { threadId: 'main' });

      const messages = getThread('main');
      const nudgeMsg = messages.find((m) => m.type === 'nudge');
      expect(nudgeMsg).toBeDefined();
      expect(nudgeMsg!.content).toContain('Alice');
    });

    it('assigns default action labels per kind', () => {
      const recon = createNudge('reconnection', 't', 'b', 1);
      expect(recon!.actionLabel).toBe('Send message');

      const reminder = createNudge('reminder_context', 't', 'b', 1);
      expect(reminder!.actionLabel).toBe('View details');

      const promise = createNudge('pending_promise', 't', 'b', 1);
      expect(promise!.actionLabel).toBe('Follow up');

      const health = createNudge('health_alert', 't', 'b', 1);
      expect(health!.actionLabel).toBe('View now');
    });
  });

  describe('dismissNudge', () => {
    it('dismisses an active nudge', () => {
      const nudge = createNudge('reconnection', 'Test', 'body', 1);
      expect(dismissNudge(nudge!.id)).toBe(true);
      expect(getActiveNudgeCount()).toBe(0);
    });

    it('returns false for nonexistent nudge', () => {
      expect(dismissNudge('nonexistent')).toBe(false);
    });
  });

  describe('actOnNudge', () => {
    it('returns action and auto-dismisses', () => {
      const nudge = createNudge('reconnection', 'Alice', 'Chat', 2, {
        contactDID: 'did:key:z6MkAlice',
      });

      const action = actOnNudge(nudge!.id);
      expect(action).not.toBeNull();
      expect(action!.actionType).toBe('message');
      expect(action!.contactDID).toBe('did:key:z6MkAlice');

      // Auto-dismissed after acting
      expect(getActiveNudgeCount()).toBe(0);
    });

    it('returns null for dismissed nudge', () => {
      const nudge = createNudge('general', 't', 'b', 1);
      dismissNudge(nudge!.id);
      expect(actOnNudge(nudge!.id)).toBeNull();
    });
  });

  describe('getActiveNudges', () => {
    it('returns only non-dismissed nudges', () => {
      const n1 = createNudge('health_alert', 'A', 'a', 1);
      const n2 = createNudge('reconnection', 'B', 'b', 1);
      dismissNudge(n1!.id);

      const active = getActiveNudges();
      expect(active).toHaveLength(1);
      expect(active[0].title).toBe('B');
    });

    it('returns empty when all dismissed', () => {
      const n = createNudge('health_alert', 'A', 'a', 1);
      dismissNudge(n!.id);
      expect(getActiveNudges()).toHaveLength(0);
    });
  });

  describe('DND mode', () => {
    it('defaults to disabled', () => {
      expect(isDND()).toBe(false);
    });

    it('toggles on and off', () => {
      setDND(true);
      expect(isDND()).toBe(true);
      setDND(false);
      expect(isDND()).toBe(false);
    });

    it('Tier 1 and 2 still delivered during DND', () => {
      setDND(true);
      expect(createNudge('health_alert', 'T', 'B', 1)).not.toBeNull();
      expect(createNudge('reconnection', 'T', 'B', 2)).not.toBeNull();
    });
  });
});
