/**
 * POST /v1/service/respond — provider-side response handler.
 *
 * Flow:
 *   1. Atomic claim via claimApprovalForExecution (queued → running).
 *   2. Extract payload fields (from_did, query_id, capability, ttl).
 *   3. Validate response body (status enum).
 *   4. Open provider window.
 *   5. Send D2D.
 *   6. On failure: release window + rollback running → queued.
 *   7. On success: setRunId (crash marker) + completeWithDetails.
 */

import type { CoreRouter } from '../router';
import { MsgTypeServiceResponse, MAX_SERVICE_TTL } from '../../d2d/families';
import type { ServiceResponseBody } from '../../d2d/service_bodies';
import { setProviderWindow, releaseProviderWindow } from '../../service/windows';
import { WorkflowTaskState, isTerminal } from '../../workflow/domain';
import { getWorkflowService } from '../../workflow/service';

export type ServiceRespondSender = (
  recipientDID: string,
  messageType: 'service.response',
  body: ServiceResponseBody,
) => Promise<void>;

let senderInstance: ServiceRespondSender | null = null;

export function setServiceRespondSender(s: ServiceRespondSender | null): void {
  senderInstance = s;
}

export function getServiceRespondSender(): ServiceRespondSender | null {
  return senderInstance;
}

const VALID_STATUSES: ReadonlySet<string> = new Set(['success', 'unavailable', 'error']);
const CLAIM_EXTENSION_SEC = 60;

interface ServiceRespondRequest {
  task_id: string;
  response_body: {
    status?: string;
    result?: unknown;
    error?: string;
  };
}

function validateRequest(
  body: unknown,
): { ok: true; req: ServiceRespondRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const taskId = typeof b.task_id === 'string' ? b.task_id : '';
  if (taskId === '') return { ok: false, error: 'task_id is required' };
  if (
    b.response_body === undefined ||
    b.response_body === null ||
    typeof b.response_body !== 'object' ||
    Array.isArray(b.response_body)
  ) {
    return { ok: false, error: 'response_body must be a JSON object' };
  }
  return {
    ok: true,
    req: {
      task_id: taskId,
      response_body: b.response_body as ServiceRespondRequest['response_body'],
    },
  };
}

export interface ServiceRespondRouteOptions {
  sender?: ServiceRespondSender;
  nowSecFn?: () => number;
  nowMsFn?: () => number;
}

