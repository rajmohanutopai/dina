/**
 * Health check diagnostic hook — self-diagnostic for the Health Check UI.
 *
 * Checks:
 *   1. Vault accessible — at least one persona is open
 *   2. Audit chain integrity — hash chain verifies
 *   3. LLM reachable — at least one provider configured
 *   4. MsgBox connected — WebSocket connection alive
 *   5. Notifications enabled — local notification module working
 *   6. Identity initialized — DID exists
 *   7. Boot personas open — default/standard personas are accessible
 *
 * Each check returns pass/fail with a human-readable message.
 * The overall status is green (all pass), yellow (some fail), red (critical fail).
 *
 * Source: ARCHITECTURE.md Task 9.14
 */

import { listPersonas, isPersonaOpen } from '@dina/core/src/persona/service';
import {
  isProviderAvailable,
  getBestProvider,
  type ProviderName,
} from '@dina/brain/src/llm/provider_config';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';
export type OverallStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheck {
  name: string;
  status: CheckStatus;
  message: string;
  critical: boolean;
}

export interface HealthReport {
  overall: OverallStatus;
  checks: HealthCheck[];
  passCount: number;
  failCount: number;
  warnCount: number;
  timestamp: number;
}

/** Injectable check functions for testability. */
export interface HealthCheckDeps {
  isAuditChainValid?: () => boolean;
  isMsgBoxConnected?: () => boolean;
  isNotificationsEnabled?: () => boolean;
  isDIDInitialized?: () => boolean;
}

let deps: HealthCheckDeps = {};

/**
 * Configure check dependencies (for production + testing).
 */
export function configureHealthChecks(d: HealthCheckDeps): void {
  deps = d;
}

/**
 * Run all health checks and return the report.
 */
export function runHealthChecks(): HealthReport {
  const checks: HealthCheck[] = [
    checkVaultAccessible(),
    checkAuditChain(),
    checkLLMReachable(),
    checkMsgBoxConnected(),
    checkNotifications(),
    checkIdentity(),
    checkBootPersonas(),
  ];

  const passCount = checks.filter((c) => c.status === 'pass').length;
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;
  const criticalFails = checks.filter((c) => c.status === 'fail' && c.critical).length;

  let overall: OverallStatus;
  if (criticalFails > 0) {
    overall = 'unhealthy';
  } else if (failCount > 0 || warnCount > 0) {
    overall = 'degraded';
  } else {
    overall = 'healthy';
  }

  return { overall, checks, passCount, failCount, warnCount, timestamp: Date.now() };
}

/**
 * Run a single check by name.
 */
export function runSingleCheck(name: string): HealthCheck | null {
  const all = runHealthChecks();
  return all.checks.find((c) => c.name === name) ?? null;
}

/**
 * Get overall status color for UI.
 */
export function getStatusColor(status: OverallStatus): string {
  switch (status) {
    case 'healthy':
      return 'green';
    case 'degraded':
      return 'yellow';
    case 'unhealthy':
      return 'red';
  }
}

/**
 * Reset health check deps (for testing).
 */
export function resetHealthChecks(): void {
  deps = {};
}

// ---------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------

function checkVaultAccessible(): HealthCheck {
  const personas = listPersonas();
  const open = personas.filter((p) => isPersonaOpen(p.name));

  if (personas.length === 0) {
    return { name: 'vault', status: 'warn', message: 'No personas created', critical: false };
  }
  if (open.length === 0) {
    return {
      name: 'vault',
      status: 'fail',
      message: 'No vaults open — unlock required',
      critical: true,
    };
  }
  return {
    name: 'vault',
    status: 'pass',
    message: `${open.length}/${personas.length} vaults open`,
    critical: true,
  };
}

function checkAuditChain(): HealthCheck {
  if (!deps.isAuditChainValid) {
    return {
      name: 'audit',
      status: 'skip',
      message: 'Audit check not configured',
      critical: false,
    };
  }
  const valid = deps.isAuditChainValid();
  return {
    name: 'audit',
    status: valid ? 'pass' : 'fail',
    message: valid ? 'Hash chain verified' : 'Audit chain integrity compromised',
    critical: true,
  };
}

function checkLLMReachable(): HealthCheck {
  const best = getBestProvider();
  if (!best) {
    return {
      name: 'llm',
      status: 'warn',
      message: 'No LLM provider configured — FTS-only mode',
      critical: false,
    };
  }
  return { name: 'llm', status: 'pass', message: `Provider: ${best}`, critical: false };
}

function checkMsgBoxConnected(): HealthCheck {
  if (!deps.isMsgBoxConnected) {
    return {
      name: 'msgbox',
      status: 'skip',
      message: 'MsgBox check not configured',
      critical: false,
    };
  }
  const connected = deps.isMsgBoxConnected();
  return {
    name: 'msgbox',
    status: connected ? 'pass' : 'warn',
    message: connected
      ? 'MsgBox WebSocket connected'
      : 'MsgBox disconnected — D2D messaging unavailable',
    critical: false,
  };
}

function checkNotifications(): HealthCheck {
  if (!deps.isNotificationsEnabled) {
    return {
      name: 'notifications',
      status: 'skip',
      message: 'Notification check not configured',
      critical: false,
    };
  }
  const enabled = deps.isNotificationsEnabled();
  return {
    name: 'notifications',
    status: enabled ? 'pass' : 'warn',
    message: enabled ? 'Notifications enabled' : "Notifications disabled — reminders won't fire",
    critical: false,
  };
}

function checkIdentity(): HealthCheck {
  if (!deps.isDIDInitialized) {
    return {
      name: 'identity',
      status: 'skip',
      message: 'Identity check not configured',
      critical: false,
    };
  }
  const initialized = deps.isDIDInitialized();
  return {
    name: 'identity',
    status: initialized ? 'pass' : 'fail',
    message: initialized ? 'DID initialized' : 'Identity not initialized — complete onboarding',
    critical: true,
  };
}

function checkBootPersonas(): HealthCheck {
  const personas = listPersonas();
  const general = personas.find((p) => p.name === 'general');

  if (!general) {
    return {
      name: 'boot_personas',
      status: 'fail',
      message: 'General persona missing',
      critical: true,
    };
  }
  if (!isPersonaOpen('general')) {
    return {
      name: 'boot_personas',
      status: 'warn',
      message: 'General persona is closed',
      critical: false,
    };
  }
  return {
    name: 'boot_personas',
    status: 'pass',
    message: 'General persona open',
    critical: false,
  };
}
