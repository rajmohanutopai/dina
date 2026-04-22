/**
 * T4.6 — Chat conversation thread: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.6
 */

import {
  getThreadState,
  getRecentChatMessages,
  sendMessage,
  addSystemNotification,
  getMessagesByType,
  isTyping,
  getThreadList,
  clearThread,
  getTotalMessageCount,
  resetChatState,
} from '../../src/hooks/useChatThread';
import { resetThreads } from '../../../brain/src/chat/thread';
import { resetChatDefaults } from '../../../brain/src/chat/orchestrator';
import { resetStagingState } from '../../../core/src/staging/service';

describe('Chat Thread Hook (4.6)', () => {
  beforeEach(() => {
    resetChatState();
    resetChatDefaults();
    resetStagingState();
  });

  describe('getThreadState', () => {
    it('returns empty thread state initially', () => {
      const state = getThreadState();
      expect(state.threadId).toBe('main');
      expect(state.messages).toHaveLength(0);
      expect(state.messageCount).toBe(0);
      expect(state.isTyping).toBe(false);
    });

    it('uses custom thread ID', () => {
      const state = getThreadState('custom');
      expect(state.threadId).toBe('custom');
    });
  });

  describe('sendMessage', () => {
    it('sends a message and gets a response', async () => {
      const response = await sendMessage('Hello Dina');

      expect(response.intent).toBeDefined();
      expect(response.response).toBeTruthy();
      expect(response.messageId).toBeTruthy();

      // Thread should have both user message and response
      const state = getThreadState();
      expect(state.messageCount).toBeGreaterThanOrEqual(2);
    });

    it('routes /help to help intent', async () => {
      const response = await sendMessage('/help');
      expect(response.intent).toBe('help');
      expect(response.response).toContain('/'); // help lists commands
    });

    it('routes /remember to remember intent', async () => {
      const response = await sendMessage('/remember Emma birthday March 15');
      expect(response.intent).toBe('remember');
    });

    it('rejects empty message', async () => {
      await expect(sendMessage('')).rejects.toThrow('empty');
      await expect(sendMessage('   ')).rejects.toThrow('empty');
    });

    it('clears typing indicator after response', async () => {
      expect(isTyping()).toBe(false);
      await sendMessage('Test message');
      expect(isTyping()).toBe(false); // cleared after response
    });

    it('tracks last message timestamps', async () => {
      const before = Date.now();
      await sendMessage('Test');
      const state = getThreadState();

      expect(state.lastUserMessageAt).toBeGreaterThanOrEqual(before);
      expect(state.lastDinaResponseAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('getRecentChatMessages', () => {
    it('returns limited messages', async () => {
      await sendMessage('Message 1');
      await sendMessage('Message 2');
      await sendMessage('Message 3');

      // Each sendMessage creates user + dina messages = 6 total
      const recent = getRecentChatMessages(4);
      expect(recent).toHaveLength(4);
    });
  });

  describe('addSystemNotification', () => {
    it('adds a system message to thread', () => {
      addSystemNotification('Persona "health" unlocked');

      const state = getThreadState();
      expect(state.messageCount).toBe(1);
      expect(state.messages[0].type).toBe('system');
      expect(state.messages[0].content).toContain('health');
    });
  });

  describe('getMessagesByType', () => {
    it('filters messages by type', async () => {
      await sendMessage('Hello');
      addSystemNotification('System event');

      const userMessages = getMessagesByType('user');
      const systemMessages = getMessagesByType('system');

      expect(userMessages.length).toBeGreaterThan(0);
      expect(systemMessages).toHaveLength(1);
      expect(userMessages.every((m) => m.type === 'user')).toBe(true);
    });
  });

  describe('thread management', () => {
    it('lists threads', async () => {
      await sendMessage('Hello', 'thread-a');
      await sendMessage('World', 'thread-b');

      const threads = getThreadList();
      expect(threads).toContain('thread-a');
      expect(threads).toContain('thread-b');
    });

    it('clears a thread', async () => {
      await sendMessage('Hello');
      expect(getThreadState().messageCount).toBeGreaterThan(0);

      clearThread();
      expect(getThreadState().messageCount).toBe(0);
    });

    it('getTotalMessageCount across threads', async () => {
      await sendMessage('A', 'thread-1');
      await sendMessage('B', 'thread-2');

      expect(getTotalMessageCount()).toBeGreaterThanOrEqual(4); // 2 per thread minimum
    });
  });
});
