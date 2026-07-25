/**
 * Item 5c — the real memory-ingress backing (dina_remember).
 *
 * Drives the backing directly against an in-memory vault, proving a
 * provenance-preserving write through the origin seam (origin=staging_item,
 * source=agent DID) — not just a stubbed façade.
 */

import {
  clearVaults,
  getItem,
  createPersona,
  resetPersonaState,
  setWorkflowService,
  getWorkflowService,
  WorkflowService,
  WorkflowTaskKind,
  WorkflowTaskState,
  InMemoryWorkflowRepository,
  setAgentGrantRepository,
  getAgentGrantRepository,
  InMemoryAgentGrantRepository,
  setVaultRepository,
  InMemoryVaultRepository,
  setServiceConfigRepository,
  getServiceConfig,
  setServiceConfigDurable,
  setServiceQuerySender,
  resetServiceConfigState,
  InMemoryServiceConfigRepository,
  InMemoryReviewPublishRepository,
  addContact,
  resetContactDirectory,
  setPeopleRepository,
  resetStagingState,
  stagingClaim,
  stagingGetItem,
  stagingResolve,
  type AgentFacadeContext,
} from '@dina/core';
import { PDSPublisher, PDSPublisherError } from '@dina/brain';
import { setD2DSender } from '@dina/core/d2d';
import { createReminder, resetReminderState } from '@dina/core/reminders';

import { createAgentFacades } from '../src/agent/facades';

const AGENT = 'did:key:z6MkAgent';
const agentFacades = createAgentFacades();
const memory = agentFacades.memory!;
const memoryStatus = agentFacades.memoryStatus!;
const ctx = (body: Record<string, unknown>): AgentFacadeContext => ({ agentDid: AGENT, sessionId: 's1', body });
const rememberBody = (
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  content,
  request_id: 'remember-0001',
  ...extra,
});

