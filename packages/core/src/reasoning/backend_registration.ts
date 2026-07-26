/**
 * Conservative boot-time provisioning for a built-in reasoning backend.
 *
 * Runtime boot is not an owner-consent surface. It may create a backend that
 * has never existed, but it must never revive, update, or silently replace an
 * existing binding. Explicit owner routes remain the only reconfiguration
 * path after first creation.
 */

import {
  ReasoningBackendConflictError,
  type ReasoningBackendRepository,
  type RegisterReasoningBackendInput,
} from './backend_repository';

import type { ReasoningBackendBinding } from './domain';

type BootBackendInput = Omit<
  RegisterReasoningBackendInput,
  'expectedVersion' | 'nowMs' | 'expiresAtMs'
> & {
  nowMs?: number;
};

export type EnsureReasoningBackendResult =
  | { status: 'created' | 'ready'; binding: ReasoningBackendBinding }
  | {
      status: 'disabled' | 'expired' | 'conflict';
      binding: ReasoningBackendBinding;
      reason: string;
    };

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

function classifyExisting(
  binding: ReasoningBackendBinding,
  input: BootBackendInput,
  nowMs: number,
): EnsureReasoningBackendResult {
  if (!binding.enabled || binding.revokedAtMs !== null) {
    return {
      status: 'disabled',
      binding,
      reason: 'existing backend was disabled or revoked by policy',
    };
  }
  if (binding.expiresAtMs !== null && binding.expiresAtMs <= nowMs) {
    return {
      status: 'expired',
      binding,
      reason: 'existing backend authorization has expired',
    };
  }
  const compatible =
    binding.kind === input.kind &&
    binding.principalDid === input.principalDid &&
    sameSet(binding.allowedTaskKinds, input.allowedTaskKinds) &&
    binding.maxSensitivity === input.maxSensitivity &&
    binding.availability === input.availability &&
    (binding.modelClass ?? null) === (input.modelClass ?? null) &&
    binding.selectedByOwnerDid === input.selectedByOwnerDid;
  if (!compatible) {
    return {
      status: 'conflict',
      binding,
      reason: 'existing backend policy differs from the boot configuration',
    };
  }
  return { status: 'ready', binding };
}

export function ensureReasoningBackendForBoot(
  repository: ReasoningBackendRepository,
  input: BootBackendInput,
): EnsureReasoningBackendResult {
  const nowMs = input.nowMs ?? Date.now();
  const existing = repository.get(input.backendId);
  if (existing !== null) return classifyExisting(existing, input, nowMs);

  try {
    const binding = repository.register({
      ...input,
      expectedVersion: null,
      expiresAtMs: null,
      nowMs,
    });
    return { status: 'created', binding };
  } catch (error) {
    // Concurrent boot can win the create race. Re-read and classify the row;
    // never turn the race into an update.
    if (error instanceof ReasoningBackendConflictError) {
      const raced = repository.get(input.backendId);
      if (raced !== null) return classifyExisting(raced, input, nowMs);
    }
    throw error;
  }
}
