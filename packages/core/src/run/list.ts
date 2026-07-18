/**
 * Run display DTO + the `RunRecord → RunListItem` mapping (ISVC-9). Shared by
 * any owner surface that lists interactive runs (the mobile run-management
 * screen) so the display shape lives in ONE place and the full `RunRecord`
 * (config, crypto fields) never leaks to the UI.
 */

import { isRunTerminal, type RunRecord, type RunState } from './domain';

export interface RunListItem {
  run_id: string;
  service_uri: string;
  provider_did: string;
  persona: string;
  transport: string;
  state: RunState;
  /** True for completed/stopped/expired — steer controls are hidden. */
  terminal: boolean;
  /** Payloads produced so far (pull pacing). */
  produced_count: number;
  /** Configured cap, or null for unbounded. */
  max_count: number | null;
  /** Hard TTL (ms). */
  expires_at: number;
}

export function runToListItem(run: RunRecord): RunListItem {
  return {
    run_id: run.run_id,
    service_uri: run.service_uri,
    provider_did: run.provider_did,
    persona: run.persona,
    transport: run.transport,
    state: run.state,
    terminal: isRunTerminal(run.state),
    produced_count: run.produced_count,
    max_count: run.max_count,
    expires_at: run.expires_at,
  };
}
