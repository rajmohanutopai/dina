/**
 * Optional provider-side reasoning executor for inbound Dina services.
 *
 * The existing service workflow remains authoritative. This adapter is only a
 * second execution strategy for instruction-backed, read/quote capabilities:
 * it selects an owner-authorized live reasoning backend, projects one
 * listing-selected safe vault, and submits a `service.respond` proposal.
 * Returning `null` means "use the existing Tier-1/agent runner".
 */

import {
  MAX_SERVICE_TTL,
  effectiveDiscoverability,
  effectiveListingStatus,
  effectiveSurface,
  isListingPublic,
  isListingPublishable,
  parseServiceListingUri,
  resolveSearchableCapability,
} from '@dina/protocol';

import { prepareServiceReasoningContext } from '../agent/connected_brain_facades';
import {
  DEFAULT_LISTING_RKEY,
  configuredCapabilityKey,
  getServiceConfig,
} from '../service/service_config';
import {
  getServiceGrantRepository,
  type ServiceGrantRepository,
} from '../service/service_grant_repository';
import { getSessionRegistry } from '../session/registry';

import { isReasoningBackendPresent } from './backend_presence';
import {
  getReasoningBackendRepository,
  type ReasoningBackendRepository,
} from './backend_repository';
import { selectReasoningBackend } from './backend_selection';
import {
  deriveReasoningPolicySnapshotHash,
  getReasoningBroker,
  type CoreReasoningBroker,
  type ReasoningPolicySnapshotInput,
  ReasoningCommitReceipt,
} from './broker';
import {
  reasoningHash,
  type ReasoningBackendBinding,
  type ReasoningServiceAuthorityPolicyRef,
} from './domain';

import type { ReasoningServiceCommitInput } from './commit_bridge';
import type { AuthorityOrigin } from '../agent/gating_policy';
import type { WorkflowService } from '../workflow/service';
import type { ServiceConfig } from '@dina/protocol';

const MAX_SERVICE_CONTEXT_ITEMS = 20;
const MAX_CONTEXT_QUERY_CHARS = 8_192;

export interface ServiceReasoningSubmissionInput {
  requesterDid: string;
  queryId: string;
  capabilityId: string;
  params: Record<string, unknown>;
  instructions: string;
  serviceName: string;
  serviceUri?: string;
  grantId?: string;
  ttlSeconds: number;
  responseSchema: Record<string, unknown>;
  responseSchemaHash?: string;
  vaultPersona: string;
  operatorApproved: boolean;
}

export interface ServiceReasoningSubmission {
  taskId: string;
  backendId: string;
  deduplicated: boolean;
}

export type ServiceReasoningSubmitter = (
  input: ServiceReasoningSubmissionInput,
) => Promise<ServiceReasoningSubmission | null>;

export interface CreateServiceReasoningSubmitterOptions {
  /** Core-derived provider identity. Never accepted from the D2D query. */
  ownerDid: string;
  getBroker?: () => CoreReasoningBroker | null;
  getBackendRepository?: () => ReasoningBackendRepository | null;
  nowMs?: () => number;
  isRuntimeAvailable?: (
    binding: ReasoningBackendBinding,
    origin: AuthorityOrigin,
    nowMs: number,
  ) => boolean;
}

