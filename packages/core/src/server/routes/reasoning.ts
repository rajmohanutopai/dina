/**
 * Narrow transport surface for Core-owned reasoning.
 *
 * A connected model host is an untrusted worker. It authenticates as its
 * paired device DID and may claim only work covered by an owner-created
 * backend binding. Owner identity, authority origin, sensitivity, policy
 * version, context, and result schemas are all derived by Core.
 */

import {
  prepareConnectedBrainContext,
  prepareConnectedBrainContextWithPublicEvidence,
  prepareOwnerReasoningContext,
  prepareOwnerReasoningContextWithPublicEvidence,
  type PublicReasoningEvidenceSource,
} from '../../agent/connected_brain_facades';
import { appendAudit } from '../../audit/service';
import { getDeviceByDID } from '../../devices/registry';
import { getNodeDID } from '../../pairing/ceremony';
import { revokeReasoningAuthorityForPrincipal } from '../../reasoning/authority_revocation';
import {
  isReasoningBackendPresent,
  markReasoningBackendPresent,
} from '../../reasoning/backend_presence';
import {
  ReasoningBackendConflictError,
  getReasoningBackendRepository,
} from '../../reasoning/backend_repository';
import { selectReasoningBackend } from '../../reasoning/backend_selection';
import {
  getReasoningBroker,
  ReasoningBrokerError,
  type ReasoningPriority,
} from '../../reasoning/broker';
import {
  isReasoningAvailability,
  isReasoningBackendKind,
  isReasoningSensitivity,
  isReasoningTaskKind,
  type ReasoningBackendBinding,
  type ReasoningSensitivity,
  type ReasoningTaskKind,
} from '../../reasoning/domain';
import { getSessionRegistry, type SessionRecord } from '../../session/registry';

import { ownerDidForRequest } from './owner_guard';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

const FORBIDDEN_AUTHORITY_FIELDS = new Set([
  'authority_origin',
  'owner_did',
  'principal_did',
  'profile',
  'policy_version',
  'context',
  'context_projection',
  'sensitivity',
]);

const DEFAULT_PURPOSE: Readonly<Record<ReasoningTaskKind, string>> = {
  'answer.compose': 'Compose an answer for the current owner request',
  'memory.structure': 'Structure an owner-provided memory proposal',
  'intent.route': 'Classify the current owner request',
  'service.respond': 'Propose a response to an authorized service request',
  'review.summarize': 'Summarize authorized review evidence',
  'reminder.extract': 'Extract reminder candidates from owner-provided text',
};

const MINIMUM_SENSITIVITY: Readonly<Record<ReasoningTaskKind, ReasoningSensitivity>> = {
  'answer.compose': 'personal',
  'memory.structure': 'sensitive',
  'intent.route': 'personal',
  'service.respond': 'sensitive',
  'review.summarize': 'personal',
  'reminder.extract': 'personal',
};

const OWNER_SUBMITTABLE_TASKS = new Set<ReasoningTaskKind>([
  'answer.compose',
  'memory.structure',
  'intent.route',
  'reminder.extract',
]);

const OWNER_SUBMIT_FIELDS = new Set([
  'task_kind',
  'input',
  'purpose',
  'backend_id',
  'idempotency_key',
  'personas',
  'limit',
]);

function response(status: number, body: unknown): CoreResponse {
  return { status, body };
}

