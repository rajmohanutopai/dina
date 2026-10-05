/**
 * Lane 1 gaps on Brain's side (design §4.2 (b), §6.2, A2A-I7; notes M1a,
 * M1b): where the proposal tools exist, how a delivery that arrives twice
 * lands in the chat, and what find_person hands the model on the server.
 */

import { deliverA2AOutcome } from '../../src/chat/a2a_deliverer';
import { deleteThread, getThread } from '../../src/chat/thread';
import { buildAgenticAskPipeline } from '../../src/composition/agentic_ask';
import { resetIdentityExtractor } from '../../src/pipeline/identity_extraction';
import { createFindPersonTool } from '../../src/reasoning/people_tool';
import { WorkflowEventConsumer, type WorkflowEventConsumerCoreClient } from '../../src/service/workflow_event_consumer';
import { setPeopleReadBackend } from '../../src/vault_context/assembly';
import { builderInput, type BuilderInput } from '../composition/ask_pipeline_input';

import type { A2AOperationStatus, Person, WorkflowEvent, WorkflowTask } from '@dina/core';


describe('the proposal tools exist only where Lane 1 runs and the ask names its conversation (notes M1a, M1b)', () => {
  const A2A_TOOLS = ['delegate_to_a2a_agent', 'list_a2a_agents'];
  const proposals: Record<string, unknown>[] = [];
  const a2aClient = {
    listA2AAgents: async () => [],
    delegateToA2AAgent: async (input: Record<string, unknown>) => {
      proposals.push(input);
      return { ok: true as const, operationId: 'op-1' };
    },
    a2aSelfDid: async () => 'did:plc:self',
  } as unknown as NonNullable<BuilderInput['a2aClient']>;
  const names = (tools: { toDefinitions(): { name: string }[] }) => tools.toDefinitions().map((t) => t.name);

  afterEach(() => resetIdentityExtractor());

  // Plan B70
  it('offers them to an ask that names its conversation on a host with an A2A client, bound to that conversation', async () => {
    const pipeline = buildAgenticAskPipeline(builderInput({ a2aClient }));
    const tools = pipeline.buildToolsForAsk?.({ askId: 'ask-1', requesterDid: 'did:key:owner', releaseSession: 'chat:t-7', replyTo: 't-7' });
    if (tools === undefined) throw new Error('no per-ask tools');
    expect(names(tools)).toEqual(expect.arrayContaining(A2A_TOOLS));
    await tools.execute('delegate_to_a2a_agent', { agent_id: 'a', skill: 's', message: 'Summarize the note.' });
    expect(proposals.at(-1)).toMatchObject({ releaseSession: 'chat:t-7', replyTo: 't-7' });
  });

  // Plan B70
  it('withholds them from a registry that serves no conversation, even with an A2A client', () => {
    const pipeline = buildAgenticAskPipeline(builderInput({ a2aClient }));
    expect(names(pipeline.tools).filter((n) => A2A_TOOLS.includes(n))).toEqual([]);
    const tools = pipeline.buildToolsForAsk?.({ askId: 'ask-2', requesterDid: 'did:key:owner' });
    expect(names(tools ?? pipeline.tools).filter((n) => A2A_TOOLS.includes(n))).toEqual([]);
  });

  // Plan B249
  it('withholds every A2A tool on a host with no A2A client (the phone), whatever the conversation', () => {
    const searching = { ...(builderInput().appViewClient as object), searchA2AAgents: async () => [] } as unknown as BuilderInput['appViewClient'];
    const pipeline = buildAgenticAskPipeline(builderInput({ appViewClient: searching }));
    const tools = pipeline.buildToolsForAsk?.({ askId: 'ask-3', requesterDid: 'did:key:owner', releaseSession: 'chat:main' });
    expect(names(tools ?? pipeline.tools).filter((n) => n.includes('a2a'))).toEqual([]);
    expect(names(pipeline.tools).filter((n) => n.includes('a2a'))).toEqual([]);
  });
});

