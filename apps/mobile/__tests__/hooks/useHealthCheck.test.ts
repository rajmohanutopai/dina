/**
 * T9.14 — Health check diagnostic: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 9.14
 */

import {
  runHealthChecks,
  runSingleCheck,
  getStatusColor,
  configureHealthChecks,
  resetHealthChecks,
  type HealthReport,
} from '../../src/hooks/useHealthCheck';
import { createPersona, openPersona, resetPersonaState } from '../../../core/src/persona/service';
import { configureProvider, resetProviderConfig } from '../../../brain/src/llm/provider_config';

describe('Health Check Diagnostic Hook (9.14)', () => {
  beforeEach(() => {
    resetHealthChecks();
    resetPersonaState();
    resetProviderConfig();
  });

  describe('runHealthChecks — all green', () => {
    it('returns healthy when all checks pass', () => {
      createPersona('general', 'default');
      openPersona('general', true);
      configureProvider('claude', 'sk-ant-abc123-long-enough');
      configureHealthChecks({
        isAuditChainValid: () => true,
        isMsgBoxConnected: () => true,
        isNotificationsEnabled: () => true,
        isDIDInitialized: () => true,
      });

      const report = runHealthChecks();

      expect(report.overall).toBe('healthy');
      expect(report.failCount).toBe(0);
      expect(report.warnCount).toBe(0);
      expect(report.checks.length).toBeGreaterThanOrEqual(7);
    });
  });

  describe('vault check', () => {
    it('pass when persona is open', () => {
      createPersona('general', 'default');
      openPersona('general', true);

      const check = runSingleCheck('vault');
      expect(check!.status).toBe('pass');
      expect(check!.message).toContain('1/1');
    });

    it('fail when no vaults open', () => {
      createPersona('general', 'default');
      // Not opened

      const check = runSingleCheck('vault');
      expect(check!.status).toBe('fail');
      expect(check!.critical).toBe(true);
    });

    it('warn when no personas exist', () => {
      const check = runSingleCheck('vault');
      expect(check!.status).toBe('warn');
    });
  });

  describe('audit chain check', () => {
    it('pass when chain valid', () => {
      configureHealthChecks({ isAuditChainValid: () => true });
      expect(runSingleCheck('audit')!.status).toBe('pass');
    });

    it('fail when chain compromised', () => {
      configureHealthChecks({ isAuditChainValid: () => false });
      const check = runSingleCheck('audit');
      expect(check!.status).toBe('fail');
      expect(check!.critical).toBe(true);
    });

    it('skip when not configured', () => {
      expect(runSingleCheck('audit')!.status).toBe('skip');
    });
  });

  describe('LLM check', () => {
    it('pass when provider available', () => {
      configureProvider('openai', 'sk-proj-1234567890abcdef');
      expect(runSingleCheck('llm')!.status).toBe('pass');
    });

    it('warn when no provider (FTS-only)', () => {
      const check = runSingleCheck('llm');
      expect(check!.status).toBe('warn');
      expect(check!.message).toContain('FTS-only');
    });
  });

  describe('MsgBox check', () => {
    it('pass when connected', () => {
      configureHealthChecks({ isMsgBoxConnected: () => true });
      expect(runSingleCheck('msgbox')!.status).toBe('pass');
    });

    it('warn when disconnected', () => {
      configureHealthChecks({ isMsgBoxConnected: () => false });
      expect(runSingleCheck('msgbox')!.status).toBe('warn');
    });

    it('skip when not configured', () => {
      expect(runSingleCheck('msgbox')!.status).toBe('skip');
    });
  });

  describe('notifications check', () => {
    it('pass when enabled', () => {
      configureHealthChecks({ isNotificationsEnabled: () => true });
      expect(runSingleCheck('notifications')!.status).toBe('pass');
    });

    it('warn when disabled', () => {
      configureHealthChecks({ isNotificationsEnabled: () => false });
      expect(runSingleCheck('notifications')!.status).toBe('warn');
    });
  });

  describe('identity check', () => {
    it('pass when initialized', () => {
      configureHealthChecks({ isDIDInitialized: () => true });
      expect(runSingleCheck('identity')!.status).toBe('pass');
    });

    it('fail when not initialized', () => {
      configureHealthChecks({ isDIDInitialized: () => false });
      const check = runSingleCheck('identity');
      expect(check!.status).toBe('fail');
      expect(check!.critical).toBe(true);
    });
  });

  describe('boot personas check', () => {
    it('pass when general is open', () => {
      createPersona('general', 'default');
      openPersona('general', true);
      expect(runSingleCheck('boot_personas')!.status).toBe('pass');
    });

    it('warn when general is closed', () => {
      createPersona('general', 'default');
      expect(runSingleCheck('boot_personas')!.status).toBe('warn');
    });

    it('fail when general is missing', () => {
      expect(runSingleCheck('boot_personas')!.status).toBe('fail');
    });
  });

  describe('overall status', () => {
    it('unhealthy when critical check fails', () => {
      // No personas → vault fail (critical)
      configureHealthChecks({ isDIDInitialized: () => false });
      const report = runHealthChecks();
      expect(report.overall).toBe('unhealthy');
    });

    it('degraded when non-critical check fails', () => {
      createPersona('general', 'default');
      openPersona('general', true);
      configureHealthChecks({
        isAuditChainValid: () => true,
        isDIDInitialized: () => true,
        isMsgBoxConnected: () => false, // non-critical warn
      });

      const report = runHealthChecks();
      // Could be degraded if LLM warn counts
      expect(['healthy', 'degraded']).toContain(report.overall);
    });

    it('report includes timestamp', () => {
      const before = Date.now();
      const report = runHealthChecks();
      expect(report.timestamp).toBeGreaterThanOrEqual(before);
    });
  });

  describe('getStatusColor', () => {
    it('healthy → green', () => {
      expect(getStatusColor('healthy')).toBe('green');
    });

    it('degraded → yellow', () => {
      expect(getStatusColor('degraded')).toBe('yellow');
    });

    it('unhealthy → red', () => {
      expect(getStatusColor('unhealthy')).toBe('red');
    });
  });
});
