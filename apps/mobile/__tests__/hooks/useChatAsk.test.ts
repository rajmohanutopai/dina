/**
 * T4.9 — Chat /ask command: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.9
 */

import {
  isAskIntent,
  extractAskQuery,
  submitAsk,
  getAskJob,
  getAskHistory,
  getLastAnswer,
  formatAnswerWithSources,
  isAnyAskPending,
  resetAskState,
} from '../../src/hooks/useChatAsk';
import { resetThreads } from '../../../brain/src/chat/thread';
import { resetChatDefaults } from '../../../brain/src/chat/orchestrator';
import { resetStagingState } from '../../../core/src/staging/service';

describe('Chat /ask Hook (4.9)', () => {
  beforeEach(() => {
    resetAskState();
    resetThreads();
    resetChatDefaults();
    resetStagingState();
  });

  describe('isAskIntent', () => {
    it('detects /ask prefix', () => {
      expect(isAskIntent('/ask When is the meeting?')).toBe(true);
      expect(isAskIntent('/ask')).toBe(true);
    });

    it('detects question mark', () => {
      expect(isAskIntent('When is the meeting?')).toBe(true);
      expect(isAskIntent('What happened?')).toBe(true);
    });

    it('detects question words', () => {
      expect(isAskIntent('What time is it')).toBe(true);
      expect(isAskIntent('When does the train leave')).toBe(true);
      expect(isAskIntent('Where is the office')).toBe(true);
      expect(isAskIntent('Who sent the email')).toBe(true);
      expect(isAskIntent('How do I reset')).toBe(true);
      expect(isAskIntent('Why did it fail')).toBe(true);
      expect(isAskIntent('Is the vault open')).toBe(true);
      expect(isAskIntent('Can you search for Alice')).toBe(true);
    });

    it('detects tell me / explain / describe', () => {
      expect(isAskIntent('Tell me about Alice')).toBe(true);
      expect(isAskIntent('Explain the vault system')).toBe(true);
      expect(isAskIntent('Describe my schedule')).toBe(true);
    });

    it('does not detect statements', () => {
      expect(isAskIntent('Hello Dina')).toBe(false);
      expect(isAskIntent('Thanks for that')).toBe(false);
      expect(isAskIntent('OK sounds good')).toBe(false);
    });

    it('handles edge cases', () => {
      expect(isAskIntent('')).toBe(false);
      expect(isAskIntent('   ')).toBe(false);
    });
  });

  describe('extractAskQuery', () => {
    it('strips /ask prefix', () => {
      expect(extractAskQuery('/ask When is Emma birthday')).toBe('When is Emma birthday');
    });

    it('returns raw text for questions without prefix', () => {
      expect(extractAskQuery('When is the meeting?')).toBe('When is the meeting?');
    });

    it('returns empty for bare /ask', () => {
      expect(extractAskQuery('/ask')).toBe('');
    });
  });

  describe('submitAsk', () => {
    it('submits a question and gets a response', async () => {
      const job = await submitAsk('/ask What is 2+2?');

      expect(job.status).toBe('completed');
      expect(job.query).toBe('What is 2+2?');
      expect(job.answer).toBeTruthy();
      expect(job.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('tracks the job', async () => {
      const job = await submitAsk('/ask test');
      const retrieved = getAskJob(job.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.query).toBe('test');
    });

    it('fails on empty query', async () => {
      const job = await submitAsk('/ask');

      expect(job.status).toBe('failed');
      expect(job.error).toContain('What would you like to know');
    });

    it('defaults persona to general', async () => {
      const job = await submitAsk('/ask test');
      expect(job.persona).toBe('general');
    });

    it('accepts custom persona', async () => {
      const job = await submitAsk('/ask health data', 'health');
      expect(job.persona).toBe('health');
    });
  });

  describe('job history', () => {
    it('returns history in reverse order', async () => {
      await submitAsk('/ask first');
      await submitAsk('/ask second');
      await submitAsk('/ask third');

      const history = getAskHistory();
      expect(history).toHaveLength(3);
      expect(history[0].query).toBe('third');
      expect(history[2].query).toBe('first');
    });

    it('getLastAnswer returns most recent completed', async () => {
      await submitAsk('/ask first');
      await submitAsk('/ask latest');

      const last = getLastAnswer();
      expect(last!.query).toBe('latest');
    });

    it('getLastAnswer returns null when empty', () => {
      expect(getLastAnswer()).toBeNull();
    });

    it('getLastAnswer skips failed jobs', async () => {
      await submitAsk('/ask good question');
      await submitAsk('/ask'); // fails

      const last = getLastAnswer();
      expect(last!.query).toBe('good question');
    });
  });

  describe('formatAnswerWithSources', () => {
    it('formats answer without sources', () => {
      const job = { answer: 'The answer is 42.', sources: [] } as any;
      expect(formatAnswerWithSources(job)).toBe('The answer is 42.');
    });

    it('formats with single source', () => {
      const job = { answer: 'Emma was born March 15.', sources: ['general'] } as any;
      expect(formatAnswerWithSources(job)).toBe('Emma was born March 15. [Source: general]');
    });

    it('formats with multiple sources', () => {
      const job = { answer: 'Result.', sources: ['general', 'work'] } as any;
      expect(formatAnswerWithSources(job)).toBe('Result. [Sources: general, work]');
    });

    it('returns empty for no answer', () => {
      expect(formatAnswerWithSources({ sources: [] } as any)).toBe('');
    });
  });

  describe('isAnyAskPending', () => {
    it('false when no jobs', () => {
      expect(isAnyAskPending()).toBe(false);
    });

    it('false after completion', async () => {
      await submitAsk('/ask test');
      expect(isAnyAskPending()).toBe(false);
    });
  });
});
