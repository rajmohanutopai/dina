/**
 * Health check diagnostics — self-diagnostic across all system modules.
 *
 * Checks:
 *   1. Vault accessible (can store + query)
 *   2. Audit chain integrity (hash chain valid)
 *   3. Persona state (expected personas exist)
 *   4. LLM availability (any provider registered)
 *   5. MsgBox connection state
 *   6. Staging inbox health (no stuck items)
 *   7. Cache health (trust cache, DID cache responsive)
 *
 * Returns a structured report: each check passes or fails with detail.
 *
 * Source: ARCHITECTURE.md Task 9.14
 */

import { storeItem, getItem, deleteItem, clearVaults } from '../vault/crud';
import { verifyAuditChain, auditCount } from '../audit/service';
import { listPersonas, isPersonaOpen } from '../persona/service';
import { isConnected } from '../relay/msgbox_ws';
import { getAppState, areSecretsZeroed } from '../lifecycle/sleep_wake';
import { inboxSize } from '../staging/service';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface HealthCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  latencyMs?: number;
}

export interface HealthReport {
  overall: CheckStatus;
  checks: HealthCheck[];
  timestamp: number;
}

/**
 * Run all health checks and return a structured report.
 */
export function runHealthCheck(): HealthReport {
  const checks: HealthCheck[] = [];

  checks.push(checkVaultAccess());
  checks.push(checkAuditChain());
  checks.push(checkPersonaState());
  checks.push(checkMsgBoxConnection());
  checks.push(checkAppLifecycle());
  checks.push(checkStagingInbox());

  const overall = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'pass';

  return { overall, checks, timestamp: Date.now() };
}

/** Check: can we store + query + delete a vault item?
 *
 * Probes against the first open persona — `requireRepo()` is strict
 * now, so writing to a hardcoded `_healthcheck` persona that nobody
 * ever registered would always throw. Falls back to `warn` when no
 * persona is open (boot-time state — vault is fine, just nothing to
 * probe).
 */
function checkVaultAccess(): HealthCheck {
  const start = Date.now();
  const probePersona = listPersonas().find((p) => p.isOpen)?.name;
  if (!probePersona) {
    return {
      name: 'vault_access',
      status: 'warn',
      detail: 'No open persona to probe — vault accessibility unverified',
      latencyMs: Date.now() - start,
    };
  }
  try {
    const id = storeItem(probePersona, { summary: '_hc_probe', type: 'note' });
    const item = getItem(probePersona, id);
    deleteItem(probePersona, id);

    if (!item) {
      return {
        name: 'vault_access',
        status: 'fail',
        detail: 'Store succeeded but get returned null',
        latencyMs: Date.now() - start,
      };
    }

    return {
      name: 'vault_access',
      status: 'pass',
      detail: `Store → get → delete round-trip OK (persona=${probePersona})`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'vault_access',
      status: 'fail',
      detail: `Vault error: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: Date.now() - start,
    };
  }
}

/** Check: is the audit hash chain intact? */
function checkAuditChain(): HealthCheck {
  const count = auditCount();
  if (count === 0) {
    return {
      name: 'audit_chain',
      status: 'pass',
      detail: 'No audit entries (empty chain is valid)',
    };
  }

  const result = verifyAuditChain();
  if (result.valid) {
    return { name: 'audit_chain', status: 'pass', detail: `Chain valid (${count} entries)` };
  }

  return {
    name: 'audit_chain',
    status: 'fail',
    detail: `Chain broken at entry ${result.brokenAt}`,
  };
}

/** Check: are expected personas registered? */
function checkPersonaState(): HealthCheck {
  const personas = listPersonas();
  if (personas.length === 0) {
    return { name: 'persona_state', status: 'warn', detail: 'No personas registered' };
  }

  const openCount = personas.filter((p) => isPersonaOpen(p.name)).length;
  return {
    name: 'persona_state',
    status: 'pass',
    detail: `${personas.length} persona(s), ${openCount} open`,
  };
}

/** Check: is MsgBox WebSocket connected? */
function checkMsgBoxConnection(): HealthCheck {
  const connected = isConnected();
  return {
    name: 'msgbox_connection',
    status: connected ? 'pass' : 'warn',
    detail: connected ? 'WebSocket connected' : 'WebSocket not connected',
  };
}

/** Check: is the app in a healthy lifecycle state? */
function checkAppLifecycle(): HealthCheck {
  const state = getAppState();
  const zeroed = areSecretsZeroed();

  if (state === 'background_expired' || zeroed) {
    return {
      name: 'app_lifecycle',
      status: 'warn',
      detail: `State: ${state}, secrets zeroed: ${zeroed}`,
    };
  }

  return { name: 'app_lifecycle', status: 'pass', detail: `State: ${state}` };
}

/** Check: is the staging inbox healthy (no excessive backlog)? */
function checkStagingInbox(): HealthCheck {
  const size = inboxSize();
  if (size > 1000) {
    return { name: 'staging_inbox', status: 'warn', detail: `Large backlog: ${size} items` };
  }

  return { name: 'staging_inbox', status: 'pass', detail: `${size} item(s) in inbox` };
}
