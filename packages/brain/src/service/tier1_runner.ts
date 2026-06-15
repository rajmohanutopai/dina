/**
 * Tier 1 runner glue — turns a claimed `service_query_execution`
 * workflow task into a `runCapability` call (docs/SERVICE_PROVIDER_TIERS.md).
 *
 * `LocalDelegationRunner` (claiming the reserved `dina.local` lane)
 * hands us `(capability, params, task)`; this module resolves the rest
 * at EXECUTION time, not task-creation time:
 *
 *   task.payload.service_uri → listing rkey → live ServiceConfig →
 *   capability's `instruction` (+ `instructionUpdatedAt`) and the
 *   published result schema → `CapabilityRuntime.run`.
 *
 * Why execution-time resolution: review-policy approvals can sit for
 * minutes; the provider may have updated the instruction (or their
 * notes) in between, and "the provider's CURRENT words" is the Tier 1
 * contract — the same reason the runtime's vault_search reads live
 * notes. The frozen `schemaSnapshot` (GAP-SH-03) still pins the OUTPUT
 * contract at the Response Bridge, so contract drift can't smuggle past
 * the requester.
 */

import {
  getCatalogCapability,
  parseServiceListingUri,
  parseServiceQueryExecutionPayload,
  resolveCatalogCapability,
} from '@dina/protocol';


import { getCapability } from './capabilities/registry';
import { getVaultFactBuilder } from './capabilities/vault_facts';

/**
 * Vault-MUTATING action classes — capabilities whose execution may persist to
 * the provider's vault (the `record_to_vault` write tool). `read` / `quote` /
 * `agentic` never write. Drives the runtime's `mutationAllowed` permission,
 * kept SEPARATE from operator approval (approving a response ≠ approving a
 * mutation).
 */
const MUTATING_ACTION_CLASSES: ReadonlySet<string> = new Set(['booking', 'write', 'payment']);
import {
  buildCapabilityRuntime,
  type CapabilityRuntimeOptions,
} from './capability_runtime';
import { findCapabilityConfig, snapshotForCapability } from './service_handler';

import type { LocalCapabilityRunner, WorkflowTask } from '@dina/core';
import type { ServiceConfig } from '@dina/protocol';

/** Mirrors `DEFAULT_LISTING_RKEY` in @dina/core's service_config. */
const DEFAULT_RKEY = 'self';

export interface Tier1RunnerOptions extends CapabilityRuntimeOptions {
  /**
   * Listing reader — rkey → live config (or null). Mobile/lite pass
   * core's `getServiceConfig`.
   */
  readConfig: (rkey: string) => ServiceConfig | null;
}

/**
 * Build the `LocalCapabilityRunner` callback for the `dina.local` lane.
 * Throws (→ task fails → error envelope to the requester) when the
 * capability has no instruction or the listing vanished — never hangs.
 */
export function makeTier1CapabilityRunner(options: Tier1RunnerOptions): LocalCapabilityRunner {
  const runtime = buildCapabilityRuntime(options);

  return async (capability: string, params: unknown, task: WorkflowTask): Promise<unknown> => {
    // THE codec — same parser as the approval consumer + Response Bridge.
    const payload = parseServiceQueryExecutionPayload(task.payload);
    if (payload === null) {
      throw new Error(`tier1_runner: task ${task.id} payload is not a service_query_execution`);
    }

    const serviceUri = payload.service_uri ?? '';
    const rkey =
      serviceUri !== '' ? (parseServiceListingUri(serviceUri)?.rkey ?? DEFAULT_RKEY) : DEFAULT_RKEY;
    const config = options.readConfig(rkey);
    const cap = findCapabilityConfig(config, capability);
    if (cap === null) {
      throw new Error(
        `tier1_runner: capability "${capability}" is not configured (or listing "${rkey}" is not active)`,
      );
    }
    const instruction = typeof cap.instruction === 'string' ? cap.instruction.trim() : '';
    if (instruction === '') {
      throw new Error(
        `tier1_runner: capability "${capability}" has no instruction — it is not a Tier 1 capability`,
      );
    }

    // Result contract: prefer the listing's PUBLISHED schema (what the
    // requester saw), fall back to the canonical registry schema.
    const resultSchema =
      snapshotForCapability(config, capability)?.result ?? getCapability(capability)?.resultSchema;

    // Execution budget = the query's TTL (the requester gives up after
    // it anyway). Bounded fallback for payloads without one.
    const ttlSeconds =
      payload.ttl_seconds !== undefined && payload.ttl_seconds > 0 ? payload.ttl_seconds : 120;

    // Vault-mutation permission — from the CATALOG action_class, NOT from the
    // approval flag. Only booking/write/payment capabilities may persist to the
    // vault (and only then if the operator also approved this execution). A
    // read/quote capability can never write, even under review policy.
    const canonical = resolveCatalogCapability(capability) ?? capability;
    const catalogEntry = getCatalogCapability(canonical);
    const actionClass = catalogEntry?.action_class;
    const mutationAllowed = actionClass !== undefined && MUTATING_ACTION_CLASSES.has(actionClass);
    // The result statuses that mean the mutation SUCCEEDED — the only ones that
    // commit a vault write (e.g. appointment_book → ['confirmed']). The runtime
    // fail-closes when this is absent, so a non-success booking
    // (declined/unavailable/unknown) never persists a "slot taken" write.
    const mutationSuccessStatuses = catalogEntry?.mutation_success_statuses;
    // Deterministic fact builder — the model NEVER authors persisted vault text
    // (a malicious param could otherwise prompt-inject a false/broad fact). The
    // model only triggers `record_to_vault`; the runtime calls this builder over
    // the validated params/result + authenticated requester DID to construct what
    // is stored. A mutating capability with no builder cannot write (fail-closed).
    const vaultFactBuilder = getVaultFactBuilder(canonical);

    // Vault scope (read AND write) is the listing's SELECTED vault — ALWAYS a
    // single concrete persona, never a fan-out across the provider's memory.
    // Default to `general` (the main vault) when the provider has not pinned a
    // dedicated one, so a service still reads exactly ONE vault instead of
    // every shared note. The runtime intersects this with its safe-tier filter
    // (a sensitive/locked pin yields empty — no access).
    const vaultPersona =
      typeof config?.vaultPersona === 'string' && config.vaultPersona !== ''
        ? config.vaultPersona
        : 'general';

    return runtime.run({
      capability,
      params,
      instruction,
      ...(typeof cap.instructionUpdatedAt === 'number'
        ? { instructionUpdatedAt: cap.instructionUpdatedAt }
        : {}),
      ...(resultSchema !== undefined ? { resultSchema } : {}),
      serviceName: config?.name ?? '',
      operatorApproved: payload.operator_approved === true,
      mutationAllowed,
      ...(mutationSuccessStatuses !== undefined ? { mutationSuccessStatuses } : {}),
      ...(vaultFactBuilder !== undefined ? { vaultFactBuilder } : {}),
      // Authenticated requester DID (Core ingress) — recorded in the
      // deterministic booking fact ("…for <did>"). Never self-asserted.
      ...(payload.from_did !== '' ? { requesterDid: payload.from_did } : {}),
      deadlineMs: ttlSeconds * 1000,
      // Single selected vault — see `vaultPersona` above. Read + write both
      // scope to exactly this one persona (∩ the runtime's safe-tier filter).
      allowedPersonas: [vaultPersona],
    });
  };
}
