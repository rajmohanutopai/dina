/**
 * Tests for `delegate_to_agent` — the agentic-loop tool that hands a
 * self-contained task to a paired agent. Brain is unaware of the
 * agent-side runtime (OpenClaw, Hermes, custom script…) — the contract
 * is just "create delegation task; paired dina-agent claims, executes,
 * reports back".
 *
 * Coverage:
 *   1. Successful round trip: create + poll + return result.
 *   2. Failed terminal state surfaces the error string.
 *   3. Timeout when the task never reaches a terminal state.
 *   4. Empty `task_description` rejected before any side-effect.
 *   5. Vanished task returns a `failed` outcome (Core lost the row —
 *      e.g. expiry sweeper deleted it before we polled).
 *   6. JSON Schema is correctly registered for the LLM wire.
 */

import { describe, expect, it } from '@jest/globals';
import type { CoreClient, WorkflowTask } from '@dina/core';
import {
  createDelegateToAgentTool,
  type DelegateOutcome,
} from '../../src/reasoning/delegate_agent_tool';

type CreateInput = Parameters<CoreClient['createWorkflowTask']>[0];

interface FakeCore {
  created: CreateInput[];
  /** Polled (id, callIndex) → task. Pulls items off the queue. */
  pollResponses: Map<string, WorkflowTask[]>;
  createWorkflowTask: CoreClient['createWorkflowTask'];
  getWorkflowTask: CoreClient['getWorkflowTask'];
}

function makeFake(): FakeCore {
  const created: CreateInput[] = [];
  const pollResponses = new Map<string, WorkflowTask[]>();
  const createWorkflowTask = (async (input: CreateInput) => {
    created.push(input);
    return { task: stubTask(input.id, 'queued'), deduped: false };
  }) as CoreClient['createWorkflowTask'];
  const getWorkflowTask = (async (id: string) => {
    const queue = pollResponses.get(id);
    if (queue === undefined || queue.length === 0) return null;
    return queue.shift() ?? null;
  }) as CoreClient['getWorkflowTask'];
  return { created, pollResponses, createWorkflowTask, getWorkflowTask };
}

function stubTask(
  id: string,
  status: WorkflowTask['status'],
  fields: Partial<WorkflowTask> = {},
): WorkflowTask {
  return {
    id,
    kind: 'delegation',
    status,
    priority: 'normal',
    description: 'fake',
    payload: '{}',
    result_summary: '',
    policy: '',
    created_at: 0,
    updated_at: 0,
    ...fields,
  };
}

function buildTool(fake: FakeCore, idSeed = 'fixed-id') {
  return createDelegateToAgentTool({
    core: { createWorkflowTask: fake.createWorkflowTask, getWorkflowTask: fake.getWorkflowTask },
    generateTaskId: () => idSeed,
    pollIntervalMs: 0,
    timeoutMs: 100,
    sleep: async () => undefined,
    nowMsFn: () => 0, // never advances → polls keep firing until queue empty
  });
}

describe('delegate_to_agent', () => {
  it('returns a completed outcome with the agent result on success', async () => {
    const fake = makeFake();
    fake.pollResponses.set('fixed-id', [
      stubTask('fixed-id', 'running'),
      stubTask('fixed-id', 'completed', {
        result: '{"answer":"42"}',
        result_summary: 'computed',
      }),
    ]);
    const tool = buildTool(fake);

    const out = (await tool.execute({ task_description: 'do the thing' })) as DelegateOutcome;

    expect(out).toEqual({
      status: 'completed',
      result: '{"answer":"42"}',
      task_id: 'fixed-id',
    });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      id: 'fixed-id',
      kind: 'delegation',
      description: 'do the thing',
      origin: 'dinamobile',
      initialState: 'queued',
    });
    // Payload type is `free_form_task`, not `service_query_execution`,
    // so the response bridge stays out of this path.
    expect(JSON.parse(fake.created[0].payload as string)).toMatchObject({
      type: 'free_form_task',
      description: 'do the thing',
    });
  });

  it('falls back to result_summary when result is unset', async () => {
    const fake = makeFake();
    fake.pollResponses.set('fixed-id', [
      stubTask('fixed-id', 'completed', { result_summary: 'plain text' }),
    ]);
    const tool = buildTool(fake);
    const out = (await tool.execute({ task_description: 'x' })) as DelegateOutcome;
    expect(out.status).toBe('completed');
    expect(out.result).toBe('plain text');
  });

  it('surfaces a failed terminal state with the error text', async () => {
    const fake = makeFake();
    fake.pollResponses.set('fixed-id', [
      stubTask('fixed-id', 'failed', { error: 'tool returned 500' }),
    ]);
    const tool = buildTool(fake);
    const out = (await tool.execute({ task_description: 'x' })) as DelegateOutcome;
    expect(out).toEqual({
      status: 'failed',
      error: 'tool returned 500',
      task_id: 'fixed-id',
    });
  });

  it('surfaces a cancelled outcome', async () => {
    const fake = makeFake();
    fake.pollResponses.set('fixed-id', [
      stubTask('fixed-id', 'cancelled', { result_summary: 'operator cancelled' }),
    ]);
    const tool = buildTool(fake);
    const out = (await tool.execute({ task_description: 'x' })) as DelegateOutcome;
    expect(out.status).toBe('cancelled');
    expect(out.error).toBe('operator cancelled');
  });

  it('returns timeout when the task never reaches a terminal state', async () => {
    const fake = makeFake();
    // Always return `running` — never terminal.
    let nowMs = 0;
    const tool = createDelegateToAgentTool({
      core: { createWorkflowTask: fake.createWorkflowTask, getWorkflowTask: fake.getWorkflowTask },
      generateTaskId: () => 'fixed-id',
      pollIntervalMs: 10,
      timeoutMs: 30,
      sleep: async (ms) => {
        nowMs += ms; // advance synthetic clock by the slept amount
      },
      nowMsFn: () => nowMs,
    });
    fake.pollResponses.set('fixed-id', [
      stubTask('fixed-id', 'running'),
      stubTask('fixed-id', 'running'),
      stubTask('fixed-id', 'running'),
      stubTask('fixed-id', 'running'),
    ]);
    const out = (await tool.execute({ task_description: 'never finishes' })) as DelegateOutcome;
    expect(out.status).toBe('timeout');
    expect(out.task_id).toBe('fixed-id');
    expect(out.error).toMatch(/within/);
  });

  it('rejects empty task_description without creating a task', async () => {
    const fake = makeFake();
    const tool = buildTool(fake);
    await expect(tool.execute({ task_description: '   ' })).rejects.toThrow(
      'task_description is required',
    );
    expect(fake.created).toHaveLength(0);
  });

  it('returns failed when the polled task disappears (expired/swept)', async () => {
    const fake = makeFake();
    // Empty queue → getWorkflowTask returns null on the first poll.
    fake.pollResponses.set('fixed-id', []);
    const tool = buildTool(fake);
    const out = (await tool.execute({ task_description: 'x' })) as DelegateOutcome;
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/disappeared/);
  });

  it('exposes a JSON-Schema-shaped parameters block for the LLM', () => {
    const fake = makeFake();
    const tool = buildTool(fake);
    expect(tool.name).toBe('delegate_to_agent');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        task_description: { type: 'string' },
      },
      required: ['task_description'],
    });
    expect(tool.description).toMatch(/paired agent/i);
  });
});
