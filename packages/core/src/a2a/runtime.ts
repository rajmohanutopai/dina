/**
 * What Core's A2A steps need, in both directions: the A2A store, the
 * workflow service, and a clock, with the store and the workflow repository
 * on ONE connection. Every A2A invariant is a single commit across both (a
 * consent card and its staged operation; a permit and its dispatch child; a
 * consumed permit and the move to `transmitting`; an inbound receipt, its
 * operation and its first child), so a runtime whose stores could not share
 * a transaction refuses to exist rather than run without that guarantee.
 *
 * A host installs A2A once (`installA2A`: the store and a clock). The
 * runtime is then paired with whichever workflow service is current: the
 * server swaps its early service for the full workflow plane during boot,
 * and A2A must follow, never hold the one it first saw.
 */

import { SQLiteWorkflowRepository } from '../workflow/repository';
import { getWorkflowService, type WorkflowService } from '../workflow/service';

import type { A2AStore } from './store';

export interface A2ARuntime {
  store: A2AStore;
  workflow: WorkflowService;
  /** The service's repository, proven to share the store's connection. */
  repository: SQLiteWorkflowRepository;
  nowMs: () => number;
}

export function createA2ARuntime(args: {
  store: A2AStore;
  workflow: WorkflowService;
  nowMs?: () => number;
}): A2ARuntime {
  const repo = args.workflow.store();
  if (!(repo instanceof SQLiteWorkflowRepository) || repo.adapter !== args.store.db) {
    throw new Error(
      'A2A outbound needs the workflow repository and the A2A store on one SQLite connection',
    );
  }
  return { store: args.store, workflow: args.workflow, repository: repo, nowMs: args.nowMs ?? Date.now };
}

let installed: { store: A2AStore; nowMs: () => number } | null = null;
let paired: { service: WorkflowService; runtime: A2ARuntime } | null = null;

/** Install A2A on this host (the server), or remove it (`null`). */
export function installA2A(args: { store: A2AStore; nowMs?: () => number } | null): void {
  installed = args === null ? null : { store: args.store, nowMs: args.nowMs ?? Date.now };
  paired = null;
}

/** The installed A2A store, or null where A2A is not installed (the phone). */
export function getA2AStore(): A2AStore | null {
  return installed?.store ?? null;
}

/**
 * The runtime over the installed store and the CURRENT workflow service.
 * Null when A2A is not installed or no service is set. THROWS when the
 * service's repository is not on the store's connection: that is a wiring
 * fault, and A2A writes must never be split across two commits. Hosts call
 * this once after their final service is in place, so the fault stops boot.
 */
export function getA2ARuntime(): A2ARuntime | null {
  if (installed === null) return null;
  const service = getWorkflowService();
  if (service === null) return null;
  if (paired !== null && paired.service === service) return paired.runtime;
  paired = null;
  const runtime = createA2ARuntime({ store: installed.store, workflow: service, nowMs: installed.nowMs });
  paired = { service, runtime };
  return runtime;
}
