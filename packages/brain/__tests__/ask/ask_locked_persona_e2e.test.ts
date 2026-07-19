/**
 * E2E — `/ask` against a sensitive/locked persona.
 *
 * Pins the chain that ADMIN_GAP.md flagged as missing in TS HNL:
 *
 *   chat input → persona resolver → checkPersonaGate → AskRegistry
 *     ─ open default persona → answers immediately (fast path).
 *     ─ closed sensitive persona → returns 200 + `pending_approval`.
 *   operator approves via AskApprovalGateway →
 *     AskRegistry resumes (`pending_approval → in_flight`).
 *   handler re-issues executeFn → answer returned, `markComplete`.
 *
 * Approval backing store is now workflow tasks (not the in-memory
 * ApprovalManager) — matches Go Core's dina_tasks pattern and makes
 * vault-read approvals visible in the mobile Approvals tab.
 *
 * Mocked: LLM (canned answers), persona resolver (keyword-based),
 * persona table (general=default+open, financial=sensitive+open),
 * CoreClient workflow methods (in-memory fake).
 */

import {
  AskApprovalGateway,
  type ApprovalSource,
  type ApprovalSourceStatus,
} from '../../src/ask/ask_approval_gateway';
import { createAskHandler, type AskExecuteFn } from '../../src/ask/ask_handler';
import { AskRegistry, InMemoryAskAdapter } from '../../src/ask/ask_registry';
import {
  approvalIdForAsk,
  buildPersonaGuardedExecuteFn,
  type GuardedLLM,
  type PersonaInfo,
} from '../../src/ask/persona_guarded_ask';

import type { VaultApprovalWorkflowClient } from '../../src/composition/persona_guard';
import type { CreateWorkflowTaskInput, WorkflowTask } from '@dina/core';

// ---------------------------------------------------------------------------
// In-memory workflow task fake — replaces ApprovalManager
// ---------------------------------------------------------------------------

interface FakeTask {
  id: string;
  status: string;
  payload: string;
}

function makeFakeWorkflowClient(): {
  client: VaultApprovalWorkflowClient;
  tasks: Map<string, FakeTask>;
  setStatus: (id: string, status: string) => void;
} {
  const tasks = new Map<string, FakeTask>();
  const client: VaultApprovalWorkflowClient = {
    async createWorkflowTask(input: CreateWorkflowTaskInput) {
      if (tasks.has(input.id)) throw new Error(`duplicate: ${input.id}`);
      const task: FakeTask = { id: input.id, status: input.initialState ?? 'pending_approval', payload: input.payload };
      tasks.set(input.id, task);
      return { task: task as unknown as WorkflowTask, deduped: false };
    },
    async getWorkflowTask(id: string) {
      return (tasks.get(id) as unknown as WorkflowTask) ?? null;
    },
    async completeWorkflowTask(id: string) {
      const t = tasks.get(id);
      if (t) t.status = 'completed';
      return t as unknown as WorkflowTask;
    },
  };
  return { client, tasks, setStatus: (id, status) => { const t = tasks.get(id); if (t) t.status = status; } };
}

/**
 * Adapt the workflow task store to the gateway's `ApprovalSource` interface.
 * Maps workflow task status → ApprovalSourceStatus.
 */
