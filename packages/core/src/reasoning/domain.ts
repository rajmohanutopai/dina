/**
 * Shared connected-Brain contracts.
 *
 * These types are deliberately transport- and runtime-neutral. Core is the
 * authority; a model backend receives only a claimed reasoning proposal and
 * can never turn its result directly into an external effect.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalJson } from '@dina/protocol';

import { parseAuthorityOrigin, type AuthorityOrigin } from '../agent/gating_policy';

export const REASONING_BACKEND_KINDS = [
  'connected_host',
  'internal_brain',
  'local_model',
  'remote_provider',
] as const;
export type ReasoningBackendKind = (typeof REASONING_BACKEND_KINDS)[number];

export const REASONING_TASK_KINDS = [
  'answer.compose',
  'memory.structure',
  'intent.route',
  'service.respond',
  'review.summarize',
  'reminder.extract',
] as const;
export type ReasoningTaskKind = (typeof REASONING_TASK_KINDS)[number];

export const REASONING_SENSITIVITIES = ['public', 'personal', 'sensitive'] as const;
export type ReasoningSensitivity = (typeof REASONING_SENSITIVITIES)[number];

export const REASONING_AVAILABILITIES = ['foreground', 'always_on'] as const;
export type ReasoningAvailability = (typeof REASONING_AVAILABILITIES)[number];

export const REASONING_EVIDENCE_POLICIES = ['none', 'optional', 'required'] as const;
export type ReasoningEvidencePolicy = (typeof REASONING_EVIDENCE_POLICIES)[number];

const SENSITIVITY_RANK: Readonly<Record<ReasoningSensitivity, number>> = {
  public: 0,
  personal: 1,
  sensitive: 2,
};

export function sensitivityAllows(
  ceiling: ReasoningSensitivity,
  requested: ReasoningSensitivity,
): boolean {
  return SENSITIVITY_RANK[ceiling] >= SENSITIVITY_RANK[requested];
}

export interface ReasoningBackendBinding {
  backendId: string;
  kind: ReasoningBackendKind;
  principalDid: string;
  allowedTaskKinds: ReasoningTaskKind[];
  maxSensitivity: ReasoningSensitivity;
  availability: ReasoningAvailability;
  modelClass?: string;
  policyVersion: number;
  selectedByOwnerDid: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
}

/**
 * Durable reference to mutable authority outside the reasoning subsystem.
 * It remains Core-only and is never returned in a backend claim.
 */
export interface ReasoningServiceAuthorityPolicyRef {
  kind: 'service';
  serviceRkey: string;
  /** True when the authenticated request selected this listing by service_uri. */
  targeted: boolean;
  capability: string;
  requesterDid: string;
  grantId: string | null;
}

export type ReasoningAuthorityPolicyRef = ReasoningServiceAuthorityPolicyRef;

export interface ReasoningTaskEnvelopeV1 {
  version: 1;
  taskId: string;
  taskKind: ReasoningTaskKind;
  ownerDid: string;
  authorityOrigin: AuthorityOrigin;
  authorityPolicyRef: ReasoningAuthorityPolicyRef | null;
  backendBindingId: string | null;
  requestSchemaId: string;
  resultSchemaId: string;
  policySnapshotHash: string;
  inputProjectionId: string;
  inputProjectionHash: string;
  contextProjectionId: string | null;
  contextProjectionHash: string | null;
  sensitivity: ReasoningSensitivity;
  evidencePolicy: ReasoningEvidencePolicy;
  allowedEvidenceIdsHash: string | null;
  /**
   * Hash of the caller-controlled logical request, excluding generated ids,
   * timestamps, and retry scheduling. This keeps an idempotency key meaningful
   * after the short-lived input/context projections have been purged.
   */
  requestFingerprint: string;
  purpose: string;
  executionId: string;
  idempotencyKey: string;
  createdAtMs: number;
  deadlineAtMs: number;
  maxAttempts: number;
}

export interface ModelContextItem {
  sourceId: string;
  sourceType: 'memory' | 'review' | 'service' | 'relationship' | 'reminder';
  text: string;
  confidence?: number;
  occurredAtMs?: number;
}

export interface ModelContextProjection {
  projectionId: string;
  purpose: string;
  items: ModelContextItem[];
  scrubbed: boolean;
  sensitivity: ReasoningSensitivity;
  expiresAtMs: number;
}