beforeEach(() => {
  resetReminderState();
  resetStagingState();
  clearVaults(['general', 'professional']);
  resetPersonaState();
  // Free personas (auto-open) — an agent write passes the PEP without a grant.
  createPersona('general', 'default');
  createPersona('professional', 'standard'); // 'work' aliases to this
  // A sensitive persona for the gated-write case.
  createPersona('financial', 'sensitive');
  setVaultRepository('financial', new InMemoryVaultRepository());
  setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  setAgentGrantRepository(new InMemoryAgentGrantRepository());
  setServiceConfigRepository(new InMemoryServiceConfigRepository());
  resetServiceConfigState();
  const didToPerson = new Map<string, string>();
  setPeopleRepository({
    upsertContactPerson: (did: string) => {
      const personId = didToPerson.get(did) ?? `person-${didToPerson.size + 1}`;
      didToPerson.set(did, personId);
      return personId;
    },
    resolveByIdentity: (_type: string, did: string) => {
      const personId = didToPerson.get(did);
      return personId === undefined ? null : ({ personId } as never);
    },
    listIdentities: (personId: string) =>
      [...didToPerson.entries()]
        .filter(([, id]) => id === personId)
        .map(([did], index) => ({
          id: index + 1,
          personId,
          identityType: 'did',
          identityValue: did,
          verified: true,
          primary: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
  } as never);
  resetContactDirectory();
  addContact('did:plc:bob', 'Bob', 'trusted', 'full');
});
afterEach(() => {
  resetReminderState();
  resetStagingState();
  resetPersonaState();
  resetContactDirectory();
  setPeopleRepository(null);
  setD2DSender(null);
  setWorkflowService(null);
  setAgentGrantRepository(null);
  setServiceConfigRepository(null);
  setServiceQuerySender(null);
  resetServiceConfigState();
});

describe('memory ingress backing', () => {
  it('stages content with authenticated provenance for Brain classification', () => {
    const res = memory(ctx(rememberBody('the wifi password rotates monthly'))) as {
      status: number;
      body: { id: string; status: string };
    };
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('processing');
    const item = stagingGetItem(res.body.id);
    expect(item).not.toBeNull();
    expect(item?.data.body).toBe('the wifi password rotates monthly');
    expect(item?.data.type).toBe('user_memory');
    expect(item?.source).toBe('agent_remember');
    expect(item?.producer_id).toBe(AGENT);
    expect(item?.data.agent_session).toBe('s1');
    expect(getItem('general', res.body.id)).toBeNull();
  });

  it('records an explicit canonical persona for the shared drain', () => {
    const res = memory(ctx(rememberBody('work note', { persona: 'work' }))) as {
      status: number;
      body: { id: string };
    };
    expect(res.status).toBe(202);
    expect(stagingGetItem(res.body.id)?.data.requested_persona).toBe('professional');
  });

  it('uses an explicit summary when provided', () => {
    const res = memory(ctx(rememberBody('long body '.repeat(20), { summary: 'short' }))) as {
      status: number;
      body: { id: string };
    };
    expect(stagingGetItem(res.body.id)?.data.summary).toBe('short');
  });

  it('400 on missing content', () => {
    expect((memory(ctx({ request_id: 'remember-0001' })) as { status: number }).status).toBe(400);
    expect((memory(ctx(rememberBody('   '))) as { status: number }).status).toBe(400);
  });

  it('413 on oversized content', () => {
    const res = memory(ctx(rememberBody('x'.repeat(32 * 1024 + 1)))) as { status: number };
    expect(res.status).toBe(413);
  });

  it('measures the memory limit in UTF-8 bytes', () => {
    const res = memory(ctx(rememberBody('\u20ac'.repeat(11 * 1024)))) as {
      status: number;
    };
    expect(res.status).toBe(413);
  });

  it('SECURITY: a classified SENSITIVE target is projected as pending approval', () => {
    const res = memory(ctx(rememberBody('Owner pre-authorized a $50k wire', {
      persona: 'financial',
    }))) as {
      status: number;
      body: { id: string };
    };
    expect(stagingClaim(1)).toHaveLength(1);
    stagingResolve(res.body.id, 'financial', false, {
      type: 'user_memory',
      summary: 'Financial note',
      body: 'Owner pre-authorized a $50k wire',
    });
    const status = memoryStatus(ctx({ item_id: res.body.id })) as {
      status: number;
      body: { status?: string; task_id?: string };
    };
    expect(status.status).toBe(202);
    expect(status.body.status).toBe('pending_approval');
    expect(status.body.task_id).toBeTruthy();
    expect(getItem('financial', `stg-${res.body.id}`)).toBeNull();
  });

  it('400 on an unknown persona', () => {
    const res = memory(ctx(rememberBody('x', { persona: 'nonexistent' }))) as { status: number };
    expect(res.status).toBe(400);
  });

  it('canonicalises a whitespace-padded persona consistently', () => {
    const res = memory(ctx(rememberBody('padded', { persona: '  general  ' }))) as {
      status: number;
      body: { id: string };
    };
    expect(res.status).toBe(202);
    expect(stagingGetItem(res.body.id)?.data.requested_persona).toBe('general');
  });

  it('deduplicates an identical request and rejects changed payload semantics', () => {
    const first = memory(ctx(rememberBody('same note'))) as {
      status: number;
      body: { id: string; duplicate?: boolean };
    };
    const retry = memory(ctx(rememberBody('same note'))) as {
      status: number;
      body: { id: string; duplicate?: boolean };
    };
    const changed = memory(ctx(rememberBody('different note'))) as {
      status: number;
      body: { error?: string };
    };
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.duplicate).toBe(true);
    expect(changed.status).toBe(409);
    expect(changed.body.error).toBe('request_id_conflict');
  });

  it('does not expose another agent or session staging row through status', () => {
    const created = memory(ctx(rememberBody('owned note'))) as {
      body: { id: string };
    };
    const otherAgent = memoryStatus({
      agentDid: 'did:key:z6MkOther',
      sessionId: 's1',
      body: { item_id: created.body.id },
    }) as { status: number };
    const otherSession = memoryStatus({
      agentDid: AGENT,
      sessionId: 's2',
      body: { item_id: created.body.id },
    }) as { status: number };
    expect(otherAgent.status).toBe(404);
    expect(otherSession.status).toBe(404);
  });
});

describe('service-query status projection', () => {
  function createServiceTask(
    id: string,
    ownerDid = AGENT,
    ownerSession = 's1',
    payloadExtra: Record<string, unknown> = {},
  ): void {
    const workflow = getWorkflowService()!;
    workflow.create({
      id,
      kind: WorkflowTaskKind.ServiceQuery,
      description: 'service query',
      payload: JSON.stringify({
        requester_agent_did: ownerDid,
        requester_session_id: ownerSession,
        params: { private: 'must not leak' },
        ...payloadExtra,
      }),
      correlationId: `query-${id}`,
      origin: 'api',
    });
    workflow
      .store()
      .transition(id, WorkflowTaskState.Created, WorkflowTaskState.Running, Date.now());
  }

  it('returns a bounded status/result projection to the creating agent session', () => {
    createServiceTask('sq-own');
    getWorkflowService()!.complete(
      'sq-own',
      JSON.stringify({ answer: '10:30' }),
      '10:30 is available',
    );

    const status = createAgentFacades().serviceStatus!;
    const result = status(ctx({ task_id: 'sq-own' })) as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      task_id: 'sq-own',
      status: WorkflowTaskState.Completed,
      query_id: 'query-sq-own',
      result_summary: '10:30 is available',
      result: { answer: '10:30' },
    });
    expect(result.body).not.toHaveProperty('payload');
    expect(result.body).not.toHaveProperty('params');
  });

  it('collapses another agent, another session, and malformed ownership to 404', () => {
    createServiceTask('sq-other-agent', 'did:key:zOther', 's1');
    createServiceTask('sq-other-session', AGENT, 's2');
    const workflow = getWorkflowService()!;
    workflow.create({
      id: 'sq-corrupt',
      kind: WorkflowTaskKind.ServiceQuery,
      description: 'corrupt',
      payload: '{',
      origin: 'api',
    });
    workflow
      .store()
      .transition(
        'sq-corrupt',
        WorkflowTaskState.Created,
        WorkflowTaskState.Running,
        Date.now(),
      );
    const status = createAgentFacades().serviceStatus!;

    for (const taskId of ['sq-other-agent', 'sq-other-session', 'sq-corrupt', 'missing']) {
      expect(status(ctx({ task_id: taskId }))).toMatchObject({
        status: 404,
        body: { error: 'service query not found' },
      });
    }
  });

  it('rejects a missing task id without reading the repository', () => {
    const status = createAgentFacades().serviceStatus!;
    expect(status(ctx({}))).toMatchObject({
      status: 400,
      body: { error: 'missing required field: task_id' },
    });
  });

  it('omits oversized structured service results while retaining the summary', () => {
    createServiceTask('sq-large');
    getWorkflowService()!.complete(
      'sq-large',
      JSON.stringify({ answer: 'x'.repeat(33 * 1024) }),
      'The service returned a large result',
    );

    const status = createAgentFacades().serviceStatus!;
    const result = status(ctx({ task_id: 'sq-large' })) as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(result).toMatchObject({
      status: 200,
      body: {
        result_summary: 'The service returned a large result',
        result_omitted: 'result exceeds 32 KiB',
      },
    });
    expect(result.body).not.toHaveProperty('result');
  });
});

