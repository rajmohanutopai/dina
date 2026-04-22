/**
 * CORE-P2-I03 + I04 — inbound `service.response` → complete matching
 * `service_query` workflow task.
 */

import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { clearGatesState } from '../../src/d2d/gates';
import { resetStagingState } from '../../src/staging/service';
import { resetAuditState, queryAudit } from '../../src/audit/service';
import { resetQuarantineState } from '../../src/d2d/quarantine';
import { clearReplayCache } from '../../src/transport/adversarial';
import { getPublicKey } from '../../src/crypto/ed25519';
import { resetServiceWindows, setRequesterWindow } from '../../src/service/windows';
import { InMemoryWorkflowRepository, setWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';
import {
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
} from '../../src/workflow/domain';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const senderPriv = TEST_ED25519_SEED;
const senderPub = getPublicKey(senderPriv);
const recipientPriv = new Uint8Array(32).fill(0x42);
const recipientPub = getPublicKey(recipientPriv);

const BUS_DID = 'did:plc:bus42';
const responseBody = {
  query_id: 'q-test-1',
  capability: 'eta_query',
  status: 'success' as const,
  result: { eta_minutes: 45, vehicle_type: 'Bus', route_name: '42' },
  ttl_seconds: 60,
};

function buildSealed(overrides?: Partial<DinaMessage>) {
  const msg: DinaMessage = {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    type: 'service.response',
    from: BUS_DID,
    to: 'did:plc:recipient',
    created_time: Date.now(),
    body: JSON.stringify(responseBody),
    ...overrides,
  };
  return sealMessage(msg, senderPriv, recipientPub);
}

function seedServiceQueryTask(
  repo: InMemoryWorkflowRepository,
  id: string,
  overrides: Partial<{
    peerDID: string;
    queryId: string;
    capability: string;
    serviceName: string;
    expiresAtSec: number;
    status: WorkflowTaskState;
  }> = {},
): void {
  const nowMs = Date.now();
  const peerDID = overrides.peerDID ?? BUS_DID;
  const queryId = overrides.queryId ?? 'q-test-1';
  const capability = overrides.capability ?? 'eta_query';
  const serviceName = overrides.serviceName ?? 'Bus 42';
  repo.create({
    id,
    kind: WorkflowTaskKind.ServiceQuery,
    status: overrides.status ?? WorkflowTaskState.Running,
    priority: WorkflowTaskPriority.Normal,
    description: '',
    payload: JSON.stringify({
      to_did: peerDID,
      capability,
      service_name: serviceName,
      query_id: queryId,
    }),
    result_summary: '',
    policy: '{}',
    correlation_id: queryId,
    expires_at: overrides.expiresAtSec ?? Math.floor(nowMs / 1000) + 300,
    created_at: nowMs,
    updated_at: nowMs,
  });
}

describe('inbound service.response → workflow completion', () => {
  let repo: InMemoryWorkflowRepository;

  beforeEach(() => {
    clearGatesState();
    resetStagingState();
    resetAuditState();
    resetQuarantineState();
    clearReplayCache();
    resetServiceWindows();
    repo = new InMemoryWorkflowRepository();
    setWorkflowRepository(repo);
    setWorkflowService(new WorkflowService({ repository: repo }));
  });

  afterAll(() => {
    setWorkflowService(null);
    setWorkflowRepository(null);
    resetServiceWindows();
  });

  it('completes the matching service_query task + emits a `completed` event', () => {
    setRequesterWindow(BUS_DID, responseBody.query_id, responseBody.capability, 60);
    seedServiceQueryTask(repo, 'sq-test-1');

    const payload = buildSealed();
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');
    expect(result.action).toBe('bypassed');

    const task = repo.getById('sq-test-1');
    expect(task?.status).toBe('completed');
    expect(task?.result).toBe(JSON.stringify(responseBody));
    expect(task?.result_summary).toBe('received');

    const events = repo.listEventsForTask('sq-test-1');
    const completed = events.find((e) => e.event_kind === 'completed');
    expect(completed).toBeDefined();
    const details = JSON.parse(completed!.details);
    expect(details.response_status).toBe('success');
    expect(details.capability).toBe('eta_query');
    expect(details.service_name).toBe('Bus 42');
  });

  it('tolerates no matching task (race: task already expired or completed)', () => {
    // Window still open, but the workflow task is gone — legitimate race
    // where the task expired or was completed by a parallel response that
    // landed first. Ingress must NOT crash.
    setRequesterWindow(BUS_DID, responseBody.query_id, responseBody.capability, 60);
    // No seedServiceQueryTask call — repo empty.

    const payload = buildSealed();
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');
    expect(result.action).toBe('bypassed'); // still bypassed, no completion
  });

  it('ignores tasks with mismatched peer DID', () => {
    setRequesterWindow(BUS_DID, responseBody.query_id, responseBody.capability, 60);
    // Task was for a DIFFERENT peer.
    seedServiceQueryTask(repo, 'sq-test-1', { peerDID: 'did:plc:other' });

    const payload = buildSealed();
    receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');

    // Task NOT completed (peer mismatch).
    expect(repo.getById('sq-test-1')?.status).toBe('running');
  });

  it('ignores already-terminal tasks (findServiceQueryTask filter)', () => {
    setRequesterWindow(BUS_DID, responseBody.query_id, responseBody.capability, 60);
    seedServiceQueryTask(repo, 'sq-test-1', { status: WorkflowTaskState.Completed });
    const before = repo.getById('sq-test-1')!;

    const payload = buildSealed();
    receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');

    const after = repo.getById('sq-test-1')!;
    // Task untouched — findServiceQueryTask filters on state IN
    // (created, running), so terminal tasks are invisible and completion
    // never runs.
    expect(after.status).toBe('completed');
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.result).toBe(before.result);
    expect(repo.listEventsForTask('sq-test-1')).toHaveLength(0);
  });

  it('ignores expired tasks (findServiceQueryTask filter)', () => {
    setRequesterWindow(BUS_DID, responseBody.query_id, responseBody.capability, 60);
    // Task expired 1 hour ago.
    seedServiceQueryTask(repo, 'sq-test-1', {
      expiresAtSec: Math.floor(Date.now() / 1000) - 3600,
    });

    const payload = buildSealed();
    receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');

    // Expired task not completed (correctly filtered out).
    expect(repo.getById('sq-test-1')?.status).toBe('running');
  });

  it('emits audit on duplicate correlation (data-integrity)', () => {
    setRequesterWindow(BUS_DID, responseBody.query_id, responseBody.capability, 60);
    // Two tasks sharing correlation — normally impossible but tests the guard.
    seedServiceQueryTask(repo, 'sq-a');
    seedServiceQueryTask(repo, 'sq-b');

    const payload = buildSealed();
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');
    // Still bypassed (response delivered at wire level) — completion
    // silently skipped so the guard event is the signal.
    expect(result.action).toBe('bypassed');

    const audits = queryAudit({ action: 'd2d_recv_service_duplicate_correlation' });
    expect(audits.length).toBeGreaterThan(0);

    // Neither task was completed (we don't pick arbitrarily on integrity violation).
    expect(repo.getById('sq-a')?.status).toBe('running');
    expect(repo.getById('sq-b')?.status).toBe('running');
  });

  it('preserves response_status on non-success outcomes', () => {
    setRequesterWindow(BUS_DID, responseBody.query_id, responseBody.capability, 60);
    seedServiceQueryTask(repo, 'sq-test-1');

    const unavailable = {
      ...responseBody,
      status: 'unavailable' as const,
      result: undefined,
    };
    const payload = buildSealed({ body: JSON.stringify(unavailable) });
    receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');

    const completed = repo.listEventsForTask('sq-test-1').find((e) => e.event_kind === 'completed');
    const details = JSON.parse(completed!.details);
    expect(details.response_status).toBe('unavailable');
  });
});
