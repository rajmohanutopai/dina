/**
 * Item 5c — the coding-agent memory-ingress backing (dina_remember).
 *
 * Wires the `/v1/agent/memory` façade to the shared staging pipeline. Brain
 * classifies/enriches the item; Core owns the final vault write and parks
 * sensitive targets behind owner approval. The authenticated agent DID and
 * session are retained as staging provenance.
 *
 * Service discovery, Talk, delegation, PeerLens, and requester-owned status
 * projections are also wired here. An un-wired façade simply registers no
 * route.
 */

import {
  AppViewClient,
  classifyAttestationPublishError,
  publishAttestationToPDS,
  type PDSPublisher,
  type PeerlensAttestation,
  type SearchPeerlensParams,
} from '@dina/brain';
import {
  MAX_PUBLISH_QUEUE,
  PUBLISH_CLAIM_LEASE_MS,
  WorkflowTaskState,
  createFacadeActionApproval,
  facadeActionTaskId,
  getAgentGrantRepository,
  getServiceConfig,
  getReviewPublishRepository,
  getContact,
  getWorkflowService,
  getServiceConfigRepository,
  serviceQueryCanonicalJSON,
  submitServiceQuery,
  upsertServiceListing,
  validateServiceConfigForSave,
  validateServiceQueryRequest,
  parseFacadeActionApprovalPayload,
  publishClaimedReview,
  listPersonas,
  resolveByName,
  resolvePersonaName,
  computeStagingSourceHash,
  stagingGetItem,
  stagingIngest,
  validateLexicon,
  agentCanAccess,
  WorkflowTaskKind,
  type AgentFacadeHandlers,
  type FacadeAction,
  type ReviewRecordWriter,
  type ReviewPublishRepository,
  type StagingItem,
} from '@dina/core';
import { getD2DSender } from '@dina/core/d2d';
import { listByPersona as listRemindersByPersona } from '@dina/core/reminders';
import {
  MSG_TYPE_TALK_MESSAGE_V1,
  isListingPublishable,
  isValidServiceListingRkey,
  validateTalkMessageBody,
  type Attestation,
} from '@dina/protocol';

import { makeHttpServiceSearchHandler } from './http_service_search_handler';

const MAX_MEMORY_BYTES = 32 * 1024;
const MAX_SERVICE_RESULT_BYTES = 32 * 1024;
const MAX_TALK_CHARS = 2_000;
const MAX_DELEGATION_DESCRIPTION_CHARS = 4_000;
const MAX_DELEGATION_INPUT_BYTES = 32 * 1024;
const MAX_PEERLENS_QUERY_CHARS = 200;
const MAX_PEERLENS_RESULTS = 20;
const MAX_PEERLENS_RESULT_TEXT_CHARS = 2_000;
const MAX_SERVICE_INVOKE_PARAMS_CHARS = 3_000;
const RUNNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DID_RE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,280}$/;
const ACTION_RECOVERY_AFTER_MS = 30_000;
const actionFlights = new Map<string, Promise<AgentActionResponse>>();