function contextQuery(input: ServiceReasoningSubmissionInput): string {
  let params = '';
  try {
    params = JSON.stringify(input.params);
  } catch {
    return input.capabilityId;
  }
  // FTS receives plain tokens rather than JSON punctuation/operators.
  return `${input.capabilityId} ${input.instructions} ${params}`
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CONTEXT_QUERY_CHARS);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validInput(input: ServiceReasoningSubmissionInput): boolean {
  return (
    /^did:[^:\s]+:\S+$/.test(input.requesterDid) &&
    input.queryId.length > 0 &&
    input.queryId.length <= 256 &&
    input.capabilityId.length > 0 &&
    input.capabilityId.length <= 256 &&
    input.instructions.trim() !== '' &&
    input.instructions.length <= 16_384 &&
    input.serviceName.length <= 512 &&
    (input.serviceUri === undefined ||
      (input.serviceUri.length > 0 && input.serviceUri.length <= 1_024)) &&
    (input.grantId === undefined ||
      (input.grantId.length > 0 &&
        input.grantId.length <= 512 &&
        !hasControlCharacter(input.grantId))) &&
    Number.isSafeInteger(input.ttlSeconds) &&
    input.ttlSeconds > 0 &&
    input.ttlSeconds <= MAX_SERVICE_TTL &&
    input.params !== null &&
    typeof input.params === 'object' &&
    !Array.isArray(input.params) &&
    input.responseSchema !== null &&
    typeof input.responseSchema === 'object' &&
    !Array.isArray(input.responseSchema)
  );
}

function serviceAuthorityRef(
  input: ServiceReasoningSubmissionInput,
  ownerDid: string,
): ReasoningServiceAuthorityPolicyRef | null {
  const targeted = input.serviceUri !== undefined && input.serviceUri !== '';
  const listing = targeted ? parseServiceListingUri(input.serviceUri ?? '') : null;
  if (targeted && (listing === null || listing.did !== ownerDid)) return null;
  return {
    kind: 'service',
    serviceRkey: listing?.rkey ?? DEFAULT_LISTING_RKEY,
    targeted,
    capability: input.capabilityId,
    requesterDid: input.requesterDid,
    grantId: input.grantId ?? null,
  };
}

export interface CreateReasoningPolicySnapshotResolverOptions {
  nowMs?: () => number;
  readServiceConfig?: (rkey: string) => ServiceConfig | null;
  getGrantRepository?: () => Pick<ServiceGrantRepository, 'getById' | 'isAuthorized'> | null;
}

/**
 * Resolve the immutable reasoning contract plus the mutable Core authority
 * that admitted it. An empty string means the authority is not currently
 * executable: submit rejects it and completion/recovery treats it as stale.
 */
export function createReasoningPolicySnapshotResolver(
  options: CreateReasoningPolicySnapshotResolverOptions = {},
): (input: ReasoningPolicySnapshotInput) => string {
  const nowMs = options.nowMs ?? Date.now;
  const readServiceConfig = options.readServiceConfig ?? getServiceConfig;
  const grantRepositoryFor = options.getGrantRepository ?? getServiceGrantRepository;

  return ({ envelope }) => {
    const basePolicyHash = deriveReasoningPolicySnapshotHash(envelope);
    const ref = envelope.authorityPolicyRef;
    if (ref === null) return basePolicyHash;

    const config = readServiceConfig(ref.serviceRkey);
    if (config === null) return '';
    const capabilityKey = configuredCapabilityKey(config, ref.capability);
    if (capabilityKey === null) return '';

    const status = effectiveListingStatus(config);
    const discoverability = effectiveDiscoverability(config);
    const surface = effectiveSurface(config);
    const requiresGrant = discoverability === 'known_only';
    const listingExecutable = requiresGrant
      ? status === 'active' && ref.targeted
      : ref.targeted
        ? isListingPublishable(config)
        : isListingPublic(config);
    if (!listingExecutable) return '';

    let grantSnapshot: Record<string, unknown> | null = null;
    if (requiresGrant) {
      if (ref.grantId === null) return '';
      const repository = grantRepositoryFor();
      const grantCapability = resolveSearchableCapability(ref.capability) ?? ref.capability;
      const grant = repository?.getById(ref.grantId) ?? null;
      const nowSec = Math.floor(nowMs() / 1_000);
      if (
        grant === null ||
        grant.grantId !== ref.grantId ||
        grant.granteeDid !== ref.requesterDid ||
        grant.serviceRkey !== ref.serviceRkey ||
        grant.capability !== grantCapability ||
        repository?.isAuthorized({
          granteeDid: ref.requesterDid,
          serviceRkey: ref.serviceRkey,
          capability: grantCapability,
          grantId: ref.grantId,
          nowSec,
        }) !== true
      ) {
        return '';
      }
      grantSnapshot = {
        grantId: grant.grantId,
        granteeDid: grant.granteeDid,
        serviceRkey: grant.serviceRkey,
        capability: grant.capability,
        grantType: grant.grantType,
        constraints: grant.constraints ?? null,
        expiresAt: grant.expiresAt ?? null,
        revokedAt: grant.revokedAt ?? null,
        createdAt: grant.createdAt,
      };
    }

    return reasoningHash({
      basePolicyHash,
      serviceAuthority: {
        serviceRkey: ref.serviceRkey,
        targeted: ref.targeted,
        capability: ref.capability,
        capabilityKey,
        requesterDid: ref.requesterDid,
        status,
        discoverability,
        surface,
        vaultPersona: config.vaultPersona ?? null,
        capabilityConfig: config.capabilities[capabilityKey] ?? null,
        capabilitySchema: config.capabilitySchemas?.[capabilityKey] ?? null,
        requiresGrant,
        grant: grantSnapshot,
      },
    });
  };
}

