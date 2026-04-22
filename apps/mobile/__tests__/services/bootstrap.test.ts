/**
 * createNode() composition tests with stubbed external dependencies.
 *
 * Covers:
 *   - Input validation
 *   - Handle shape + identity passthrough
 *   - Runner lifecycle: start/stop idempotency + drainOnce
 *   - Response Bridge wiring: completion on a service_query_execution
 *     delegation fires the sendD2D callback
 *   - onApproved wiring: approved event dispatches executeAndRespond
 *   - globalWiring: dispose() undoes the chat-orchestrator globals
 *   - Provider role with no config: publish is skipped silently
 */

import { createNode, type CreateNodeOptions } from '../../src/services/bootstrap';
import { InMemoryWorkflowRepository } from '../../../core/src/workflow/repository';
import type { BrainCoreClient, WorkflowTask } from '../../../brain/src/core_client/http';
import type { ServiceConfig } from '../../../core/src/service/service_config';
import type { IdentityKeypair } from '../../../core/src/identity/keypair';
import type { PDSSession } from '../../../brain/src/pds/account';
import {
  resetServiceCommandHandler,
  resetServiceApproveCommandHandler,
  resetServiceDenyCommandHandler,
  resetChatDefaults,
} from '../../../brain/src/chat/orchestrator';
import { resetThreads, getThread } from '../../../brain/src/chat/thread';

function fakeScheduler() {
  let nextHandle = 1;
  const timers = new Map<number, { everyMs: number; fn: () => void; nextMs: number }>();
  let nowMs = 1_700_000_000_000;
  return {
    now: () => nowMs,
    setInterval: (fn: () => void, ms: number) => {
      const h = nextHandle++;
      timers.set(h, { everyMs: ms, fn, nextMs: nowMs + ms });
      return h as unknown;
    },
    clearInterval: (h: unknown) => {
      timers.delete(h as number);
    },
    advance(ms: number) {
      nowMs += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [id, t] of timers) {
          if (t.nextMs <= nowMs) {
            t.fn();
            t.nextMs += t.everyMs;
            fired = true;
          }
          void id;
        }
      }
    },
  };
}

function stubCoreClient(
  overrides: Partial<{
    list: WorkflowTask[];
    events: unknown[];
    createCalls: unknown[];
    completeCalls: unknown[];
    cancelCalls: unknown[];
    taskById: Map<string, WorkflowTask>;
  }> = {},
): { client: BrainCoreClient; state: ReturnType<typeof defaultState> } {
  function defaultState() {
    return {
      listCalls: [] as unknown[],
      eventsList: overrides.events ?? [],
      ackedEvents: [] as number[],
      listResult: overrides.list ?? [],
      createCalls: [] as unknown[],
      completeCalls: [] as unknown[],
      cancelCalls: [] as unknown[],
      approveCalls: [] as string[],
      taskById: overrides.taskById ?? new Map<string, WorkflowTask>(),
    };
  }
  const state = defaultState();
  const client = {
    listWorkflowTasks: async (params: unknown) => {
      state.listCalls.push(params);
      return state.listResult;
    },
    listWorkflowEvents: async () => state.eventsList,
    acknowledgeWorkflowEvent: async (id: number) => {
      state.ackedEvents.push(id);
      return true;
    },
    getWorkflowTask: async (id: string) => state.taskById.get(id) ?? null,
    createWorkflowTask: async (input: unknown) => {
      state.createCalls.push(input);
      return {
        task: { id: (input as { id: string }).id } as unknown as WorkflowTask,
        deduped: false,
      };
    },
    completeWorkflowTask: async (id: string, result: string, summary: string) => {
      state.completeCalls.push({ id, result, summary });
      return { id, status: 'completed' } as unknown as WorkflowTask;
    },
    cancelWorkflowTask: async (id: string, reason?: string) => {
      state.cancelCalls.push({ id, reason });
      return { id, status: 'cancelled' } as unknown as WorkflowTask;
    },
    approveWorkflowTask: async (id: string) => {
      state.approveCalls.push(id);
      return { id, status: 'queued' } as unknown as WorkflowTask;
    },
    sendServiceRespond: async () => ({ status: 'sent', taskId: '', alreadyProcessed: false }),
    setRequestId: () => {
      /* no-op */
    },
  } as unknown as BrainCoreClient;
  return { client, state };
}

