/**
 * service_workflow_bridge tests.
 */

import type { CapabilityConfig, InboundQuery } from '../src/brain/service_handler';
import {
  ServiceWorkflowBridge,
  type BridgeEvent,
  type ResponseEnvelope,
  type ServiceWorkflowBridgeIO,
  type TaskCompletionInput,
} from '../src/brain/service_workflow_bridge';

function etaCapability(overrides: Partial<CapabilityConfig> = {}): CapabilityConfig {
  return {
    name: 'eta_query',
    schemaHash: 'h1',
    paramsSchema: {
      type: 'object',
      properties: { route_id: { type: 'string' } },
      required: ['route_id'],
    },
    policy: 'auto',
    ...overrides,
  };
}

function inboundQuery(overrides: Partial<InboundQuery> = {}): InboundQuery {
  return {
    queryId: 'q-1',
    fromDid: 'did:plc:alice',
    capability: 'eta_query',
    schemaHash: 'h1',
    params: { route_id: '42' },
    receivedAt: 1_700_000_000,
    ...overrides,
  };
}

function ioRig(overrides: Partial<ServiceWorkflowBridgeIO> = {}) {
  const created: Array<Parameters<ServiceWorkflowBridgeIO['createTaskFn']>[0]> = [];
  const sent: Array<Parameters<ServiceWorkflowBridgeIO['sendResponseFn']>[0]> = [];
  const io: ServiceWorkflowBridgeIO = {
    createTaskFn: jest.fn(async (spec) => {
      created.push(spec);
      return { ok: true };
    }),
    sendResponseFn: jest.fn(async (input) => {
      sent.push(input);
      return { ok: true };
    }),
    ...overrides,
  };
  return { io, created, sent };
}

describe('ServiceWorkflowBridge — construction', () => {
  it.each([
    ['missing handlerConfig', { io: { createTaskFn: jest.fn(), sendResponseFn: jest.fn() } }],
    ['missing io', { handlerConfig: { capabilities: [] } }],
    ['io missing createTaskFn', { handlerConfig: { capabilities: [] }, io: { sendResponseFn: jest.fn() } }],
    ['io missing sendResponseFn', { handlerConfig: { capabilities: [] }, io: { createTaskFn: jest.fn() } }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(
      () =>
        new ServiceWorkflowBridge(
          bad as unknown as ConstructorParameters<typeof ServiceWorkflowBridge>[0],
        ),
    ).toThrow();
  });
});

describe('ServiceWorkflowBridge — canned respond', () => {
  it('canned cap → respond path ships success', async () => {
    const { io, created, sent } = ioRig();
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: {
        capabilities: [
          etaCapability({
            cannedResponse: { pong: true },
            paramsSchema: { type: 'object', properties: {}, required: [] },
          }),
        ],
      },
      io,
    });
    const r = await bridge.onInboundQuery(inboundQuery({ params: {} }));
    expect(r).toEqual({ kind: 'responded', queryId: 'q-1', via: 'canned' });
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.toDid).toBe('did:plc:alice');
    expect(sent[0]!.body.status).toBe('success');
  });
});

describe('ServiceWorkflowBridge — reject', () => {
  it('unknown capability → reject envelope sent', async () => {
    const { io, sent } = ioRig();
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: { capabilities: [etaCapability()] },
      io,
    });
    const r = await bridge.onInboundQuery(inboundQuery({ capability: 'unknown' }));
    if (r.kind !== 'responded') throw new Error('expected responded');
    expect(r.via).toBe('reject');
    expect(sent[0]!.body.status).toBe('error');
  });
});

describe('ServiceWorkflowBridge — delegate path', () => {
  it('auto → task enqueued + pending correlation', async () => {
    const { io, created, sent } = ioRig();
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: {
        capabilities: [etaCapability()],
        makeTaskIdFn: () => 'task-123',
      },
      io,
    });
    const r = await bridge.onInboundQuery(inboundQuery());
    expect(r).toEqual({ kind: 'pending', taskId: 'task-123', queryId: 'q-1' });
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe('auto_delegation');
    expect(sent).toHaveLength(0);
    expect(bridge.pendingCount()).toBe(1);
  });

  it('review policy → review task enqueued', async () => {
    const { io, created } = ioRig();
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: {
        capabilities: [etaCapability({ policy: 'review' })],
        makeTaskIdFn: () => 'task-review',
      },
      io,
    });
    await bridge.onInboundQuery(inboundQuery());
    expect(created[0]!.kind).toBe('review_pending_approval');
  });

  it('createTaskFn ok:false → io_error, no correlation recorded', async () => {
    const { io } = ioRig({
      createTaskFn: jest.fn(async () => ({ ok: false, error: 'db down' })),
    });
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: { capabilities: [etaCapability()] },
      io,
    });
    const r = await bridge.onInboundQuery(inboundQuery());
    expect(r.kind).toBe('io_error');
    if (r.kind === 'io_error') expect(r.stage).toBe('create_task');
    expect(bridge.pendingCount()).toBe(0);
  });

  it('createTaskFn throws → io_error', async () => {
    const { io } = ioRig({
      createTaskFn: jest.fn(async () => {
        throw new Error('oops');
      }),
    });
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: { capabilities: [etaCapability()] },
      io,
    });
    const r = await bridge.onInboundQuery(inboundQuery());
    if (r.kind === 'io_error') {
      expect(r.error).toBe('oops');
    } else throw new Error('expected io_error');
  });
});

