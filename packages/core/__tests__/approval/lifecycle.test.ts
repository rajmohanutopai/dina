/**
 * T2A.7 — Approval lifecycle: create request, approve, deny, list pending.
 *
 * Category B: contract test. Tests the real ApprovalManager.
 *
 * Source: core/test/approval_preview_test.go
 */

import { ApprovalManager } from '../../src/approval/manager';

describe('Approval Lifecycle', () => {
  let manager: ApprovalManager;

  beforeEach(() => {
    manager = new ApprovalManager();
  });

  describe('requestApproval', () => {
    it('creates a pending approval request', () => {
      const id = manager.requestApproval({
        id: 'apr-001',
        action: 'access_health_vault',
        requester_did: 'did:key:z6MkAgent',
        persona: 'health',
        reason: 'Agent needs health data',
        preview: 'Lab results from Dr. Smith',
        created_at: 1700000000,
      });
      expect(id).toBe('apr-001');
    });

    it('approval is listed as pending', () => {
      manager.requestApproval({
        id: 'apr-002',
        action: 'access_health_vault',
        requester_did: 'did:key:z6MkAgent',
        persona: 'health',
        reason: 'test',
        preview: '',
        created_at: 1700000000,
      });
      const pending = manager.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('apr-002');
      expect(pending[0].status).toBe('pending');
    });

    it('includes context: action, requester, persona, reason, preview', () => {
      manager.requestApproval({
        id: 'apr-003',
        action: 'send_email',
        requester_did: 'did:key:z6MkBot',
        persona: 'work',
        reason: 'Bot wants to send report',
        preview: 'Quarterly sales summary',
        created_at: 1700000000,
      });
      const pending = manager.listPending();
      expect(pending[0].action).toBe('send_email');
      expect(pending[0].requester_did).toBe('did:key:z6MkBot');
      expect(pending[0].persona).toBe('work');
      expect(pending[0].reason).toBe('Bot wants to send report');
      expect(pending[0].preview).toBe('Quarterly sales summary');
    });

    it('rejects duplicate ID', () => {
      manager.requestApproval({
        id: 'dup',
        action: 'test',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      expect(() =>
        manager.requestApproval({
          id: 'dup',
          action: 'test2',
          requester_did: 'd',
          persona: 'p',
          reason: 'r',
          preview: '',
          created_at: 0,
        }),
      ).toThrow('already exists');
    });
  });

  describe('subscribeRequests (5.66 inbox bridge hook)', () => {
    it('fires the listener synchronously after a successful requestApproval', () => {
      const seen: string[] = [];
      manager.subscribeRequests((req) => seen.push(req.id));
      manager.requestApproval({
        id: 'sub-1',
        action: 'a',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      expect(seen).toEqual(['sub-1']);
    });

    it('does NOT fire the listener when requestApproval rejects (duplicate id)', () => {
      manager.requestApproval({
        id: 'dup',
        action: 'a',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      const seen: string[] = [];
      manager.subscribeRequests((req) => seen.push(req.id));
      expect(() =>
        manager.requestApproval({
          id: 'dup',
          action: 'a',
          requester_did: 'd',
          persona: 'p',
          reason: 'r',
          preview: '',
          created_at: 0,
        }),
      ).toThrow('already exists');
      expect(seen).toEqual([]);
    });

    it('disposer detaches the listener', () => {
      const seen: string[] = [];
      const off = manager.subscribeRequests((req) => seen.push(req.id));
      off();
      manager.requestApproval({
        id: 'after-off',
        action: 'a',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      expect(seen).toEqual([]);
    });

    it('fan-out: a faulty listener does not break other subscribers', () => {
      const seen: string[] = [];
      manager.subscribeRequests(() => {
        throw new Error('boom');
      });
      manager.subscribeRequests((req) => seen.push(req.id));
      manager.requestApproval({
        id: 'fan',
        action: 'a',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      expect(seen).toEqual(['fan']);
    });

    it('listener receives a clone — mutations do not poison the canonical request', () => {
      manager.subscribeRequests((req) => {
        req.reason = 'overwritten';
      });
      manager.requestApproval({
        id: 'mut',
        action: 'a',
        requester_did: 'd',
        persona: 'p',
        reason: 'original',
        preview: '',
        created_at: 0,
      });
      expect(manager.getRequest('mut')!.reason).toBe('original');
    });
  });

  describe('approveRequest', () => {
    it('changes status to approved', () => {
      manager.requestApproval({
        id: 'apr-004',
        action: 'test',
        requester_did: 'did',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.approveRequest('apr-004', 'session', 'user');
      const pending = manager.listPending();
      expect(pending).toHaveLength(0);
      expect(manager.isApproved('apr-004')).toBe(true);
    });

    it('sets scope (single or session)', () => {
      manager.requestApproval({
        id: 'apr-005',
        action: 'test',
        requester_did: 'did',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.approveRequest('apr-005', 'single', 'user');
      const req = manager.getRequest('apr-005');
      expect(req?.scope).toBe('single');
      expect(req?.approved_by).toBe('user');
    });

    it('throws if request not found', () => {
      expect(() => manager.approveRequest('nope', 'session', 'user')).toThrow('not found');
    });

    it('throws if already approved', () => {
      manager.requestApproval({
        id: 'x',
        action: 'test',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.approveRequest('x', 'session', 'user');
      expect(() => manager.approveRequest('x', 'session', 'user')).toThrow('not pending');
    });
  });

  describe('denyRequest', () => {
    it('changes status to denied', () => {
      manager.requestApproval({
        id: 'apr-006',
        action: 'test',
        requester_did: 'did',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.denyRequest('apr-006');
      const req = manager.getRequest('apr-006');
      expect(req?.status).toBe('denied');
    });

    it('denied request no longer in pending list', () => {
      manager.requestApproval({
        id: 'apr-007',
        action: 'test',
        requester_did: 'did',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.denyRequest('apr-007');
      const pending = manager.listPending();
      expect(pending).toHaveLength(0);
    });

    it('throws if not found', () => {
      expect(() => manager.denyRequest('nope')).toThrow('not found');
    });
  });

  describe('listPending', () => {
    it('returns empty when no requests', () => {
      expect(manager.listPending()).toHaveLength(0);
    });

    it('returns only pending requests (not approved/denied)', () => {
      manager.requestApproval({
        id: 'a1',
        action: 'x',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.requestApproval({
        id: 'a2',
        action: 'y',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.approveRequest('a1', 'session', 'user');
      const pending = manager.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('a2');
    });
  });

  describe('consumeSingle', () => {
    it('consumes a single-scope approval', () => {
      manager.requestApproval({
        id: 's1',
        action: 'x',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.approveRequest('s1', 'single', 'user');
      expect(manager.consumeSingle('s1')).toBe(true);
      expect(manager.getRequest('s1')).toBeUndefined();
    });

    it('does not consume session-scope approval', () => {
      manager.requestApproval({
        id: 's2',
        action: 'x',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.approveRequest('s2', 'session', 'user');
      expect(manager.consumeSingle('s2')).toBe(false);
      expect(manager.isApproved('s2')).toBe(true);
    });
  });

  describe('revokeSession', () => {
    it('revokes all session-scoped approvals', () => {
      manager.requestApproval({
        id: 'r1',
        action: 'x',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.requestApproval({
        id: 'r2',
        action: 'y',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.approveRequest('r1', 'session', 'user');
      manager.approveRequest('r2', 'session', 'user');
      const count = manager.revokeSession();
      expect(count).toBe(2);
      expect(manager.getRequest('r1')).toBeUndefined();
      expect(manager.getRequest('r2')).toBeUndefined();
    });

    it('does not revoke pending requests', () => {
      manager.requestApproval({
        id: 'r3',
        action: 'x',
        requester_did: 'd',
        persona: 'p',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      manager.revokeSession();
      expect(manager.listPending()).toHaveLength(1);
    });
  });
});
