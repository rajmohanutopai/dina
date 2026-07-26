/**
 * Core-owned default selection for reasoning backends.
 *
 * Callers may request an explicit owner-authorized backend, but convenience
 * clients must not reproduce routing policy in UI code. Selection happens only
 * after Core has derived the request's actual sensitivity.
 */

import {
  sensitivityAllows,
  type ReasoningBackendBinding,
  type ReasoningBackendKind,
  type ReasoningSensitivity,
  type ReasoningTaskKind,
} from './domain';

const KIND_PRIORITY: Readonly<Record<ReasoningBackendKind, number>> = {
  connected_host: 0,
  local_model: 1,
  internal_brain: 2,
  remote_provider: 3,
};

export interface SelectReasoningBackendInput {
  ownerDid: string;
  taskKind: ReasoningTaskKind;
  sensitivity: ReasoningSensitivity;
  nowMs?: number;
  isRuntimeAvailable?: (binding: ReasoningBackendBinding) => boolean;
}

export function selectReasoningBackend(
  bindings: readonly ReasoningBackendBinding[],
  input: SelectReasoningBackendInput,
): ReasoningBackendBinding | null {
  const nowMs = input.nowMs ?? Date.now();
  return (
    bindings
      .filter(
        (binding) =>
          binding.selectedByOwnerDid === input.ownerDid &&
          binding.enabled &&
          binding.revokedAtMs === null &&
          (binding.expiresAtMs === null || binding.expiresAtMs > nowMs) &&
          binding.allowedTaskKinds.includes(input.taskKind) &&
          sensitivityAllows(binding.maxSensitivity, input.sensitivity) &&
          (input.isRuntimeAvailable?.(binding) ?? true),
      )
      .sort((left, right) => {
        const priority = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
        if (priority !== 0) return priority;
        const freshness = right.updatedAtMs - left.updatedAtMs;
        if (freshness !== 0) return freshness;
        return left.backendId.localeCompare(right.backendId);
      })[0] ?? null
  );
}
