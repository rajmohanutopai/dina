import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemoryReasoningBackendRepository,
  SQLiteReasoningBackendRepository,
} from '../../src/reasoning/backend_repository';
import {
  InMemoryReasoningContextRepository,
  REASONING_PROJECTION_RECOVERY_RETENTION_MS,
  SQLiteReasoningContextRepository,
  type ReasoningContextRepository,
  type ReasoningContextTicket,
} from '../../src/reasoning/context_repository';
import { reasoningHash } from '../../src/reasoning/domain';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
} from '../../src/workflow/domain';
import {
  InMemoryWorkflowRepository,
  SQLiteWorkflowRepository,
  type WorkflowRepository,
} from '../../src/workflow/repository';

import type { ReasoningTaskEnvelopeV1 } from '../../src/reasoning/domain';

const OWNER_DID = 'did:plc:owner';
const PRINCIPAL_DID = 'did:key:z6MkReasoningWorker';

interface ContextHarness {
  contexts: ReasoningContextRepository;
  workflows: WorkflowRepository;
  cleanup(): void;
}

function inMemoryHarness(): ContextHarness {
  const backends = new InMemoryReasoningBackendRepository();
  backends.register({
    backendId: 'claude',
    kind: 'connected_host',
    principalDid: PRINCIPAL_DID,
    allowedTaskKinds: ['answer.compose'],
    maxSensitivity: 'sensitive',
    availability: 'foreground',
    selectedByOwnerDid: OWNER_DID,
    expectedVersion: null,
    nowMs: 1_000,
  });
  return {
    contexts: new InMemoryReasoningContextRepository(),
    workflows: new InMemoryWorkflowRepository(),
    cleanup: () => {},
  };
}

