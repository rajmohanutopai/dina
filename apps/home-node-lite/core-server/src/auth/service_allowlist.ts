/**
 * Task 4.24 — per-service allowlists loaded from `service_config`.
 *
 * `ServiceAllowlist` maps an inbound signed request's DID to a
 * `CallerType` (`brain` | `admin` | `connector` | `device` | `agent`)
 * so the downstream authz check (`isAuthorized` in `@dina/core`) can
 * gate the path. The mapping comes from `service_config` — Core's
 * persisted config records which DIDs are the home node's own Brain,
 * its paired devices, and which external services are trusted
 * connectors.
 *
 * **Why a separate module.** `@dina/core`'s `isAuthorized` takes a
 * caller-type enum — it doesn't know about DIDs. That's the right
 * separation of concerns: path→caller-type is stable policy, but
 * DID→caller-type is per-deployment (every Home Node has its own
 * Brain DID). The allowlist is the bridge.
 *
 * **Fail-closed.** An unknown DID returns `unknown` — not a caller
 * type. The middleware renders that as 403. Adding a DID to the wrong
 * category (e.g. admin) is a deployment-level action; we don't try
 * to infer from context.
 *
 * **Live-reload hook.** Brain's equivalent runs a 60s poll on the
 * service_config endpoint. Core's own allowlist reloads on-demand via
 * `setConfig` — `apps/home-node-lite/core-server`'s boot-ordering
 * task (4.3 continuation) will wire that into the service_config
 * route. Today this module just owns the lookup; the reload orchestrator
 * lives in the boot pipeline.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4c task 4.24.
 */

import type { CallerType } from '@dina/core';

/** The subset of `service_config` this module cares about. */
export interface ServiceAllowlistConfig {
  /** Home node's own Brain DID. Every signed request from Brain uses this. */
  brainDid: string;
  /** Admin caller DID. Typically an operator's CLI / web admin UI device. */
  adminDid?: string;
  /** Registered connector DIDs — external services the operator trusts
   *  to push data (Gmail connector, Calendar connector, etc.). */
  connectorDids?: string[];
  /** Paired device DIDs — user's phones / laptops / glasses. */
  deviceDids?: string[];
  /** Active agent-session DIDs (OpenClaw etc.). These typically come
   *  from the active agent-sessions registry, not service_config; but
   *  the allowlist is the right single lookup surface for all caller
   *  classes. Callers can push updates via `setAgentSessions`. */
  agentDids?: string[];
}

export type AllowlistLookup =
  | { ok: true; callerType: CallerType }
  | { ok: false; reason: 'unknown_did' };

/**
 * DID → CallerType resolver. Construct once at boot; rebuild on
 * `service_config` changes via `setConfig`.
 *
 * Order of lookup matches caller-type priority: brain > admin >
 * connector > device > agent. In practice no DID should appear in
 * two lists (a deployment-level misconfiguration); if one does, the
 * higher-priority entry wins so a Brain accidentally listed as a
 * device still authenticates as Brain.
 */
export class ServiceAllowlist {
  private brainDid: string;
  private adminDid: string | undefined;
  private connectors: Set<string>;
  private devices: Set<string>;
  private agents: Set<string>;

  constructor(config: ServiceAllowlistConfig) {
    if (!config.brainDid || config.brainDid.length === 0) {
      throw new Error('ServiceAllowlist: brainDid is required');
    }
    this.brainDid = config.brainDid;
    this.adminDid = config.adminDid ?? undefined;
    this.connectors = new Set(config.connectorDids ?? []);
    this.devices = new Set(config.deviceDids ?? []);
    this.agents = new Set(config.agentDids ?? []);
  }

  /**
   * Resolve a DID to its caller type. Returns `{ok: false}` when the
   * DID is unknown — the auth middleware maps that to HTTP 403.
   */
  lookup(did: string): AllowlistLookup {
    if (did === this.brainDid) return { ok: true, callerType: 'brain' };
    if (did === this.adminDid) return { ok: true, callerType: 'admin' };
    if (this.connectors.has(did)) return { ok: true, callerType: 'connector' };
    if (this.devices.has(did)) return { ok: true, callerType: 'device' };
    if (this.agents.has(did)) return { ok: true, callerType: 'agent' };
    return { ok: false, reason: 'unknown_did' };
  }

  /**
   * Replace the allowlist with a new config — called after
   * service_config is reloaded. Atomic: lookups before the call use
   * the old sets, lookups after use the new ones.
   */
  setConfig(config: ServiceAllowlistConfig): void {
    if (!config.brainDid || config.brainDid.length === 0) {
      throw new Error('ServiceAllowlist: brainDid is required');
    }
    this.brainDid = config.brainDid;
    this.adminDid = config.adminDid ?? undefined;
    this.connectors = new Set(config.connectorDids ?? []);
    this.devices = new Set(config.deviceDids ?? []);
    this.agents = new Set(config.agentDids ?? []);
  }

  /** Update only the agent-session list (the one thing that churns frequently). */
  setAgentSessions(agentDids: string[]): void {
    this.agents = new Set(agentDids);
  }

  /** For /readyz probes + tests. */
  stats(): { brain: 1; admin: 0 | 1; connectors: number; devices: number; agents: number } {
    return {
      brain: 1,
      admin: this.adminDid !== undefined ? 1 : 0,
      connectors: this.connectors.size,
      devices: this.devices.size,
      agents: this.agents.size,
    };
  }
}