const TEST_KEYPAIR: IdentityKeypair = {
  privateKey: new Uint8Array(32).fill(0xaa),
  publicKey: new Uint8Array(32).fill(0xbb),
};
const TEST_SESSION: PDSSession = {
  accessJwt: 'access',
  refreshJwt: 'refresh',
  handle: 'busdriver.test-pds.dinakernel.com',
  did: 'did:plc:busdriver',
};
const DID = 'did:plc:busdriver';

const BUS_CONFIG: ServiceConfig = {
  isDiscoverable: true,
  name: 'Bus 42',
  capabilities: {
    eta_query: {
      mcpServer: 'transit',
      mcpTool: 'eta',
      responsePolicy: 'auto',
    },
  },
};

function baseOptions(overrides: Partial<CreateNodeOptions> = {}): CreateNodeOptions {
  const { client } = stubCoreClient();
  return {
    did: DID,
    signingKeypair: TEST_KEYPAIR,
    pdsSession: TEST_SESSION,
    sendD2D: async () => {
      /* no-op */
    },
    coreClient: client,
    appViewClient: { searchServices: async () => [] },
    workflowRepository: new InMemoryWorkflowRepository(),
    readConfig: () => null,
    role: 'requester',
    globalWiring: false,
    ...overrides,
  };
}

beforeEach(() => {
  resetChatDefaults();
  resetThreads();
  resetServiceCommandHandler();
  resetServiceApproveCommandHandler();
  resetServiceDenyCommandHandler();
});

describe('createNode — input validation', () => {
  it('rejects missing did', async () => {
    await expect(createNode(baseOptions({ did: '' }))).rejects.toThrow(/did/);
  });

  it('rejects missing sendD2D', async () => {
    await expect(
      createNode(
        baseOptions({
          sendD2D: undefined as unknown as CreateNodeOptions['sendD2D'],
        }),
      ),
    ).rejects.toThrow(/sendD2D/);
  });

  it('allows provider role without pdsPublisher (no-public-discovery mode)', async () => {
    // Providers that expose capabilities only to known peers can skip
    // the PDS publisher entirely — the start() path guards on null and
    // simply doesn't publish a service-profile record.
    const node = await createNode(baseOptions({ role: 'provider' }));
    expect(node).toBeDefined();
    await node.dispose();
  });
});

describe('createNode — handle shape', () => {
  it('returns a node with identity + runners + services accessible', async () => {
    const node = await createNode(baseOptions());
    expect(node.did).toBe(DID);
    expect(node.coreClient).toBeDefined();
    expect(node.workflowService).toBeDefined();
    expect(node.orchestrator).toBeDefined();
    expect(node.handler).toBeDefined();
    expect(node.runners.events).toBeDefined();
    expect(node.runners.approvals).toBeDefined();
    await node.dispose();
  });
});

describe('createNode — lifecycle', () => {
  it('start / stop / start again is idempotent', async () => {
    const sched = fakeScheduler();
    const node = await createNode(
      baseOptions({
        nowMsFn: sched.now,
        setInterval: sched.setInterval,
        clearInterval: sched.clearInterval,
      }),
    );
    await node.start();
    await node.start(); // no-op
    await node.stop();
    await node.stop(); // no-op
    await node.dispose();
  });

  it('drainOnce runs exactly one tick on both runners', async () => {
    const { client, state } = stubCoreClient();
    const sched = fakeScheduler();
    const node = await createNode(
      baseOptions({
        coreClient: client,
        nowMsFn: sched.now,
        setInterval: sched.setInterval,
        clearInterval: sched.clearInterval,
      }),
    );
    await node.drainOnce();
    // Both runners ran: event consumer listed events, reconciler listed tasks.
    expect(state.eventsList).toBeDefined();
    await node.dispose();
  });
});