export interface ReasoningClaim {
  taskId: string;
  claimId: string;
  contextTicketId: string;
  leaseExpiresAtMs: number;
  taskKind: ReasoningTaskKind;
  purpose: string;
  authorityOrigin: AuthorityOrigin;
  input: unknown;
  context: ModelContextProjection | null;
  allowedEvidenceIds: string[];
  resultSchema: unknown;
  resultSchemaId: string;
  executionId: string;
  contextProjectionHash: string | null;
  policySnapshotHash: string;
}

export function isReasoningTaskKind(value: unknown): value is ReasoningTaskKind {
  return typeof value === 'string' && (REASONING_TASK_KINDS as readonly string[]).includes(value);
}

export function isReasoningBackendKind(value: unknown): value is ReasoningBackendKind {
  return (
    typeof value === 'string' && (REASONING_BACKEND_KINDS as readonly string[]).includes(value)
  );
}

export function isReasoningSensitivity(value: unknown): value is ReasoningSensitivity {
  return (
    typeof value === 'string' && (REASONING_SENSITIVITIES as readonly string[]).includes(value)
  );
}

export function isReasoningAvailability(value: unknown): value is ReasoningAvailability {
  return (
    typeof value === 'string' && (REASONING_AVAILABILITIES as readonly string[]).includes(value)
  );
}

export function isReasoningEvidencePolicy(value: unknown): value is ReasoningEvidencePolicy {
  return (
    typeof value === 'string' && (REASONING_EVIDENCE_POLICIES as readonly string[]).includes(value)
  );
}

const OPAQUE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DID_RE = /^did:[^:\s]+:\S+$/;

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID_RE.test(value);
}

function validDid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && DID_RE.test(value);
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseAuthorityPolicyRef(value: unknown): ReasoningAuthorityPolicyRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  if (
    ref.kind !== 'service' ||
    typeof ref.serviceRkey !== 'string' ||
    ref.serviceRkey.length < 1 ||
    ref.serviceRkey.length > 512 ||
    hasControlCharacter(ref.serviceRkey) ||
    typeof ref.targeted !== 'boolean' ||
    typeof ref.capability !== 'string' ||
    ref.capability.length < 1 ||
    ref.capability.length > 512 ||
    hasControlCharacter(ref.capability) ||
    !validDid(ref.requesterDid) ||
    !(
      ref.grantId === null ||
      (typeof ref.grantId === 'string' &&
        ref.grantId.length > 0 &&
        ref.grantId.length <= 512 &&
        !hasControlCharacter(ref.grantId))
    )
  ) {
    return null;
  }
  return {
    kind: 'service',
    serviceRkey: ref.serviceRkey,
    targeted: ref.targeted,
    capability: ref.capability,
    requesterDid: ref.requesterDid,
    grantId: ref.grantId,
  };
}

export function parseModelContextProjection(value: unknown): ModelContextProjection | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (
    !validOpaqueId(obj.projectionId) ||
    typeof obj.purpose !== 'string' ||
    obj.purpose.length < 1 ||
    obj.purpose.length > 512 ||
    !Array.isArray(obj.items) ||
    obj.items.length > 256 ||
    typeof obj.scrubbed !== 'boolean' ||
    !isReasoningSensitivity(obj.sensitivity) ||
    typeof obj.expiresAtMs !== 'number' ||
    !Number.isSafeInteger(obj.expiresAtMs) ||
    obj.expiresAtMs < 0
  ) {
    return null;
  }
  const items: ModelContextItem[] = [];
  for (const raw of obj.items) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (
      !validOpaqueId(item.sourceId) ||
      (item.sourceType !== 'memory' &&
        item.sourceType !== 'review' &&
        item.sourceType !== 'service' &&
        item.sourceType !== 'relationship' &&
        item.sourceType !== 'reminder') ||
      typeof item.text !== 'string' ||
      item.text.length < 1 ||
      item.text.length > 16_384 ||
      (item.confidence !== undefined &&
        (typeof item.confidence !== 'number' ||
          !Number.isFinite(item.confidence) ||
          item.confidence < 0 ||
          item.confidence > 1)) ||
      (item.occurredAtMs !== undefined &&
        (typeof item.occurredAtMs !== 'number' ||
          !Number.isSafeInteger(item.occurredAtMs) ||
          item.occurredAtMs < 0))
    ) {
      return null;
    }
    items.push({
      sourceId: item.sourceId,
      sourceType: item.sourceType,
      text: item.text,
      ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
      ...(typeof item.occurredAtMs === 'number' ? { occurredAtMs: item.occurredAtMs } : {}),
    });
  }
  return {
    projectionId: obj.projectionId,
    purpose: obj.purpose,
    items,
    scrubbed: obj.scrubbed,
    sensitivity: obj.sensitivity,
    expiresAtMs: obj.expiresAtMs,
  };
}

