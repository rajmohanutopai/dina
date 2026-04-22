/**
 * T4.6 — Chat message model + thread storage.
 *
 * Source: ARCHITECTURE.md Task 4.6
 */

import {
  addMessage,
  getThread,
  getRecentMessages,
  getMessagesByType,
  getMessage,
  threadLength,
  listThreads,
  deleteThread,
  addUserMessage,
  addDinaResponse,
  addSystemMessage,
  resetThreads,
} from '../../src/chat/thread';

describe('Chat Message Model + Thread', () => {
  beforeEach(() => resetThreads());

  describe('addMessage', () => {
    it('adds message with generated ID', () => {
      const msg = addMessage('main', 'user', 'Hello Dina');
      expect(msg.id).toMatch(/^cm-[0-9a-f]{12}$/);
      expect(msg.threadId).toBe('main');
      expect(msg.type).toBe('user');
      expect(msg.content).toBe('Hello Dina');
      expect(msg.timestamp).toBeGreaterThan(0);
    });

    it('supports all 7 message types', () => {
      const types = ['user', 'dina', 'approval', 'nudge', 'briefing', 'system', 'error'] as const;
      for (const type of types) {
        const msg = addMessage('main', type, `${type} message`);
        expect(msg.type).toBe(type);
      }
    });

    it('stores metadata and sources', () => {
      const msg = addMessage('main', 'dina', 'Answer', {
        metadata: { scrubbed: true },
        sources: ['item-001', 'item-002'],
      });
      expect(msg.metadata).toEqual({ scrubbed: true });
      expect(msg.sources).toEqual(['item-001', 'item-002']);
    });
  });

  describe('getThread', () => {
    it('returns messages in chronological order', () => {
      addMessage('main', 'user', 'first');
      addMessage('main', 'dina', 'second');
      addMessage('main', 'user', 'third');
      const thread = getThread('main');
      expect(thread).toHaveLength(3);
      expect(thread[0].content).toBe('first');
      expect(thread[2].content).toBe('third');
    });

    it('returns empty for unknown thread', () => {
      expect(getThread('nonexistent')).toEqual([]);
    });

    it('returns a copy (not a reference)', () => {
      addMessage('main', 'user', 'test');
      const thread = getThread('main');
      thread.pop(); // mutate the copy
      expect(getThread('main')).toHaveLength(1); // original unchanged
    });
  });

  describe('getRecentMessages', () => {
    it('returns last N messages', () => {
      for (let i = 0; i < 10; i++) addMessage('main', 'user', `msg ${i}`);
      const recent = getRecentMessages('main', 3);
      expect(recent).toHaveLength(3);
      expect(recent[0].content).toBe('msg 7');
      expect(recent[2].content).toBe('msg 9');
    });

    it('returns all if fewer than limit', () => {
      addMessage('main', 'user', 'only one');
      expect(getRecentMessages('main', 10)).toHaveLength(1);
    });
  });

  describe('getMessagesByType', () => {
    it('filters by type', () => {
      addMessage('main', 'user', 'question');
      addMessage('main', 'dina', 'answer');
      addMessage('main', 'system', 'event');
      addMessage('main', 'user', 'another question');
      expect(getMessagesByType('main', 'user')).toHaveLength(2);
      expect(getMessagesByType('main', 'system')).toHaveLength(1);
      expect(getMessagesByType('main', 'approval')).toHaveLength(0);
    });
  });

  describe('getMessage', () => {
    it('finds message by ID across threads', () => {
      addMessage('thread-A', 'user', 'in A');
      const msg = addMessage('thread-B', 'dina', 'in B');
      expect(getMessage(msg.id)!.content).toBe('in B');
    });

    it('returns null for unknown ID', () => {
      expect(getMessage('cm-nonexistent')).toBeNull();
    });
  });

  describe('thread management', () => {
    it('threadLength counts messages', () => {
      addMessage('main', 'user', 'a');
      addMessage('main', 'dina', 'b');
      expect(threadLength('main')).toBe(2);
      expect(threadLength('other')).toBe(0);
    });

    it('listThreads returns all thread IDs', () => {
      addMessage('main', 'user', 'x');
      addMessage('work', 'user', 'y');
      addMessage('health', 'user', 'z');
      const ids = listThreads();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('main');
      expect(ids).toContain('work');
    });

    it('deleteThread removes thread', () => {
      addMessage('main', 'user', 'test');
      expect(deleteThread('main')).toBe(true);
      expect(threadLength('main')).toBe(0);
      expect(listThreads()).not.toContain('main');
    });

    it('deleteThread returns false for unknown', () => {
      expect(deleteThread('nonexistent')).toBe(false);
    });
  });

  describe('convenience functions', () => {
    it('addUserMessage creates user type', () => {
      const msg = addUserMessage('main', 'Hello');
      expect(msg.type).toBe('user');
    });

    it('addDinaResponse creates dina type with sources', () => {
      const msg = addDinaResponse('main', 'Answer', ['src-1']);
      expect(msg.type).toBe('dina');
      expect(msg.sources).toEqual(['src-1']);
    });

    it('addSystemMessage creates system type', () => {
      const msg = addSystemMessage('main', 'Persona unlocked');
      expect(msg.type).toBe('system');
    });
  });

  describe('thread isolation', () => {
    it('messages in one thread are invisible from another', () => {
      addMessage('thread-A', 'user', 'private to A');
      addMessage('thread-B', 'user', 'private to B');
      expect(getThread('thread-A')).toHaveLength(1);
      expect(getThread('thread-B')).toHaveLength(1);
      expect(getThread('thread-A')[0].content).toBe('private to A');
    });
  });
});
