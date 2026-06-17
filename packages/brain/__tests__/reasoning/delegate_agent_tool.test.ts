/**
 * Tests for `delegate_to_agent` — the agentic-loop tool that hands a
 * self-contained task to a paired agent. Brain is unaware of the
 * agent-side runtime (OpenClaw, Hermes, custom script…) — the contract
 * is just "create delegation task; paired dina-agent claims, executes,
 * reports back".
 *
 * Async delivery: the tool no longer blocks on execution. It creates the
 * delegation and returns `status: 'delegated'` immediately; the agent's
 * terminal result is delivered to chat by the `WorkflowEventConsumer`
 * (delegation branch) when the task finishes. The old blocking poll +
 * 60s timeout are gone (they raced the owner's mid-task approval). The
 * completion-delivery side is covered in
 * `__tests__/service/workflow_event_consumer.test.ts`.
 *
 * Coverage:
 *   1. Returns a `delegated` outcome + creates the delegation task.
 *   2. Sets a generous claim/expiry TTL (no 60s race).
 *   3. Binds the current Dina session name.
 *   4. Empty `task_description` rejected before any side-effect.
 *   5. JSON Schema is correctly registered for the LLM wire.
 *   6. PII scrubbed before crossing the trust boundary (MT-46).
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
  createWorkflowTask: CoreClient['createWorkflowTask'];
}

function makeFake(): FakeCore {
  const created: CreateInput[] = [];
  const createWorkflowTask = (async (input: CreateInput) => {
    created.push(input);
    return { task: stubTask(input.id, 'queued'), deduped: false };
  }) as CoreClient['createWorkflowTask'];
  return { created, createWorkflowTask };
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
    core: { createWorkflowTask: fake.createWorkflowTask },
    generateTaskId: () => idSeed,
    nowMsFn: () => 0,
  });
}

describe('delegate_to_agent', () => {
  it('returns a delegated outcome immediately and creates the delegation task', async () => {
    const fake = makeFake();
    const tool = buildTool(fake);

    const out = (await tool.execute({ task_description: 'do the thing' })) as DelegateOutcome;

    expect(out.status).toBe('delegated');
    expect(out.task_id).toBe('fixed-id');
    // The LLM relays `note` — it must NOT read as "done".
    expect(out.note).toMatch(/delegat/i);
    expect(out.note).not.toMatch(/\b(done|finished|completed)\b/i);

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

  it('sets a generous claim/expiry TTL (default 1h) — no 60s race', async () => {
    const fake = makeFake();
    const tool = buildTool(fake); // nowMsFn → 0
    await tool.execute({ task_description: 'x' });
    // floor(0/1000) + 3600
    expect(fake.created[0].expiresAtSec).toBe(3600);
  });

  it('honours a custom expirySec relative to the current clock', async () => {
    const fake = makeFake();
    const tool = createDelegateToAgentTool({
      core: { createWorkflowTask: fake.createWorkflowTask },
      generateTaskId: () => 'id2',
      nowMsFn: () => 10_000,
      expirySec: 120,
    });
    await tool.execute({ task_description: 'x' });
    expect(fake.created[0].expiresAtSec).toBe(Math.floor(10_000 / 1000) + 120);
  });

  it('rejects empty task_description without creating a task', async () => {
    const fake = makeFake();
    const tool = buildTool(fake);
    await expect(tool.execute({ task_description: '   ' })).rejects.toThrow(
      'task_description is required',
    );
    expect(fake.created).toHaveLength(0);
  });

  it('persists the current Dina session name on created delegation tasks', async () => {
    const fake = makeFake();
    const tool = createDelegateToAgentTool({
      core: { createWorkflowTask: fake.createWorkflowTask },
      generateTaskId: () => 'fixed-id',
      nowMsFn: () => 0,
      sessionName: 'sess-health-123',
    });

    await tool.execute({ task_description: 'read health summary' });

    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].sessionName).toBe('sess-health-123');
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
    // The description must steer the LLM away from claiming completion.
    expect(tool.description).toMatch(/immediately|delegated|report back/i);
  });

  // ---------------------------------------------------------------------
  // MT-46 — PII scrub before crossing the Home Node trust boundary.
  // The agent reads the task `description` and `payload.description` when
  // claiming. Raw PII in either would leak values like email addresses,
  // phone numbers, or SSN strings outside the Home Node. Scrub replaces
  // them with placeholder tokens; the original entities are stashed under
  // `_pii_entities` for a future rehydrate-on-validate-approval flow.
  // ---------------------------------------------------------------------
  describe('PII scrubbing (MT-46)', () => {
    it('scrubs the description before the workflow task is created', async () => {
      const fake = makeFake();
      const tool = buildTool(fake);

      await tool.execute({
        task_description: 'Send an email to alice@example.com about the budget',
      });

      expect(fake.created).toHaveLength(1);
      const stored = fake.created[0];
      expect(stored.description as string).not.toContain('alice@example.com');
      expect(stored.description as string).toMatch(/\[EMAIL_/);
      const payload = JSON.parse(stored.payload as string);
      expect(payload.description).not.toContain('alice@example.com');
      expect(payload.description).toMatch(/\[EMAIL_/);
    });

    it('stores the original entities under `_pii_entities` for rehydrate-on-approval', async () => {
      const fake = makeFake();
      const tool = buildTool(fake);

      await tool.execute({
        task_description: 'Email alice@example.com and call (555) 123-4567',
      });

      const payload = JSON.parse(fake.created[0].payload as string);
      expect(Array.isArray(payload._pii_entities)).toBe(true);
      const values: string[] = payload._pii_entities.map((e: { value: string }) => e.value);
      expect(values).toContain('alice@example.com');
      expect(values.some((v) => v.includes('555'))).toBe(true);
    });

    it('passes through descriptions that have no PII (no entities, identical text)', async () => {
      const fake = makeFake();
      const tool = buildTool(fake);

      const plain = 'List my unread emails from the last week';
      await tool.execute({ task_description: plain });

      const stored = fake.created[0];
      expect(stored.description).toBe(plain);
      const payload = JSON.parse(stored.payload as string);
      expect(payload.description).toBe(plain);
      expect(payload._pii_entities).toEqual([]);
    });

    it('the agent-visible fields contain ONLY scrubbed text — never raw PII', async () => {
      const fake = makeFake();
      const tool = buildTool(fake);

      const secret = 'alice@example.com';
      await tool.execute({ task_description: `Send ${secret} an email` });

      const stored = fake.created[0];
      const payload = JSON.parse(stored.payload as string);
      const entities = payload._pii_entities;
      delete payload._pii_entities;
      const visibleToAgent = JSON.stringify({ description: stored.description, payload });
      expect(visibleToAgent).not.toContain(secret);
      expect(JSON.stringify(entities)).toContain(secret);
    });
  });
});