/** Strict parser used at every durable and wire boundary. */
export function parseReasoningEnvelope(raw: string | unknown): ReasoningTaskEnvelopeV1 | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const authorityOrigin = parseAuthorityOrigin(obj.authorityOrigin);
  const authorityPolicyRef = parseAuthorityPolicyRef(obj.authorityPolicyRef);
  if (
    obj.version !== 1 ||
    !validOpaqueId(obj.taskId) ||
    !isReasoningTaskKind(obj.taskKind) ||
    !validDid(obj.ownerDid) ||
    authorityOrigin === null ||
    !(
      obj.authorityPolicyRef === null ||
      (authorityPolicyRef !== null &&
        authorityOrigin.kind === 'service_request' &&
        authorityOrigin.requesterDid === authorityPolicyRef.requesterDid)
    ) ||
    (obj.backendBindingId !== null && !validOpaqueId(obj.backendBindingId)) ||
    !validOpaqueId(obj.requestSchemaId) ||
    !validOpaqueId(obj.resultSchemaId) ||
    !validHash(obj.policySnapshotHash) ||
    !validOpaqueId(obj.inputProjectionId) ||
    !validHash(obj.inputProjectionHash) ||
    (obj.contextProjectionId !== null && !validOpaqueId(obj.contextProjectionId)) ||
    (obj.contextProjectionHash !== null && !validHash(obj.contextProjectionHash)) ||
    (obj.contextProjectionId === null) !== (obj.contextProjectionHash === null) ||
    !isReasoningSensitivity(obj.sensitivity) ||
    !isReasoningEvidencePolicy(obj.evidencePolicy) ||
    (obj.allowedEvidenceIdsHash !== null && !validHash(obj.allowedEvidenceIdsHash)) ||
    !validHash(obj.requestFingerprint) ||
    typeof obj.purpose !== 'string' ||
    obj.purpose.length < 1 ||
    obj.purpose.length > 512 ||
    !validOpaqueId(obj.executionId) ||
    !validOpaqueId(obj.idempotencyKey) ||
    typeof obj.createdAtMs !== 'number' ||
    !Number.isSafeInteger(obj.createdAtMs) ||
    obj.createdAtMs < 0 ||
    typeof obj.deadlineAtMs !== 'number' ||
    !Number.isSafeInteger(obj.deadlineAtMs) ||
    obj.deadlineAtMs <= obj.createdAtMs ||
    typeof obj.maxAttempts !== 'number' ||
    !Number.isSafeInteger(obj.maxAttempts) ||
    obj.maxAttempts < 1 ||
    obj.maxAttempts > 20
  ) {
    return null;
  }
  return {
    version: 1,
    taskId: obj.taskId,
    taskKind: obj.taskKind,
    ownerDid: obj.ownerDid,
    authorityOrigin,
    authorityPolicyRef,
    backendBindingId: obj.backendBindingId,
    requestSchemaId: obj.requestSchemaId,
    resultSchemaId: obj.resultSchemaId,
    policySnapshotHash: obj.policySnapshotHash,
    inputProjectionId: obj.inputProjectionId,
    inputProjectionHash: obj.inputProjectionHash,
    contextProjectionId: obj.contextProjectionId,
    contextProjectionHash: obj.contextProjectionHash,
    sensitivity: obj.sensitivity,
    evidencePolicy: obj.evidencePolicy,
    allowedEvidenceIdsHash: obj.allowedEvidenceIdsHash,
    requestFingerprint: obj.requestFingerprint,
    purpose: obj.purpose,
    executionId: obj.executionId,
    idempotencyKey: obj.idempotencyKey,
    createdAtMs: obj.createdAtMs,
    deadlineAtMs: obj.deadlineAtMs,
    maxAttempts: obj.maxAttempts,
  };
}

export function reasoningHash(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))));
}

export function reasoningRunner(backendId: string): string {
  return `reasoning:${backendId}`;
}

export function isReasoningRunner(value: string): boolean {
  return value.startsWith('reasoning:') && value.length > 'reasoning:'.length;
}
