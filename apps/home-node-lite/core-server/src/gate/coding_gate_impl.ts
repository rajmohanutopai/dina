/**
 * Item 4 — the concrete fs-backed coding gate injected into `@dina/core`'s
 * `POST /v1/agent/gate` route.
 *
 * `@dina/core` owns the route, auth, and wire shape but cannot canonicalise real
 * paths (it is pure). This wraps the Node-side `gateToolCall` (which composes the
 * 3b/3c classifiers + the 3d permit store) behind the `CodingGateFn` interface.
 * One `PermitStore` is shared across calls so a permit minted on one request is
 * redeemable on the execution seam.
 */

import type { CodingGateInput, CodingGateResult } from '@dina/core';

import { gateToolCall } from './gate_decision';
import { PermitStore } from './permit';

/** Synchronous concrete gate — assignable to @dina/core's `CodingGateFn`. */
type SyncCodingGate = (input: CodingGateInput) => CodingGateResult;

export interface CodingGateConfig {
  /** Dina vault/state dir — protected-path root. */
  vaultDir: string;
  /** Extra key/credential dirs, if any. */
  keyDirs?: string[];
  /** Hosts a network fetch may reach without escalating to HIGH. */
  allowedHosts?: string[];
}

export interface CodingGateHandle {
  gate: SyncCodingGate;
  permits: PermitStore;
}

export function createCodingGate(config: CodingGateConfig): CodingGateHandle {
  const permits = new PermitStore();
  const gate: SyncCodingGate = (input) => {
    const decision = gateToolCall(
      {
        toolName: input.toolName,
        toolInput: input.toolInput,
        agentDid: input.agentDid,
        sessionId: input.sessionId,
        vaultDir: config.vaultDir,
        cwd: input.cwd,
        keyDirs: config.keyDirs,
        allowedHosts: config.allowedHosts,
        mode: input.mode,
      },
      permits,
    );
    return {
      action: decision.action,
      risk: decision.risk,
      outcome: decision.outcome,
      enforced: decision.enforced,
      permitId: decision.permit?.permitId,
      reason: decision.reason,
    };
  };
  return { gate, permits };
}