describe('service publication projection', () => {
  it('returns the durable receipt without exposing the listing config', async () => {
    const repo = new InMemoryServiceConfigRepository();
    setServiceConfigRepository(repo);
    await repo.put('salon', '{"secret":"not projected"}', 1);
    await repo.setPublicationStatus('salon', {
      state: 'published',
      uri: 'at://did:plc:owner/com.dinakernel.service.profile/salon',
      cid: 'bafyreceipt',
      attemptedAtMs: 123,
    });

    const status = createAgentFacades().servicePublicationStatus!;
    const result = (await status(ctx({ rkey: 'salon' }))) as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(result).toMatchObject({
      status: 200,
      body: {
        rkey: 'salon',
        publication_status: 'published',
        cid: 'bafyreceipt',
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('secret');
  });

  it('does not claim a durable retry is possible without a PDS identity', async () => {
    const repo = new InMemoryServiceConfigRepository();
    setServiceConfigRepository(repo);
    await setServiceConfigDurable(
      {
        isDiscoverable: true,
        discoverability: 'public',
        status: 'active',
        name: 'Salon',
        capabilities: {
          appointment_book: {
            mcpServer: 'salon',
            mcpTool: 'appointment_book',
            responsePolicy: 'review',
            category: 'appointments',
          },
        },
      },
      'salon',
    );

    const status = createAgentFacades().servicePublicationStatus!;
    const result = await status(ctx({ rkey: 'salon' }));

    expect(result).toMatchObject({
      status: 200,
      body: {
        rkey: 'salon',
        publication_status: 'not_configured',
        stored_status: 'pending',
        can_publish: false,
        last_error: expect.stringContaining('--pds-handle'),
      },
    });
  });

  it('reports a pending durable retry when a PDS publisher is wired', async () => {
    const repo = new InMemoryServiceConfigRepository();
    setServiceConfigRepository(repo);
    await repo.put('salon', '{"name":"Salon"}', 1);

    const status = createAgentFacades({
      pdsPublisher: {} as PDSPublisher,
      ownerDid: 'did:plc:owner',
    }).servicePublicationStatus!;
    const result = await status(ctx({ rkey: 'salon' }));

    expect(result).toMatchObject({
      status: 200,
      body: {
        rkey: 'salon',
        publication_status: 'pending',
        can_publish: true,
        last_error: null,
      },
    });
    expect(result.body).not.toHaveProperty('stored_status');
  });

  it('keeps a known-only listing valid without a PDS identity', async () => {
    const repo = new InMemoryServiceConfigRepository();
    setServiceConfigRepository(repo);
    const config = {
      isDiscoverable: false,
      discoverability: 'known_only',
      status: 'active',
      name: 'Private Salon',
      capabilities: {
        appointment_book: {
          mcpServer: 'salon',
          mcpTool: 'appointment_book',
          responsePolicy: 'review',
          category: 'appointments',
        },
      },
    } as const;
    await setServiceConfigDurable(config, 'private-salon');

    const status = createAgentFacades().servicePublicationStatus!;
    const result = await status(ctx({ rkey: 'private-salon' }));

    expect(result).toMatchObject({
      status: 200,
      body: {
        publication_status: 'not_published',
        stored_status: 'pending',
        can_publish: false,
        last_error: null,
      },
    });
  });

  it('rejects invalid and unknown listing keys', async () => {
    const status = createAgentFacades().servicePublicationStatus!;
    expect(await status(ctx({ rkey: '../salon' }))).toMatchObject({ status: 400 });
    expect(await status(ctx({ rkey: 'missing' }))).toMatchObject({ status: 404 });
  });
});

describe('owner-approved service mutation facades', () => {
  const serviceConfig = {
    isDiscoverable: true,
    discoverability: 'public',
    status: 'active',
    name: 'Alonso Salon',
    description: 'Appointment availability and booking.',
    vaultPersona: 'general',
    capabilities: {
      appointment_book: {
        mcpServer: 'salon',
        mcpTool: 'appointment_book',
        responsePolicy: 'review',
        category: 'appointments',
      },
    },
  } as const;

  it('validates and binds a service publication before writing it', async () => {
    const facades = createAgentFacades();
    const request = {
      request_id: 'service-publish-request-0001',
      rkey: 'salon',
      config: serviceConfig,
    };

    const pending = (await facades.servicePublish!(ctx(request))) as {
      status: number;
      body: { task_id: string };
    };
    expect(pending).toMatchObject({
      status: 202,
      body: { status: 'pending_approval' },
    });
    expect(getServiceConfig('salon')).toBeNull();

    getWorkflowService()!.approve(pending.body.task_id);
    const completed = await facades.actionStatus!(
      ctx({ action: 'service_publish', request_id: request.request_id }),
    );
    expect(completed).toMatchObject({
      status: 200,
      body: {
        status: WorkflowTaskState.Completed,
        action: 'service_publish',
        rkey: 'salon',
        saved: true,
        publication_status: 'pending',
      },
    });
    expect(getServiceConfig('salon')).toEqual(serviceConfig);
  });

  it('rejects invalid service configs before creating an approval', async () => {
    const result = await createAgentFacades().servicePublish!(
      ctx({
        request_id: 'service-publish-request-0002',
        rkey: 'salon',
        config: { ...serviceConfig, capabilities: {} },
      }),
    );
    expect(result).toMatchObject({ status: 400 });
    expect(
      getWorkflowService()!.store().listByKindAndState(
        WorkflowTaskKind.Approval,
        WorkflowTaskState.PendingApproval,
        20,
      ),
    ).toHaveLength(0);
  });

  it('rejects changed publication semantics under one stable request id', async () => {
    const publish = createAgentFacades().servicePublish!;
    const request = {
      request_id: 'service-publish-request-0003',
      rkey: 'salon',
      config: serviceConfig,
    };
    expect(await publish(ctx(request))).toMatchObject({ status: 202 });
    expect(
      await publish(
        ctx({
          ...request,
          config: { ...serviceConfig, name: 'Changed Salon' },
        }),
      ),
    ).toMatchObject({ status: 409, body: { error: 'request_id_conflict' } });
  });

  it('does not send a service query until approval, then sends exactly once', async () => {
    const sender = jest.fn(async () => undefined);
    setServiceQuerySender(sender);
    const facades = createAgentFacades();
    const request = {
      request_id: 'service-invoke-request-0001',
      to_did: 'did:plc:provider',
      capability: 'appointment_book',
      params: { date: '2026-07-28', time: '10:30' },
      ttl_seconds: 300,
      service_name: 'Alonso Salon',
    };

    const pending = (await facades.serviceInvoke!(ctx(request))) as {
      status: number;
      body: { task_id: string };
    };
    expect(pending).toMatchObject({
      status: 202,
      body: { status: 'pending_approval' },
    });
    expect(sender).not.toHaveBeenCalled();

    getWorkflowService()!.approve(pending.body.task_id);
    const completed = (await facades.actionStatus!(
      ctx({ action: 'service_invoke', request_id: request.request_id }),
    )) as { status: number; body: Record<string, unknown> };
    expect(completed).toMatchObject({
      status: 200,
      body: {
        status: WorkflowTaskState.Completed,
        action: 'service_invoke',
        service_task_id: expect.stringMatching(/^sq-agent-/),
        query_id: expect.stringMatching(/^agent-/),
      },
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(
      request.to_did,
      'service.query',
      expect.objectContaining({
        capability: request.capability,
        params: request.params,
        ttl_seconds: request.ttl_seconds,
      }),
    );

    await facades.actionStatus!(
      ctx({ action: 'service_invoke', request_id: request.request_id }),
    );
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid or non-visible service params before approval', async () => {
    const invoke = createAgentFacades().serviceInvoke!;
    expect(
      await invoke(
        ctx({
          request_id: 'service-invoke-request-0002',
          to_did: 'not-a-did',
          capability: 'appointment_book',
          params: {},
          ttl_seconds: 300,
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await invoke(
        ctx({
          request_id: 'service-invoke-request-0003',
          to_did: 'did:plc:provider',
          capability: 'appointment_book',
          params: { private_note: 'x'.repeat(3_100) },
          ttl_seconds: 300,
        }),
      ),
    ).toMatchObject({ status: 413 });
  });
});

describe('Talk facade', () => {
  const request = {
    request_id: 'talk-request-0001',
    contact: 'Bob',
    text: 'Can we speak tomorrow?',
  };

  it('requires owner approval, then status polling sends exactly once', async () => {
    const sender = jest.fn(async () => ({
      messageId: 'wire-message-1',
      delivered: true,
      buffered: false,
      queued: false,
    }));
    setD2DSender(sender);
    const facades = createAgentFacades();

    const pending = (await facades.talk!(ctx(request))) as {
      status: number;
      body: { status: string; task_id: string };
    };
    expect(pending).toMatchObject({
      status: 202,
      body: { status: 'pending_approval' },
    });
    expect(sender).not.toHaveBeenCalled();

    getWorkflowService()!.approve(pending.body.task_id);
    const completed = (await facades.actionStatus!(
      ctx({ action: 'talk', request_id: request.request_id }),
    )) as { status: number; body: Record<string, unknown> };

    expect(completed).toMatchObject({
      status: 200,
      body: {
        status: WorkflowTaskState.Completed,
        action: 'talk',
        delivery_status: 'sent',
        recipient_did: 'did:plc:bob',
      },
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(
      'did:plc:bob',
      'talk.message.v1',
      { text: request.text },
      expect.objectContaining({
        dataCategories: ['message_text'],
        messageId: expect.stringMatching(/^d2d-talk-/),
      }),
    );

    await facades.actionStatus!(
      ctx({ action: 'talk', request_id: request.request_id }),
    );
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('rejects changed semantics under the same request id', async () => {
    setD2DSender(jest.fn(async () => undefined));
    const talk = createAgentFacades().talk!;
    expect(await talk(ctx(request))).toMatchObject({ status: 202 });
    expect(await talk(ctx({ ...request, text: 'A changed message' }))).toMatchObject({
      status: 409,
      body: { error: 'request_id_conflict' },
    });
  });

  it('does not create approval cards for unknown contacts or unsafe text', async () => {
    const talk = createAgentFacades().talk!;
    expect(
      await talk(ctx({ ...request, contact: 'Mallory', request_id: 'talk-request-0002' })),
    ).toMatchObject({ status: 404, body: { error: 'contact_not_found' } });
    expect(
      await talk(
        ctx({
          ...request,
          text: 'pay alice\u202Etxt.exe',
          request_id: 'talk-request-0003',
        }),
      ),
    ).toMatchObject({ status: 400 });
  });

  it('collapses a denied action to a terminal non-success response', async () => {
    const facades = createAgentFacades();
    const pending = (await facades.talk!(ctx(request))) as {
      body: { task_id: string };
    };
    getWorkflowService()!.cancel(pending.body.task_id, 'owner denied');
    expect(
      await facades.actionStatus!(
        ctx({ action: 'talk', request_id: request.request_id }),
      ),
    ).toMatchObject({
      status: 403,
      body: { status: WorkflowTaskState.Cancelled },
    });
  });

  it('single-flights overlapping execution after approval', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sender = jest.fn(async () => {
      await gate;
      return { messageId: 'wire', delivered: true, buffered: false, queued: false };
    });
    setD2DSender(sender);
    const facades = createAgentFacades();
    const pending = (await facades.talk!(ctx(request))) as {
      body: { task_id: string };
    };
    getWorkflowService()!.approve(pending.body.task_id);

    const first = facades.actionStatus!(
      ctx({ action: 'talk', request_id: request.request_id }),
    );
    const second = facades.actionStatus!(
      ctx({ action: 'talk', request_id: request.request_id }),
    );
    await Promise.resolve();
    expect(sender).toHaveBeenCalledTimes(1);
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 202]);
  });
});

describe('delegation facade', () => {
  const request = {
    request_id: 'delegate-request-0001',
    runner: 'openclaw',
    description: 'Compare the two supplied documents.',
    input: { document_ids: ['a', 'b'] },
  };

  it('creates only an approval before consent and one deterministic queued task after', async () => {
    const facades = createAgentFacades();
    const pending = (await facades.delegate!(ctx(request))) as {
      status: number;
      body: { task_id: string };
    };
    expect(pending.status).toBe(202);
    expect(
      getWorkflowService()!.store().listByKindAndState(
        WorkflowTaskKind.Delegation,
        WorkflowTaskState.Queued,
        10,
      ),
    ).toHaveLength(0);

    getWorkflowService()!.approve(pending.body.task_id);
    const completed = (await facades.actionStatus!(
      ctx({ action: 'delegate', request_id: request.request_id }),
    )) as { status: number; body: Record<string, unknown> };
    expect(completed).toMatchObject({
      status: 200,
      body: {
        status: WorkflowTaskState.Completed,
        delegation_submit_status: 'queued',
        delegation_status: WorkflowTaskState.Queued,
      },
    });
    const tasks = getWorkflowService()!.store().listByKindAndState(
      WorkflowTaskKind.Delegation,
      WorkflowTaskState.Queued,
      10,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      requested_runner: 'openclaw',
      origin: 'agent',
      description: request.description,
    });

    await facades.actionStatus!(
      ctx({ action: 'delegate', request_id: request.request_id }),
    );
    expect(
      getWorkflowService()!.store().listByKindAndState(
        WorkflowTaskKind.Delegation,
        WorkflowTaskState.Queued,
        10,
      ),
    ).toHaveLength(1);
  });

  it('rejects internal runner lanes and non-JSON input before approval', async () => {
    const delegate = createAgentFacades().delegate!;
    expect(await delegate(ctx({ ...request, runner: 'dina.local' }))).toMatchObject({
      status: 400,
    });
    expect(
      await delegate(
        ctx({
          ...request,
          request_id: 'delegate-request-0002',
          input: BigInt(1),
        }),
      ),
    ).toMatchObject({ status: 400 });
  });
});

describe('PeerLens facades', () => {
  const review = {
    request_id: 'review-request-0001',
    record: {
      subject: { type: 'product', identifier: 'chair-123', name: 'Chair 123' },
      category: 'furniture',
      sentiment: 'positive',
      text: 'Supportive during long work sessions.',
      tags: ['ergonomic'],
      confidence: 'high',
    },
  };

  function fakePublisher(options: {
    putRecord?: jest.Mock;
    authenticatedDid?: string;
  } = {}): PDSPublisher {
    return {
      authenticate: jest.fn(async () => options.authenticatedDid ?? 'did:plc:owner'),
      putRecord:
        options.putRecord ??
        jest.fn(async () => ({
          uri: 'at://did:plc:owner/com.dinakernel.peerlens.attestation/agent-review',
          cid: 'bafyreireview',
        })),
    } as unknown as PDSPublisher;
  }

  it('requires owner approval, stamps agent provenance, and publishes once', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const publisher = fakePublisher();
    const now = Date.now();
    const facades = createAgentFacades({
      pdsPublisher: publisher,
      ownerDid: 'did:plc:owner',
      reviewPublishRepository: repo,
      now: () => now,
    });

    const pending = (await facades.peerlensAttest!(ctx(review))) as {
      status: number;
      body: { task_id: string };
    };
    expect(pending).toMatchObject({
      status: 202,
      body: { status: 'pending_approval' },
    });
    expect(repo.listForOwnerWithReceipts('did:plc:owner')).toHaveLength(0);
    expect(publisher.putRecord).not.toHaveBeenCalled();

    getWorkflowService()!.approve(pending.body.task_id);
    const completed = (await facades.peerlensStatus!(
      ctx({ request_id: review.request_id }),
    )) as { status: number; body: Record<string, unknown> };

    expect(completed).toMatchObject({
      status: 200,
      body: {
        publish_status: 'published',
        uri: expect.stringContaining('com.dinakernel.peerlens.attestation'),
      },
    });
    expect(publisher.putRecord).toHaveBeenCalledTimes(1);
    expect(publisher.putRecord).toHaveBeenCalledWith(
      'com.dinakernel.peerlens.attestation',
      expect.stringMatching(/^agent-[0-9a-f]{32}$/),
      expect.objectContaining({
        ...review.record,
        $type: 'com.dinakernel.peerlens.attestation',
        createdAt: new Date(now).toISOString(),
        isAgentGenerated: true,
      }),
    );

    await facades.peerlensStatus!(ctx({ request_id: review.request_id }));
    expect(publisher.putRecord).toHaveBeenCalledTimes(1);
  });

  it('queues a retryable PDS failure without losing the approved review', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const now = Date.now();
    const publisher = fakePublisher({
      putRecord: jest.fn(async () => {
        throw new PDSPublisherError('PDS unavailable', 503);
      }),
    });
    const facades = createAgentFacades({
      pdsPublisher: publisher,
      ownerDid: 'did:plc:owner',
      reviewPublishRepository: repo,
      now: () => now,
    });
    const pending = (await facades.peerlensAttest!(ctx(review))) as {
      body: { task_id: string };
    };
    getWorkflowService()!.approve(pending.body.task_id);

    const result = await facades.peerlensStatus!(ctx({ request_id: review.request_id }));
    expect(result).toMatchObject({
      status: 202,
      body: {
        publish_status: 'queued',
        attempts: 1,
        error_code: 'server_5xx',
      },
    });
    expect(repo.listForOwner('did:plc:owner')).toHaveLength(1);
  });

  it('rejects unsupported public fields and missing credentials before approval', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const noCredentials = createAgentFacades({ reviewPublishRepository: repo });
    expect(await noCredentials.peerlensAttest!(ctx(review))).toMatchObject({
      status: 409,
      body: { error: 'no_credentials' },
    });
    expect(
      await createAgentFacades({
        pdsPublisher: fakePublisher(),
        ownerDid: 'did:plc:owner',
        reviewPublishRepository: repo,
      }).peerlensAttest!(
        ctx({
          ...review,
          request_id: 'review-request-0002',
          record: { ...review.record, createdAt: '2000-01-01T00:00:00Z' },
        }),
      ),
    ).toMatchObject({
      status: 400,
      body: { error: 'lexicon_invalid' },
    });
    expect(
      getWorkflowService()!.store().listByKindAndState(
        WorkflowTaskKind.Approval,
        WorkflowTaskState.PendingApproval,
        20,
      ),
    ).toHaveLength(0);
  });

  it('bounds PeerLens search input and strips unapproved AppView fields', async () => {
    const fetchImpl = jest.fn(async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              uri: 'at://did:plc:reviewer/com.dinakernel.peerlens.attestation/r1',
              cid: 'bafyreicid',
              authorDid: 'did:plc:reviewer',
              authorHandle: 'reviewer.example',
              subjectId: 'product:chair-123',
              subjectRefRaw: {
                type: 'product',
                identifier: 'chair-123',
                name: 'Chair 123',
              },
              category: 'furniture',
              sentiment: 'positive',
              text: 'A useful review',
              tags: ['ergonomic'],
              privateInternalColumn: 'must not escape',
            },
          ],
          totalEstimate: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const search = createAgentFacades({
      appViewUrl: 'https://appview.example',
      fetchImpl: fetchImpl as typeof fetch,
    }).peerlensSearch!;

    const result = await search(
      ctx({ q: 'chair', sentiment: 'positive', limit: 5 }),
    );
    expect(result).toMatchObject({
      status: 200,
      body: {
        results: [
          {
            authorDid: 'did:plc:reviewer',
            subject: { type: 'product', identifier: 'chair-123' },
            sentiment: 'positive',
          },
        ],
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('privateInternalColumn');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('q=chair'),
      expect.any(Object),
    );
    expect(await search(ctx({ limit: 500 }))).toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('bounded vault and reminder projections', () => {
  it('lists vault metadata without contents or runtime-open state', () => {
    const result = createAgentFacades().vaults!(ctx({})) as {
      status: number;
      body: { vaults: Array<Record<string, unknown>> };
    };
    expect(result.status).toBe(200);
    expect(result.body.vaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'general', readable: true, access: 'session' }),
        expect.objectContaining({
          name: 'financial',
          readable: false,
          access: 'approval_required',
        }),
      ]),
    );
    expect(JSON.stringify(result.body)).not.toContain('isOpen');
    expect(JSON.stringify(result.body)).not.toContain('description');
  });

  it('returns reminders only from personas readable by the exact session', () => {
    createReminder({
      message: 'Buy milk',
      due_at: Date.now() + 1_000,
      persona: 'general',
    });
    createReminder({
      message: 'Pay the private invoice',
      due_at: Date.now() + 2_000,
      persona: 'financial',
    });
    const facades = createAgentFacades();

    const before = facades.reminders!(ctx({ limit: 10 })) as {
      status: number;
      body: { reminders: Array<{ message: string }>; restricted_personas: string[] };
    };
    expect(before.body.reminders.map((item) => item.message)).toEqual(['Buy milk']);
    expect(before.body.restricted_personas).toContain('financial');

    getAgentGrantRepository()!.insert({
      id: 'grant-financial-read',
      sessionId: 's1',
      agentDID: AGENT,
      persona: 'financial',
      mode: 'read',
      scopeJson: '{}',
      approvalTaskId: 'approval-1',
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    const after = facades.reminders!(ctx({ limit: 10 })) as {
      body: { reminders: Array<{ message: string }>; restricted_personas: string[] };
    };
    expect(after.body.reminders.map((item) => item.message)).toEqual([
      'Buy milk',
      'Pay the private invoice',
    ]);
    expect(after.body.restricted_personas).not.toContain('financial');

    const otherSession = facades.reminders!({
      agentDid: AGENT,
      sessionId: 's2',
      body: { limit: 10 },
    }) as { body: { reminders: Array<{ message: string }> } };
    expect(otherSession.body.reminders.map((item) => item.message)).toEqual(['Buy milk']);
  });

  it('rejects unbounded reminder requests', () => {
    expect(createAgentFacades().reminders!(ctx({ limit: 101 }))).toMatchObject({
      status: 400,
    });
  });
});