/**
 * Build the callback injected into the shared ServiceHandler.
 *
 * Absence, revocation, an offline foreground host, a disallowed vault, or a
 * queue race all return `null`; the established service executor remains the
 * availability fallback. Invalid programmer input throws because falling back
 * with an unvalidated contract would hide a composition bug.
 */
export function createServiceReasoningSubmitter(
  options: CreateServiceReasoningSubmitterOptions,
): ServiceReasoningSubmitter {
  if (!/^did:[^:\s]+:\S+$/.test(options.ownerDid)) {
    throw new Error('invalid service reasoning owner DID');
  }
  const brokerFor = options.getBroker ?? getReasoningBroker;
  const repositoryFor = options.getBackendRepository ?? getReasoningBackendRepository;
  const nowMs = options.nowMs ?? Date.now;
  return async (input) => {
    if (!validInput(input)) throw new Error('invalid service reasoning submission');
    const authorityPolicyRef = serviceAuthorityRef(input, options.ownerDid);
    if (authorityPolicyRef === null) {
      throw new Error('invalid service reasoning listing authority');
    }
    const broker = brokerFor();
    const repository = repositoryFor();
    if (broker === null || repository === null) return null;

    const purpose = `service:${input.capabilityId}`.slice(0, 512);
    const context = prepareServiceReasoningContext({
      ownerDid: options.ownerDid,
      requesterDid: input.requesterDid,
      query: contextQuery(input),
      purpose,
      persona: input.vaultPersona,
      limit: MAX_SERVICE_CONTEXT_ITEMS,
    });
    if (context === null) return null;

    const now = nowMs();
    const authorityOrigin: AuthorityOrigin = {
      kind: 'service_request',
      ownerDid: options.ownerDid,
      requesterDid: input.requesterDid,
      ingress: 'd2d',
      correlationId: input.queryId,
      authenticatedAtMs: now,
    };
    const runtimeAvailable =
      options.isRuntimeAvailable ??
      ((binding: ReasoningBackendBinding, origin: AuthorityOrigin, currentNowMs: number) =>
        isReasoningBackendPresent(binding.backendId, binding.principalDid, currentNowMs) &&
        (binding.kind !== 'connected_host' ||
          getSessionRegistry().hasSessionAvailableForAuthority(binding.principalDid, origin)));
    const selected = selectReasoningBackend(repository.list(), {
      ownerDid: options.ownerDid,
      taskKind: 'service.respond',
      sensitivity: context.sensitivity,
      nowMs: now,
      isRuntimeAvailable: (binding) => runtimeAvailable(binding, authorityOrigin, now),
    });
    if (selected === null) return null;

    const responseSchemaHash =
      input.responseSchemaHash !== undefined && /^[0-9a-f]{64}$/.test(input.responseSchemaHash)
        ? input.responseSchemaHash
        : reasoningHash(input.responseSchema);
    try {
      const submitted = broker.submit({
        taskKind: 'service.respond',
        ownerDid: options.ownerDid,
        authorityOrigin,
        authorityPolicyRef,
        input: {
          capabilityId: input.capabilityId,
          params: input.params,
          instructions: input.instructions,
          serviceName: input.serviceName,
          ...(input.serviceUri === undefined ? {} : { serviceUri: input.serviceUri }),
          ttlSeconds: input.ttlSeconds,
          responseSchema: input.responseSchema,
          responseSchemaHash,
          operatorApproved: input.operatorApproved,
        },
        context: {
          items: context.items,
          scrubbed: true,
          sensitivity: context.sensitivity,
        },
        sensitivity: context.sensitivity,
        evidencePolicy: context.items.length === 0 ? 'none' : 'optional',
        purpose,
        backendBindingId: selected.backendId,
        idempotencyKey: `service:${reasoningHash({
          ownerDid: options.ownerDid,
          requesterDid: input.requesterDid,
          queryId: input.queryId,
          capabilityId: input.capabilityId,
          serviceUri: input.serviceUri ?? '',
        })}`,
        priority: 'normal',
        deadlineAtMs: now + input.ttlSeconds * 1_000,
        maxAttempts: 3,
        origin: 'd2d',
        sessionName: `service:${input.queryId}`.slice(0, 256),
      });
      return {
        taskId: submitted.taskId,
        backendId: selected.backendId,
        deduplicated: submitted.deduplicated,
      };
    } catch (error) {
      // Backend state can change between selection and submit. Preserve the
      // service's existing execution path for availability races and capacity.
      const code =
        error !== null && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : '';
      if (code === 'backend_not_found' || code === 'backend_not_allowed' || code === 'queue_full') {
        return null;
      }
      throw error;
    }
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface CreateServiceReasoningCommitterOptions {
  workflowService: Pick<WorkflowService, 'stageServiceQueryResponse'>;
}

/**
 * Turn an already-validated `service.respond` proposal into the existing
 * durable service-response egress. The authenticated authority origin, not
 * model output, supplies requester identity and correlation.
 */
export function createServiceReasoningCommitter(
  options: CreateServiceReasoningCommitterOptions,
): (input: ReasoningServiceCommitInput) => Promise<ReasoningCommitReceipt> {
  if (options.workflowService === undefined) {
    throw new Error('service reasoning workflow is required');
  }
  return async (proposal) => {
    const origin = proposal.authorityOrigin;
    const input = record(proposal.input);
    const result = record(proposal.result);
    const responseSchema = input === null ? null : record(input.responseSchema);
    if (
      origin.kind !== 'service_request' ||
      origin.ownerDid !== proposal.ownerDid ||
      typeof origin.requesterDid !== 'string' ||
      origin.requesterDid === '' ||
      input === null ||
      result === null ||
      responseSchema === null ||
      typeof input.capabilityId !== 'string' ||
      typeof input.serviceName !== 'string' ||
      typeof input.ttlSeconds !== 'number' ||
      !Number.isSafeInteger(input.ttlSeconds) ||
      input.ttlSeconds <= 0 ||
      record(result.result) === null
    ) {
      throw new Error('invalid service reasoning commit');
    }
    const responseSchemaHash =
      typeof input.responseSchemaHash === 'string' &&
      /^[0-9a-f]{64}$/.test(input.responseSchemaHash)
        ? input.responseSchemaHash
        : reasoningHash(responseSchema);
    options.workflowService.stageServiceQueryResponse({
      taskId: proposal.taskId,
      fromDID: origin.requesterDid,
      queryId: origin.correlationId,
      capability: input.capabilityId,
      ttlSeconds: input.ttlSeconds as number,
      resultJSON: JSON.stringify(result.result),
      serviceName: input.serviceName,
      schemaSnapshot: {
        params: { type: 'object' },
        result: responseSchema,
        schema_hash: responseSchemaHash,
      },
    });
    return {
      state: 'committed',
      receipt: {
        query_id: origin.correlationId,
        capability: input.capabilityId,
        status: 'queued_for_delivery',
      },
    };
  };
}
