/**
 * BRAIN-P2-W05 — `/service_deny` orchestrator integration + factory.
 */

import {
  handleChat,
  resetChatDefaults,
  setServiceDenyCommandHandler,
  resetServiceDenyCommandHandler,
} from '../../src/chat/orchestrator';
import { resetThreads } from '../../src/chat/thread';
import { makeServiceDenyHandler } from '../../src/service/approve_command';
import { CoreHttpError, type BrainCoreClient } from '../../src/core_client/http';
import type { WorkflowTask } from '../../../core/src/workflow/domain';

describe('Chat orchestrator — /service_deny', () => {
  beforeEach(() => {
    resetChatDefaults();
    resetThreads();
    resetServiceDenyCommandHandler();
  });

  afterAll(() => {
    resetServiceDenyCommandHandler();
  });

  it('without a handler, returns a friendly "not wired up" notice', async () => {
    const res = await handleChat('/service_deny approval-u1');
    expect(res.intent).toBe('service_deny');
    expect(res.response).toMatch(/approval-u1/);
    expect(res.response).toMatch(/not wired up|coming soon/i);
  });

  it('missing taskId → parser falls back to chat (no dispatch)', async () => {
    const res = await handleChat('/service_deny');
    expect(res.intent).not.toBe('service_deny');
  });

  it('with a handler installed, delegates with the parsed taskId + reason', async () => {
    const calls: Array<{ taskId: string; reason: string }> = [];
    setServiceDenyCommandHandler(async (taskId, reason) => {
      calls.push({ taskId, reason });
      return { ack: `Denied ${taskId}: ${reason || '(no reason)'}` };
    });

    const res = await handleChat('/service_deny approval-xyz scope too broad');
    expect(calls).toEqual([{ taskId: 'approval-xyz', reason: 'scope too broad' }]);
    expect(res.response).toBe('Denied approval-xyz: scope too broad');
  });

  it('empty reason is forwarded as ""', async () => {
    const received: string[] = [];
    setServiceDenyCommandHandler(async (_taskId, reason) => {
      received.push(reason);
      return { ack: 'ok' };
    });
    await handleChat('/service_deny approval-u1');
    expect(received).toEqual(['']);
  });

  it('HTTP 404 → "No approval task with id …"', async () => {
    setServiceDenyCommandHandler(async () => {
      throw new CoreHttpError(
        'cancelWorkflowTask: HTTP 404 — task not found',
        404,
        'task not found',
        'cancelWorkflowTask',
      );
    });
    const res = await handleChat('/service_deny approval-missing');
    expect(res.response).toBe('No approval task with id "approval-missing".');
  });

  it('HTTP 409 → "is no longer pending approval"', async () => {
    setServiceDenyCommandHandler(async () => {
      throw new CoreHttpError(
        'cancelWorkflowTask: HTTP 409 — transition error',
        409,
        'transition error',
        'cancelWorkflowTask',
      );
    });
    const res = await handleChat('/service_deny approval-stale');
    expect(res.response).toBe('Task "approval-stale" is no longer pending approval.');
  });

  it('generic error → surfaces "Couldn\'t deny" + underlying message', async () => {
    setServiceDenyCommandHandler(async () => {
      throw new Error('database locked');
    });
    const res = await handleChat('/service_deny approval-u1 junk');
    expect(res.response).toMatch(/Couldn't deny "approval-u1".*database locked/);
  });
});

describe('makeServiceDenyHandler (BRAIN-P2-W05)', () => {
  interface RespondCall {
    taskId: string;
    body: { status: string; error?: string };
  }
  interface CancelCall {
    taskId: string;
    reason?: string;
  }

  function stubClient(overrides?: {
    respondError?: Error;
    cancelError?: Error;
    respondCalls?: RespondCall[];
    cancelCalls?: CancelCall[];
  }): Pick<BrainCoreClient, 'cancelWorkflowTask' | 'sendServiceRespond'> {
    return {
      async sendServiceRespond(taskId, body) {
        overrides?.respondCalls?.push({
          taskId,
          body: body as { status: string; error?: string },
        });
        if (overrides?.respondError) throw overrides.respondError;
        return { status: 'sent', taskId, alreadyProcessed: false };
      },
      async cancelWorkflowTask(id: string, reason?: string) {
        overrides?.cancelCalls?.push({ taskId: id, reason });
        if (overrides?.cancelError) throw overrides.cancelError;
        return {
          id,
          status: 'cancelled',
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
    expect(() => makeServiceDenyHandler(undefined as unknown as BrainCoreClient)).toThrow(
      /coreClient/,
    );
  });

  it('sends unavailable response and does NOT double-cancel (review #1 happy path)', async () => {
    const respondCalls: RespondCall[] = [];
    const cancelCalls: CancelCall[] = [];
    const handler = makeServiceDenyHandler(stubClient({ respondCalls, cancelCalls }));
    const result = await handler('approval-u1', 'stale data');

    expect(respondCalls).toEqual([
      {
        taskId: 'approval-u1',
        body: { status: 'unavailable', error: 'stale data' },
      },
    ]);
    // Review #1: /v1/service/respond already terminates the approval
    // task. Cancelling again produced false 409s. Happy path has zero
    // cancel calls now.
    expect(cancelCalls).toEqual([]);
    expect(result.ack).toBe('Denied — "approval-u1" (stale data).');
  });

  it('defaults empty reason to "denied_by_operator"', async () => {
    const respondCalls: RespondCall[] = [];
    const cancelCalls: CancelCall[] = [];
    const handler = makeServiceDenyHandler(stubClient({ respondCalls, cancelCalls }));

    await handler('approval-u1', '');

    expect(respondCalls[0].body.error).toBe('denied_by_operator');
    // Respond succeeded, so no cancel fallback.
    expect(cancelCalls).toEqual([]);
  });

  it('falls back to cancel when sendServiceRespond fails (review #1 negative path)', async () => {
    const cancelCalls: CancelCall[] = [];
    const handler = makeServiceDenyHandler(
      stubClient({
        respondError: new Error('HTTP 409 — claim conflict'),
        cancelCalls,
      }),
    );
    const result = await handler('approval-u1', 'reason');

    // Respond threw → cancel fires so the approval doesn't sit
    // `running` forever.
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]).toEqual({ taskId: 'approval-u1', reason: 'reason' });
    expect(result.ack).toContain('cancelled locally');
    expect(result.ack).toContain('HTTP 409');
  });

  it('propagates cancelWorkflowTask errors on the fallback path', async () => {
    const handler = makeServiceDenyHandler(
      stubClient({
        respondError: new Error('HTTP 500 — respond blew up'),
        cancelError: new Error('cancelWorkflowTask: HTTP 404 — not found'),
      }),
    );
    await expect(handler('approval-missing', 'x')).rejects.toThrow(/HTTP 404/);
  });

  it('integrates end-to-end with the orchestrator (happy path)', async () => {
    const respondCalls: RespondCall[] = [];
    const cancelCalls: CancelCall[] = [];
    setServiceDenyCommandHandler(makeServiceDenyHandler(stubClient({ respondCalls, cancelCalls })));

    const res = await handleChat('/service_deny approval-e2e wrong bus route');

    expect(respondCalls).toEqual([
      {
        taskId: 'approval-e2e',
        body: { status: 'unavailable', error: 'wrong bus route' },
      },
    ]);
    // Single-termination contract — see review #1.
    expect(cancelCalls).toEqual([]);
    expect(res.response).toBe('Denied — "approval-e2e" (wrong bus route).');
  });
});
