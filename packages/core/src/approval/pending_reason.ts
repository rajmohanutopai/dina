/**
 * Pending reason lifecycle — tracks WHY an operation is pending approval.
 *
 * Lifecycle: create → pending_approval → resuming → completed | denied
 * Expiry: expired entries swept by sweepPendingReasons.
 * Caller binding: only the original caller DID can check status.
 *
 * Source: core/test/pending_reason_test.go
 */

export interface PendingReasonRecord {
  requestId: string;
  callerDID: string;
  approvalId: string;
  status: 'pending_approval' | 'resuming' | 'completed' | 'denied' | 'expired';
  result?: string;
  error?: string;
  expiresAt: number;
  createdAt: number;
}

/** In-memory store of pending reason records. */
const records = new Map<string, PendingReasonRecord>();

/**
 * Create a pending reason record.
 * Initial status is always 'pending_approval'.
 */
export function createPendingReason(
  input: Omit<PendingReasonRecord, 'status' | 'createdAt'>,
): PendingReasonRecord {
  const record: PendingReasonRecord = {
    ...input,
    status: 'pending_approval',
    createdAt: Math.floor(Date.now() / 1000),
  };
  records.set(input.requestId, record);
  return record;
}

/**
 * Get a record by ID, enforcing caller DID binding.
 * Only the original requester can check status.
 *
 * @returns record or null if not found or caller mismatch
 */
export function getByID(requestId: string, callerDID: string): PendingReasonRecord | null {
  const record = records.get(requestId);
  if (!record) return null;
  if (record.callerDID !== callerDID) return null;
  return record;
}

/**
 * Get all records for a given approval ID.
 */
export function getByApprovalID(approvalId: string): PendingReasonRecord[] {
  return Array.from(records.values()).filter((r) => r.approvalId === approvalId);
}

/**
 * Update status of a pending reason record.
 *
 * @param requestId - Record ID
 * @param status - New status
 * @param result - Optional result string (for completed)
 * @param error - Optional error string (for denied)
 * @throws if record not found
 */
export function updateStatus(
  requestId: string,
  status: string,
  result?: string,
  error?: string,
): void {
  const record = records.get(requestId);
  if (!record) {
    throw new Error(`pending_reason: record "${requestId}" not found`);
  }
  record.status = status as PendingReasonRecord['status'];
  if (result !== undefined) record.result = result;
  if (error !== undefined) record.error = error;
}

/**
 * Update the approval ID for a record (second approval extends lifecycle).
 */
export function updateApprovalID(requestId: string, approvalId: string): void {
  const record = records.get(requestId);
  if (!record) {
    throw new Error(`pending_reason: record "${requestId}" not found`);
  }
  record.approvalId = approvalId;
}

/**
 * Sweep pending reasons:
 * - Mark expired pending_approval entries as 'expired'
 * - Delete completed/denied/expired entries older than retentionDays
 *
 * @param retentionDays - Days to retain completed/denied entries
 * @returns count of swept entries
 */
export function sweepPendingReasons(retentionDays: number): number {
  const now = Math.floor(Date.now() / 1000);
  const retentionSeconds = retentionDays * 86400;
  let swept = 0;

  for (const [id, record] of records.entries()) {
    // Mark expired pending_approval entries
    if (record.status === 'pending_approval' && now > record.expiresAt) {
      record.status = 'expired';
      swept++;
      continue;
    }

    // Delete old completed/denied/expired entries past retention
    if (['completed', 'denied', 'expired'].includes(record.status)) {
      if (now - record.createdAt > retentionSeconds) {
        records.delete(id);
        swept++;
      }
    }
  }

  return swept;
}

/** Clear all records (for testing). */
export function clearPendingReasons(): void {
  records.clear();
}