describe('ServiceWorkflowBridge — task completion', () => {
  async function bootstrap(
    completion: TaskCompletionInput,
    resultSchemas: Record<string, Parameters<typeof validateStub>[0]> = {},
  ) {
    const { io, sent } = ioRig();
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: {
        capabilities: [etaCapability()],
        makeTaskIdFn: () => 'task-done',
      },
      io,
      resultSchemas,
    });
    await bridge.onInboundQuery(inboundQuery());
    const r = await bridge.onTaskCompleted(completion);
    return { bridge, sent, r };
  }

  const validateStub = (
    schema: { type: 'object'; required?: string[]; properties?: Record<string, { type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' }> },
  ) => schema;

  it('task_completed ok:true → success envelope shipped', async () => {
    const { sent, r } = await bootstrap({
      taskId: 'task-done',
      ok: true,
      result: { eta_minutes: 12 },
    });
    if (r.kind !== 'responded') throw new Error('expected responded');
    expect(r.via).toBe('task_result');
    expect(sent[0]!.body).toEqual<ResponseEnvelope>({
      queryId: 'q-1',
      status: 'success',
      result: { eta_minutes: 12 },
    });
  });

  it('task_completed ok:false → error envelope shipped', async () => {
    const { sent, r } = await bootstrap({
      taskId: 'task-done',
      ok: false,
      error: 'timeout',
    });
    if (r.kind !== 'responded') throw new Error('expected responded');
    expect(r.via).toBe('task_error');
    expect(sent[0]!.body.status).toBe('error');
    expect(sent[0]!.body.error).toBe('timeout');
  });

  it('unknown task id → unknown_task outcome, no send', async () => {
    const { io, sent } = ioRig();
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: { capabilities: [etaCapability()] },
      io,
    });
    const r = await bridge.onTaskCompleted({ taskId: 'nope', ok: true });
    expect(r).toEqual({ kind: 'unknown_task', taskId: 'nope' });
    expect(sent).toHaveLength(0);
  });

  it('result validation — missing required → provider_result_invalid', async () => {
    const { sent, r } = await bootstrap(
      { taskId: 'task-done', ok: true, result: {} },
      {
        eta_query: {
          type: 'object',
          properties: { eta_minutes: { type: 'integer' } },
          required: ['eta_minutes'],
        },
      },
    );
    if (r.kind !== 'responded') throw new Error('expected responded');
    expect(sent[0]!.body.error).toBe('provider_result_invalid');
    expect(sent[0]!.body.detail).toContain('eta_minutes');
  });

  it('result validation — valid result passes through', async () => {
    const { sent } = await bootstrap(
      { taskId: 'task-done', ok: true, result: { eta_minutes: 12 } },
      {
        eta_query: {
          type: 'object',
          properties: { eta_minutes: { type: 'integer' } },
          required: ['eta_minutes'],
        },
      },
    );
    expect(sent[0]!.body.status).toBe('success');
  });

  it('completing a task clears the correlation', async () => {
    const { io } = ioRig();
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: {
        capabilities: [etaCapability()],
        makeTaskIdFn: () => 'task-clear',
      },
      io,
    });
    await bridge.onInboundQuery(inboundQuery());
    expect(bridge.pendingCount()).toBe(1);
    await bridge.onTaskCompleted({ taskId: 'task-clear', ok: true, result: {} });
    expect(bridge.pendingCount()).toBe(0);
  });
});

describe('ServiceWorkflowBridge — sendResponseFn failure', () => {
  it('send throws → io_error send_response', async () => {
    const { io } = ioRig({
      sendResponseFn: jest.fn(async () => {
        throw new Error('no socket');
      }),
    });
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: {
        capabilities: [etaCapability({
          cannedResponse: { ok: true },
          paramsSchema: { type: 'object', properties: {}, required: [] },
        })],
      },
      io,
    });
    const r = await bridge.onInboundQuery(inboundQuery({ params: {} }));
    if (r.kind !== 'io_error') throw new Error('expected io_error');
    expect(r.stage).toBe('send_response');
    expect(r.error).toBe('no socket');
  });

  it('send ok:false → io_error', async () => {
    const { io } = ioRig({
      sendResponseFn: jest.fn(async () => ({ ok: false, error: 'queue full' })),
    });
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: { capabilities: [etaCapability()] },
      io,
    });
    const r = await bridge.onInboundQuery(inboundQuery({ capability: 'unknown' }));
    if (r.kind === 'io_error') expect(r.stage).toBe('send_response');
  });
});

describe('ServiceWorkflowBridge — event stream + introspection', () => {
  it('emits inbound_decided + task_enqueued + task_completed + response_sent', async () => {
    const events: BridgeEvent[] = [];
    const { io } = ioRig();
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: {
        capabilities: [etaCapability()],
        makeTaskIdFn: () => 'task-x',
      },
      io,
      onEvent: (e) => events.push(e),
    });
    await bridge.onInboundQuery(inboundQuery());
    await bridge.onTaskCompleted({ taskId: 'task-x', ok: true, result: {} });
    expect(events.map((e) => e.kind)).toEqual([
      'inbound_decided',
      'task_enqueued',
      'task_completed',
      'response_sent',
    ]);
  });

  it('listPending returns a defensive copy', async () => {
    const { io } = ioRig();
    const bridge = new ServiceWorkflowBridge({
      handlerConfig: { capabilities: [etaCapability()], makeTaskIdFn: () => 'task-lp' },
      io,
    });
    await bridge.onInboundQuery(inboundQuery());
    const snap = bridge.listPending();
    snap[0]!.queryId = 'mutated';
    expect(bridge.listPending()[0]!.queryId).toBe('q-1');
  });
});
