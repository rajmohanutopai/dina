/**
 * T2B.10 — Sync engine: 2-pass triage, fiduciary override, sync cycle.
 *
 * Source: brain/tests/test_sync.py
 */

import {
  triageEmail,
  pass1CategoryFilter,
  pass2SenderHeuristics,
  hasFiduciaryOverride,
  runSyncCycle,
  registerDataSource,
  registerIngestHandler,
  resetSyncProviders,
} from '../../src/sync/engine';
import type { EmailRecord, TriageDecision } from '../../src/sync/engine';

describe('Sync Engine', () => {
  afterEach(() => resetSyncProviders());

  describe('triageEmail', () => {
    it('PRIMARY email → INGEST', () => {
      expect(
        triageEmail({ category: 'PRIMARY', sender: 'alice@example.com', subject: 'Hello' }),
      ).toBe('INGEST');
    });

    it('PROMOTIONS email → SKIP', () => {
      expect(
        triageEmail({ category: 'PROMOTIONS', sender: 'deals@shop.com', subject: 'Sale!' }),
      ).toBe('SKIP');
    });

    it('SOCIAL email → SKIP', () => {
      expect(
        triageEmail({ category: 'SOCIAL', sender: 'noreply@social.com', subject: 'New follower' }),
      ).toBe('SKIP');
    });

    it('fiduciary keyword overrides category SKIP', () => {
      expect(
        triageEmail({
          category: 'PROMOTIONS',
          sender: 'bank@alert.com',
          subject: 'Security Alert',
        }),
      ).toBe('INGEST');
    });

    it('no-reply sender → SKIP', () => {
      expect(
        triageEmail({ category: 'PRIMARY', sender: 'noreply@company.com', subject: 'Receipt' }),
      ).toBe('SKIP');
    });

    it('OTP subject → THIN', () => {
      expect(
        triageEmail({
          category: 'PRIMARY',
          sender: 'auth@service.com',
          subject: 'Your verification code',
        }),
      ).toBe('THIN');
    });

    it('personal email → INGEST', () => {
      expect(
        triageEmail({ category: 'PRIMARY', sender: 'alice@example.com', subject: 'Lunch plans' }),
      ).toBe('INGEST');
    });
  });

  describe('pass1CategoryFilter', () => {
    it('PRIMARY → INGEST', () => expect(pass1CategoryFilter('PRIMARY')).toBe('INGEST'));
    it('PROMOTIONS → SKIP', () => expect(pass1CategoryFilter('PROMOTIONS')).toBe('SKIP'));
    it('SOCIAL → SKIP', () => expect(pass1CategoryFilter('SOCIAL')).toBe('SKIP'));
    it('UPDATES → SKIP', () => expect(pass1CategoryFilter('UPDATES')).toBe('SKIP'));
    it('FORUMS → SKIP', () => expect(pass1CategoryFilter('FORUMS')).toBe('SKIP'));
    it('unknown category → INGEST', () => expect(pass1CategoryFilter('UNKNOWN')).toBe('INGEST'));
  });

  describe('pass2SenderHeuristics', () => {
    it('noreply sender → SKIP', () => {
      expect(pass2SenderHeuristics('noreply@company.com', 'Receipt')).toBe('SKIP');
    });

    it('notifications sender → SKIP', () => {
      expect(pass2SenderHeuristics('notifications@example.com', 'Update')).toBe('SKIP');
    });

    it('OTP/verification subject → THIN', () => {
      expect(pass2SenderHeuristics('auth@service.com', 'Your verification code')).toBe('THIN');
    });

    it('weekly digest → THIN', () => {
      expect(pass2SenderHeuristics('digest@news.com', 'Weekly Digest')).toBe('THIN');
    });

    it('personal sender → INGEST', () => {
      expect(pass2SenderHeuristics('alice@example.com', 'Lunch plans')).toBe('INGEST');
    });
  });

  describe('hasFiduciaryOverride', () => {
    it('"Security Alert" → true', () => {
      expect(hasFiduciaryOverride('Security Alert: Unusual login')).toBe(true);
    });

    it('"lab results" → true', () => {
      expect(hasFiduciaryOverride('Your lab results are ready')).toBe(true);
    });

    it('"Hello friend" → false', () => {
      expect(hasFiduciaryOverride('Hello friend, how are you?')).toBe(false);
    });

    it('"payment due" → true', () => {
      expect(hasFiduciaryOverride('Payment due in 3 days')).toBe(true);
    });
  });

  describe('runSyncCycle', () => {
    const makeEmail = (overrides: Partial<EmailRecord>): EmailRecord => ({
      id: `email-${Math.random().toString(16).slice(2, 8)}`,
      category: 'PRIMARY',
      sender: 'alice@example.com',
      subject: 'Hello',
      ...overrides,
    });

    it('returns zero counts when no data source registered', async () => {
      const result = await runSyncCycle('gmail');
      expect(result).toEqual({ ingested: 0, skipped: 0, thinRecords: 0, errors: 0 });
    });

    it('triages and counts emails from data source', async () => {
      registerDataSource(async () => ({
        emails: [
          makeEmail({ subject: 'Personal note' }),
          makeEmail({ category: 'PROMOTIONS', subject: 'Big sale!' }),
          makeEmail({ sender: 'auth@service.com', subject: 'Verification code' }),
        ],
      }));
      const result = await runSyncCycle('gmail');
      expect(result.ingested).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.thinRecords).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('fiduciary override promotes to INGEST', async () => {
      registerDataSource(async () => ({
        emails: [makeEmail({ category: 'PROMOTIONS', subject: 'Security Alert: unusual login' })],
      }));
      const result = await runSyncCycle('gmail');
      expect(result.ingested).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('calls ingest handler for non-skipped emails', async () => {
      const ingested: Array<{ email: EmailRecord; decision: TriageDecision }> = [];
      registerDataSource(async () => ({
        emails: [
          makeEmail({ subject: 'Important meeting' }),
          makeEmail({ category: 'PROMOTIONS', subject: 'Deals' }),
        ],
      }));
      registerIngestHandler(async (email, decision) => {
        ingested.push({ email, decision });
      });
      await runSyncCycle('gmail');
      expect(ingested).toHaveLength(1);
      expect(ingested[0].decision).toBe('INGEST');
    });

    it('counts errors from ingest handler failures', async () => {
      registerDataSource(async () => ({
        emails: [makeEmail({ subject: 'Will fail' })],
      }));
      registerIngestHandler(async () => {
        throw new Error('ingest failed');
      });
      const result = await runSyncCycle('gmail');
      expect(result.errors).toBe(1);
      expect(result.ingested).toBe(0);
    });

    it('processes all emails even if some fail', async () => {
      let callCount = 0;
      registerDataSource(async () => ({
        emails: [
          makeEmail({ subject: 'First' }),
          makeEmail({ subject: 'Second' }),
          makeEmail({ subject: 'Third' }),
        ],
      }));
      registerIngestHandler(async () => {
        callCount++;
        if (callCount === 2) throw new Error('second fails');
      });
      const result = await runSyncCycle('gmail');
      // First succeeds (ingested), Second fails (error), Third succeeds (ingested)
      expect(result.ingested + result.errors).toBe(3);
    });

    it('passes source and cursor to data source', async () => {
      let capturedSource = '';
      let capturedCursor = '';
      registerDataSource(async (source, cursor) => {
        capturedSource = source;
        capturedCursor = cursor ?? '';
        return { emails: [] };
      });
      await runSyncCycle('gmail', 'cursor-abc');
      expect(capturedSource).toBe('gmail');
      expect(capturedCursor).toBe('cursor-abc');
    });

    it('handles empty email batch', async () => {
      registerDataSource(async () => ({ emails: [] }));
      const result = await runSyncCycle('gmail');
      expect(result).toEqual({ ingested: 0, skipped: 0, thinRecords: 0, errors: 0 });
    });
  });
});
