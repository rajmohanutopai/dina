import {
  REMOTE_APPROVAL_API_PREFIX,
  applyOwnerWorkflowDecision,
  getWorkflowService,
  parseCodingGateApprovalPayload,
  remoteApprovalProposalId,
} from '@dina/core';
import { kvDelete, kvList, kvSet } from '@dina/core/kv';

export interface PhoneApprovalResponse {
  status: number;
  body: unknown;
}

export interface PhoneApprovalClient {
  readonly did: string;
  request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<PhoneApprovalResponse>;
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
  withdrawn: number;
  failed: number;
}

export interface PhoneApprovalMirrorWithdrawalResult {
  withdrawn: number;
  failed: number;
}

interface ProposalWire {
  proposal_id: string;
  decision: 'pending' | 'approved' | 'denied' | 'expired';
}

const RECEIPT_NAMESPACE = 'phone_approval_mirrors';

interface MirrorReceipt {
  sourceTaskId: string;
  proposalId: string;
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
    withdrawn: 0,
    failed: 0,
  };
  const service = getWorkflowService();
  if (service === null) return result;

  // Close phone-side cards whose authoritative laptop task is no longer
  // pending. Receipts are durable so a cancellation followed by a laptop
  // restart still reconciles rather than leaving a misleading phone card.
  for (const receipt of await listMirrorReceipts()) {
    const source = service.store().getById(receipt.sourceTaskId);
    if (source !== null && source.status === 'pending_approval') continue;
    try {
      const withdrawn = await options.client.request(
        'DELETE',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals/${encodeURIComponent(receipt.proposalId)}`,
      );
      if ((withdrawn.status >= 200 && withdrawn.status < 300) || withdrawn.status === 404) {
        await kvDelete(receipt.sourceTaskId, RECEIPT_NAMESPACE);
        result.withdrawn++;
      } else {
        result.failed++;
      }
    } catch {
      result.failed++;
      break;
    }
  }

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
      const expectedProposalId = remoteApprovalProposalId(options.client.did, task.id);
      // Persist the deterministic receipt before transport. If the phone
      // creates the card and this process dies before POST returns, the next
      // boot can still withdraw the card when the source task is terminal.
      await kvSet(
        task.id,
        JSON.stringify({ source_task_id: task.id, proposal_id: expectedProposalId }),
        RECEIPT_NAMESPACE,
      );
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
      if (decision.proposal_id !== expectedProposalId) {
        // A signed phone response that violates the deterministic protocol
        // cannot authorize the local task. Best-effort close the unexpected
        // card and retain the expected receipt for later reconciliation.
        await options.client
          .request(
            'DELETE',
            `${REMOTE_APPROVAL_API_PREFIX}/proposals/${encodeURIComponent(decision.proposal_id)}`,
          )
          .catch(() => undefined);
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
        await kvDelete(task.id, RECEIPT_NAMESPACE);
        result.approved++;
      } else {
        await applyOwnerWorkflowDecision(task.id, 'deny', {
          reason:
            decision.decision === 'expired' ? 'phone approval expired' : 'denied on owner phone',
        });
        await kvDelete(task.id, RECEIPT_NAMESPACE);
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
    void this.tick().catch(() => undefined);
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.intervalMs);
    this.timer.unref?.();
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

/** Withdraw every durable phone mirror before revoking/replacing the phone. */
export async function withdrawAllPhoneApprovalMirrors(
  client: PhoneApprovalClient,
): Promise<PhoneApprovalMirrorWithdrawalResult> {
  const result: PhoneApprovalMirrorWithdrawalResult = { withdrawn: 0, failed: 0 };
  for (const receipt of await listMirrorReceipts()) {
    try {
      const response = await client.request(
        'DELETE',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals/${encodeURIComponent(receipt.proposalId)}`,
      );
      if ((response.status >= 200 && response.status < 300) || response.status === 404) {
        await kvDelete(receipt.sourceTaskId, RECEIPT_NAMESPACE);
        result.withdrawn++;
      } else {
        result.failed++;
      }
    } catch {
      result.failed++;
      break;
    }
  }
  return result;
}

async function listMirrorReceipts(): Promise<MirrorReceipt[]> {
  const entries = await kvList(RECEIPT_NAMESPACE);
  const receipts: MirrorReceipt[] = [];
  for (const entry of entries) {
    try {
      const value = JSON.parse(entry.value) as Record<string, unknown>;
      const valid =
        typeof value.source_task_id === 'string' &&
        value.source_task_id !== '' &&
        typeof value.proposal_id === 'string' &&
        value.proposal_id !== '';
      if (valid) {
        receipts.push({
          sourceTaskId: value.source_task_id as string,
          proposalId: value.proposal_id as string,
        });
      } else {
        await deleteReceiptEntry(entry.key);
      }
    } catch {
      // Quarantine malformed local metadata by deleting it. It contains no
      // authority; retaining it can only block future cleanup.
      await deleteReceiptEntry(entry.key);
    }
  }
  return receipts;
}

function parseProposalWire(value: unknown): ProposalWire | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.proposal_id !== 'string' ||
    body.proposal_id === '' ||
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

async function deleteReceiptEntry(entryKey: string): Promise<void> {
  const key = entryKey.startsWith(`${RECEIPT_NAMESPACE}:`)
    ? entryKey.slice(RECEIPT_NAMESPACE.length + 1)
    : entryKey;
  await kvDelete(key, RECEIPT_NAMESPACE);
}