function recordBody(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasForbiddenAuthorityField(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((key) => FORBIDDEN_AUTHORITY_FIELDS.has(key));
}

function hasUnsupportedField(body: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(body).some((key) => !allowed.has(key));
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function optionalSafeInteger(value: unknown, min: number, max: number): number | undefined | null {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : null;
}

function projectBinding(binding: ReasoningBackendBinding): Record<string, unknown> {
  return {
    backend_id: binding.backendId,
    kind: binding.kind,
    principal_did: binding.principalDid,
    allowed_task_kinds: binding.allowedTaskKinds,
    max_sensitivity: binding.maxSensitivity,
    availability: binding.availability,
    model_class: binding.modelClass ?? null,
    policy_version: binding.policyVersion,
    selected_by_owner_did: binding.selectedByOwnerDid,
    enabled: binding.enabled,
    created_at: binding.createdAtMs,
    updated_at: binding.updatedAtMs,
    expires_at: binding.expiresAtMs,
    revoked_at: binding.revokedAtMs,
  };
}

function stricterSensitivity(
  left: ReasoningSensitivity,
  right: ReasoningSensitivity,
): ReasoningSensitivity {
  const rank: Readonly<Record<ReasoningSensitivity, number>> = {
    public: 0,
    personal: 1,
    sensitive: 2,
  };
  return rank[left] >= rank[right] ? left : right;
}

function mapBrokerError(error: unknown): CoreResponse | null {
  if (!(error instanceof ReasoningBrokerError)) return null;
  switch (error.code) {
    case 'invalid_request':
      return response(400, { error: error.code });
    case 'queue_full':
      return response(429, { error: error.code });
    case 'backend_not_found':
    case 'not_found':
      return response(404, { error: error.code });
    case 'backend_not_allowed':
    case 'authority_unavailable':
    case 'forbidden':
      return response(403, { error: error.code });
    case 'conflict':
      return response(409, { error: error.code });
  }
}

function activeBindingForCaller(
  req: CoreRequest,
  body: Record<string, unknown>,
): ReasoningBackendBinding | CoreResponse {
  const principalDid = req.callerDID;
  if (principalDid === undefined || principalDid === '') {
    return response(401, { error: 'unauthenticated_backend' });
  }
  const backendId = boundedString(body.backend_id, 256);
  if (backendId === null) return response(400, { error: 'backend_id_required' });
  const repo = getReasoningBackendRepository();
  if (repo === null) return response(503, { error: 'reasoning_repository_unavailable' });
  const binding = repo.get(backendId);
  const now = Date.now();
  if (
    binding === null ||
    binding.principalDid !== principalDid ||
    !binding.enabled ||
    binding.revokedAtMs !== null ||
    (binding.expiresAtMs !== null && binding.expiresAtMs <= now)
  ) {
    // Uniform response: do not expose another principal's backend identifiers.
    return response(404, { error: 'reasoning_backend_unavailable' });
  }
  return binding;
}

function requireConnectedHostSession(
  binding: ReasoningBackendBinding,
  body: Record<string, unknown>,
): SessionRecord | CoreResponse | null {
  if (binding.kind !== 'connected_host') return null;
  const sessionId = boundedString(body.session_id, 256);
  if (sessionId === null) return response(401, { error: 'invalid_session' });
  const session = getSessionRegistry().renew(sessionId, binding.principalDid);
  return session.ok ? session.session : response(401, { error: 'invalid_session' });
}

function currentOwnerBinding(binding: ReasoningBackendBinding): string | CoreResponse {
  const ownerDid = getNodeDID();
  if (ownerDid === null || binding.selectedByOwnerDid !== ownerDid) {
    return response(403, { error: 'stale_owner_binding' });
  }
  return ownerDid;
}

function backendRequest(req: CoreRequest):
  | {
      body: Record<string, unknown>;
      binding: ReasoningBackendBinding;
      session: SessionRecord | null;
    }
  | CoreResponse {
  const body =
    req.method === 'GET' ? ({ ...req.query } as Record<string, unknown>) : recordBody(req.body);
  if (body === null) return response(400, { error: 'invalid_json_body' });
  if (hasForbiddenAuthorityField(body)) {
    return response(400, { error: 'caller_authority_not_accepted' });
  }
  const binding = activeBindingForCaller(req, body);
  if (!('backendId' in binding)) return binding;
  const owner = currentOwnerBinding(binding);
  if (typeof owner !== 'string') return owner;
  const session = requireConnectedHostSession(binding, body);
  if (session !== null && !('sessionId' in session)) return session;
  // A valid authenticated backend request is its liveness heartbeat. Durable
  // authorization and runtime availability stay separate; auto-routing needs
  // both and naturally stops after the worker's polling process disappears.
  markReasoningBackendPresent(binding.backendId, binding.principalDid);
  return { body, binding, session };
}

function auditMetadata(
  actor: string,
  action: string,
  backendId: string,
  detail: Record<string, unknown>,
): void {
  try {
    appendAudit(actor, action, backendId, JSON.stringify(detail));
  } catch {
    // Audit is metadata-only and best-effort, matching the existing route layer.
  }
}

export interface ReasoningRouteOptions {
  ownerCapability?: string;
  publicEvidenceSource?: PublicReasoningEvidenceSource;
}

export function registerReasoningRoutes(
  router: CoreRouter,
  optionsOrOwnerCapability: ReasoningRouteOptions | string = {},
): void {
  const options: ReasoningRouteOptions =
    typeof optionsOrOwnerCapability === 'string'
      ? { ownerCapability: optionsOrOwnerCapability }
      : optionsOrOwnerCapability;
  const ownerCapability = options.ownerCapability;

  router.post('/v1/owner/reasoning/jobs', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const broker = getReasoningBroker();
    if (broker === null) return response(503, { error: 'reasoning_broker_unavailable' });
    const body = recordBody(req.body);
    if (body === null) return response(400, { error: 'invalid_json_body' });
    if (hasForbiddenAuthorityField(body)) {
      return response(400, { error: 'caller_authority_not_accepted' });
    }
    if (hasUnsupportedField(body, OWNER_SUBMIT_FIELDS)) {
      return response(400, { error: 'unsupported_reasoning_field' });
    }

    const taskKind = body.task_kind;
    const idempotencyKey = boundedString(body.idempotency_key, 256);
    const purpose =
      isReasoningTaskKind(taskKind) && body.purpose === undefined
        ? DEFAULT_PURPOSE[taskKind]
        : boundedString(body.purpose, 512);
    const backendId =
      body.backend_id === undefined || body.backend_id === null
        ? null
        : boundedString(body.backend_id, 256);
    const limit = optionalSafeInteger(body.limit, 1, 50);
    if (
      !isReasoningTaskKind(taskKind) ||
      !OWNER_SUBMITTABLE_TASKS.has(taskKind) ||
      idempotencyKey === null ||
      purpose === null ||
      (backendId === null && body.backend_id !== undefined && body.backend_id !== null) ||
      limit === null ||
      body.input === undefined ||
      (body.personas !== undefined &&
        (!Array.isArray(body.personas) ||
          body.personas.some((persona) => typeof persona !== 'string')))
    ) {
      return response(400, { error: 'invalid_reasoning_request' });
    }
    if (
      taskKind !== 'answer.compose' &&
      (body.personas !== undefined || body.limit !== undefined)
    ) {
      return response(400, { error: 'context_options_not_supported' });
    }

    try {
      const answerInput = taskKind === 'answer.compose' ? recordBody(body.input) : null;
      const contextRequest =
        answerInput !== null && typeof answerInput.query === 'string'
          ? {
              ownerDid: owner,
              query: answerInput.query,
              purpose,
              ...(body.personas === undefined ? {} : { personas: body.personas as string[] }),
              ...(limit === undefined ? {} : { limit }),
            }
          : null;
      const context =
        contextRequest === null
          ? null
          : options.publicEvidenceSource === undefined
            ? prepareOwnerReasoningContext(contextRequest)
            : await prepareOwnerReasoningContextWithPublicEvidence(
                contextRequest,
                options.publicEvidenceSource,
              );
      const sensitivity =
        context === null
          ? MINIMUM_SENSITIVITY[taskKind]
          : stricterSensitivity(MINIMUM_SENSITIVITY[taskKind], context.sensitivity);
      const bindings = getReasoningBackendRepository()?.list() ?? [];
      const selectedBackend =
        backendId === null
          ? (selectReasoningBackend(bindings, {
              ownerDid: owner,
              taskKind,
              sensitivity,
              isRuntimeAvailable: (binding) =>
                isReasoningBackendPresent(binding.backendId, binding.principalDid),
            }) ??
            // Durable owner work may be created while a foreground Brain is
            // closed. Prefer a present backend, but if none is running, bind
            // the job to the owner's best authorized backend and leave it
            // queued until that exact worker returns. Task-kind and
            // sensitivity checks remain identical, so this is not a privacy
            // downgrade.
            selectReasoningBackend(bindings, {
              ownerDid: owner,
              taskKind,
              sensitivity,
            }))
          : null;
      const resolvedBackendId = backendId ?? selectedBackend?.backendId ?? null;
      if (resolvedBackendId === null) {
        return response(503, { error: 'reasoning_backend_unavailable' });
      }
      const submitted = broker.submit({
        taskKind,
        ownerDid: owner,
        authorityOrigin: {
          kind: 'owner_interactive',
          ownerDid: owner,
          requesterDid: owner,
          ingress: 'internal',
          correlationId: idempotencyKey,
          authenticatedAtMs: Date.now(),
        },
        input: body.input,
        ...(context === null
          ? {}
          : {
              context: {
                items: context.items,
                scrubbed: context.scrubbed,
                sensitivity: context.sensitivity,
              },
            }),
        sensitivity,
        evidencePolicy: context !== null && context.items.length > 0 ? 'optional' : 'none',
        purpose,
        backendBindingId: resolvedBackendId,
        idempotencyKey,
        priority: 'user_blocking',
        origin: 'api',
      });
      const job = broker.getOwnerJob(submitted.taskId, owner);
      auditMetadata(owner, 'reasoning_job_submitted', submitted.taskId, {
        task_kind: taskKind,
        backend_id: resolvedBackendId,
        restricted_persona_count: context?.restrictedPersonas.length ?? 0,
      });
      return response(submitted.deduplicated ? 200 : 202, {
        submission: submitted,
        job,
        restricted_personas: context?.restrictedPersonas ?? [],
        unavailable_sources: context?.unavailableSources ?? [],
      });
    } catch (error) {
      return mapBrokerError(error) ?? response(400, { error: 'reasoning_submit_failed' });
    }
  });

  router.get('/v1/owner/reasoning/jobs', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const broker = getReasoningBroker();
    if (broker === null) return response(503, { error: 'reasoning_broker_unavailable' });
    const limit = optionalSafeInteger(
      req.query.limit === undefined ? undefined : Number(req.query.limit),
      1,
      200,
    );
    if (limit === null) return response(400, { error: 'invalid_reasoning_job_limit' });
    try {
      return response(200, { jobs: broker.listOwnerJobs(owner, limit ?? 50) });
    } catch (error) {
      return mapBrokerError(error) ?? response(500, { error: 'reasoning_jobs_failed' });
    }
  });

  router.get('/v1/owner/reasoning/jobs/:id', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const broker = getReasoningBroker();
    if (broker === null) return response(503, { error: 'reasoning_broker_unavailable' });
    const job = broker.getOwnerJob(req.params.id, owner);
    return job === null
      ? response(404, { error: 'reasoning_job_not_found' })
      : response(200, { job });
  });

  router.get('/v1/reasoning/backends', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const repo = getReasoningBackendRepository();
    if (repo === null) return response(503, { error: 'reasoning_repository_unavailable' });
    return response(200, {
      backends: repo
        .list()
        .filter((binding) => binding.selectedByOwnerDid === owner)
        .map(projectBinding),
    });
  });

  router.post('/v1/reasoning/backends/register', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const repo = getReasoningBackendRepository();
    if (repo === null) return response(503, { error: 'reasoning_repository_unavailable' });
    const body = recordBody(req.body);
    if (body === null) return response(400, { error: 'invalid_json_body' });

    const backendId = boundedString(body.backend_id, 256);
    const principalDid = boundedString(body.principal_did, 512);
    const expectedVersion =
      body.expected_version === null
        ? null
        : optionalSafeInteger(body.expected_version, 1, Number.MAX_SAFE_INTEGER);
    const expiresAt =
      body.expires_at === null
        ? null
        : optionalSafeInteger(body.expires_at, 1, Number.MAX_SAFE_INTEGER);
    const modelClass =
      body.model_class === undefined || body.model_class === null
        ? undefined
        : boundedString(body.model_class, 256);
    if (
      backendId === null ||
      principalDid === null ||
      !isReasoningBackendKind(body.kind) ||
      !Array.isArray(body.allowed_task_kinds) ||
      body.allowed_task_kinds.length === 0 ||
      body.allowed_task_kinds.some((kind) => !isReasoningTaskKind(kind)) ||
      !isReasoningSensitivity(body.max_sensitivity) ||
      !isReasoningAvailability(body.availability) ||
      expectedVersion === undefined ||
      expiresAt === undefined ||
      modelClass === null
    ) {
      return response(400, { error: 'invalid_reasoning_backend' });
    }

    if (body.kind === 'connected_host') {
      const device = getDeviceByDID(principalDid);
      if (
        device === null ||
        device.revoked ||
        device.role !== 'agent' ||
        device.scope !== 'coding'
      ) {
        return response(404, { error: 'coding_agent_not_found' });
      }
      if (body.availability !== 'foreground') {
        return response(400, { error: 'connected_host_must_be_foreground' });
      }
    }

    try {
      const binding = repo.register({
        backendId,
        kind: body.kind,
        principalDid,
        allowedTaskKinds: body.allowed_task_kinds as ReasoningTaskKind[],
        maxSensitivity: body.max_sensitivity,
        availability: body.availability,
        ...(modelClass === undefined ? {} : { modelClass }),
        selectedByOwnerDid: owner,
        expiresAtMs: expiresAt,
        expectedVersion,
      });
      auditMetadata(owner, 'reasoning_backend_registered', backendId, {
        kind: binding.kind,
        policy_version: binding.policyVersion,
      });
      return response(expectedVersion === null ? 201 : 200, projectBinding(binding));
    } catch (error) {
      if (error instanceof ReasoningBackendConflictError) {
        return response(409, { error: 'policy_version_conflict' });
      }
      return response(400, { error: 'invalid_reasoning_backend' });
    }
  });

  router.post('/v1/reasoning/backends/:id/revoke', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const repo = getReasoningBackendRepository();
    if (repo === null) return response(503, { error: 'reasoning_repository_unavailable' });
    const body = recordBody(req.body);
    const expectedVersion =
      body === null ? null : optionalSafeInteger(body.expected_version, 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion === undefined || expectedVersion === null) {
      return response(400, { error: 'expected_version_required' });
    }
    const existing = repo.get(req.params.id);
    if (existing === null || existing.selectedByOwnerDid !== owner) {
      return response(404, { error: 'reasoning_backend_not_found' });
    }
    const alreadyRevoked = !existing.enabled && existing.revokedAtMs !== null;
    if (
      (alreadyRevoked && existing.policyVersion !== expectedVersion) ||
      (!alreadyRevoked && !repo.revoke(req.params.id, expectedVersion, owner))
    ) {
      return response(409, { error: 'policy_version_conflict' });
    }
    const cascade = revokeReasoningAuthorityForPrincipal(existing.principalDid);
    if (!cascade.ok) {
      return response(503, { error: 'reasoning_revocation_incomplete' });
    }
    const revokedVersion = alreadyRevoked ? existing.policyVersion : expectedVersion + 1;
    auditMetadata(owner, 'reasoning_backend_revoked', req.params.id, {
      policy_version: revokedVersion,
    });
    return response(204, null);
  });

  router.get('/v1/reasoning/backends/self', async (req) => {
    const principalDid = req.callerDID;
    if (
      principalDid === undefined ||
      principalDid === '' ||
      req.callerType !== 'agent' ||
      req.agentScope !== 'coding'
    ) {
      return response(401, { error: 'unauthenticated_backend' });
    }
    const owner = getNodeDID();
    if (owner === null) return response(503, { error: 'owner_identity_unavailable' });
    const repo = getReasoningBackendRepository();
    if (repo === null) return response(503, { error: 'reasoning_repository_unavailable' });
    const now = Date.now();
    const backends = repo
      .getActiveForPrincipal(principalDid, now)
      .filter(
        (binding) => binding.kind === 'connected_host' && binding.selectedByOwnerDid === owner,
      );
    for (const binding of backends) {
      markReasoningBackendPresent(binding.backendId, binding.principalDid);
    }
    return response(200, { backends: backends.map(projectBinding) });
  });

  router.get('/v1/reasoning/status', async (req) => {
    const request = backendRequest(req);
    if (!('binding' in request)) return request;
    const broker = getReasoningBroker();
    if (broker === null) return response(503, { error: 'reasoning_broker_unavailable' });
    try {
      return response(200, broker.status({ did: request.binding.principalDid }));
    } catch (error) {
      return mapBrokerError(error) ?? response(500, { error: 'reasoning_status_failed' });
    }
  });

  router.post('/v1/reasoning/begin', async (req) => {
    const request = backendRequest(req);
    if (!('binding' in request)) return request;
    if (request.binding.kind !== 'connected_host' || request.session === null) {
      return response(403, { error: 'inline_begin_requires_connected_host' });
    }
    // `/begin` is the owner-interactive convenience path. Non-owner work is
    // created by Core and claimed through `/claim`; letting the host call
    // `/begin` while any session for the same principal carries a service,
    // contact, or delegation origin would provide a second-session escape from
    // the bounded projection attached to that task.
    if (
      request.session.authorityOrigin !== null ||
      getSessionRegistry().hasActiveNonOwnerAuthority(request.binding.principalDid)
    ) {
      return response(403, { error: 'inline_begin_requires_owner_authority' });
    }
    const broker = getReasoningBroker();
    if (broker === null) return response(503, { error: 'reasoning_broker_unavailable' });
    const taskKind = request.body.task_kind;
    if (!isReasoningTaskKind(taskKind)) {
      return response(400, { error: 'invalid_task_kind' });
    }
    if (!request.binding.allowedTaskKinds.includes(taskKind)) {
      return response(403, { error: 'task_kind_not_allowed' });
    }
    const purpose =
      request.body.purpose === undefined
        ? DEFAULT_PURPOSE[taskKind]
        : boundedString(request.body.purpose, 512);
    const idempotencyKey =
      request.body.idempotency_key === undefined
        ? undefined
        : boundedString(request.body.idempotency_key, 256);
    if (purpose === null || idempotencyKey === null || request.body.input === undefined) {
      return response(400, { error: 'invalid_reasoning_request' });
    }
    const owner = currentOwnerBinding(request.binding);
    if (typeof owner !== 'string') return owner;
    const authorityOrigin =
      request.session.authorityOrigin ??
      ({
        kind: 'owner_interactive',
        ownerDid: owner,
        requesterDid: owner,
        ingress: 'coding_host',
        correlationId: request.session.sessionId,
        authenticatedAtMs: request.session.createdAtMs,
      } as const);
    const priority: ReasoningPriority = 'user_blocking';
    try {
      const answerInput = taskKind === 'answer.compose' ? recordBody(request.body.input) : null;
      const contextRequest =
        answerInput !== null && typeof answerInput.query === 'string'
          ? {
              agentDid: request.binding.principalDid,
              ownerDid: owner,
              sessionId: request.session.sessionId,
              query: answerInput.query,
              purpose,
            }
          : null;
      const context =
        contextRequest === null
          ? null
          : options.publicEvidenceSource === undefined
            ? prepareConnectedBrainContext(contextRequest)
            : await prepareConnectedBrainContextWithPublicEvidence(
                contextRequest,
                options.publicEvidenceSource,
              );
      const pendingContext = context?.restrictedPersonas.filter(
        (entry) => entry.status === 'pending_approval',
      );
      if (pendingContext !== undefined && pendingContext.length > 0) {
        return response(202, {
          status: 'pending_approval',
          approvals: pendingContext.map((entry) => ({
            persona: entry.persona,
            task_id: entry.taskId,
          })),
        });
      }
      const submitted = broker.submit({
        taskKind,
        ownerDid: owner,
        authorityOrigin,
        input: request.body.input,
        ...(context === null
          ? {}
          : {
              context: {
                items: context.items,
                scrubbed: context.scrubbed,
                sensitivity: context.sensitivity,
              },
            }),
        sensitivity:
          context === null
            ? MINIMUM_SENSITIVITY[taskKind]
            : stricterSensitivity(MINIMUM_SENSITIVITY[taskKind], context.sensitivity),
        evidencePolicy:
          taskKind === 'review.summarize'
            ? 'required'
            : context !== null && context.items.length > 0
              ? 'optional'
              : 'none',
        purpose,
        backendBindingId: request.binding.backendId,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        priority,
        maxAttempts: 1,
        origin: 'cli',
        sessionName: request.session.hostSessionId,
      });
      const claim = broker.claim({
        backendId: request.binding.backendId,
        principalDid: request.binding.principalDid,
        authenticatedSessionId: request.session.sessionId,
        taskId: submitted.taskId,
      });
      auditMetadata(request.binding.principalDid, 'reasoning_inline_begun', submitted.taskId, {
        task_kind: taskKind,
        backend_id: request.binding.backendId,
      });
      return response(claim === null ? 202 : 200, {
        submission: submitted,
        claim,
        unavailable_sources: context?.unavailableSources ?? [],
      });
    } catch (error) {
      return mapBrokerError(error) ?? response(500, { error: 'reasoning_begin_failed' });
    }
  });

  router.post('/v1/reasoning/claim', async (req) => {
    const request = backendRequest(req);
    if (!('binding' in request)) return request;
    const broker = getReasoningBroker();
    if (broker === null) return response(503, { error: 'reasoning_broker_unavailable' });
    const leaseMs = optionalSafeInteger(request.body.lease_ms, 1_000, 5 * 60_000);
    if (leaseMs === null) return response(400, { error: 'invalid_lease' });
    try {
      const claim = broker.claim({
        backendId: request.binding.backendId,
        principalDid: request.binding.principalDid,
        ...(request.session === null ? {} : { authenticatedSessionId: request.session.sessionId }),
        ...(leaseMs === undefined ? {} : { leaseMs }),
      });
      return response(200, { claim });
    } catch (error) {
      return mapBrokerError(error) ?? response(500, { error: 'reasoning_claim_failed' });
    }
  });

  router.post('/v1/reasoning/:id/heartbeat', async (req) => {
    const request = backendRequest(req);
    if (!('binding' in request)) return request;
    const broker = getReasoningBroker();
    if (broker === null) return response(503, { error: 'reasoning_broker_unavailable' });
    const claimId = boundedString(request.body.claim_id, 256);
    const ticketId = boundedString(request.body.context_ticket_id, 256);
    const leaseMs = optionalSafeInteger(request.body.lease_ms, 1_000, 5 * 60_000);
    if (claimId === null || ticketId === null || leaseMs === null) {
      return response(400, { error: 'invalid_heartbeat' });
    }
    const ok = broker.heartbeat({
      taskId: req.params.id,
      claimId,
      contextTicketId: ticketId,
      backendId: request.binding.backendId,
      principalDid: request.binding.principalDid,
      ...(request.session === null ? {} : { authenticatedSessionId: request.session.sessionId }),
      ...(leaseMs === undefined ? {} : { leaseMs }),
    });
    return ok ? response(200, { ok: true }) : response(409, { ok: false, error: 'stale_claim' });
  });

  router.post('/v1/reasoning/:id/complete', async (req) => {
    const request = backendRequest(req);
    if (!('binding' in request)) return request;
    const broker = getReasoningBroker();
    if (broker === null) return response(503, { error: 'reasoning_broker_unavailable' });
    const claimId = boundedString(request.body.claim_id, 256);
    const ticketId = boundedString(request.body.context_ticket_id, 256);
    const executionId = boundedString(request.body.execution_id, 256);
    const policyHash = boundedString(request.body.policy_snapshot_hash, 64);
    const contextHash =
      request.body.context_projection_hash === null
        ? null
        : boundedString(request.body.context_projection_hash, 64);
    const evidenceIds = request.body.evidence_ids;
    if (
      claimId === null ||
      ticketId === null ||
      executionId === null ||
      policyHash === null ||
      contextHash === undefined ||
      request.body.result === undefined ||
      (evidenceIds !== undefined &&
        (!Array.isArray(evidenceIds) || evidenceIds.some((id) => typeof id !== 'string')))
    ) {
      return response(400, { error: 'invalid_completion' });
    }
    const completed = await broker.complete({
      taskId: req.params.id,
      claimId,
      contextTicketId: ticketId,
      backendId: request.binding.backendId,
      principalDid: request.binding.principalDid,
      executionId,
      contextProjectionHash: contextHash,
      policySnapshotHash: policyHash,
      result: request.body.result,
      ...(evidenceIds === undefined ? {} : { evidenceIds: evidenceIds as string[] }),
      ...(request.session === null ? {} : { authenticatedSessionId: request.session.sessionId }),
    });
    return response(completed.accepted ? 200 : 409, completed);
  });

  router.post('/v1/reasoning/:id/fail', async (req) => {
    const request = backendRequest(req);
    if (!('binding' in request)) return request;
    const broker = getReasoningBroker();
    if (broker === null) return response(503, { error: 'reasoning_broker_unavailable' });
    const claimId = boundedString(request.body.claim_id, 256);
    const ticketId = boundedString(request.body.context_ticket_id, 256);
    const error = boundedString(request.body.error, 2_048);
    if (
      claimId === null ||
      ticketId === null ||
      error === null ||
      typeof request.body.retryable !== 'boolean'
    ) {
      return response(400, { error: 'invalid_failure' });
    }
    const failed = await broker.fail({
      taskId: req.params.id,
      claimId,
      contextTicketId: ticketId,
      backendId: request.binding.backendId,
      principalDid: request.binding.principalDid,
      ...(request.session === null ? {} : { authenticatedSessionId: request.session.sessionId }),
      error,
      retryable: request.body.retryable,
    });
    return response(failed.accepted ? 200 : 409, failed);
  });

  router.post('/v1/owner/reasoning/:id/cancel', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const broker = getReasoningBroker();
    if (broker === null) return response(503, { error: 'reasoning_broker_unavailable' });
    const body = recordBody(req.body) ?? {};
    const reason =
      body.reason === undefined ? 'cancelled by owner' : boundedString(body.reason, 512);
    if (reason === null) return response(400, { error: 'invalid_cancel_reason' });
    const cancelled = broker.cancel(req.params.id, owner, reason);
    if (!cancelled) return response(404, { error: 'reasoning_job_not_found' });
    auditMetadata(owner, 'reasoning_job_cancelled', req.params.id, {});
    return response(200, { ok: true });
  });
}