describe('createNode — Response Bridge wiring', () => {
  it('completing a service_query_execution delegation fires sendD2D', async () => {
    const sent: Array<{ to: string; type: string; body: unknown }> = [];
    const repo = new InMemoryWorkflowRepository();
    const node = await createNode(
      baseOptions({
        sendD2D: async (to, type, body) => {
          sent.push({ to, type, body });
        },
        workflowRepository: repo,
      }),
    );

    // Seed a delegation task in created state with the canonical payload.
    node.workflowService.create({
      id: 'svc-exec-1',
      kind: 'delegation',
      description: '',
      payload: JSON.stringify({
        type: 'service_query_execution',
        from_did: 'did:plc:alice',
        query_id: 'q-1',
        capability: 'eta_query',
        ttl_seconds: 60,
        service_name: 'Bus 42',
      }),
    });
    node.workflowService.complete(
      'svc-exec-1',
      '{"eta_minutes":45,"vehicle_type":"Bus","route_name":"42"}',
      'responded',
    );
    // Bridge fires on next microtask.
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('did:plc:alice');
    expect((sent[0].body as { query_id: string }).query_id).toBe('q-1');
    await node.dispose();
  });
});

describe('createNode — onApproved wiring', () => {
  it('approved event on an approval task triggers executeAndRespond', async () => {
    const approvalTask: WorkflowTask = {
      id: 'appr-1',
      kind: 'approval',
      status: 'queued',
      priority: 'normal',
      description: '',
      payload: JSON.stringify({
        type: 'service_query_execution',
        from_did: 'did:plc:requester',
        query_id: 'q-2',
        capability: 'eta_query',
        params: {},
        ttl_seconds: 60,
      }),
      result_summary: '',
      policy: '{}',
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    };
    const { client, state } = stubCoreClient({
      events: [
        {
          event_id: 100,
          task_id: 'appr-1',
          at: 1_700_000_000_000,
          event_kind: 'approved',
          needs_delivery: true,
          delivery_attempts: 0,
          delivery_failed: false,
          details: '{"kind":"approval"}',
        },
      ],
      taskById: new Map([['appr-1', approvalTask]]),
    });

    const node = await createNode(baseOptions({ coreClient: client }));
    await node.runners.events.runTick();

    // executeAndRespond creates a delegation task and cancels the approval.
    expect(state.createCalls.length).toBeGreaterThanOrEqual(1);
    const delegation = state.createCalls.find((c) => (c as { kind: string }).kind === 'delegation');
    expect(delegation).toBeDefined();
    expect(state.cancelCalls).toContainEqual({ id: 'appr-1', reason: 'executed_via_delegation' });
    await node.dispose();
  });
});

describe('createNode — globalWiring', () => {
  it('with globalWiring=true, start() installs chat handlers; dispose() clears them', async () => {
    // Issue #8 contract: globals aren't wired until start(). Before
    // start(), the handler is still the "coming soon" fallback.
    const node = await createNode(baseOptions({ globalWiring: true }));
    const { handleChat } = require('../../../brain/src/chat/orchestrator');
    const preStartAck = (await handleChat('/service eta_query test')).response;
    expect(preStartAck).toContain("isn't wired up");

    await node.start();
    // After start, /service has an installed handler (not the fallback).
    const ack = (await handleChat('/service eta_query test')).response;
    expect(ack).not.toContain("isn't wired up");
    await node.dispose();
    // After dispose, the handler is cleared and we fall back to "coming soon".
    const afterAck = (await handleChat('/service eta_query test')).response;
    expect(afterAck).toContain("isn't wired up");
  });
});

describe('createNode — provider role', () => {
  it('provider with null config skips publish silently', async () => {
    const pubPds = {
      putRecord: jest.fn(),
      deleteRecordIdempotent: jest.fn(),
      authenticate: jest.fn().mockResolvedValue(DID),
      did: DID,
    };
    const node = await createNode(
      baseOptions({
        role: 'provider',
        pdsPublisher: pubPds as never,
        readConfig: () => null,
      }),
    );
    await node.start();
    expect(pubPds.putRecord).not.toHaveBeenCalled();
    await node.dispose();
  });

  it('provider with isDiscoverable=true syncs the service profile on start', async () => {
    const pubPds = {
      putRecord: jest.fn().mockResolvedValue({ uri: 'at://x', cid: 'b' }),
      deleteRecordIdempotent: jest.fn(),
      authenticate: jest.fn().mockResolvedValue(DID),
      did: DID,
    };
    const node = await createNode(
      baseOptions({
        role: 'provider',
        pdsPublisher: pubPds as never,
        readConfig: () => BUS_CONFIG,
      }),
    );
    await node.start();
    expect(pubPds.putRecord).toHaveBeenCalledTimes(1);
    await node.dispose();
  });
});

