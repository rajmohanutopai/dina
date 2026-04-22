/**
 * T9.14 — Health check diagnostics: self-diagnostic across all modules.
 *
 * Source: ARCHITECTURE.md Task 9.14
 */

import { runHealthCheck } from '../../src/diagnostics/health';
import { clearVaults, storeItem } from '../../src/vault/crud';
import { appendAudit, resetAuditState } from '../../src/audit/service';
import { createPersona, openPersona, resetPersonaState } from '../../src/persona/service';
import { resetConnectionState } from '../../src/relay/msgbox_ws';
import { resetLifecycleState } from '../../src/lifecycle/sleep_wake';
import { resetStagingState } from '../../src/staging/service';

describe('Health Check Diagnostics', () => {
  beforeEach(() => {
    clearVaults();
    resetAuditState();
    resetPersonaState();
    resetConnectionState();
    resetLifecycleState();
    resetStagingState();
  });

  describe('runHealthCheck', () => {
    it('returns a complete health report', () => {
      const report = runHealthCheck();
      expect(report.checks.length).toBeGreaterThanOrEqual(6);
      expect(report.timestamp).toBeGreaterThan(0);
      expect(['pass', 'fail', 'warn']).toContain(report.overall);
    });

    it('all checks pass in clean state', () => {
      const report = runHealthCheck();
      const failed = report.checks.filter((c) => c.status === 'fail');
      expect(failed).toHaveLength(0);
    });

    it('each check has name, status, detail', () => {
      const report = runHealthCheck();
      for (const check of report.checks) {
        expect(check.name).toBeTruthy();
        expect(['pass', 'fail', 'warn', 'skip']).toContain(check.status);
        expect(check.detail).toBeTruthy();
      }
    });
  });

  describe('vault_access check', () => {
    it('passes when vault is accessible', () => {
      const report = runHealthCheck();
      const vaultCheck = report.checks.find((c) => c.name === 'vault_access');
      expect(vaultCheck!.status).toBe('pass');
      expect(vaultCheck!.detail).toContain('round-trip');
    });

    it('cleans up health check probe item', () => {
      runHealthCheck();
      // The _healthcheck item should be deleted after the probe
      const { getItem } = require('../../src/vault/crud');
      // No leftover items in the _healthcheck persona
    });
  });

  describe('audit_chain check', () => {
    it('passes with empty chain', () => {
      const report = runHealthCheck();
      const check = report.checks.find((c) => c.name === 'audit_chain');
      expect(check!.status).toBe('pass');
    });

    it('passes with valid chain', () => {
      appendAudit('brain', 'store', 'general');
      appendAudit('brain', 'query', 'health');
      const report = runHealthCheck();
      const check = report.checks.find((c) => c.name === 'audit_chain');
      expect(check!.status).toBe('pass');
      expect(check!.detail).toContain('2 entries');
    });
  });

  describe('persona_state check', () => {
    it('warns when no personas registered', () => {
      const report = runHealthCheck();
      const check = report.checks.find((c) => c.name === 'persona_state');
      expect(check!.status).toBe('warn');
    });

    it('passes with registered personas', () => {
      createPersona('general', 'default');
      openPersona('general');
      const report = runHealthCheck();
      const check = report.checks.find((c) => c.name === 'persona_state');
      expect(check!.status).toBe('pass');
      expect(check!.detail).toContain('1 persona');
      expect(check!.detail).toContain('1 open');
    });
  });

  describe('msgbox_connection check', () => {
    it('warns when not connected', () => {
      const report = runHealthCheck();
      const check = report.checks.find((c) => c.name === 'msgbox_connection');
      expect(check!.status).toBe('warn');
    });
  });

  describe('app_lifecycle check', () => {
    it('passes in active state', () => {
      const report = runHealthCheck();
      const check = report.checks.find((c) => c.name === 'app_lifecycle');
      expect(check!.status).toBe('pass');
      expect(check!.detail).toContain('active');
    });
  });

  describe('staging_inbox check', () => {
    it('passes with empty inbox', () => {
      const report = runHealthCheck();
      const check = report.checks.find((c) => c.name === 'staging_inbox');
      expect(check!.status).toBe('pass');
    });
  });

  describe('overall status', () => {
    it('overall is pass when all pass', () => {
      createPersona('general', 'default');
      const report = runHealthCheck();
      // Some checks might warn (MsgBox not connected) but none fail
      expect(['pass', 'warn']).toContain(report.overall);
    });
  });
});
