import {
  createBrokerReasoningAuthority,
  createCoreClientReasoningAuthority,
  CoreHttpError,
  CoreReasoningBroker,
  InMemoryReasoningBackendRepository,
  InMemoryReasoningContextRepository,
  ReasoningBackendWorker,
  type AuthorityOrigin,
} from '../../src';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService } from '../../src/workflow/service';

const OWNER = 'did:plc:owner';
const PRINCIPAL = 'did:plc:internal-brain';

function origin(): AuthorityOrigin {
  return {
    kind: 'owner_interactive',
    ownerDid: OWNER,
    requesterDid: OWNER,
    ingress: 'internal',
    correlationId: 'ask-1',
    authenticatedAtMs: 1_000,
  };
}

function harness() {
  const now = 10_000;
  const workflows = new InMemoryWorkflowRepository();
  const service = new WorkflowService({ repository: workflows, nowMsFn: () => now });
  const backends = new InMemoryReasoningBackendRepository();
  const contexts = new InMemoryReasoningContextRepository();
  const broker = new CoreReasoningBroker({
    workflowService: service,
    workflowRepository: workflows,
    backendRepository: backends,
    contextRepository: contexts,
    nowMs: () => now,
  });
  backends.register({
    backendId: 'internal',
    kind: 'internal_brain',
    principalDid: PRINCIPAL,
    allowedTaskKinds: ['answer.compose'],
    maxSensitivity: 'sensitive',
    availability: 'always_on',
    selectedByOwnerDid: OWNER,
    expectedVersion: null,
    nowMs: now,
  });
  const submit = () =>
    broker.submit({
      taskKind: 'answer.compose',
      ownerDid: OWNER,
      authorityOrigin: origin(),
      input: { query: 'Which chair?' },
      context: {
        items: [{ sourceId: 'review-1', sourceType: 'review', text: 'Good lumbar support' }],
        scrubbed: true,
        sensitivity: 'personal',
      },
      sensitivity: 'personal',
      evidencePolicy: 'required',
      purpose: 'answer owner',
      backendBindingId: 'internal',
      deadlineAtMs: now + 60_000,
    });
  return { broker, workflows, submit };
}

describe('ReasoningBackendWorker', () => {
  it('runs one backend proposal through the broker completion fence', async () => {
    const h = harness();
    const submitted = h.submit();
    const worker = new ReasoningBackendWorker({
      broker: h.broker,
      backendId: 'internal',
      principalDid: PRINCIPAL,
      execute: async (claim) => ({
        result: {
          answer: `Use the evidence: ${claim.context?.items[0]?.text ?? 'none'}`,
          evidenceIds: ['review-1'],
        },
        evidenceIds: ['review-1'],
      }),
    });

    const result = await worker.runOne(submitted.taskId);
    expect(result).toMatchObject({
      state: 'completed',
      taskId: submitted.taskId,
      completion: { accepted: true, code: 'completed' },
    });
    expect(h.workflows.getById(submitted.taskId)?.status).toBe('completed');
  });

  it('fails closed by default when the adapter throws', async () => {
    const h = harness();
    const submitted = h.submit();
    const worker = new ReasoningBackendWorker({
      broker: h.broker,
      backendId: 'internal',
      principalDid: PRINCIPAL,
      execute: async () => {
        throw new Error('provider rejected the request');
      },
    });

    expect(await worker.runOne(submitted.taskId)).toMatchObject({
      state: 'failed',
      failure: { accepted: true, state: 'failed', code: 'failed' },
    });
    expect(h.workflows.getById(submitted.taskId)?.status).toBe('failed');
  });

  it('requeues only when the adapter explicitly classifies an error as retryable', async () => {
    const h = harness();
    const submitted = h.submit();
    const worker = new ReasoningBackendWorker({
      broker: h.broker,
      backendId: 'internal',
      principalDid: PRINCIPAL,
      execute: async () => {
        throw new Error('temporary timeout');
      },
      classifyError: () => ({ message: 'temporary timeout', retryable: true }),
    });

    expect(await worker.runOne(submitted.taskId)).toMatchObject({
      state: 'failed',
      failure: { accepted: true, state: 'queued', code: 'requeued' },
    });
    expect(h.workflows.getById(submitted.taskId)?.status).toBe('queued');
  });

  it('returns idle when no eligible work exists and suppresses overlapping ticks', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.submit();
    const worker = new ReasoningBackendWorker({
      broker: h.broker,
      backendId: 'internal',
      principalDid: PRINCIPAL,
      execute: async () => {
        await blocked;
        return { result: { answer: 'done' } };
      },
    });

    const first = worker.runOne();
    expect(await worker.runOne()).toEqual({ state: 'busy' });
    release?.();
    await first;
    expect(await worker.runOne()).toEqual({ state: 'idle' });
  });

  it('heartbeats a slow execution and aborts without completing after lease loss', async () => {
    const h = harness();
    const submitted = h.submit();
    const base = createBrokerReasoningAuthority(h.broker);
    const intervals: (() => void)[] = [];
    let completed = false;
    const worker = new ReasoningBackendWorker({
      authority: {
        ...base,
        heartbeat: async () => false,
        complete: async (input) => {
          completed = true;
          return base.complete(input);
        },
      },
      backendId: 'internal',
      principalDid: PRINCIPAL,
      execute: async (_claim, context) =>
        new Promise((resolve, reject) => {
          context?.signal.addEventListener('abort', () => reject(context.signal.reason));
          void resolve;
        }),
      setInterval: (callback) => {
        intervals.push(callback);
        return 1;
      },
      clearInterval: () => undefined,
    });

    const running = worker.runOne(submitted.taskId);
    await Promise.resolve();
    intervals[0]?.();
    await Promise.resolve();
    await expect(running).resolves.toEqual({ state: 'lost', taskId: submitted.taskId });
    expect(completed).toBe(false);
  });

  it('does not requeue when completion transport outcome is unknown', async () => {
    const h = harness();
    const submitted = h.submit();
    const base = createBrokerReasoningAuthority(h.broker);
    let failed = false;
    const worker = new ReasoningBackendWorker({
      authority: {
        ...base,
        complete: async () => {
          throw new Error('connection reset after upload');
        },
        fail: async (input) => {
          failed = true;
          return base.fail(input);
        },
      },
      backendId: 'internal',
      principalDid: PRINCIPAL,
      execute: async () => ({ result: { answer: 'done' } }),
    });

    await expect(worker.runOne(submitted.taskId)).resolves.toEqual({
      state: 'outcome_unknown',
      taskId: submitted.taskId,
      error: 'connection reset after upload',
    });
    expect(failed).toBe(false);
  });

  it('treats an unavailable persisted backend as idle without masking other failures', async () => {
    let error: Error = new CoreHttpError(
      'HttpCoreTransport: reasoningClaim failed 404 — reasoning_backend_unavailable',
      404,
    );
    const authority = createCoreClientReasoningAuthority({
      reasoningClaim: async () => {
        throw error;
      },
    } as never);

    await expect(
      authority.claim({
        backendId: 'internal',
        principalDid: PRINCIPAL,
      }),
    ).resolves.toBeNull();

    error = new CoreHttpError('HttpCoreTransport: reasoningClaim failed 503 — unavailable', 503);
    await expect(
      authority.claim({
        backendId: 'internal',
        principalDid: PRINCIPAL,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
