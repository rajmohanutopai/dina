/**
 * T3.3 — Audit/crash log cleanup: 90-day retention purge.
 *
 * Wired to real audit service sweepRetention.
 *
 * Source: core/test/traceability_test.go, watchdog_test.go
 */

import { appendAudit, sweepRetention, auditCount, resetAuditState } from '../../src/audit/service';

describe('Audit & Crash Log Cleanup (Mobile-Specific)', () => {
  beforeEach(() => resetAuditState());

  describe('audit log retention', () => {
    it('entries older than 90 days are purged', () => {
      appendAudit('brain', 'old_action', 'general');
      const ninetyOneDays = Date.now() + 91 * 24 * 60 * 60 * 1000;
      const purged = sweepRetention(ninetyOneDays);
      expect(purged).toBe(1);
      expect(auditCount()).toBe(0);
    });

    it('entries within 90 days are preserved', () => {
      appendAudit('brain', 'recent_action', 'general');
      expect(sweepRetention()).toBe(0);
      expect(auditCount()).toBe(1);
    });

    it('purge returns count of deleted entries', () => {
      appendAudit('a', 'x', 'r1');
      appendAudit('a', 'x', 'r2');
      appendAudit('a', 'x', 'r3');
      const far = Date.now() + 91 * 24 * 60 * 60 * 1000;
      expect(sweepRetention(far)).toBe(3);
    });

    it('fresh entries survive sweep', () => {
      appendAudit('brain', 'action', 'general');
      expect(sweepRetention()).toBe(0);
    });
  });

  describe('crash log retention (uses same sweep mechanism)', () => {
    it('old crash entries purged', () => {
      appendAudit('crash_handler', 'crash', 'brain', 'OOM error');
      const far = Date.now() + 91 * 24 * 60 * 60 * 1000;
      expect(sweepRetention(far)).toBe(1);
    });

    it('recent crash entries preserved', () => {
      appendAudit('crash_handler', 'crash', 'brain', 'NPE');
      expect(sweepRetention()).toBe(0);
      expect(auditCount()).toBe(1);
    });
  });
});
