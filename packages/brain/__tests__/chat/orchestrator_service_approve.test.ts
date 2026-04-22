/**
 * BRAIN-P2-W01 + W02 — `/service_approve` orchestrator integration.
 *
 * Covers:
 *   - No handler → friendly "not wired up" notice.
 *   - With a handler → hook is invoked with the parsed taskId.
 *   - HTTP-404 error from Core → "No approval task with id …".
 *   - HTTP-409 error → "task is no longer pending approval".
 *   - `makeServiceApproveHandler` delegates to `coreClient.approveWorkflowTask`.
 */

import {
  handleChat,
  resetChatDefaults,
  setServiceApproveCommandHandler,
  resetServiceApproveCommandHandler,
} from '../../src/chat/orchestrator';
import { resetThreads } from '../../src/chat/thread';
import { makeServiceApproveHandler } from '../../src/service/approve_command';
import { CoreHttpError, type BrainCoreClient } from '../../src/core_client/http';
import type { WorkflowTask } from '../../../core/src/workflow/domain';

describe('Chat orchestrator — /service_approve', () => {
  beforeEach(() => {
    resetChatDefaults();
    resetThreads();
    resetServiceApproveCommandHandler();
  });

  afterAll(() => {
    resetServiceApproveCommandHandler();
  });

  it('without a handler, returns a friendly "not wired up" notice', async () => {
    const res = await handleChat('/service_approve approval-u1');
    expect(res.intent).toBe('service_approve');
    expect(res.response).toMatch(/approval-u1/);
    expect(res.response).toMatch(/not wired up|coming soon/i);
  });

  it('missing taskId → parser falls back to chat (no dispatch)', async () => {
    const res = await handleChat('/service_approve');
    expect(res.intent).not.toBe('service_approve');
  });

  it('with a handler installed, delegates with the parsed taskId', async () => {
    const calls: string[] = [];
    setServiceApproveCommandHandler(async (taskId) => {
      calls.push(taskId);
      return { ack: `Approved — "${taskId}" moving.` };
    });

    const res = await handleChat('/service_approve approval-xyz');

    expect(calls).toEqual(['approval-xyz']);
    expect(res.response).toBe('Approved — "approval-xyz" moving.');
  });

  it('HTTP 404 from Core → "No approval task with id …"', async () => {
    setServiceApproveCommandHandler(async () => {
      throw new CoreHttpError(
        'approveWorkflowTask: HTTP 404 — task not found',
        404,
        'task not found',
        'approveWorkflowTask',
      );
    });
    const res = await handleChat('/service_approve approval-missing');
    expect(res.response).toBe('No approval task with id "approval-missing".');
  });

  it('HTTP 409 from Core → "is no longer pending approval"', async () => {
    setServiceApproveCommandHandler(async () => {
      throw new CoreHttpError(
        'approveWorkflowTask: HTTP 409 — transition pending_approval → queued is not allowed',
        409,
        'transition pending_approval → queued is not allowed',
        'approveWorkflowTask',
      );
    });
    const res = await handleChat('/service_approve approval-stale');
    expect(res.response).toBe('Task "approval-stale" is no longer pending approval.');
  });

  it('generic error → surfaces "Couldn\'t approve" + underlying message', async () => {
    setServiceApproveCommandHandler(async () => {
      throw new Error('network down');
    });
    const res = await handleChat('/service_approve approval-u1');
    expect(res.response).toMatch(/Couldn't approve "approval-u1".*network down/);
  });
});

describe('makeServiceApproveHandler (BRAIN-P2-W02)', () => {
  function stubClient(overrides?: {
    approveError?: Error;
    seenTasks?: string[];
  }): Pick<BrainCoreClient, 'approveWorkflowTask'> {
    return {
      async approveWorkflowTask(id: string) {
        overrides?.seenTasks?.push(id);
        if (overrides?.approveError) throw overrides.approveError;
        return {
          id,
          status: 'queued',
          kind: 'approval',
          priority: 'normal',
          description: '',
          payload: '{}',
          result_summary: '',
          policy: '{}',
          created_at: 0,
          updated_at: 0,
        } as WorkflowTask;
      },
    };
  }

  it('rejects a missing coreClient at build time', () => {
    expect(() => makeServiceApproveHandler(undefined as unknown as BrainCoreClient)).toThrow(
      /coreClient/,
    );
  });

  it('calls coreClient.approveWorkflowTask with the taskId', async () => {
    const seen: string[] = [];
    const handler = makeServiceApproveHandler(stubClient({ seenTasks: seen }));
    const result = await handler('approval-u1');
    expect(seen).toEqual(['approval-u1']);
    expect(result.ack).toBe('Approved — "approval-u1" executing via delegation…');
  });

  it('propagates Core errors so the orchestrator can format them', async () => {
    const handler = makeServiceApproveHandler(
      stubClient({
        approveError: new CoreHttpError(
          'approveWorkflowTask: HTTP 404 — not found',
          404,
          'not found',
          'approveWorkflowTask',
        ),
      }),
    );
    await expect(handler('approval-missing')).rejects.toThrow(/HTTP 404/);
  });

  it('integrates end-to-end with the orchestrator (happy path)', async () => {
    const seen: string[] = [];
    setServiceApproveCommandHandler(makeServiceApproveHandler(stubClient({ seenTasks: seen })));

    const res = await handleChat('/service_approve approval-integration');

    expect(seen).toEqual(['approval-integration']);
    expect(res.intent).toBe('service_approve');
    expect(res.response).toBe('Approved — "approval-integration" executing via delegation…');
  });
});
