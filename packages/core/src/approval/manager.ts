/**
 * Approval request manager — in-memory lifecycle for user approvals.
 *
 * Lifecycle: pending → approved | denied
 * Approval scope: 'single' (consumed after one use) or 'session' (valid until session end).
 *
 * Brain/agents request approval; user approves/denies via UI.
 * Gatekeeper checks approval status before allowing high-risk actions.
 *
 * Source: core/internal/adapter/approval/manager.go
 */

export interface ApprovalRequest {
  id: string;
  action: string;
  requester_did: string;
  persona: string;
  reason: string;
  preview: string;
  status: 'pending' | 'approved' | 'denied';
  scope?: 'single' | 'session';
  approved_by?: string;
  created_at: number;
}

export class ApprovalManager {
  private readonly requests: Map<string, ApprovalRequest> = new Map();

  /**
   * Create a new approval request.
   *
   * @returns The approval ID
   * @throws if an approval with the same ID already exists
   */
  requestApproval(req: Omit<ApprovalRequest, 'status'>): string {
    if (this.requests.has(req.id)) {
      throw new Error(`approval: request "${req.id}" already exists`);
    }

    this.requests.set(req.id, {
      ...req,
      status: 'pending',
    });

    return req.id;
  }

  /**
   * Approve a pending request.
   *
   * @param id - Approval request ID
   * @param scope - 'single' (one-time) or 'session' (until session end)
   * @param approvedBy - DID or identifier of the approver
   * @throws if request not found or not pending
   */
  approveRequest(id: string, scope: 'single' | 'session', approvedBy: string): void {
    const req = this.requests.get(id);
    if (!req) {
      throw new Error(`approval: request "${id}" not found`);
    }
    if (req.status !== 'pending') {
      throw new Error(`approval: request "${id}" is ${req.status}, not pending`);
    }

    req.status = 'approved';
    req.scope = scope;
    req.approved_by = approvedBy;
  }

  /**
   * Deny a pending request.
   *
   * @throws if request not found or not pending
   */
  denyRequest(id: string): void {
    const req = this.requests.get(id);
    if (!req) {
      throw new Error(`approval: request "${id}" not found`);
    }
    if (req.status !== 'pending') {
      throw new Error(`approval: request "${id}" is ${req.status}, not pending`);
    }

    req.status = 'denied';
  }

  /** List all pending approval requests. */
  listPending(): ApprovalRequest[] {
    return Array.from(this.requests.values()).filter((r) => r.status === 'pending');
  }

  /** Get a specific request by ID. */
  getRequest(id: string): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  /** Check if a specific approval is approved with the given scope. */
  isApproved(id: string): boolean {
    const req = this.requests.get(id);
    return req?.status === 'approved';
  }

  /**
   * Consume a single-use approval (marks as consumed after one use).
   * Session-scoped approvals are NOT consumed by this.
   *
   * @returns true if the approval was consumed, false if not single-scope or not approved
   */
  consumeSingle(id: string): boolean {
    const req = this.requests.get(id);
    if (!req || req.status !== 'approved' || req.scope !== 'single') {
      return false;
    }
    this.requests.delete(id);
    return true;
  }

  /** Revoke all session-scoped approvals (called on session end). */
  revokeSession(): number {
    let count = 0;
    for (const [id, req] of this.requests.entries()) {
      if (req.status === 'approved' && req.scope === 'session') {
        this.requests.delete(id);
        count++;
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Singleton — shared across HTTP routes, UI hooks, and Brain event processor.
//
// Previously, approvals.ts and useChatApprovals.ts each created their own
// ApprovalManager instance, so approvals created via HTTP were invisible to
// the UI and vice versa. This singleton fixes that bug (GAP_ANALYSIS §A48).
// ---------------------------------------------------------------------------

let _instance: ApprovalManager | null = null;

/** Get the shared ApprovalManager singleton. */
export function getApprovalManager(): ApprovalManager {
  if (!_instance) {
    _instance = new ApprovalManager();
  }
  return _instance;
}

/** Reset the singleton (for testing only). */
export function resetApprovalManager(): void {
  _instance = new ApprovalManager();
}
