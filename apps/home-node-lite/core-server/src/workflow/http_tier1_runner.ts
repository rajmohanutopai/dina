/**
 * Core→Brain adapter for the Tier-1 (`dina.local`) execution lane.
 *
 * The lite Core owns the `dina.local` workflow lane in-process (the reserved
 * lane is EXACT-match and the HTTP claim route 403s it by design — it can
 * never be claimed by an external agent over the wire). So the Core's
 * `LocalDelegationRunner` claims the `service_query_execution` task, but Core
 * has no LLM. This adapter ships the claimed task to the lite Brain's
 * `/api/v1/capability/run` endpoint, which runs the real Tier-1 runtime
 * (instruction + vault_search → schema-valid JSON) where the LLM, the
 * vault-read backend, and the mirrored persona registry already live.
 *
 * Core resolves the listing's `ServiceConfig` IN-PROCESS (`getServiceConfig`)
 * and passes it along, so the Brain endpoint never has to round-trip back to
 * Core for it. Loopback HTTP, no signing (the Brain capability route is
 * localhost-only, same posture as its other routes).
 */

import { getServiceConfig, type LocalCapabilityRunner, type WorkflowTask } from '@dina/core';
import { parseServiceListingUri, parseServiceQueryExecutionPayload } from '@dina/protocol';

import type { Logger } from '../logger';

/** Mirrors `DEFAULT_LISTING_RKEY` in @dina/core's service_config + tier1_runner. */
const DEFAULT_RKEY = 'self';

export interface HttpTier1RunnerOptions {
  /** Base URL of the lite Brain (e.g. http://127.0.0.1:8200). */
  brainUrl: string;
  logger: Logger;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export function makeHttpTier1Runner(options: HttpTier1RunnerOptions): LocalCapabilityRunner {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.brainUrl.replace(/\/+$/, '');

  return async (capability: string, params: unknown, task: WorkflowTask): Promise<unknown> => {
    // Resolve the listing config Core holds for this query's rkey. The Brain
    // runtime needs the capability's instruction + result schema + vault pin;
    // Core has them in-process, so pass them rather than make Brain fetch.
    const payload = parseServiceQueryExecutionPayload(task.payload);
    const serviceUri = payload?.service_uri ?? '';
    const rkey =
      serviceUri !== '' ? (parseServiceListingUri(serviceUri)?.rkey ?? DEFAULT_RKEY) : DEFAULT_RKEY;
    const config = getServiceConfig(rkey);

    options.logger.info(
      { task_id: task.id, capability, rkey, has_config: config !== null },
      'tier1: dispatching capability execution to brain',
    );

    const res = await fetchImpl(`${base}/api/v1/capability/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability,
        params,
        task: { id: task.id, payload: task.payload },
        config,
      }),
    });

    const text = await res.text();
    let parsed: { result?: unknown; error?: string } = {};
    try {
      parsed = text === '' ? {} : (JSON.parse(text) as { result?: unknown; error?: string });
    } catch {
      /* non-JSON body — fall through to the status check below */
    }
    if (!res.ok) {
      // Throwing fails the task → the Response Bridge ships an error envelope
      // to the requester. A clear signal beats a silent expiry.
      throw new Error(parsed.error ?? `tier1 brain endpoint returned ${res.status}`);
    }
    return parsed.result;
  };
}