interface AgentActionResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface CreateAgentFacadesOptions {
  brainUrl?: string;
  appViewUrl?: string;
  pdsPublisher?: PDSPublisher;
  ownerDid?: string;
  reviewPublishRepository?: ReviewPublishRepository;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export function createAgentFacades(options: CreateAgentFacadesOptions = {}): AgentFacadeHandlers {
  const hasNetworkPublisher =
    options.pdsPublisher !== undefined && options.ownerDid !== undefined;
  const findService =
    options.brainUrl !== undefined
      ? makeHttpServiceSearchHandler({
          brainUrl: options.brainUrl,
          ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        })
      : undefined;
  const appView =
    options.appViewUrl !== undefined
      ? new AppViewClient({
          appViewURL: options.appViewUrl,
          ...(options.fetchImpl !== undefined ? { fetch: options.fetchImpl } : {}),
        })
      : undefined;
  const reviewRepo = (): ReviewPublishRepository | null =>
    options.reviewPublishRepository ?? getReviewPublishRepository();
  const publishReview =
    options.pdsPublisher !== undefined && options.ownerDid !== undefined
      ? async (
          job: { rkey: string },
          record: Record<string, unknown>,
        ): Promise<{ uri: string; cid: string }> =>
          publishAttestationToPDS(
            options.pdsPublisher!,
            options.ownerDid!,
            record,
            job.rkey,
          )
      : undefined;
  return {
    // 5c — dina_remember: provenance-preserving ingress.
    memory: (ctx) => {
      const unsupported = Object.keys(ctx.body).find(
        (key) =>
          !new Set(['session_id', 'request_id', 'content', 'summary', 'persona']).has(key),
      );
      if (unsupported !== undefined) {
        return { status: 400, body: { error: `unsupported memory field: ${unsupported}` } };
      }
      const requestId = readRequestId(ctx.body);
      if (requestId === null) return invalidRequestId();
      const content = typeof ctx.body.content === 'string' ? ctx.body.content.trim() : '';
      if (content === '') {
        return { status: 400, body: { error: 'missing required field: content' } };
      }
      if (new TextEncoder().encode(content).byteLength > MAX_MEMORY_BYTES) {
        return { status: 413, body: { error: 'content too large' } };
      }
      const rawPersona =
        typeof ctx.body.persona === 'string' ? ctx.body.persona.trim() : '';
      const persona = rawPersona === '' ? '' : resolvePersonaName(rawPersona);
      if (persona !== '' && !listPersonas().some((candidate) => candidate.name === persona)) {
        return { status: 400, body: { error: `unknown persona: ${persona}` } };
      }
      const summary =
        typeof ctx.body.summary === 'string' && ctx.body.summary.trim() !== ''
          ? ctx.body.summary.trim().slice(0, 500)
          : content.slice(0, 80);
      try {
        const stagedData: Record<string, unknown> = {
          type: 'user_memory',
          summary,
          body: content,
          source: 'agent_remember',
          agent_did: ctx.agentDid,
          agent_session: ctx.sessionId,
          ...(persona !== '' ? { requested_persona: persona } : {}),
        };
        const accepted = stagingIngest({
          source: 'agent_remember',
          source_id: requestId,
          producer_id: ctx.agentDid,
          data: stagedData,
        });
        const item = stagingGetItem(accepted.id);
        if (item === null) {
          return { status: 500, body: { error: 'staged memory could not be read after ingest' } };
        }
        if (
          accepted.duplicate &&
          item.source_hash !== computeStagingSourceHash(stagedData)
        ) {
          return {
            status: 409,
            body: {
              error: 'request_id_conflict',
              id: item.id,
              request_id: requestId,
            },
          };
        }
        return projectAgentMemory(item, {
          duplicate: accepted.duplicate,
          requestId,
        });
      } catch (err) {
        return { status: 500, body: { error: safeError(err) } };
      }
    },
    memoryStatus: (ctx) => {
      const allowed = new Set(['session_id', 'item_id']);
      const unsupported = Object.keys(ctx.body).find((key) => !allowed.has(key));
      if (unsupported !== undefined) {
        return { status: 400, body: { error: `unsupported memory status field: ${unsupported}` } };
      }
      const itemId = typeof ctx.body.item_id === 'string' ? ctx.body.item_id.trim() : '';
      if (itemId === '') {
        return { status: 400, body: { error: 'missing required field: item_id' } };
      }
      const item = stagingGetItem(itemId);
      if (
        item === null ||
        item.source !== 'agent_remember' ||
        item.producer_id !== ctx.agentDid ||
        item.data.agent_session !== ctx.sessionId
      ) {
        return { status: 404, body: { error: 'memory not found' } };
      }
      return projectAgentMemory(item);
    },
    ...(findService !== undefined ? { findService } : {}),
    servicePublish: async (ctx) => {
      const allowed = new Set(['session_id', 'request_id', 'rkey', 'config']);
      const unsupported = Object.keys(ctx.body).find((key) => !allowed.has(key));
      if (unsupported !== undefined) {
        return { status: 400, body: { error: `unsupported service publish field: ${unsupported}` } };
      }
      const requestId = readRequestId(ctx.body);
      if (requestId === null) return invalidRequestId();
      const rkey = typeof ctx.body.rkey === 'string' ? ctx.body.rkey.trim() : '';
      if (!isValidServiceListingRkey(rkey)) {
        return { status: 400, body: { error: 'invalid service listing rkey' } };
      }
      const validated = validateServiceConfigForSave(ctx.body.config);
      if (!validated.ok) {
        return {
          status: 400,
          body: {
            error: validated.error,
            ...(validated.details !== undefined ? { details: validated.details } : {}),
          },
        };
      }
      const config = validated.config;
      const capabilities = Object.keys(config.capabilities).sort();
      const detail = [
        `Name: ${config.name}`,
        `Visibility: ${config.discoverability ?? (config.isDiscoverable ? 'public' : 'known_only')}`,
        `Status: ${config.status ?? 'active'}`,
        `Capabilities: ${capabilities.join(', ')}`,
        ...(config.vaultPersona !== undefined ? [`Vault: ${config.vaultPersona}`] : []),
        ...(config.description !== undefined ? [`Description: ${config.description}`] : []),
      ].join('\n');
      if (hasUnsafeDisplayText(detail, true) || detail.length > 4_000) {
        return { status: 400, body: { error: 'service listing is too large or unsafe to approve' } };
      }
      return runFacadeAction({
        action: 'service_publish',
        agentDid: ctx.agentDid,
        sessionId: ctx.sessionId,
        requestId,
        actionPayload: { rkey, config },
        displayTitle: `Publish service "${config.name}"`,
        displayDetail: detail,
        execute: executeServicePublish,
      });
    },
    serviceInvoke: async (ctx) => {
      const allowed = new Set([
        'session_id',
        'request_id',
        'to_did',
        'capability',
        'params',
        'ttl_seconds',
        'service_name',
        'origin_channel',
        'schema_hash',
        'service_uri',
        'grant_id',
      ]);
      const unsupported = Object.keys(ctx.body).find((key) => !allowed.has(key));
      if (unsupported !== undefined) {
        return { status: 400, body: { error: `unsupported service invoke field: ${unsupported}` } };
      }
      const requestId = readRequestId(ctx.body);
      if (requestId === null) return invalidRequestId();
      const approvalTaskId = facadeActionTaskId(
        ctx.agentDid,
        ctx.sessionId,
        'service_invoke',
        requestId,
      );
      const queryId = `agent-${approvalTaskId.slice('agent-action-'.length)}`;
      const validated = validateServiceQueryRequest({ ...ctx.body, query_id: queryId });
      if (!validated.ok) {
        return { status: 400, body: { error: validated.error } };
      }
      let paramsJSON: string;
      try {
        paramsJSON = serviceQueryCanonicalJSON(validated.req.params);
      } catch (error) {
        return { status: 400, body: { error: safeError(error) } };
      }
      if (
        paramsJSON.length > MAX_SERVICE_INVOKE_PARAMS_CHARS ||
        hasUnsafeDisplayText(paramsJSON, true)
      ) {
        return {
          status: 413,
          body: {
            error: `service params must fit within ${MAX_SERVICE_INVOKE_PARAMS_CHARS} visible characters`,
          },
        };
      }
      const provider = validated.req.service_name ?? validated.req.to_did;
      return runFacadeAction({
        action: 'service_invoke',
        agentDid: ctx.agentDid,
        sessionId: ctx.sessionId,
        requestId,
        actionPayload: { request: validated.req },
        displayTitle: `Ask service "${validated.req.capability}"`,
        displayDetail: `Provider: ${provider}\nParameters: ${paramsJSON}`,
        execute: executeServiceInvoke,
      });
    },
    serviceStatus: (ctx) => {
      const taskId = typeof ctx.body.task_id === 'string' ? ctx.body.task_id.trim() : '';
      if (taskId === '') {
        return { status: 400, body: { error: 'missing required field: task_id' } };
      }
      const workflow = getWorkflowService();
      if (workflow === null) {
        return { status: 503, body: { error: 'workflow service not wired' } };
      }
      const task = workflow.store().getById(taskId);
      if (task === null || task.kind !== WorkflowTaskKind.ServiceQuery) {
        return { status: 404, body: { error: 'service query not found' } };
      }
      let ownerDid = '';
      let ownerSession = '';
      try {
        const payload = JSON.parse(task.payload) as Record<string, unknown>;
        ownerDid =
          typeof payload.requester_agent_did === 'string' ? payload.requester_agent_did : '';
        ownerSession =
          typeof payload.requester_session_id === 'string' ? payload.requester_session_id : '';
      } catch {
        return { status: 404, body: { error: 'service query not found' } };
      }
      if (ownerDid !== ctx.agentDid || ownerSession !== ctx.sessionId) {
        return { status: 404, body: { error: 'service query not found' } };
      }
      const resultBody: Record<string, unknown> = {
        task_id: task.id,
        status: task.status,
        query_id: task.correlation_id ?? '',
        result_summary: task.result_summary,
        updated_at: task.updated_at,
        expires_at: task.expires_at ?? null,
      };
      if (task.result !== undefined && task.result !== '') {
        if (new TextEncoder().encode(task.result).byteLength <= MAX_SERVICE_RESULT_BYTES) {
          try {
            resultBody.result = JSON.parse(task.result);
          } catch {
            resultBody.result = task.result;
          }
        } else {
          resultBody.result_omitted = 'result exceeds 32 KiB';
        }
      }
      return {
        status: 200,
        body: resultBody,
      };
    },
    servicePublicationStatus: async (ctx) => {
      const rkey = typeof ctx.body.rkey === 'string' ? ctx.body.rkey.trim() : '';
      if (!isValidServiceListingRkey(rkey)) {
        return { status: 400, body: { error: 'invalid service listing rkey' } };
      }
      const repo = getServiceConfigRepository();
      if (repo === null) {
        return { status: 503, body: { error: 'service config store not wired' } };
      }
      const status = await repo.getPublicationStatus(rkey);
      if (status === null) {
        return { status: 404, body: { error: 'service listing not found' } };
      }
      const config = getServiceConfig(rkey);
      const needsNetworkPublication =
        config !== null && isListingPublishable(config);
      const publicationBlocked =
        !hasNetworkPublisher && status.state === 'pending' && needsNetworkPublication;
      const intentionallyLocal =
        !hasNetworkPublisher && status.state === 'pending' && !needsNetworkPublication;
      return {
        status: 200,
        body: {
          rkey,
          publication_status: publicationBlocked
            ? 'not_configured'
            : intentionallyLocal
              ? 'not_published'
              : status.state,
          can_publish: hasNetworkPublisher,
          ...(publicationBlocked || intentionallyLocal
            ? { stored_status: status.state }
            : {}),
          uri: status.uri,
          cid: status.cid,
          last_error:
            status.error ??
            (publicationBlocked
              ? 'PDS identity is not configured; install or restore the Home Node with --pds-handle'
              : null),
          attempted_at: status.attemptedAtMs,
          next_retry_at: status.nextRetryAtMs,
        },
      };
    },
    talk: async (ctx) => {
      const requestId = readRequestId(ctx.body);
      if (requestId === null) return invalidRequestId();
      const contactInput =
        typeof ctx.body.contact === 'string' ? ctx.body.contact.trim() : '';
      if (
        contactInput === '' ||
        contactInput.length > 300 ||
        hasUnsafeDisplayText(contactInput, false)
      ) {
        return { status: 400, body: { error: 'contact must be a bounded contact name or DID' } };
      }
      const contact = getContact(contactInput) ?? resolveByName(contactInput);
      if (contact === null || contact.did === '') {
        return { status: 404, body: { error: 'contact_not_found' } };
      }
      const text = typeof ctx.body.text === 'string' ? ctx.body.text.trim() : '';
      const inReplyTo =
        typeof ctx.body.in_reply_to === 'string' ? ctx.body.in_reply_to.trim() : undefined;
      const talkBody = {
        text,
        ...(inReplyTo !== undefined && inReplyTo !== '' ? { in_reply_to: inReplyTo } : {}),
      };
      const talkError = validateTalkMessageBody(talkBody);
      if (
        talkError !== null ||
        text.length > MAX_TALK_CHARS ||
        hasUnsafeDisplayText(text, true)
      ) {
        return { status: 400, body: { error: talkError ?? 'talk text is invalid or too long' } };
      }
      return runFacadeAction({
        action: 'talk',
        agentDid: ctx.agentDid,
        sessionId: ctx.sessionId,
        requestId,
        actionPayload: {
          recipient_did: contact.did,
          recipient_name: contact.displayName,
          body: talkBody,
        },
        displayTitle: `Send a message to ${contact.displayName}`,
        displayDetail: text,
        execute: executeTalk,
      });
    },
    delegate: async (ctx) => {
      const requestId = readRequestId(ctx.body);
      if (requestId === null) return invalidRequestId();
      const runner = typeof ctx.body.runner === 'string' ? ctx.body.runner.trim() : '';
      if (
        !RUNNER_RE.test(runner) ||
        runner === 'dina.local' ||
        runner.startsWith('plugin:')
      ) {
        return {
          status: 400,
          body: { error: 'runner must name a bounded external agent runner' },
        };
      }
      const description =
        typeof ctx.body.description === 'string' ? ctx.body.description.trim() : '';
      if (
        description === '' ||
        description.length > MAX_DELEGATION_DESCRIPTION_CHARS ||
        hasUnsafeDisplayText(description, true)
      ) {
        return { status: 400, body: { error: 'description is invalid or too long' } };
      }
      const input = ctx.body.input ?? {};
      if (!isJSONValue(input)) {
        return { status: 400, body: { error: 'input must be JSON-serializable data' } };
      }
      const inputJSON = JSON.stringify(input);
      if (new TextEncoder().encode(inputJSON).byteLength > MAX_DELEGATION_INPUT_BYTES) {
        return { status: 413, body: { error: 'delegation input too large' } };
      }
      return runFacadeAction({
        action: 'delegate',
        agentDid: ctx.agentDid,
        sessionId: ctx.sessionId,
        requestId,
        actionPayload: { runner, description, input },
        displayTitle: `Delegate a task to ${runner}`,
        displayDetail: description,
        execute: executeDelegation,
      });
    },
    actionStatus: async (ctx) => {
      const requestId = readRequestId(ctx.body);
      if (requestId === null) return invalidRequestId();
      const action = ctx.body.action;
      if (
        action !== 'talk' &&
        action !== 'delegate' &&
        action !== 'service_publish' &&
        action !== 'service_invoke'
      ) {
        return {
          status: 400,
          body: { error: 'action must be talk, delegate, service_publish, or service_invoke' },
        };
      }
      const workflow = getWorkflowService();
      if (workflow === null) {
        return { status: 503, body: { error: 'workflow service not wired' } };
      }
      const id = facadeActionTaskId(ctx.agentDid, ctx.sessionId, action, requestId);
      const task = workflow.store().getById(id);
      const payload = parseFacadeActionApprovalPayload(task?.payload);
      if (
        task === null ||
        payload === null ||
        payload.agent_did !== ctx.agentDid ||
        payload.session !== ctx.sessionId ||
        payload.action !== action ||
        payload.request_id !== requestId
      ) {
        return { status: 404, body: { error: 'action not found' } };
      }
      // Status polling is also the safe continuation point after the owner
      // approves on another device. The same durable request id and payload
      // flow back through the single-flight/idempotent executor; pending and
      // terminal tasks remain read-only projections.
      return runFacadeAction({
        action,
        agentDid: ctx.agentDid,
        sessionId: ctx.sessionId,
        requestId,
        actionPayload: payload.action_payload,
        displayTitle: payload.display_title,
        displayDetail: payload.display_detail,
        execute: executorForAction(action),
      });
    },
    ...(appView !== undefined
      ? {
          peerlensSearch: async (ctx) => {
            const params = parsePeerlensSearch(ctx.body);
            if ('error' in params) {
              return { status: 400, body: { error: params.error } };
            }
            try {
              const result = await appView.searchTrust(params);
              return {
                status: 200,
                body: {
                  results: result.results
                    .slice(0, params.limit ?? MAX_PEERLENS_RESULTS)
                    .map(projectPeerlensResult),
                  cursor:
                    typeof result.cursor === 'string'
                      ? result.cursor.slice(0, 1_000)
                      : undefined,
                  total_estimate: result.totalEstimate,
                },
              };
            } catch (error) {
              return {
                status: 502,
                body: { error: 'peerlens_search_unavailable', detail: safeError(error) },
              };
            }
          },
        }
      : {}),
    peerlensAttest: async (ctx) => {
      const requestId = readRequestId(ctx.body);
      if (requestId === null) return invalidRequestId();
      if (
        options.pdsPublisher === undefined ||
        options.ownerDid === undefined ||
        options.ownerDid.trim() === ''
      ) {
        return {
          status: 409,
          body: {
            error: 'no_credentials',
            detail: 'PeerLens publishing requires a configured PDS identity',
          },
        };
      }
      if (reviewRepo() === null) {
        return { status: 503, body: { error: 'review publish store not wired' } };
      }
      const parsed = parseAgentAttestation(ctx.body.record, options.now ?? Date.now);
      if ('error' in parsed) {
        return { status: 400, body: { error: 'lexicon_invalid', detail: parsed.error } };
      }
      const taskId = facadeActionTaskId(
        ctx.agentDid,
        ctx.sessionId,
        'review',
        requestId,
      );
      const jobId = reviewJobId(taskId);
      if (
        reviewRepo()!.getById(jobId) === null &&
        reviewRepo()!.countActive(options.ownerDid) >= MAX_PUBLISH_QUEUE
      ) {
        return { status: 429, body: { error: 'review_publish_queue_full' } };
      }
      const subjectLabel =
        parsed.record.subject.name ??
        parsed.record.subject.identifier ??
        parsed.record.subject.did ??
        parsed.record.subject.uri ??
        parsed.record.subject.type;
      const detail = [
        `${parsed.record.sentiment} ${parsed.record.category} review of ${subjectLabel}`,
        parsed.record.text,
      ]
        .filter((value): value is string => typeof value === 'string' && value !== '')
        .join('\n');
      return runFacadeAction({
        action: 'review',
        agentDid: ctx.agentDid,
        sessionId: ctx.sessionId,
        requestId,
        actionPayload: { record: parsed.record },
        displayTitle: 'Publish a public review',
        displayDetail: detail,
        execute: (taskId, payload) =>
          executeReviewPublish(taskId, payload, {
            ownerDid: options.ownerDid!,
            repo: reviewRepo()!,
            publish: publishReview!,
            now: options.now ?? Date.now,
          }),
      });
    },
    peerlensStatus: async (ctx) => {
      const requestId = readRequestId(ctx.body);
      if (requestId === null) return invalidRequestId();
      const workflow = getWorkflowService();
      if (workflow === null) {
        return { status: 503, body: { error: 'workflow service not wired' } };
      }
      const id = facadeActionTaskId(ctx.agentDid, ctx.sessionId, 'review', requestId);
      const task = workflow.store().getById(id);
      const payload = parseFacadeActionApprovalPayload(task?.payload);
      if (
        task === null ||
        payload === null ||
        payload.agent_did !== ctx.agentDid ||
        payload.session !== ctx.sessionId ||
        payload.action !== 'review' ||
        payload.request_id !== requestId
      ) {
        return { status: 404, body: { error: 'review publish not found' } };
      }
      if (
        options.pdsPublisher === undefined ||
        options.ownerDid === undefined ||
        reviewRepo() === null
      ) {
        return { status: 409, body: { error: 'no_credentials' } };
      }
      const action = await runFacadeAction({
        action: 'review',
        agentDid: ctx.agentDid,
        sessionId: ctx.sessionId,
        requestId,
        actionPayload: payload.action_payload,
        displayTitle: payload.display_title,
        displayDetail: payload.display_detail,
        execute: (taskId, actionPayload) =>
          executeReviewPublish(taskId, actionPayload, {
            ownerDid: options.ownerDid!,
            repo: reviewRepo()!,
            publish: publishReview!,
            now: options.now ?? Date.now,
          }),
      });
      return projectReviewStatus(action, reviewRepo()!, id);
    },
    vaults: (ctx) => {
      const now = (options.now ?? Date.now)();
      const grants = getAgentGrantRepository();
      const personas = listPersonas()
        .map((persona) => {
          const grant =
            grants?.findActiveGrant(
              ctx.agentDid,
              persona.name,
              'read',
              ctx.sessionId,
              now,
            ) ?? null;
          return {
            name: persona.name,
            tier: persona.tier,
            readable: agentCanAccess(persona.tier, grant !== null),
            access: agentCanAccess(persona.tier, grant !== null)
              ? grant === null
                ? 'session'
                : 'approved'
              : 'approval_required',
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return { status: 200, body: { vaults: personas } };
    },
    reminders: (ctx) => {
      const allowed = new Set(['session_id', 'limit']);
      for (const key of Object.keys(ctx.body)) {
        if (!allowed.has(key)) {
          return { status: 400, body: { error: `unsupported reminders field: ${key}` } };
        }
      }
      const rawLimit = ctx.body.limit ?? 50;
      if (
        typeof rawLimit !== 'number' ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > 100
      ) {
        return { status: 400, body: { error: 'limit must be an integer from 1 to 100' } };
      }
      const now = (options.now ?? Date.now)();
      const grants = getAgentGrantRepository();
      const readable: string[] = [];
      const restricted: string[] = [];
      for (const persona of listPersonas()) {
        const grant =
          grants?.findActiveGrant(
            ctx.agentDid,
            persona.name,
            'read',
            ctx.sessionId,
            now,
          ) ?? null;
        if (agentCanAccess(persona.tier, grant !== null)) readable.push(persona.name);
        else restricted.push(persona.name);
      }
      const reminders = readable
        .flatMap((persona) => listRemindersByPersona(persona))
        .filter(
          (reminder) =>
            reminder.completed === 0 &&
            (reminder.status === 'pending' ||
              reminder.status === 'snoozed' ||
              reminder.status === 'fired'),
        )
        .sort((a, b) => a.due_at - b.due_at || a.id.localeCompare(b.id))
        .slice(0, rawLimit)
        .map((reminder) => ({
          id: reminder.id,
          short_id: reminder.short_id,
          message: reminder.message.slice(0, 2_000),
          due_at: reminder.due_at,
          recurring: reminder.recurring,
          persona: reminder.persona,
          timezone: reminder.timezone.slice(0, 100),
          kind: reminder.kind.slice(0, 100),
          status: reminder.status,
        }));
      return {
        status: 200,
        body: {
          reminders,
          restricted_personas: restricted.sort(),
          restricted_count: restricted.length,
        },
      };
    },
  };
}

function projectAgentMemory(
  item: StagingItem,
  options: { duplicate?: boolean; requestId?: string } = {},
): AgentActionResponse {
  const base: Record<string, unknown> = {
    id: item.id,
    request_id: options.requestId ?? item.source_id,
    ...(options.duplicate !== undefined ? { duplicate: options.duplicate } : {}),
    ...(item.persona !== '' ? { persona: item.persona } : {}),
  };

  if (item.status === 'stored') {
    return { status: 200, body: { ...base, status: 'stored' } };
  }
  if (item.status === 'received' || item.status === 'classifying') {
    return { status: 202, body: { ...base, status: 'processing' } };
  }
  if (item.status === 'pending_unlock') {
    if (item.approval_id === undefined || item.approval_id === '') {
      return { status: 202, body: { ...base, status: 'pending_unlock' } };
    }
    const task = getWorkflowService()?.store().getById(item.approval_id) ?? null;
    if (task?.status === WorkflowTaskState.PendingApproval) {
      return {
        status: 202,
        body: {
          ...base,
          status: 'pending_approval',
          task_id: item.approval_id,
        },
      };
    }
    if (
      task?.status === WorkflowTaskState.Cancelled ||
      task?.status === WorkflowTaskState.Failed
    ) {
      return {
        status: 200,
        body: {
          ...base,
          status: task.status === WorkflowTaskState.Cancelled ? 'denied' : 'failed',
          task_id: item.approval_id,
        },
      };
    }
    return {
      status: 202,
      body: {
        ...base,
        status: 'processing',
        task_id: item.approval_id,
      },
    };
  }
  if (item.status === 'failed') {
    return {
      status: 200,
      body: {
        ...base,
        status: 'failed',
        ...(item.error !== undefined && item.error !== ''
          ? { error: item.error.slice(0, 500) }
          : {}),
      },
    };
  }
  return { status: 202, body: { ...base, status: item.status } };
}

interface RunFacadeActionInput {
  action: FacadeAction;
  agentDid: string;
  sessionId: string;
  requestId: string;
  actionPayload: Record<string, unknown>;
  displayTitle: string;
  displayDetail: string;
  execute: (
    taskId: string,
    payload: Record<string, unknown>,
    agentDid: string,
    sessionId: string,
  ) => Promise<Record<string, unknown>>;
}

async function runFacadeAction(input: RunFacadeActionInput): Promise<AgentActionResponse> {
  const created = createFacadeActionApproval({
    action: input.action,
    agentDid: input.agentDid,
    sessionId: input.sessionId,
    requestId: input.requestId,
    actionPayload: input.actionPayload,
    displayTitle: input.displayTitle,
    displayDetail: input.displayDetail,
  });
  if (created.kind === 'unavailable') {
    return { status: 503, body: { error: 'workflow service not wired' } };
  }
  if (created.kind === 'too_many_pending') {
    return { status: 429, body: { error: 'too_many_pending_actions' } };
  }
  if (created.kind === 'conflict') {
    return {
      status: 409,
      body: {
        error: 'request_id_conflict',
        task_id: created.taskId,
      },
    };
  }

  const task = created.task;
  if (task.status === WorkflowTaskState.PendingApproval) {
    return {
      status: 202,
      body: {
        status: 'pending_approval',
        task_id: task.id,
        request_id: input.requestId,
      },
    };
  }
  if (
    task.status === WorkflowTaskState.Completed ||
    task.status === WorkflowTaskState.Recorded
  ) {
    return projectActionTask(task, created.payload);
  }
  if (
    task.status === WorkflowTaskState.Cancelled ||
    task.status === WorkflowTaskState.Failed ||
    task.status === WorkflowTaskState.OutcomeUnknown
  ) {
    return projectActionTask(task, created.payload);
  }

  const workflow = getWorkflowService();
  if (workflow === null) {
    return { status: 503, body: { error: 'workflow service not wired' } };
  }

  if (task.status === WorkflowTaskState.Running) {
    const inFlight = actionFlights.get(task.id);
    if (inFlight !== undefined || Date.now() - task.updated_at < ACTION_RECOVERY_AFTER_MS) {
      return {
        status: 202,
        body: {
          status: 'executing',
          task_id: task.id,
          request_id: input.requestId,
        },
      };
    }
    // The prior process may have died after starting. Talk retries use a stable
    // D2D message id; delegation reconciles a stable task id, so replay is safe.
  } else if (task.status === WorkflowTaskState.Queued) {
    const claimed = workflow
      .store()
      .claimApprovalForExecution(task.id, 60, Math.floor(Date.now() / 1000));
    if (!claimed) {
      const fresh = workflow.store().getById(task.id);
      return fresh === null
        ? { status: 404, body: { error: 'action not found' } }
        : projectActionTask(fresh, created.payload);
    }
  } else {
    return projectActionTask(task, created.payload);
  }

  const execution = executeAndCompleteAction(input, task.id);
  actionFlights.set(task.id, execution);
  try {
    return await execution;
  } finally {
    if (actionFlights.get(task.id) === execution) actionFlights.delete(task.id);
  }
}

async function executeAndCompleteAction(
  input: RunFacadeActionInput,
  taskId: string,
): Promise<AgentActionResponse> {
  const workflow = getWorkflowService();
  if (workflow === null) {
    return { status: 503, body: { error: 'workflow service not wired' } };
  }
  try {
    const result = await input.execute(
      taskId,
      input.actionPayload,
      input.agentDid,
      input.sessionId,
    );
    try {
      workflow.complete(
        taskId,
        JSON.stringify(result),
        input.action === 'talk'
          ? 'Message handed to Dina transport'
          : input.action === 'delegate'
            ? 'Delegation queued'
            : input.action === 'review'
              ? 'Review accepted for durable publication'
              : input.action === 'service_publish'
                ? 'Service listing saved for publication'
                : 'Service query sent',
        input.agentDid,
      );
    } catch {
      // A crash-recovery replay can race the original attempt. Only the winner
      // completes; both performed an idempotent underlying action.
    }
    const fresh = workflow.store().getById(taskId);
    if (fresh !== null) {
      const payload = parseFacadeActionApprovalPayload(fresh.payload);
      if (payload !== null) return projectActionTask(fresh, payload);
    }
    return { status: 200, body: result };
  } catch (error) {
    const message = safeError(error);
    const fresh = workflow.store().getById(taskId);
    if (fresh?.status === WorkflowTaskState.Running) {
      try {
        workflow.fail(taskId, message, input.agentDid);
      } catch {
        // Preserve the winning terminal state.
      }
    }
    return {
      status: 502,
      body: {
        status: 'failed',
        task_id: taskId,
        error: message,
      },
    };
  }
}

async function executeTalk(
  taskId: string,
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sender = getD2DSender();
  if (sender === null) throw new Error('D2D sender is not available');
  const recipientDID = raw.recipient_did;
  const body = raw.body;
  if (
    typeof recipientDID !== 'string' ||
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    validateTalkMessageBody(body) !== null
  ) {
    throw new Error('stored Talk action is invalid');
  }
  const outcome = await sender(
    recipientDID,
    MSG_TYPE_TALK_MESSAGE_V1,
    body as Record<string, unknown>,
    {
      dataCategories: ['message_text'],
      messageId: `d2d-talk-${taskId.slice('agent-action-'.length)}`,
    },
  );
  return {
    delivery_status: outcome?.queued ? 'queued' : 'sent',
    recipient_did: recipientDID,
    message_id: outcome?.messageId ?? `d2d-talk-${taskId.slice('agent-action-'.length)}`,
    delivered: outcome?.delivered ?? null,
    buffered: outcome?.buffered ?? null,
    queued: outcome?.queued ?? null,
  };
}

async function executeDelegation(
  taskId: string,
  raw: Record<string, unknown>,
  agentDid: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const workflow = getWorkflowService();
  if (workflow === null) throw new Error('workflow service not wired');
  const runner = raw.runner;
  const description = raw.description;
  if (
    typeof runner !== 'string' ||
    !RUNNER_RE.test(runner) ||
    runner === 'dina.local' ||
    runner.startsWith('plugin:') ||
    typeof description !== 'string'
  ) {
    throw new Error('stored delegation action is invalid');
  }
  const delegationId = `agent-delegation-${taskId.slice('agent-action-'.length)}`;
  const delegationPayload = JSON.stringify({
    type: 'agent_delegation_v1',
    requester_agent_did: agentDid,
    requester_session_id: sessionId,
    approval_task_id: taskId,
    input: raw.input ?? {},
  });
  const existing = workflow.store().getById(delegationId);
  if (existing === null) {
    workflow.create({
      id: delegationId,
      kind: WorkflowTaskKind.Delegation,
      description,
      payload: delegationPayload,
      priority: 'normal',
      origin: 'agent',
      sessionName: sessionId,
      initialState: WorkflowTaskState.Queued,
      idempotencyKey: `agent-delegation:${taskId}`,
      requestedRunner: runner,
    });
  } else if (
    existing.kind !== WorkflowTaskKind.Delegation ||
    existing.payload !== delegationPayload ||
    existing.requested_runner !== runner
  ) {
    throw new Error('delegation task conflict');
  }
  return {
    delegation_submit_status: 'queued',
    delegation_task_id: delegationId,
    runner,
  };
}

function executorForAction(
  action: 'talk' | 'delegate' | 'service_publish' | 'service_invoke',
): RunFacadeActionInput['execute'] {
  if (action === 'talk') return executeTalk;
  if (action === 'delegate') return executeDelegation;
  if (action === 'service_publish') return executeServicePublish;
  return executeServiceInvoke;
}

async function executeServicePublish(
  _taskId: string,
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rkey = typeof raw.rkey === 'string' ? raw.rkey : '';
  if (!isValidServiceListingRkey(rkey)) {
    throw new Error('stored service listing rkey is invalid');
  }
  const validated = validateServiceConfigForSave(raw.config);
  if (!validated.ok) throw new Error(`stored service listing is invalid: ${validated.error}`);
  const result = await upsertServiceListing(rkey, validated.config);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(readCoreError(result.body, 'service listing save failed'));
  }
  return {
    rkey,
    saved: true,
    publication_status: 'pending',
  };
}

async function executeServiceInvoke(
  _taskId: string,
  raw: Record<string, unknown>,
  agentDid: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const validated = validateServiceQueryRequest(raw.request);
  if (!validated.ok) throw new Error(`stored service request is invalid: ${validated.error}`);
  const result = await submitServiceQuery(validated.req, {
    requesterAgentDid: agentDid,
    requesterSessionId: sessionId,
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(readCoreError(result.body, 'service query failed'));
  }
  const body =
    result.body !== null && typeof result.body === 'object' && !Array.isArray(result.body)
      ? (result.body as Record<string, unknown>)
      : {};
  if (typeof body.task_id !== 'string' || typeof body.query_id !== 'string') {
    throw new Error('service query returned an invalid receipt');
  }
  return {
    service_task_id: body.task_id,
    query_id: body.query_id,
    ...(body.deduped === true ? { deduped: true } : {}),
  };
}

function readCoreError(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === 'string' && error !== '') return error;
  }
  return fallback;
}

function projectActionTask(
  task: {
    id: string;
    status: string;
    result?: string;
    error?: string;
    updated_at: number;
  },
  payload: {
    action: FacadeAction;
    request_id: string;
    action_payload: Record<string, unknown>;
  },
): AgentActionResponse {
  const base: Record<string, unknown> = {
    status: task.status,
    action: payload.action,
    request_id: payload.request_id,
    task_id: task.id,
    updated_at: task.updated_at,
  };
  if (task.error !== undefined && task.error !== '') base.error = task.error;
  if (task.result !== undefined && task.result !== '') {
    try {
      Object.assign(base, JSON.parse(task.result) as Record<string, unknown>);
    } catch {
      base.result = task.result.slice(0, 4_000);
    }
  }
  if (payload.action === 'delegate' && typeof base.delegation_task_id === 'string') {
    const delegated = getWorkflowService()?.store().getById(base.delegation_task_id);
    if (delegated !== null && delegated !== undefined) {
      base.delegation_status = delegated.status;
      base.delegation_result_summary = delegated.result_summary;
      if (delegated.error !== undefined && delegated.error !== '') {
        base.delegation_error = delegated.error;
      }
      if (
        delegated.result !== undefined &&
        new TextEncoder().encode(delegated.result).byteLength <= 32 * 1024
      ) {
        try {
          base.delegation_result = JSON.parse(delegated.result);
        } catch {
          base.delegation_result = delegated.result;
        }
      }
    }
  }
  const terminalError =
    task.status === WorkflowTaskState.Cancelled
      ? 403
      : task.status === WorkflowTaskState.Failed ||
          task.status === WorkflowTaskState.OutcomeUnknown
        ? 409
        : task.status === WorkflowTaskState.PendingApproval ||
            task.status === WorkflowTaskState.Queued ||
            task.status === WorkflowTaskState.Running
          ? 202
          : 200;
  return { status: terminalError, body: base };
}

interface ExecuteReviewDeps {
  ownerDid: string;
  repo: ReviewPublishRepository;
  publish: ReviewRecordWriter;
  now: () => number;
}

async function executeReviewPublish(
  taskId: string,
  raw: Record<string, unknown>,
  deps: ExecuteReviewDeps,
): Promise<Record<string, unknown>> {
  const record = readStoredAgentAttestation(raw.record);
  if (record === null) throw new Error('stored review action is invalid');

  const jobId = reviewJobId(taskId);
  const rkey = reviewRkey(taskId);
  const recordJSON = JSON.stringify(record);
  const existing = deps.repo.getById(jobId);
  if (existing === null) {
    if (deps.repo.countActive(deps.ownerDid) >= MAX_PUBLISH_QUEUE) {
      throw new Error('review publish queue is full');
    }
    const subjectLabel =
      record.subject.name ??
      record.subject.identifier ??
      record.subject.did ??
      record.subject.uri ??
      record.subject.type;
    const now = deps.now();
    deps.repo.create({
      jobId,
      ownerDid: deps.ownerDid,
      rkey,
      recordJSON,
      draftJSON: JSON.stringify({
        subject: subjectLabel,
        category: record.category,
        sentiment: record.sentiment,
        text: record.text ?? '',
      }),
      createdAt: now,
    });
  } else if (
    existing.ownerDid !== deps.ownerDid ||
    existing.rkey !== rkey ||
    existing.recordJSON !== recordJSON
  ) {
    throw new Error('stored review job conflicts with approved action');
  }

  let job = deps.repo.getById(jobId);
  if (job === null) throw new Error('review publish job was not created');
  if (job.status === 'queued') {
    const claimedAt = deps.now();
    if (deps.repo.claim(jobId, claimedAt, PUBLISH_CLAIM_LEASE_MS)) {
      job = deps.repo.getById(jobId);
      if (job !== null) {
        await publishClaimedReview(job, {
          repo: deps.repo,
          publish: deps.publish,
          classifyError: classifyAttestationPublishError,
          now: deps.now,
        });
      }
    }
  }

  job = deps.repo.getById(jobId);
  if (job === null) throw new Error('review publish job disappeared');
  return {
    job_id: job.jobId,
    publish_status: job.status,
    attempts: job.attempts,
    ...(job.publishedUri !== null ? { uri: job.publishedUri } : {}),
    ...(job.publishedCid !== null ? { cid: job.publishedCid } : {}),
    ...(job.lastErrorCode !== null ? { error_code: job.lastErrorCode } : {}),
    ...(job.lastErrorMessage !== null ? { error: job.lastErrorMessage } : {}),
    ...(job.nextAttemptAt !== null ? { next_retry_at: job.nextAttemptAt } : {}),
  };
}

function projectReviewStatus(
  action: AgentActionResponse,
  repo: ReviewPublishRepository,
  taskId: string,
): AgentActionResponse {
  const job = repo.getById(reviewJobId(taskId));
  if (job === null) return action;
  const body: Record<string, unknown> = {
    ...action.body,
    job_id: job.jobId,
    publish_status: job.status,
    attempts: job.attempts,
    updated_at: job.updatedAt,
  };
  if (job.publishedUri !== null) body.uri = job.publishedUri;
  if (job.publishedCid !== null) body.cid = job.publishedCid;
  if (job.lastErrorCode !== null) body.error_code = job.lastErrorCode;
  if (job.lastErrorMessage !== null) body.error = job.lastErrorMessage;
  if (job.nextAttemptAt !== null) body.next_retry_at = job.nextAttemptAt;
  return {
    status:
      job.status === 'published'
        ? 200
        : job.status === 'failed'
          ? 409
          : 202,
    body,
  };
}

function reviewJobId(taskId: string): string {
  return `review-publish-${taskId.slice('agent-action-'.length)}`;
}

function reviewRkey(taskId: string): string {
  return `agent-${taskId.slice('agent-action-'.length)}`;
}

function parsePeerlensSearch(
  body: Record<string, unknown>,
): SearchPeerlensParams | { error: string } {
  const allowed = new Set([
    'session_id',
    'q',
    'category',
    'domain',
    'subject_type',
    'sentiment',
    'min_confidence',
    'author_did',
    'tags',
    'sort',
    'limit',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { error: `unsupported search field: ${key}` };
  }

  const result: SearchPeerlensParams = {};
  for (const [wire, target] of [
    ['q', 'q'],
    ['category', 'category'],
    ['domain', 'domain'],
  ] as const) {
    const value = body[wire];
    if (value === undefined) continue;
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.trim().length > MAX_PEERLENS_QUERY_CHARS ||
      hasUnsafeDisplayText(value, false)
    ) {
      return { error: `${wire} must be a non-empty string up to 200 characters` };
    }
    result[target] = value.trim();
  }
  if (body.subject_type !== undefined) {
    if (
      body.subject_type !== 'did' &&
      body.subject_type !== 'content' &&
      body.subject_type !== 'product' &&
      body.subject_type !== 'dataset' &&
      body.subject_type !== 'organization' &&
      body.subject_type !== 'claim' &&
      body.subject_type !== 'place'
    ) {
      return { error: 'subject_type is invalid' };
    }
    result.subjectType = body.subject_type;
  }
  if (body.sentiment !== undefined) {
    if (
      body.sentiment !== 'positive' &&
      body.sentiment !== 'neutral' &&
      body.sentiment !== 'negative'
    ) {
      return { error: 'sentiment is invalid' };
    }
    result.sentiment = body.sentiment;
  }
  if (body.min_confidence !== undefined) {
    if (
      body.min_confidence !== 'speculative' &&
      body.min_confidence !== 'moderate' &&
      body.min_confidence !== 'high' &&
      body.min_confidence !== 'certain'
    ) {
      return { error: 'min_confidence is invalid' };
    }
    result.minConfidence = body.min_confidence;
  }
  if (body.author_did !== undefined) {
    if (typeof body.author_did !== 'string' || !DID_RE.test(body.author_did)) {
      return { error: 'author_did must be a valid bounded DID' };
    }
    result.authorDid = body.author_did;
  }
  if (body.tags !== undefined) {
    if (
      !Array.isArray(body.tags) ||
      body.tags.length > 10 ||
      body.tags.some(
        (tag) =>
          typeof tag !== 'string' ||
          tag.trim() === '' ||
          tag.trim().length > 50 ||
          hasUnsafeDisplayText(tag, false),
      )
    ) {
      return { error: 'tags must contain at most 10 bounded strings' };
    }
    result.tags = body.tags.map((tag) => (tag as string).trim());
  }
  if (body.sort !== undefined) {
    if (body.sort !== 'recent' && body.sort !== 'relevant') {
      return { error: 'sort must be recent or relevant' };
    }
    result.sort = body.sort;
  }
  if (body.limit !== undefined) {
    if (
      typeof body.limit !== 'number' ||
      !Number.isInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > MAX_PEERLENS_RESULTS
    ) {
      return { error: `limit must be an integer from 1 to ${MAX_PEERLENS_RESULTS}` };
    }
    result.limit = body.limit;
  } else {
    result.limit = 10;
  }
  return result;
}

function projectPeerlensResult(row: PeerlensAttestation): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, max] of [
    ['uri', 2_048],
    ['cid', 256],
    ['authorDid', 300],
    ['authorHandle', 300],
    ['subjectId', 1_000],
    ['category', 200],
    ['domain', 253],
    ['sentiment', 20],
    ['confidence', 20],
    ['recordCreatedAt', 100],
    ['text', MAX_PEERLENS_RESULT_TEXT_CHARS],
  ] as const) {
    const value = row[key];
    if (typeof value === 'string') result[key] = value.slice(0, max);
  }
  if (Array.isArray(row.tags)) {
    result.tags = row.tags
      .filter((tag): tag is string => typeof tag === 'string')
      .slice(0, 20)
      .map((tag) => tag.slice(0, 100));
  }
  if (
    row.subjectRefRaw !== null &&
    typeof row.subjectRefRaw === 'object' &&
    !Array.isArray(row.subjectRefRaw)
  ) {
    const subject = sanitizePublicSubject(row.subjectRefRaw as Record<string, unknown>);
    if (subject !== null) result.subject = subject;
  }
  return result;
}