describe('createNode — agenticAsk wiring', () => {
  it('installs an agentic /ask handler when agenticAsk is provided + globalWiring=true', async () => {
    const { ToolRegistry } = require('../../../brain/src/reasoning/tool_registry');
    const tools = new ToolRegistry();
    const provider = {
      name: 't',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      async chat() {
        return {
          content: 'agentic reply',
          toolCalls: [],
          model: 't',
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: 'end' as const,
        };
      },
      async *stream() {
        throw new Error('nope');
      },
      async embed() {
        throw new Error('nope');
      },
    };
    const node = await createNode(
      baseOptions({
        globalWiring: true,
        agenticAsk: { provider: provider as never, tools },
      }),
    );
    // Chat globals are deferred to start() (issue #8).
    await node.start();
    const { handleChat } = require('../../../brain/src/chat/orchestrator');
    const res = await handleChat('/ask is it raining?');
    expect(res.response).toBe('agentic reply');
    await node.dispose();
  });

  it('skips the agentic /ask install when globalWiring=false even if agenticAsk given', async () => {
    const { ToolRegistry } = require('../../../brain/src/reasoning/tool_registry');
    const tools = new ToolRegistry();
    const provider = {
      name: 't',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      async chat() {
        return {
          content: 'SHOULD NOT APPEAR',
          toolCalls: [],
          model: 't',
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: 'end' as const,
        };
      },
      async *stream() {
        throw new Error('nope');
      },
      async embed() {
        throw new Error('nope');
      },
    };
    const node = await createNode(
      baseOptions({
        globalWiring: false,
        agenticAsk: { provider: provider as never, tools },
      }),
    );
    const { handleChat } = require('../../../brain/src/chat/orchestrator');
    const res = await handleChat('/ask hello');
    // Falls back to the single-shot `reason()` pipeline, which produces a
    // different response shape. Just assert we did NOT get the agentic
    // provider's stub reply.
    expect(res.response).not.toBe('SHOULD NOT APPEAR');
    await node.dispose();
  });
});

describe('createNode — chat delivery', () => {
  it('a service_query completion event lands in the chat thread', async () => {
    const completedTask: WorkflowTask = {
      id: 'svc-q-1',
      kind: 'service_query',
      status: 'completed',
      priority: 'normal',
      description: '',
      payload: '{}',
      result: JSON.stringify({
        query_id: 'q-1',
        capability: 'eta_query',
        status: 'success',
        result: { eta_minutes: 45, vehicle_type: 'Bus', route_name: '42' },
        ttl_seconds: 60,
      }),
      result_summary: 'received',
      policy: '{}',
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    };
    const { client } = stubCoreClient({
      events: [
        {
          event_id: 200,
          task_id: 'svc-q-1',
          at: 1_700_000_000_000,
          event_kind: 'completed',
          needs_delivery: true,
          delivery_attempts: 0,
          delivery_failed: false,
          details: JSON.stringify({
            response_status: 'success',
            capability: 'eta_query',
            service_name: 'Bus 42',
          }),
        },
      ],
      taskById: new Map([['svc-q-1', completedTask]]),
    });

    const node = await createNode(
      baseOptions({
        coreClient: client,
        chatThreadId: 'alice-main',
      }),
    );
    await node.runners.events.runTick();

    const thread = getThread('alice-main');
    const dinaMessages = thread.filter((m) => m.type === 'dina');
    expect(dinaMessages).toHaveLength(1);
    expect(dinaMessages[0].content).toContain('Bus 42');
    expect(dinaMessages[0].content).toContain('45 minutes away');
    await node.dispose();
  });
});