function workflowTaskSource(
  tasks: Map<string, FakeTask>,
  approve: (id: string) => void,
  deny: (id: string) => void,
): ApprovalSource {
  return {
    getStatus(id: string): ApprovalSourceStatus {
      const t = tasks.get(id);
      if (!t) return 'expired';
      if (t.status === 'pending_approval') return 'pending';
      if (t.status === 'queued' || t.status === 'running') return 'approved';
      if (t.status === 'cancelled' || t.status === 'failed') return 'denied';
      return 'expired';
    },
    approve(id: string) { approve(id); },
    deny(id: string) { deny(id); },
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const REQUESTER_DID = 'did:key:z6MkUserAlonso';

const personaTable: Record<string, PersonaInfo> = {
  general: { name: 'general', tier: 'default', open: true },
  // Sensitive + open: DEK in RAM but each brain-read still needs approval.
  financial: { name: 'financial', tier: 'sensitive', open: true },
};

function personaResolver(question: string): string {
  const lower = question.toLowerCase();
  if (lower.includes('balance') || lower.includes('finance') || lower.includes('bank')) return 'financial';
  return 'general';
}

function personaLookup(name: string): PersonaInfo | null {
  return personaTable[name] ?? null;
}

const llm: GuardedLLM = async ({ question, persona }) => ({
  text: `[${persona.name}] answer to: ${question}`,
  persona: persona.name,
});

interface Harness {
  registry: AskRegistry;
  workflowTasks: Map<string, FakeTask>;
  gateway: AskApprovalGateway;
  executeFn: AskExecuteFn;
  handleAsk: ReturnType<typeof createAskHandler>;
}

function buildHarness(): Harness {
  const registry = new AskRegistry({ adapter: new InMemoryAskAdapter(), defaultTtlMs: 30_000 });
  const { client, tasks, setStatus } = makeFakeWorkflowClient();
  const executeFn = buildPersonaGuardedExecuteFn({ personaResolver, personaLookup, coreClient: client, llm, callerRole: 'brain' });
  const approvalSource = workflowTaskSource(
    tasks,
    (id) => setStatus(id, 'queued'),    // approve → queued
    (id) => setStatus(id, 'cancelled'), // deny → cancelled
  );
  const gateway = new AskApprovalGateway({ askRegistry: registry, approvalSource });
  const handleAsk = createAskHandler({ registry, executeFn, fastPathMs: 50 });
  return { registry, workflowTasks: tasks, gateway, executeFn, handleAsk };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/ask × persona-gate × approval — E2E (Jest)', () => {
  it('default persona answers immediately (fast path, 200 + complete)', async () => {
    const h = buildHarness();
    const result = await h.handleAsk({ question: "what's the weather in San Francisco?", requesterDid: REQUESTER_DID });
    expect(result.kind).toBe('fast_path');
    if (result.kind !== 'fast_path') return;
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('complete');
    expect(result.body.answer).toEqual({ text: "[general] answer to: what's the weather in San Francisco?", persona: 'general' });
    // No approval task created — the gate allowed it outright.
    expect(h.workflowTasks.size).toBe(0);
  });

  it('sensitive persona returns pending_approval with a fresh approval_id', async () => {
    const h = buildHarness();
    const result = await h.handleAsk({ question: "what's my bank balance?", requesterDid: REQUESTER_DID });
    expect(result.kind).toBe('fast_path');
    if (result.kind !== 'fast_path') return;
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('pending_approval');
    expect(result.body.approval_id).toBeDefined();
    expect(result.body.approval_id).toBe(approvalIdForAsk(result.body.request_id));

    const askRecord = await h.registry.get(result.body.request_id);
    expect(askRecord?.status).toBe('pending_approval');
    expect(askRecord?.approvalId).toBe(result.body.approval_id);

    // Workflow task was created for the vault-read approval.
    const task = h.workflowTasks.get(result.body.approval_id!);
    expect(task).toBeDefined();
    expect(task?.status).toBe('pending_approval');
    const payload = JSON.parse(task?.payload ?? '{}');
    expect(payload.type).toBe('vault_read_request');
    expect(payload.persona).toBe('financial');
    expect(payload.requester_did).toBe(REQUESTER_DID);
  });

  it('operator approves → ask resumes to in_flight → re-run executeFn → answer', async () => {
    const h = buildHarness();
    const submit = await h.handleAsk({ question: 'show me my finance summary', requesterDid: REQUESTER_DID });
    expect(submit.kind).toBe('fast_path');
    if (submit.kind !== 'fast_path') return;
    expect(submit.body.status).toBe('pending_approval');
    const askId = submit.body.request_id;
    const approvalId = submit.body.approval_id!;

    // Operator taps Approve → gateway drives task to queued + resumes ask.
    const approveOutcome = await h.gateway.approve(approvalId);
    expect(approveOutcome.ok).toBe(true);

    const resumed = await h.registry.get(askId);
    expect(resumed?.status).toBe('in_flight');
    expect(resumed?.approvalId).toBeUndefined();

    // Re-issue executeFn (production wires via approval_resumed event).
    // executeFn sees task in queued → completes task → runs LLM.
    const second = await h.executeFn({ id: askId, question: 'show me my finance summary', requesterDid: REQUESTER_DID });
    expect(second.kind).toBe('answer');
    if (second.kind !== 'answer') return;
    expect(second.answer).toEqual({ text: '[financial] answer to: show me my finance summary', persona: 'financial' });
    await h.registry.markComplete(askId, JSON.stringify(second.answer));

    const final = await h.registry.get(askId);
    expect(final?.status).toBe('complete');

    // Task was consumed (completed) after vault read.
    expect(h.workflowTasks.get(approvalId)?.status).toBe('completed');
  });

  it('operator denies → ask transitions to failed with operator reason', async () => {
    const h = buildHarness();
    const submit = await h.handleAsk({ question: 'send 1000 USD to my bank', requesterDid: REQUESTER_DID });
    expect(submit.kind).toBe('fast_path');
    if (submit.kind !== 'fast_path') return;
    expect(submit.body.status).toBe('pending_approval');
    const askId = submit.body.request_id;
    const approvalId = submit.body.approval_id!;

    const denyOutcome = await h.gateway.deny(approvalId, 'Not auto-approving outbound transfers');
    expect(denyOutcome.ok).toBe(true);

    const final = await h.registry.get(askId);
    expect(final?.status).toBe('failed');
    const err = JSON.parse(final?.errorJson ?? '{}');
    expect(err.reason).toBe('denied');
    expect(err.detail).toBe('Not auto-approving outbound transfers');

    // Task was cancelled.
    expect(h.workflowTasks.get(approvalId)?.status).toBe('cancelled');
  });
});
