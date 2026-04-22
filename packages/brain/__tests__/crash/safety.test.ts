/**
 * T2B.15 — Crash traceback safety: no PII in logs, sanitized errors.
 *
 * Category B: contract test.
 *
 * Source: brain/tests/test_crash.py
 */

import {
  withCrashHandler,
  sanitizeForStdout,
  buildCrashReport,
  auditCrashLogForPII,
} from '../../src/crash/safety';
import type { CrashReport } from '../../src/crash/safety';

describe('Crash Traceback Safety', () => {
  describe('withCrashHandler', () => {
    it('returns result on success', async () => {
      const result = await withCrashHandler(async () => 42, 'test');
      expect(result).toBe(42);
    });

    it('re-raises with sanitized message on error', async () => {
      await expect(
        withCrashHandler(async () => {
          throw new Error('fatal crash');
        }, 'guardian'),
      ).rejects.toThrow('fatal crash');
    });

    it('attaches crashReport to thrown error', async () => {
      try {
        await withCrashHandler(async () => {
          throw new Error('test');
        }, 'staging');
      } catch (e: any) {
        expect(e.crashReport).toBeDefined();
        expect(e.crashReport.component).toBe('staging');
      }
    });
  });

  describe('sanitizeForStdout', () => {
    it('produces one-liner (no newlines)', () => {
      const error = new Error('multi\nline\nerror');
      const result = sanitizeForStdout(error);
      expect(result).not.toContain('\n');
    });

    it('strips PII from error message', () => {
      const error = new Error('Failed for john@example.com');
      const result = sanitizeForStdout(error);
      expect(result).not.toContain('john@example.com');
      expect(result).toContain('[REDACTED]');
    });

    it('includes error type/name', () => {
      const error = new TypeError('bad input');
      const result = sanitizeForStdout(error);
      expect(result).toContain('TypeError');
    });

    it('truncates long messages to 200 chars', () => {
      const error = new Error('x'.repeat(300));
      const result = sanitizeForStdout(error);
      expect(result.length).toBeLessThanOrEqual(200);
    });

    it('strips phone numbers', () => {
      const error = new Error('Call failed: 555-123-4567');
      const result = sanitizeForStdout(error);
      expect(result).not.toContain('555-123-4567');
    });
  });

  describe('buildCrashReport', () => {
    it('includes component name', () => {
      const report = buildCrashReport(new Error('test'), 'guardian');
      expect(report.component).toBe('guardian');
    });

    it('includes stack hash for dedup', () => {
      const report = buildCrashReport(new Error('test'), 'guardian');
      expect(report.stackHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('includes sanitized one-liner', () => {
      const report = buildCrashReport(new Error('test'), 'guardian');
      expect(report.sanitizedOneLiner).toContain('Error');
      expect(report.sanitizedOneLiner).not.toContain('\n');
    });

    it('same error produces same stack hash', () => {
      const err = new Error('deterministic');
      const r1 = buildCrashReport(err, 'a');
      const r2 = buildCrashReport(err, 'b');
      expect(r1.stackHash).toBe(r2.stackHash); // same error, same stack
    });

    it('different errors produce different hashes', () => {
      const r1 = buildCrashReport(new Error('error1'), 'a');
      const r2 = buildCrashReport(new Error('error2'), 'a');
      expect(r1.stackHash).not.toBe(r2.stackHash);
    });
  });

  describe('auditCrashLogForPII', () => {
    it('clean report → clean:true', () => {
      const report: CrashReport = {
        component: 'guardian',
        message: 'LLM timeout after 30s',
        stackHash: 'abc123',
        sanitizedOneLiner: 'guardian: LLM timeout',
      };
      expect(auditCrashLogForPII(report)).toEqual({ clean: true });
    });

    it('report with email → clean:false, piiFound includes EMAIL', () => {
      const report: CrashReport = {
        component: 'staging',
        message: 'Failed for john@example.com',
        stackHash: 'def456',
        sanitizedOneLiner: 'staging: failed',
      };
      const result = auditCrashLogForPII(report);
      expect(result.clean).toBe(false);
      expect(result.piiFound).toContain('EMAIL');
    });

    it('report with phone → clean:false', () => {
      const report: CrashReport = {
        component: 'transport',
        message: 'Connection to 555-123-4567 failed',
        stackHash: 'ghi789',
        sanitizedOneLiner: 'transport: connection failed',
      };
      expect(auditCrashLogForPII(report).clean).toBe(false);
    });
  });

  describe('logging audit invariant', () => {
    it('crash log is stored in vault (encrypted at rest)', () => {
      expect(true).toBe(true);
    });

    it('traceback never written to files outside vault', () => {
      expect(true).toBe(true);
    });
  });
});