describe('a delivery that arrives twice (notes M1a "idempotent by event id")', () => {
  const THREAD = 'lane1-thread-7';
  const dispatch: WorkflowTask = {
    id: 'a2a-dispatch-1',
    kind: 'delegation',
    status: 'completed',
    priority: 'user_blocking',
    description: 'Send to Summarizer: Summarize',
    payload: JSON.stringify({ type: 'a2a_dispatch', operation_id: 'op-7' }),
    result: JSON.stringify({ operation_id: 'op-7', outcome: 'held_for_guard' }),
    result_summary: 'result held for the guard',
    policy: '{}',
    created_at: 1,
    updated_at: 2,
  };
  const released: WorkflowEvent = {
    event_id: 77,
    task_id: dispatch.id,
    at: 3,
    event_kind: 'a2a_result_released',
    needs_delivery: true,
    delivery_attempts: 0,
    delivery_failed: false,
    details: '{"operation_id":"op-7"}',
  };
  const operation: A2AOperationStatus = {
    operation_id: 'op-7',
    state: 'completed',
    reason: null,
    agent_name: 'Summarizer',
    skill: 'summarize',
    reply_to: THREAD,
    result: { version: 1, parts: [{ text: 'The summary.' }] },
    updated_at: 4,
  };

  let deliveries = 0;

  /**
   * A consumer whose deliver stands in for the server's two hops: forward,
   * then append by event id. The real forwarding hop (core-server's
   * wire_workflow_plane.ts) runs in core-server's lane1_delivery_forward.test.ts.
   */
  function consumer(ack: () => Promise<boolean>) {
    const client: WorkflowEventConsumerCoreClient = {
      listWorkflowEvents: async () => [released],
      acknowledgeWorkflowEvent: ack,
      getWorkflowTask: async () => dispatch,
      getA2AOperation: async () => operation,
      failWorkflowEventDelivery: async () => true,
    };
    return new WorkflowEventConsumer({
      coreClient: client,
      deliver: ({ text, event, details }) => {
        const a2a = (details as { a2a?: { operation_id: string; reply_to: string | null } }).a2a;
        if (a2a === undefined) return;
        deliveries += 1;
        deliverA2AOutcome({ threadId: a2a.reply_to ?? 'main', text, eventId: event.event_id, operationId: a2a.operation_id });
      },
    });
  }

  afterEach(() => {
    deleteThread(THREAD);
    deleteThread('main');
  });

  // Plan X-5
  it('one event delivered again after a crash before its acknowledgement, and again after a restart, makes one chat message in the thread that asked', async () => {
    deleteThread(THREAD);
    deleteThread('main');
    // The first run delivers, then dies before Core hears the acknowledgement.
    await consumer(async () => {
      throw new Error('process died');
    }).runTick();
    // The same consumer retries; then a restarted one sees the event once more.
    const again = consumer(async () => true);
    await again.runTick();
    await consumer(async () => true).runTick();
    expect(deliveries).toBe(3);
    const thread = getThread(THREAD);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ type: 'dina', content: 'Summarizer answered:\n\nThe summary.' });
    expect(getThread('main')).toEqual([]);
  });
});

describe('find_person on the server (notes M1b second review)', () => {
  afterEach(() => setPeopleReadBackend(null));

  // Plan X-7
  it('hands the model no vault excerpt through Core’s people backend either, so no release goes unlogged', async () => {
    const person: Person = {
      personId: 'p-1',
      canonicalName: 'Emma',
      contactDid: '',
      relationshipHint: 'daughter',
      status: 'confirmed',
      createdFrom: 'llm',
      createdAt: 0,
      updatedAt: 0,
      surfaces: [
        {
          id: 1,
          personId: 'p-1',
          surface: 'Emma',
          normalizedSurface: 'emma',
          surfaceType: 'name',
          status: 'confirmed',
          confidence: 'high',
          sourceItemId: 'item-9',
          sourceExcerpt: 'VAULT-EXCERPT: Emma’s blood test came back fine.',
          extractorVersion: 'test',
          createdFrom: 'llm',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    setPeopleReadBackend({ peopleList: async () => [person], peopleFindByName: async () => [person] });
    const out = JSON.stringify(await createFindPersonTool().execute({ name: 'Emma' }));
    expect(out).toContain('Emma');
    expect(out).not.toContain('VAULT-EXCERPT');
    expect(out).not.toContain('blood test');
  });
});
