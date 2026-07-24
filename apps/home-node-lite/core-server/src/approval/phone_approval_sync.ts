import {
  REMOTE_APPROVAL_API_PREFIX,
  applyOwnerWorkflowDecision,
  getWorkflowService,
  parseCodingGateApprovalPayload,
} from '@dina/core';

export interface PhoneApprovalResponse {
  status: number;
  body: unknown;
}

export interface PhoneApprovalClient {
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<PhoneApprovalResponse>;
}

export interface PhoneApprovalSyncTickOptions {
  client: PhoneApprovalClient;
  nowMs?: number;
  limit?: number;
}

export interface PhoneApprovalSyncTickResult {
  proposed: number;
  pending: number;
  approved: number;
  denied: number;
  failed: number;
}

interface ProposalWire {
  proposal_id: string;
  decision: 'pending' | 'approved' | 'denied' | 'expired';
}

/**
 * Reconcile local HIGH-risk coding approvals with phone-owned mirrors.
 *
 * The source task remains authoritative for permit minting. The phone task is
 * only the owner decision receipt; after an authenticated response says
 * approved/denied, this function applies that decision through Core's normal
 * owner path.
 */
export async function runPhoneApprovalSyncTick(
  options: PhoneApprovalSyncTickOptions,
): Promise<PhoneApprovalSyncTickResult> {
  const result: PhoneApprovalSyncTickResult = {
    proposed: 0,
    pending: 0,
    approved: 0,
    denied: 0,
    failed: 0,
  };
  const service = getWorkflowService();
  if (service === null) return result;
  const nowMs = options.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const tasks = service
    .store()
    .listByKindAndState('approval', 'pending_approval', options.limit ?? 50);

  for (const task of tasks) {
    const payload = parseCodingGateApprovalPayload(task.payload);
    if (payload === null || payload.risk !== 'HIGH') continue;
    if (typeof task.expires_at !== 'number' || task.expires_at <= nowSec) continue;

    try {
      const created = await options.client.request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        {
          source_task_id: task.id,
          source_payload_hash: payload.payload_hash,
          agent_did: payload.agent_did,
          action: payload.action,
          risk_level: 'HIGH',
          tool_name: payload.tool,
          expires_at: task.expires_at,
        },
      );
      if (created.status < 200 || created.status >= 300) {
        result.failed++;
        continue;
      }
      result.proposed++;
      const decision = parseProposalWire(created.body);
      if (decision === null) {
        result.failed++;
        continue;
      }

      // POST is idempotent and returns the mirror's current decision on both
      // create and replay. Polling GET immediately would double MsgBox
      // handshakes for no useful latency gain; the next tick's POST is the poll.
      if (decision.decision === 'pending') {
        result.pending++;
      } else if (decision.decision === 'approved') {
        await applyOwnerWorkflowDecision(task.id, 'approve');
        result.approved++;
      } else {
        await applyOwnerWorkflowDecision(task.id, 'deny', {
          reason:
            decision.decision === 'expired' ? 'phone approval expired' : 'denied on owner phone',
        });
        result.denied++;
      }
    } catch {
      // A relay/phone/storage failure must leave the source task pending. The
      // next tick retries the idempotent proposal; never infer approval. A
      // thrown transport failure applies to the shared phone/relay, so stop
      // this batch rather than serially waiting once per queued task.
      result.failed++;
      break;
    }
  }
  return result;
}

export class PhoneApprovalSyncWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<PhoneApprovalSyncTickResult> | null = null;

  constructor(
    private readonly client: PhoneApprovalClient,
    private readonly intervalMs = 5_000,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.tick().catch(() => {});
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.intervalMs);
  }

  async tick(): Promise<PhoneApprovalSyncTickResult> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = runPhoneApprovalSyncTick({ client: this.client }).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight !== null) {
      try {
        await this.inFlight;
      } catch {
        // The worker is fail-closed. Shutdown only needs the attempt settled.
      }
    }
  }
}

function parseProposalWire(value: unknown): ProposalWire | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.proposal_id !== 'string' ||
    (body.decision !== 'pending' &&
      body.decision !== 'approved' &&
      body.decision !== 'denied' &&
      body.decision !== 'expired')
  ) {
    return null;
  }
  return {
    proposal_id: body.proposal_id,
    decision: body.decision,
  };
}