function parseAgentAttestation(
  value: unknown,
  now: () => number,
): { record: Attestation } | { error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'record must be an object' };
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    'subject',
    'category',
    'sentiment',
    'dimensions',
    'text',
    'tags',
    'domain',
    'evidence',
    'confidence',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return { error: `unsupported attestation field: ${key}` };
  }
  const subject =
    raw.subject !== null && typeof raw.subject === 'object' && !Array.isArray(raw.subject)
      ? sanitizePublicSubject(raw.subject as Record<string, unknown>)
      : null;
  if (subject === null) return { error: 'subject is invalid' };

  const record = {
    subject,
    category: raw.category,
    sentiment: raw.sentiment,
    ...(raw.dimensions !== undefined ? { dimensions: sanitizeDimensions(raw.dimensions) } : {}),
    ...(raw.text !== undefined ? { text: raw.text } : {}),
    ...(raw.tags !== undefined ? { tags: raw.tags } : {}),
    ...(raw.domain !== undefined ? { domain: raw.domain } : {}),
    ...(raw.evidence !== undefined ? { evidence: sanitizeEvidence(raw.evidence) } : {}),
    ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}),
    isAgentGenerated: true,
    createdAt: new Date(now()).toISOString(),
  } as unknown as Attestation;
  if (record.dimensions === null || record.evidence === null) {
    return { error: 'dimensions or evidence is invalid' };
  }
  const errors = validateLexicon(record);
  return errors.length > 0 ? { error: errors.join('; ') } : { record };
}

