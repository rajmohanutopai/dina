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

import { parseServiceListingUri, parseServiceQueryExecutionPayload } from '@dina/protocol';


import { getCapability } from './capabilities/registry';
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
      deadlineMs: ttlSeconds * 1000,
      // Per-listing vault pin: this listing's executions read ONLY the
      // designated persona (intersected with the runtime's fail-closed
      // tier scope — a pin can narrow, never widen).
      ...(typeof config?.vaultPersona === 'string' && config.vaultPersona !== ''
        ? { allowedPersonas: [config.vaultPersona] }
        : {}),
    });
  };
}
