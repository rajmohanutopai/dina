/**
 * Server-owned policy for connected-agent tool gating.
 *
 * A host may report a tool call, but it never chooses either the policy or the
 * authority origin under which Core evaluates that call. Both are durable Core
 * state. This module is deliberately React-Native-safe and contains no Node or
 * filesystem imports so mobile and Home Node use exactly the same contract.
 */

export const GATING_PROFILES = [
  'network_protection',
  'sensitive_boundaries',
  'full_supervision',
] as const;

export type AgentGatingProfile = (typeof GATING_PROFILES)[number];

const PROFILE_RANK: Readonly<Record<AgentGatingProfile, number>> = {
  network_protection: 0,
  sensitive_boundaries: 1,
  full_supervision: 2,
};

export const AUTHORITY_ORIGIN_KINDS = [
  'owner_interactive',
  'contact_request',
  'service_request',
  'delegated_task',
  'background_job',
  'system_maintenance',
  'unknown',
] as const;

export type AuthorityOriginKind = (typeof AUTHORITY_ORIGIN_KINDS)[number];

export const AUTHORITY_INGRESS_VALUES = [
  'coding_host',
  'host_hook',
  'mcp',
  'mobile',
  'web',
  'cli',
  'service',
  'd2d',
  'workflow',
  'scheduler',
  'internal',
  'system',
  'unknown',
] as const;

export type AuthorityIngress = (typeof AUTHORITY_INGRESS_VALUES)[number];

/**
 * Immutable provenance attached by Core to a session or durable task.
 *
 * `requesterDid` is intentionally optional: local/background work may not have
 * a remote requester. An absent requester never upgrades an origin to owner.
 */
export interface AuthorityOrigin {
  kind: AuthorityOriginKind;
  ownerDid: string;
  requesterDid?: string;
  ingress: AuthorityIngress;
  correlationId: string;
  authenticatedAtMs: number;
  /** Optional hash of the authenticated envelope that established the origin. */
  evidenceHash?: string;
}

export interface AgentGatingPolicy {
  agentDid: string;
  profile: AgentGatingProfile;
  policyVersion: number;
  selectedByOwnerDid: string;
  createdAtMs: number;
  updatedAtMs: number;
  revokedAtMs: number | null;
}

export interface SetAgentGatingPolicyInput {
  agentDid: string;
  profile: AgentGatingProfile;
  selectedByOwnerDid: string;
  /** Required when replacing an existing row; null creates only if absent. */
  expectedVersion: number | null;
  nowMs?: number;
}

export class AgentGatingPolicyConflictError extends Error {
  constructor() {
    super('agent gating policy version conflict');
    this.name = 'AgentGatingPolicyConflictError';
  }
}

export interface AgentGatingPolicyRepository {
  get(agentDid: string): AgentGatingPolicy | null;
  list(): AgentGatingPolicy[];
  set(input: SetAgentGatingPolicyInput): AgentGatingPolicy;
  revoke(agentDid: string, expectedVersion: number, ownerDid: string, nowMs?: number): boolean;
}

export function isAgentGatingProfile(value: unknown): value is AgentGatingProfile {
  return typeof value === 'string' && (GATING_PROFILES as readonly string[]).includes(value);
}

export function isOwnerAuthority(origin: AuthorityOrigin): boolean {
  return origin.kind === 'owner_interactive';
}

/**
 * Resolve the effective profile with a monotonic safety floor.
 *
 * Unknown provenance is non-owner provenance. No configured profile can relax
 * work initiated by another person, a service, a delegated/background task, or
 * an origin Core cannot prove.
 */
export function resolveEffectiveGatingProfile(
  configured: AgentGatingProfile,
  origin: AuthorityOrigin,
): AgentGatingProfile {
  return isOwnerAuthority(origin) ? configured : 'full_supervision';
}

export function stricterGatingProfile(
  left: AgentGatingProfile,
  right: AgentGatingProfile,
): AgentGatingProfile {
  return PROFILE_RANK[left] >= PROFILE_RANK[right] ? left : right;
}

const DID_MAX = 512;
const CORRELATION_MAX = 256;

function validDid(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('did:') && value.length <= DID_MAX;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= CORRELATION_MAX;
}

/** Strict parser for persisted/task-supplied authority metadata. */
export function parseAuthorityOrigin(value: unknown): AuthorityOrigin | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.kind !== 'string' ||
    !(AUTHORITY_ORIGIN_KINDS as readonly string[]).includes(raw.kind) ||
    !validDid(raw.ownerDid) ||
    typeof raw.ingress !== 'string' ||
    !(AUTHORITY_INGRESS_VALUES as readonly string[]).includes(raw.ingress) ||
    !validOpaqueId(raw.correlationId) ||
    typeof raw.authenticatedAtMs !== 'number' ||
    !Number.isSafeInteger(raw.authenticatedAtMs) ||
    raw.authenticatedAtMs < 0
  ) {
    return null;
  }
  if (raw.requesterDid !== undefined && !validDid(raw.requesterDid)) return null;
  if (
    raw.kind === 'owner_interactive' &&
    typeof raw.requesterDid === 'string' &&
    raw.requesterDid !== raw.ownerDid
  ) {
    return null;
  }
  if (
    raw.evidenceHash !== undefined &&
    (typeof raw.evidenceHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.evidenceHash))
  ) {
    return null;
  }
  return {
    kind: raw.kind as AuthorityOriginKind,
    ownerDid: raw.ownerDid,
    ...(typeof raw.requesterDid === 'string' ? { requesterDid: raw.requesterDid } : {}),
    ingress: raw.ingress as AuthorityIngress,
    correlationId: raw.correlationId,
    authenticatedAtMs: raw.authenticatedAtMs,
    ...(typeof raw.evidenceHash === 'string' ? { evidenceHash: raw.evidenceHash } : {}),
  };
}

export function makeUnknownAuthorityOrigin(params: {
  ownerDid: string;
  correlationId: string;
  authenticatedAtMs?: number;
  ingress?: AuthorityIngress;
}): AuthorityOrigin {
  return {
    kind: 'unknown',
    ownerDid: params.ownerDid,
    ingress: params.ingress ?? 'unknown',
    correlationId: params.correlationId,
    authenticatedAtMs: params.authenticatedAtMs ?? Date.now(),
  };
}

let repository: AgentGatingPolicyRepository | null = null;

export function setAgentGatingPolicyRepository(next: AgentGatingPolicyRepository | null): void {
  repository = next;
}

export function getAgentGatingPolicyRepository(): AgentGatingPolicyRepository | null {
  return repository;
}

/**
 * Missing policy preserves the legacy behavior: Full Supervision.
 *
 * The returned policy is synthetic only for evaluation. Owner UI must use the
 * repository directly so it can distinguish "not configured" from an explicit
 * Full Supervision selection.
 */
export function resolveConfiguredGatingProfile(agentDid: string): {
  profile: AgentGatingProfile;
  policyVersion: number;
  policy: AgentGatingPolicy | null;
} {
  const policy = repository?.get(agentDid) ?? null;
  if (policy === null || policy.revokedAtMs !== null) {
    return { profile: 'full_supervision', policyVersion: 0, policy: null };
  }
  return { profile: policy.profile, policyVersion: policy.policyVersion, policy };
}