function sqliteHarness(): ContextHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-reasoning-context-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  new SQLiteReasoningBackendRepository(adapter).register({
    backendId: 'claude',
    kind: 'connected_host',
    principalDid: PRINCIPAL_DID,
    allowedTaskKinds: ['answer.compose'],
    maxSensitivity: 'sensitive',
    availability: 'foreground',
    selectedByOwnerDid: OWNER_DID,
    expectedVersion: null,
    nowMs: 1_000,
  });
  return {
    contexts: new SQLiteReasoningContextRepository(adapter),
    workflows: new SQLiteWorkflowRepository(adapter),
    cleanup: () => {
      try {
        adapter.close();
      } catch {
        // Cleanup is intentionally idempotent.
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedTicket(
  harness: ContextHarness,
  suffix: string,
  authenticatedSessionId: string | null,
): ReasoningContextTicket {
  const taskId = `task-${suffix}`;
  const projectionId = `projection-${suffix}`;
  const content = { query: `question-${suffix}` };
  harness.workflows.create({
    id: taskId,
    kind: WorkflowTaskKind.Reasoning,
    status: WorkflowTaskState.Running,
    priority: WorkflowTaskPriority.Normal,
    description: `reasoning ${suffix}`,
    payload: '{}',
    result_summary: '',
    policy: '{}',
    agent_did: PRINCIPAL_DID,
    assigned_runner: 'reasoning:claude',
    claim_id: `claim-${suffix}`,
    lease_expires_at: 10_000,
    created_at: 1_000,
    updated_at: 1_000,
  });
  harness.contexts.createProjection({
    projectionId,
    taskId,
    kind: 'input',
    ownerDid: OWNER_DID,
    purpose: 'answer the owner',
    sensitivity: 'personal',
    content,
    contentHash: reasoningHash(content),
    scrubbed: true,
    allowedEvidenceIds: [],
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    revokedAtMs: null,
  });
  const ticket: ReasoningContextTicket = {
    ticketId: `ticket-${suffix}`,
    taskId,
    claimId: `claim-${suffix}`,
    backendId: 'claude',
    principalDid: PRINCIPAL_DID,
    authenticatedSessionId,
    ownerDid: OWNER_DID,
    purpose: 'answer the owner',
    policyVersion: 1,
    inputProjectionId: projectionId,
    contextProjectionId: null,
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    consumedAtMs: null,
    revokedAtMs: null,
  };
  harness.contexts.createTicket(ticket);
  return ticket;
}

function seedLeasedReasoningTask(
  harness: ContextHarness,
  suffix: string,
  overrides: {
    maxAttempts?: number;
    deadlineAtMs?: number;
  } = {},
): string {
  const taskId = `lease-${suffix}`;
  const envelope: ReasoningTaskEnvelopeV1 = {
    version: 1,
    taskId,
    taskKind: 'answer.compose',
    ownerDid: OWNER_DID,
    authorityOrigin: {
      kind: 'owner_interactive',
      ownerDid: OWNER_DID,
      requesterDid: OWNER_DID,
      ingress: 'mobile',
      correlationId: `correlation-${suffix}`,
      authenticatedAtMs: 1_000,
    },
    authorityPolicyRef: null,
    backendBindingId: 'claude',
    requestSchemaId: 'reasoning.answer.compose.request.v1',
    resultSchemaId: 'reasoning.answer.compose.result.v1',
    policySnapshotHash: 'a'.repeat(64),
    inputProjectionId: `input-${suffix}`,
    inputProjectionHash: 'b'.repeat(64),
    contextProjectionId: null,
    contextProjectionHash: null,
    sensitivity: 'personal',
    evidencePolicy: 'none',
    allowedEvidenceIdsHash: null,
    requestFingerprint: 'c'.repeat(64),
    purpose: 'lease recovery test',
    executionId: `execution-${suffix}`,
    idempotencyKey: `reason:${reasoningHash(suffix)}`,
    createdAtMs: 1_000,
    deadlineAtMs: overrides.deadlineAtMs ?? 20_000,
    maxAttempts: overrides.maxAttempts ?? 3,
  };
  harness.workflows.create({
    id: taskId,
    kind: WorkflowTaskKind.Reasoning,
    status: WorkflowTaskState.Queued,
    priority: WorkflowTaskPriority.Normal,
    description: `reasoning lease ${suffix}`,
    payload: JSON.stringify(envelope),
    result_summary: '',
    policy: '{}',
    requested_runner: 'reasoning:claude',
    created_at: 1_000,
    updated_at: 1_000,
  });
  return taskId;
}

function claimReasoning(harness: ContextHarness, nowMs: number, taskId: string): void {
  expect(
    harness.workflows.claimReasoningTask(
      PRINCIPAL_DID,
      'claude',
      OWNER_DID,
      ['answer.compose'],
      'sensitive',
      nowMs,
      100,
      taskId,
    ),
  ).not.toBeNull();
}

describe.each([
  ['in-memory', inMemoryHarness],
  ['SQLite', sqliteHarness],
] as const)('reasoning context session binding — %s', (_name, makeHarness) => {
  let harness: ContextHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  test('round-trips the exact connected-host session and managed-worker null', () => {
    const connected = seedTicket(harness, 'connected', 'sess-A');
    const managed = seedTicket(harness, 'managed', null);

    expect(harness.contexts.getTicket(connected.ticketId)?.authenticatedSessionId).toBe('sess-A');
    expect(harness.contexts.getTicket(managed.ticketId)?.authenticatedSessionId).toBeNull();
  });

  test('revokes only tickets issued to the ended session', () => {
    const sessionA = seedTicket(harness, 'session-a', 'sess-A');
    const sessionB = seedTicket(harness, 'session-b', 'sess-B');
    const managed = seedTicket(harness, 'managed', null);

    expect(harness.contexts.revokeTicketsForSession('sess-A', 5_000)).toBe(1);
    expect(harness.contexts.revokeTicketsForSession('sess-A', 5_001)).toBe(0);
    expect(harness.contexts.getTicket(sessionA.ticketId)?.revokedAtMs).toBe(5_000);
    expect(harness.contexts.getTicket(sessionB.ticketId)?.revokedAtMs).toBeNull();
    expect(harness.contexts.getTicket(managed.ticketId)?.revokedAtMs).toBeNull();
  });

  test('sweep immediately removes consumed tickets but retains live projections', () => {
    const ticket = seedTicket(harness, 'consumed-sweep', 'sess-A');
    expect(harness.contexts.consumeTicket(ticket.ticketId, ticket.claimId, 5_000)).toBe(true);

    expect(harness.contexts.sweep(5_000)).toBe(1);
    expect(harness.contexts.getTicket(ticket.ticketId)).toBeNull();
    expect(harness.contexts.getProjection(ticket.inputProjectionId)).not.toBeNull();
  });

  test('sweep immediately removes revoked terminal projections after ticket cleanup', () => {
    const ticket = seedTicket(harness, 'revoked-sweep', 'sess-A');
    expect(harness.contexts.revokeTicket(ticket.ticketId, 5_000)).toBe(true);
    expect(harness.contexts.revokeProjectionsForTask(ticket.taskId, 5_000)).toBe(1);

    expect(harness.contexts.sweep(5_000)).toBe(2);
    expect(harness.contexts.getTicket(ticket.ticketId)).toBeNull();
    expect(harness.contexts.getProjection(ticket.inputProjectionId)).toBeNull();
  });

  test('sweep retains expired unrevoked projections for commit recovery, then purges them', () => {
    const ticket = seedTicket(harness, 'recovery-window', null);
    const justInsideRecovery = ticket.expiresAtMs + REASONING_PROJECTION_RECOVERY_RETENTION_MS - 1;

    expect(harness.contexts.sweep(justInsideRecovery)).toBe(1);
    expect(harness.contexts.getTicket(ticket.ticketId)).toBeNull();
    expect(harness.contexts.getProjection(ticket.inputProjectionId)).not.toBeNull();

    expect(
      harness.contexts.sweep(ticket.expiresAtMs + REASONING_PROJECTION_RECOVERY_RETENTION_MS),
    ).toBe(1);
    expect(harness.contexts.getProjection(ticket.inputProjectionId)).toBeNull();
  });

  test('lease loss requeues reasoning work only inside its attempt budget', () => {
    const taskId = seedLeasedReasoningTask(harness, 'retry', { maxAttempts: 3 });
    claimReasoning(harness, 1_000, taskId);

    expect(harness.workflows.expireLeasedTasks(1_200)).toHaveLength(1);
    expect(harness.workflows.getById(taskId)).toMatchObject({
      status: 'queued',
      next_run_at: 3,
    });
  });

  test('lease loss terminalizes reasoning work at its attempt budget', () => {
    const taskId = seedLeasedReasoningTask(harness, 'exhausted', { maxAttempts: 3 });
    claimReasoning(harness, 1_000, taskId);
    expect(harness.workflows.expireLeasedTasks(1_200)).toHaveLength(1);
    claimReasoning(harness, 3_000, taskId);
    expect(harness.workflows.expireLeasedTasks(3_200)).toHaveLength(1);
    claimReasoning(harness, 6_000, taskId);

    expect(harness.workflows.expireLeasedTasks(6_200)).toHaveLength(1);
    expect(harness.workflows.getById(taskId)).toMatchObject({
      status: 'failed',
      error: 'reasoning attempt budget exhausted',
    });
  });

  test('lease loss terminalizes reasoning work whose deadline cannot survive retry', () => {
    const taskId = seedLeasedReasoningTask(harness, 'deadline', {
      deadlineAtMs: 2_500,
    });
    claimReasoning(harness, 1_000, taskId);

    expect(harness.workflows.expireLeasedTasks(2_000)).toHaveLength(1);
    expect(harness.workflows.getById(taskId)).toMatchObject({
      status: 'failed',
      error: 'reasoning deadline expired',
    });
  });
});

test('in-memory lease loss fails closed for a malformed reasoning envelope', () => {
  const harness = inMemoryHarness();
  const taskId = 'lease-malformed';
  harness.workflows.create({
    id: taskId,
    kind: WorkflowTaskKind.Reasoning,
    status: WorkflowTaskState.Running,
    priority: WorkflowTaskPriority.Normal,
    description: 'malformed reasoning lease',
    payload: '{"version":1}',
    result_summary: '',
    policy: '{}',
    requested_runner: 'reasoning:claude',
    assigned_runner: 'reasoning:claude',
    agent_did: PRINCIPAL_DID,
    claim_id: 'claim-malformed',
    attempt: 1,
    lease_expires_at: 1_500,
    created_at: 1_000,
    updated_at: 1_000,
  });

  expect(harness.workflows.expireLeasedTasks(2_000)).toHaveLength(1);
  expect(harness.workflows.getById(taskId)).toMatchObject({
    status: 'failed',
    error: 'reasoning lease lost — invalid task envelope',
  });
});