function readStoredAgentAttestation(value: unknown): Attestation | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Attestation;
  if (record.isAgentGenerated !== true || validateLexicon(record).length > 0) return null;
  return record;
}

function sanitizePublicSubject(raw: Record<string, unknown>): Attestation['subject'] | null {
  const allowed = new Set(['type', 'did', 'uri', 'name', 'identifier']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  if (
    raw.type !== 'did' &&
    raw.type !== 'content' &&
    raw.type !== 'product' &&
    raw.type !== 'dataset' &&
    raw.type !== 'organization' &&
    raw.type !== 'claim' &&
    raw.type !== 'place'
  ) {
    return null;
  }
  const subject: Attestation['subject'] = { type: raw.type };
  for (const [key, max] of [
    ['did', 300],
    ['uri', 2_048],
    ['name', 300],
    ['identifier', 500],
  ] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.length > max ||
      hasUnsafeDisplayText(value, false)
    ) {
      return null;
    }
    subject[key] = value.trim();
  }
  if (
    subject.did === undefined &&
    subject.uri === undefined &&
    subject.name === undefined &&
    subject.identifier === undefined
  ) {
    return null;
  }
  return subject;
}

function sanitizeDimensions(value: unknown): Attestation['dimensions'] | null {
  if (!Array.isArray(value)) return null;
  const result: NonNullable<Attestation['dimensions']> = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => !['dimension', 'value', 'note'].includes(key))) {
      return null;
    }
    result.push(row as unknown as NonNullable<Attestation['dimensions']>[number]);
  }
  return result;
}

function sanitizeEvidence(value: unknown): Attestation['evidence'] | null {
  if (!Array.isArray(value)) return null;
  const result: NonNullable<Attestation['evidence']> = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) => !['type', 'uri', 'hash', 'description'].includes(key),
      )
    ) {
      return null;
    }
    result.push(row as unknown as NonNullable<Attestation['evidence']>[number]);
  }
  return result;
}

function readRequestId(body: Record<string, unknown>): string | null {
  const value = typeof body.request_id === 'string' ? body.request_id.trim() : '';
  return REQUEST_ID_RE.test(value) ? value : null;
}

function invalidRequestId(): AgentActionResponse {
  return {
    status: 400,
    body: { error: 'request_id must be 8-128 URL-safe characters' },
  };
}

function hasUnsafeDisplayText(value: string, allowNewline: boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (allowNewline && (code === 0x0a || code === 0x09)) continue;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function isJSONValue(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 500) || 'action failed';
}
