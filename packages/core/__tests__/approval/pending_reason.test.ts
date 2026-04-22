/**
 * T2A.20 — Pending reason lifecycle: create, status transitions,
 * caller binding, sweep.
 *
 * Category B: contract test.
 *
 * Source: core/test/pending_reason_test.go
 */

import {
  createPendingReason,
  getByID,
  getByApprovalID,
  updateStatus,
  updateApprovalID,
  sweepPendingReasons,
  clearPendingReasons,
} from '../../src/approval/pending_reason';

describe('Pending Reason Lifecycle', () => {
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    clearPendingReasons();
  });

  describe('createPendingReason', () => {
    it('creates a record with pending_approval status', () => {
      const record = createPendingReason({
        requestId: 'req-001',
        callerDID: 'did:key:z6MkAgent',
        approvalId: 'apr-001',
        expiresAt: now + 300,
      });
      expect(record.status).toBe('pending_approval');
      expect(record.requestId).toBe('req-001');
      expect(record.callerDID).toBe('did:key:z6MkAgent');
    });

    it('sets createdAt timestamp', () => {
      const record = createPendingReason({
        requestId: 'req-002',
        callerDID: 'did:key:z6MkAgent',
        approvalId: 'apr-002',
        expiresAt: now + 300,
      });
      expect(record.createdAt).toBeGreaterThan(0);
    });
  });

  describe('getByID', () => {
    it('returns record for matching caller DID', () => {
      createPendingReason({
        requestId: 'req-001',
        callerDID: 'did:key:z6MkAgent',
        approvalId: 'apr-001',
        expiresAt: now + 300,
      });
      const record = getByID('req-001', 'did:key:z6MkAgent');
      expect(record).not.toBeNull();
      expect(record!.requestId).toBe('req-001');
    });

    it('returns null for non-existent ID', () => {
      expect(getByID('req-nonexistent', 'did:key:z6MkAgent')).toBeNull();
    });

    it('enforces caller DID binding (wrong caller → null)', () => {
      createPendingReason({
        requestId: 'req-001',
        callerDID: 'did:key:z6MkAgent',
        approvalId: 'apr-001',
        expiresAt: now + 300,
      });
      expect(getByID('req-001', 'did:key:z6MkDifferent')).toBeNull();
    });
  });

  describe('getByApprovalID', () => {
    it('returns all records for an approval ID', () => {
      createPendingReason({
        requestId: 'req-a',
        callerDID: 'did:a',
        approvalId: 'apr-001',
        expiresAt: now + 300,
      });
      createPendingReason({
        requestId: 'req-b',
        callerDID: 'did:b',
        approvalId: 'apr-001',
        expiresAt: now + 300,
      });
      const records = getByApprovalID('apr-001');
      expect(records.length).toBe(2);
    });

    it('returns empty for unknown approval ID', () => {
      expect(getByApprovalID('apr-unknown')).toEqual([]);
    });
  });

  describe('updateStatus', () => {
    it('transitions to resuming', () => {
      createPendingReason({
        requestId: 'req-001',
        callerDID: 'did:a',
        approvalId: 'apr-001',
        expiresAt: now + 300,
      });
      updateStatus('req-001', 'resuming');
      expect(getByID('req-001', 'did:a')!.status).toBe('resuming');
    });

    it('transitions to completed with result', () => {
      createPendingReason({
        requestId: 'req-001',
        callerDID: 'did:a',
        approvalId: 'apr-001',
        expiresAt: now + 300,
      });
      updateStatus('req-001', 'completed', '{"items": 5}');
      const record = getByID('req-001', 'did:a')!;
      expect(record.status).toBe('completed');
      expect(record.result).toBe('{"items": 5}');
    });

    it('transitions to denied with error', () => {
      createPendingReason({
        requestId: 'req-001',
        callerDID: 'did:a',
        approvalId: 'apr-001',
        expiresAt: now + 300,
      });
      updateStatus('req-001', 'denied', undefined, 'User denied');
      const record = getByID('req-001', 'did:a')!;
      expect(record.status).toBe('denied');
      expect(record.error).toBe('User denied');
    });

    it('throws for non-existent record', () => {
      expect(() => updateStatus('req-none', 'resuming')).toThrow('not found');
    });
  });

  describe('updateApprovalID', () => {
    it('updates the approval ID', () => {
      createPendingReason({
        requestId: 'req-001',
        callerDID: 'did:a',
        approvalId: 'apr-001',
        expiresAt: now + 300,
      });
      updateApprovalID('req-001', 'apr-002');
      expect(getByID('req-001', 'did:a')!.approvalId).toBe('apr-002');
    });
  });

  describe('sweepPendingReasons', () => {
    it('marks expired pending entries as expired', () => {
      createPendingReason({
        requestId: 'req-exp',
        callerDID: 'did:a',
        approvalId: 'apr-001',
        expiresAt: now - 100, // already expired
      });
      const swept = sweepPendingReasons(90);
      expect(swept).toBeGreaterThan(0);
      expect(getByID('req-exp', 'did:a')!.status).toBe('expired');
    });

    it('skips non-expired pending entries', () => {
      createPendingReason({
        requestId: 'req-ok',
        callerDID: 'did:a',
        approvalId: 'apr-001',
        expiresAt: now + 1000, // still valid
      });
      sweepPendingReasons(90);
      expect(getByID('req-ok', 'did:a')!.status).toBe('pending_approval');
    });

    it('returns count of swept entries', () => {
      createPendingReason({
        requestId: 'req-exp1',
        callerDID: 'did:a',
        approvalId: 'apr-001',
        expiresAt: now - 100,
      });
      createPendingReason({
        requestId: 'req-exp2',
        callerDID: 'did:b',
        approvalId: 'apr-002',
        expiresAt: now - 200,
      });
      expect(sweepPendingReasons(90)).toBe(2);
    });
  });

  describe('full lifecycle', () => {
    it('create → resuming → completed', () => {
      const record = createPendingReason({
        requestId: 'req-lc',
        callerDID: 'did:key:z6MkAgent',
        approvalId: 'apr-lc',
        expiresAt: now + 300,
      });
      expect(record.status).toBe('pending_approval');

      updateStatus('req-lc', 'resuming');
      expect(getByID('req-lc', 'did:key:z6MkAgent')!.status).toBe('resuming');

      updateStatus('req-lc', 'completed', '{"result": "ok"}');
      const final = getByID('req-lc', 'did:key:z6MkAgent')!;
      expect(final.status).toBe('completed');
      expect(final.result).toBe('{"result": "ok"}');
    });
  });
});
