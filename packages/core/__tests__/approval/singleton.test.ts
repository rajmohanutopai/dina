/**
 * ApprovalManager singleton tests — verifies that HTTP routes and UI hooks
 * share the same instance (fixing the dual-instance bug from §A48).
 */

import {
  ApprovalManager,
  getApprovalManager,
  resetApprovalManager,
} from '../../src/approval/manager';

describe('ApprovalManager Singleton', () => {
  beforeEach(() => resetApprovalManager());

  it('returns the same instance on multiple calls', () => {
    const a = getApprovalManager();
    const b = getApprovalManager();
    expect(a).toBe(b);
  });

  it('resets to a fresh instance on resetApprovalManager', () => {
    const a = getApprovalManager();
    a.requestApproval({
      id: 'test-1',
      action: 'vault_read',
      requester_did: 'did:test',
      persona: 'health',
      reason: 'testing',
      preview: 'test',
      created_at: Date.now(),
    });
    expect(a.listPending()).toHaveLength(1);

    resetApprovalManager();
    const b = getApprovalManager();
    expect(b).not.toBe(a);
    expect(b.listPending()).toHaveLength(0);
  });

  it('state created in one caller is visible to another', () => {
    const manager = getApprovalManager();

    // Simulate: Brain creates an approval via HTTP route
    manager.requestApproval({
      id: 'shared-1',
      action: 'vault_write',
      requester_did: 'did:brain',
      persona: 'finance',
      reason: 'need access',
      preview: 'bank data',
      created_at: Date.now(),
    });

    // Simulate: UI hook reads the same approval
    const sameManager = getApprovalManager();
    const pending = sameManager.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('shared-1');
    expect(pending[0].action).toBe('vault_write');
  });

  it('approval created by one consumer is approved by another', () => {
    const manager = getApprovalManager();

    // Brain creates approval
    manager.requestApproval({
      id: 'cross-1',
      action: 'staging_resolve',
      requester_did: 'did:brain',
      persona: 'health',
      reason: 'classify',
      preview: 'medical note',
      created_at: Date.now(),
    });

    // UI approves it (same singleton)
    const uiManager = getApprovalManager();
    uiManager.approveRequest('cross-1', 'session', 'did:user');

    // Both see approved state
    expect(manager.isApproved('cross-1')).toBe(true);
    expect(uiManager.isApproved('cross-1')).toBe(true);
  });
});
