/**
 * useServiceThreadDelivery — MOBILE-009 tests.
 */

import {
  wireServiceThreadDelivery,
  type DeliveryCoreClient,
} from '../../src/hooks/useServiceThreadDelivery';
import type { WorkflowEvent, WorkflowTask } from '@dina/core';
import { getThread, resetThreads } from '../../../brain/src/chat/thread';

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    event_id: 1,
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
    ...overrides,
  };
}

function makeTask(overrides: Partial<WorkflowTask> & { id: string }): WorkflowTask {
  return {
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
    correlation_id: 'q-1',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_500,
    ...overrides,
  };
}

function stubCore(init: { events?: WorkflowEvent[]; task?: WorkflowTask | null }): {
  client: DeliveryCoreClient;
  acks: number[];
} {
  const acks: number[] = [];
  const client: DeliveryCoreClient = {
    async listWorkflowEvents() {
      return init.events ?? [];
    },
    async acknowledgeWorkflowEvent(id: number) {
      acks.push(id);
      return true;
    },
    async getWorkflowTask() {
      return init.task ?? null;
    },
    async failWorkflowEventDelivery() {
      return true;
    },
  };
  return { client, acks };
}

describe('useServiceThreadDelivery', () => {
  beforeEach(() => resetThreads());

  it('rejects missing coreClient', () => {
    expect(() =>
      wireServiceThreadDelivery({ coreClient: undefined as unknown as DeliveryCoreClient }),
    ).toThrow(/coreClient/);
  });

  it('runOnce appends the formatted response to the chat thread', async () => {
    const { client, acks } = stubCore({
      events: [makeEvent()],
      task: makeTask({ id: 'svc-q-1' }),
    });
    const handle = wireServiceThreadDelivery({
      coreClient: client,
      threadId: 'main',
    });
    const tick = await handle.runOnce();
    expect(tick.delivered).toBe(1);
    const thread = getThread('main');
    const dina = thread.filter((m) => m.type === 'dina');
    expect(dina).toHaveLength(1);
    expect(dina[0].content).toContain('Bus 42');
    expect(dina[0].content).toContain('45 minutes away');
    expect(dina[0].sources).toEqual(['svc-q-1', 'eta_query']);
    expect(acks).toEqual([1]);
  });

  it('onDelivered hook fires with the appended chat message', async () => {
    const { client } = stubCore({
      events: [makeEvent()],
      task: makeTask({ id: 'svc-q-1' }),
    });
    const seen: string[] = [];
    const handle = wireServiceThreadDelivery({
      coreClient: client,
      threadId: 'main',
      onDelivered: (m) => seen.push(m.content),
    });
    await handle.runOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('Bus 42');
  });

  it('onError hook fires on transport failure (no chat delivery)', async () => {
    const client: DeliveryCoreClient = {
      async listWorkflowEvents() {
        throw new Error('core down');
      },
      async acknowledgeWorkflowEvent() {
        return true;
      },
      async getWorkflowTask() {
        return null;
      },
      async failWorkflowEventDelivery() {
        return true;
      },
    };
    const errs: unknown[] = [];
    const handle = wireServiceThreadDelivery({
      coreClient: client,
      onError: (e) => errs.push(e),
    });
    await handle.runOnce();
    expect(errs).toHaveLength(1);
    expect(getThread('main')).toHaveLength(0);
  });

  it('defaults threadId to "main" when not supplied', async () => {
    const { client } = stubCore({
      events: [makeEvent()],
      task: makeTask({ id: 'svc-q-1' }),
    });
    const handle = wireServiceThreadDelivery({ coreClient: client });
    await handle.runOnce();
    expect(getThread('main')).not.toHaveLength(0);
  });

  it('start fires an immediate tick; stop halts the schedule', async () => {
    const { client, acks } = stubCore({
      events: [makeEvent()],
      task: makeTask({ id: 'svc-q-1' }),
    });
    const handle = wireServiceThreadDelivery({ coreClient: client });
    handle.start();
    // Give the immediate tick time to land.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    handle.stop();
    expect(acks).toContain(1);
  });
});