export function registerServiceRespondRoutes(
  router: CoreRouter,
  options: ServiceRespondRouteOptions = {},
): void {
  const nowSecFn = options.nowSecFn ?? (() => Math.floor(Date.now() / 1000));
  const nowMsFn = options.nowMsFn ?? (() => Date.now());

  router.post('/v1/service/respond', async (req) => {
    const service = getWorkflowService();
    if (service === null) return j(503, { error: 'workflow service not wired' });
    const sender = options.sender ?? senderInstance;
    if (sender === null) return j(503, { error: 'service-respond sender not wired' });

    if (req.body === undefined) return j(400, { error: 'empty body' });
    const v = validateRequest(req.body);
    if (!v.ok) return j(400, { error: v.error });
    const { task_id, response_body } = v.req;
    const repo = service.store();

    // 1. Atomic claim.
    const claimed = repo.claimApprovalForExecution(task_id, CLAIM_EXTENSION_SEC, nowSecFn());
    if (!claimed) {
      const current = repo.getById(task_id);
      if (current === null) return j(404, { error: 'task not found' });
      if (isTerminal(current.status as WorkflowTaskState)) {
        return j(200, { already_processed: true, status: current.status });
      }
      if (
        current.status === WorkflowTaskState.Running &&
        current.kind === 'approval' &&
        current.run_id !== undefined &&
        current.run_id !== ''
      ) {
        const eventDetails = JSON.stringify({ state: 'completed', reason: 'crash_recovery' });
        const existingResult = current.result ?? JSON.stringify({ recovered: true });
        const eventId = repo.completeWithDetails(
          task_id,
          '',
          'recovered',
          existingResult,
          eventDetails,
          nowMsFn(),
        );
        if (eventId === 0) return j(500, { error: 'crash recovery completion failed' });
        return j(200, { already_processed: true, status: 'recovered' });
      }
      return j(409, { error: 'task already claimed by another caller' });
    }

    // 2. Extract payload.
    const claimedTask = repo.getById(task_id);
    if (claimedTask === null) return j(500, { error: 'task disappeared after claim' });
    let payload: {
      from_did?: string;
      query_id?: string;
      capability?: string;
      ttl_seconds?: number;
      service_name?: string;
    };
    try {
      payload = JSON.parse(claimedTask.payload);
    } catch (err) {
      rollbackToQueued(repo, task_id, nowMsFn());
      return j(500, { error: `invalid task payload: ${(err as Error).message}` });
    }
    const fromDID = payload.from_did ?? '';
    const queryId = payload.query_id ?? '';
    const capability = payload.capability ?? '';
    const ttlSeconds =
      typeof payload.ttl_seconds === 'number' && Number.isFinite(payload.ttl_seconds)
        ? payload.ttl_seconds
        : 60;
    if (fromDID === '' || queryId === '' || capability === '') {
      rollbackToQueued(repo, task_id, nowMsFn());
      return j(500, { error: 'incomplete task payload' });
    }
    if (ttlSeconds < 1 || ttlSeconds > MAX_SERVICE_TTL) {
      rollbackToQueued(repo, task_id, nowMsFn());
      return j(500, { error: 'task payload ttl_seconds out of range' });
    }

    // 3. Validate response body status.
    const status = response_body.status ?? '';
    if (!VALID_STATUSES.has(status)) {
      rollbackToQueued(repo, task_id, nowMsFn());
      return j(400, { error: 'response_body.status must be success|unavailable|error' });
    }

    // 4. Open fresh provider window.
    //
    //    Use the REMAINING original wait window, not the
    //    lease-extended `expires_at`. Review history:
    //      - Main-dina 4848a934: stop hardcoding 30s; preserve
    //        requester's ttl through the bridge.
    //      - Later pass: using the full `ttl_seconds` verbatim was
    //        wrong for review/approval flows — a task sitting queued
    //        for 45s then handed a fresh 60s window authorises the
    //        provider past the requester's T+60 expiry.
    //      - This pass (review #2 of the follow-up): computing
    //        remaining from `claimedTask.expires_at` is ALSO wrong
    //        because `claimApprovalForExecution` already extended
    //        that column by `CLAIM_EXTENSION_SEC=60` as part of the
    //        claim. The authoritative deadline is the task's
    //        creation time plus its original ttl.
    //    Formula: `originalDeadlineSec = floor(created_at / 1000) +
    //    ttlSeconds`; `remainingSec = max(1, originalDeadlineSec -
    //    nowSec)`. Minimum 1s so a just-expired task still gets one
    //    shot at the window (the D2D-level ttl check is elsewhere).
    const nowSecNow = nowSecFn();
    const originalDeadlineSec = Math.floor(claimedTask.created_at / 1000) + ttlSeconds;
    const remainingSec = Math.max(1, originalDeadlineSec - nowSecNow);
    const windowSec = Math.min(remainingSec, ttlSeconds);
    setProviderWindow(fromDID, queryId, capability, windowSec);

    // 5. Build D2D body (task payload is authoritative for query_id etc.).
    const d2dBody: ServiceResponseBody = {
      query_id: queryId,
      capability,
      status: status as ServiceResponseBody['status'],
      ttl_seconds: ttlSeconds,
    };
    if (status === 'success' && response_body.result !== undefined) {
      d2dBody.result = response_body.result;
    }
    if (status !== 'success' && typeof response_body.error === 'string') {
      d2dBody.error = response_body.error;
    }

    // 6. Send.
    try {
      await sender(fromDID, MsgTypeServiceResponse, d2dBody);
    } catch (err) {
      releaseProviderWindow(fromDID, queryId, capability);
      rollbackToQueued(repo, task_id, nowMsFn());
      return j(502, { error: `send failed: ${(err as Error).message ?? String(err)}` });
    }

    // 7. Durable marker + completion.
    void repo.setRunId(task_id, `svc-resp:${task_id}`, nowMsFn());
    // Carry the `error` string on event details when the response is
    // non-success (issue #12). The consumer-side formatter reads this
    // to surface a meaningful user message instead of a generic
    // "service unavailable".
    const eventDetails = JSON.stringify({
      response_status: status,
      service_name: payload.service_name ?? '',
      capability,
      error: typeof response_body.error === 'string' ? response_body.error : undefined,
    });
    const eventId = repo.completeWithDetails(
      task_id,
      '',
      'responded',
      JSON.stringify(d2dBody),
      eventDetails,
      nowMsFn(),
    );
    if (eventId === 0) return j(500, { error: 'response sent but task completion failed' });

    return j(200, { status: 'sent', task_id });
  });
}

// Helpers.

function rollbackToQueued(
  repo: ReturnType<NonNullable<ReturnType<typeof getWorkflowService>>['store']>,
  taskId: string,
  nowMs: number,
): void {
  repo.transition(taskId, WorkflowTaskState.Running, WorkflowTaskState.Queued, nowMs);
}

function j(status: number, body: unknown) {
  return { status, body };
}
