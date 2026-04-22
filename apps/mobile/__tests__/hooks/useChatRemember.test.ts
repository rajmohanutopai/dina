/**
 * T4.8 — Chat /remember command: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.8
 */

import {
  isRememberIntent,
  extractRememberText,
  submitRemember,
  getRememberJob,
  getRememberHistory,
  getLastRememberJob,
  formatRememberStatus,
  resetRememberState,
} from '../../src/hooks/useChatRemember';
import { resetStagingState } from '../../../core/src/staging/service';
import { resetThreads } from '../../../brain/src/chat/thread';

describe('Chat /remember Hook (4.8)', () => {
  beforeEach(() => {
    resetRememberState();
    resetStagingState();
    resetThreads();
  });

  describe('isRememberIntent', () => {
    it('detects /remember prefix', () => {
      expect(isRememberIntent('/remember Emma birthday March 15')).toBe(true);
      expect(isRememberIntent('/remember')).toBe(true);
    });

    it('detects natural remember intent', () => {
      expect(isRememberIntent('remember that Alice likes tea')).toBe(true);
      expect(isRememberIntent('Remember this: meeting at 3pm')).toBe(true);
      expect(isRememberIntent("don't forget Bob's phone number")).toBe(true);
      expect(isRememberIntent('note that the deadline is Friday')).toBe(true);
      expect(isRememberIntent('save this recipe')).toBe(true);
      expect(isRememberIntent('keep in mind she prefers email')).toBe(true);
    });

    it('does not detect regular messages', () => {
      expect(isRememberIntent('Hello Dina')).toBe(false);
      expect(isRememberIntent('What time is the meeting?')).toBe(false);
      expect(isRememberIntent('I need to remember to buy milk')).toBe(false); // "I need to" prefix
    });

    it('handles edge cases', () => {
      expect(isRememberIntent('')).toBe(false);
      expect(isRememberIntent('   ')).toBe(false);
      expect(isRememberIntent('store something')).toBe(true);
    });
  });

  describe('extractRememberText', () => {
    it('strips /remember prefix', () => {
      expect(extractRememberText('/remember Emma birthday March 15')).toBe(
        'Emma birthday March 15',
      );
    });

    it('strips natural intent keywords', () => {
      expect(extractRememberText('remember that Alice likes tea')).toBe('that Alice likes tea');
      expect(extractRememberText('note that deadline is Friday')).toBe('deadline is Friday');
    });

    it('returns empty for bare /remember', () => {
      expect(extractRememberText('/remember')).toBe('');
    });

    it('preserves whitespace-trimmed content', () => {
      expect(extractRememberText('/remember   spaced text  ')).toBe('spaced text');
    });
  });

  describe('submitRemember', () => {
    it('stores a memory successfully', () => {
      const job = submitRemember('/remember Emma birthday is March 15');

      expect(job.status).toBe('stored');
      expect(job.text).toBe('Emma birthday is March 15');
      expect(job.persona).toBe('general');
      expect(job.duplicate).toBe(false);
      expect(job.completedAt).toBeTruthy();
    });

    it('detects duplicate submissions', () => {
      submitRemember('/remember same thing');
      const job2 = submitRemember('/remember same thing');

      expect(job2.status).toBe('duplicate');
      expect(job2.duplicate).toBe(true);
    });

    it('fails on empty text', () => {
      const job = submitRemember('/remember');

      expect(job.status).toBe('failed');
      expect(job.error).toContain('Nothing to remember');
    });

    it('accepts custom persona', () => {
      const job = submitRemember('/remember health data', 'health');
      expect(job.persona).toBe('health');
    });

    it('adds confirmation to chat thread', () => {
      submitRemember('/remember test note', 'general', 'main');

      // The system message was added to the thread
      const { getThread } = require('../../../brain/src/chat/thread');
      const messages = getThread('main');
      const systemMsg = messages.find((m: any) => m.type === 'system');
      expect(systemMsg).toBeDefined();
      expect(systemMsg.content).toContain('remember');
    });
  });

  describe('job tracking', () => {
    it('getRememberJob by ID', () => {
      const job = submitRemember('/remember test');
      const retrieved = getRememberJob(job.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.text).toBe('test');
    });

    it('getRememberHistory returns recent first', () => {
      submitRemember('/remember first');
      submitRemember('/remember second');
      submitRemember('/remember third');

      const history = getRememberHistory();
      expect(history).toHaveLength(3);
      expect(history[0].text).toBe('third');
      expect(history[2].text).toBe('first');
    });

    it('getLastRememberJob returns most recent', () => {
      submitRemember('/remember first');
      submitRemember('/remember latest');

      expect(getLastRememberJob()!.text).toBe('latest');
    });

    it('getLastRememberJob returns null when empty', () => {
      expect(getLastRememberJob()).toBeNull();
    });
  });

  describe('formatRememberStatus', () => {
    it('formats stored status', () => {
      const job = submitRemember('/remember test');
      expect(formatRememberStatus(job)).toContain('remember');
    });

    it('formats duplicate status', () => {
      submitRemember('/remember same');
      const job = submitRemember('/remember same');
      expect(formatRememberStatus(job)).toContain('already');
    });

    it('formats failed status', () => {
      const job = submitRemember('/remember');
      expect(formatRememberStatus(job)).toContain('Nothing to remember');
    });

    it('formats processing status', () => {
      const job = { status: 'processing' as const } as any;
      expect(formatRememberStatus(job)).toBe('Storing...');
    });

    it('formats needs_approval status', () => {
      const job = { status: 'needs_approval' as const } as any;
      expect(formatRememberStatus(job)).toContain('approval');
    });
  });
});
