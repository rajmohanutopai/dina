/**
 * T4.13 — Chat system messages: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.13
 */

import {
  emitSystemEvent,
  formatEvent,
  notifyPersonaUnlocked,
  notifyPersonaLocked,
  notifyReminderSet,
  notifyReminderFired,
  notifyApprovalResolved,
  notifyConfigChanged,
  notifyError,
  getEventHistory,
  resetSystemMessages,
} from '../../src/hooks/useChatSystemMessages';
import { resetThreads, getThread } from '../../../brain/src/chat/thread';

describe('Chat System Messages Hook (4.13)', () => {
  beforeEach(() => {
    resetSystemMessages();
    resetThreads();
  });

  describe('formatEvent', () => {
    it('formats persona_unlocked', () => {
      expect(formatEvent('persona_unlocked', { persona: 'health' })).toBe(
        'Persona "health" unlocked',
      );
    });

    it('formats persona_locked', () => {
      expect(formatEvent('persona_locked', { persona: 'health' })).toBe('Persona "health" locked');
    });

    it('formats reminder_set with due label', () => {
      expect(
        formatEvent('reminder_set', { message: 'Call dentist', dueLabel: 'tomorrow 3pm' }),
      ).toBe('Reminder set: Call dentist (tomorrow 3pm)');
    });

    it('formats reminder_set without due label', () => {
      expect(formatEvent('reminder_set', { message: 'Call dentist' })).toBe(
        'Reminder set: Call dentist',
      );
    });

    it('formats reminder_fired', () => {
      expect(formatEvent('reminder_fired', { message: 'Call the dentist' })).toBe(
        'Reminder: Call the dentist',
      );
    });

    it('formats reminder_dismissed', () => {
      expect(formatEvent('reminder_dismissed', { message: 'Old reminder' })).toBe(
        'Reminder dismissed: Old reminder',
      );
    });

    it('formats approval_resolved — approved', () => {
      expect(
        formatEvent('approval_resolved', {
          action: 'unlock health',
          approved: true,
          scope: 'session',
        }),
      ).toBe('unlock health was approved (session)');
    });

    it('formats approval_resolved — denied', () => {
      expect(formatEvent('approval_resolved', { action: 'share data', approved: false })).toBe(
        'share data was denied',
      );
    });

    it('formats config_changed', () => {
      expect(
        formatEvent('config_changed', { setting: 'Background timeout', value: '5 minutes' }),
      ).toBe('Background timeout set to 5 minutes');
    });

    it('formats connection_status — connected', () => {
      expect(formatEvent('connection_status', { connected: true, service: 'MsgBox' })).toBe(
        'Connected to MsgBox',
      );
    });

    it('formats connection_status — disconnected', () => {
      expect(formatEvent('connection_status', { connected: false, service: 'Brain' })).toBe(
        'Disconnected from Brain',
      );
    });

    it('formats error', () => {
      expect(formatEvent('error', { message: 'Connection refused' })).toBe(
        'Error: Connection refused',
      );
    });
  });

  describe('emitSystemEvent', () => {
    it('adds system message to chat thread', () => {
      emitSystemEvent('persona_unlocked', { persona: 'work' }, 'main');

      const messages = getThread('main');
      const systemMsg = messages.find((m) => m.type === 'system');
      expect(systemMsg).toBeDefined();
      expect(systemMsg!.content).toContain('work');
    });

    it('adds error message with error type', () => {
      emitSystemEvent('error', { message: 'Something failed' }, 'main');

      const messages = getThread('main');
      const errorMsg = messages.find((m) => m.type === 'error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.content).toContain('failed');
    });

    it('tracks in event history', () => {
      emitSystemEvent('config_changed', { setting: 'Timeout', value: '5m' });
      emitSystemEvent('persona_unlocked', { persona: 'general' });

      const history = getEventHistory();
      expect(history).toHaveLength(2);
      expect(history[0].type).toBe('config_changed');
      expect(history[1].type).toBe('persona_unlocked');
    });

    it('returns the formatted message', () => {
      const msg = emitSystemEvent('reminder_fired', { message: 'Call Bob' });
      expect(msg).toBe('Reminder: Call Bob');
    });
  });

  describe('convenience functions', () => {
    it('notifyPersonaUnlocked', () => {
      const msg = notifyPersonaUnlocked('health', 'main');
      expect(msg).toContain('health');
      expect(msg).toContain('unlocked');
    });

    it('notifyPersonaLocked', () => {
      const msg = notifyPersonaLocked('health');
      expect(msg).toContain('locked');
    });

    it('notifyReminderSet', () => {
      const msg = notifyReminderSet('Call dentist', 'tomorrow 3pm');
      expect(msg).toContain('Call dentist');
      expect(msg).toContain('tomorrow 3pm');
    });

    it('notifyReminderFired', () => {
      const msg = notifyReminderFired('Meeting now');
      expect(msg).toContain('Meeting now');
    });

    it('notifyApprovalResolved — approved', () => {
      const msg = notifyApprovalResolved('unlock health', true, 'session');
      expect(msg).toContain('approved');
      expect(msg).toContain('session');
    });

    it('notifyApprovalResolved — denied', () => {
      const msg = notifyApprovalResolved('share data', false);
      expect(msg).toContain('denied');
    });

    it('notifyConfigChanged', () => {
      const msg = notifyConfigChanged('Background timeout', '5 minutes');
      expect(msg).toContain('Background timeout');
      expect(msg).toContain('5 minutes');
    });

    it('notifyError', () => {
      const msg = notifyError('Connection refused');
      expect(msg).toContain('Error');
      expect(msg).toContain('Connection refused');
    });
  });

  describe('event history', () => {
    it('limits to 100 entries', () => {
      for (let i = 0; i < 110; i++) {
        emitSystemEvent('config_changed', { setting: 'x', value: String(i) });
      }
      expect(getEventHistory()).toHaveLength(100);
    });

    it('resets cleanly', () => {
      emitSystemEvent('error', { message: 'test' });
      resetSystemMessages();
      expect(getEventHistory()).toHaveLength(0);
    });
  });
});
