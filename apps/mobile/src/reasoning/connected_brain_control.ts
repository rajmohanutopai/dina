import { reasoningHash } from '@dina/core';

import type {
  OwnerReasoningBackendView,
  OwnerReasoningClient,
  ReasoningTaskKind,
} from '@dina/core';

export const CONNECTED_BRAIN_TASK_KINDS: readonly ReasoningTaskKind[] = [
  'answer.compose',
  'memory.structure',
  'intent.route',
  'service.respond',
  'review.summarize',
  'reminder.extract',
];

export interface ConnectedBrainDevice {
  deviceId: string;
  did: string;
}

export type ConnectedBrainOwnerClient = Pick<
  OwnerReasoningClient,
  'reasoningBackends' | 'reasoningRegisterBackend' | 'reasoningRevokeBackend'
>;

export function connectedBrainBackendId(deviceId: string): string {
  const normalized = deviceId.trim();
  if (normalized.length === 0) throw new Error('Agent has no usable device identifier.');
  return `connected.${reasoningHash({ deviceId: normalized })}`;
}

export function activeConnectedBrainForPrincipal(
  backends: readonly OwnerReasoningBackendView[],
  principalDid: string,
  nowMs: number = Date.now(),
): OwnerReasoningBackendView | null {
  return (
    backends.find(
      (backend) =>
        backend.kind === 'connected_host' &&
        backend.principal_did === principalDid &&
        backend.enabled &&
        backend.revoked_at === null &&
        (backend.expires_at === null || backend.expires_at > nowMs),
    ) ?? null
  );
}

export async function enableConnectedBrain(
  client: ConnectedBrainOwnerClient,
  device: ConnectedBrainDevice,
): Promise<OwnerReasoningBackendView> {
  const { backends } = await client.reasoningBackends();
  const active = activeConnectedBrainForPrincipal(backends, device.did);
  if (active !== null) return active;

  const generatedBackendId = connectedBrainBackendId(device.deviceId);
  const existing =
    backends.find((backend) => backend.backend_id === generatedBackendId) ??
    backends.find(
      (backend) => backend.kind === 'connected_host' && backend.principal_did === device.did,
    ) ??
    null;
  const backendId = existing?.backend_id ?? generatedBackendId;
  return client.reasoningRegisterBackend({
    backend_id: backendId,
    kind: 'connected_host',
    principal_did: device.did,
    allowed_task_kinds: [...CONNECTED_BRAIN_TASK_KINDS],
    max_sensitivity: 'sensitive',
    availability: 'foreground',
    model_class: 'connected-host',
    expires_at: null,
    expected_version: existing?.policy_version ?? null,
  });
}

export async function disableConnectedBrain(
  client: ConnectedBrainOwnerClient,
  principalDid: string,
): Promise<number> {
  const { backends } = await client.reasoningBackends();
  const active = backends.filter(
    (backend) =>
      backend.kind === 'connected_host' &&
      backend.principal_did === principalDid &&
      backend.enabled &&
      backend.revoked_at === null,
  );
  if (active.length === 0) return 0;

  // The owner revoke route cascades to every binding for this principal.
  // Calling it once avoids replaying stale policy versions after that cascade.
  const first = active[0];
  await client.reasoningRevokeBackend(first.backend_id, first.policy_version);
  return active.length;
}
