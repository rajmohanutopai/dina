/**
 * ActionRiskPolicy — Draft-Don't-Send invariant and risk gating.
 *
 * Source: brain/src/service/guardian.py — ActionRiskPolicy
 */

import {
  assessRisk,
  createProposal,
  approveProposal,
  rejectProposal,
  isApproved,
  getProposal,
  listPendingProposals,
  getAuditTrail,
  resetActionRiskState,
  setApprovalThreshold,
  getApprovalThreshold,
  resetApprovalThreshold,
  type RiskLevel,
} from '../../src/guardian/action_risk';

describe('ActionRiskPolicy', () => {
  beforeEach(() => resetActionRiskState());

  describe('assessRisk', () => {
    it('vault.read → low risk, no approval', () => {
      const risk = assessRisk('vault.read');
      expect(risk.riskLevel).toBe('low');
      expect(risk.requiresApproval).toBe(false);
    });

    it('vault.search → low risk', () => {
      expect(assessRisk('vault.search').riskLevel).toBe('low');
    });

    it('vault.store → medium risk, requires approval', () => {
      const risk = assessRisk('vault.store');
      expect(risk.riskLevel).toBe('medium');
      expect(risk.requiresApproval).toBe(true);
    });

    it('reminder.create → medium risk', () => {
      expect(assessRisk('reminder.create').riskLevel).toBe('medium');
    });

    it('message.send → high risk', () => {
      const risk = assessRisk('message.send');
      expect(risk.riskLevel).toBe('high');
      expect(risk.requiresApproval).toBe(true);
    });

    it('email.send → high risk', () => {
      expect(assessRisk('email.send').riskLevel).toBe('high');
    });

    it('vault.delete → critical risk', () => {
      const risk = assessRisk('vault.delete');
      expect(risk.riskLevel).toBe('critical');
      expect(risk.requiresApproval).toBe(true);
    });

    it('device.revoke → critical risk', () => {
      expect(assessRisk('device.revoke').riskLevel).toBe('critical');
    });

    it('unknown action → defaults to high risk', () => {
      const risk = assessRisk('unknown.action');
      expect(risk.riskLevel).toBe('high');
      expect(risk.requiresApproval).toBe(true);
    });
  });

  describe('approval threshold', () => {
    it('default threshold is medium', () => {
      expect(getApprovalThreshold()).toBe('medium');
    });

    it('low-risk actions skip approval at default threshold', () => {
      expect(assessRisk('vault.read').requiresApproval).toBe(false);
    });

    it('setting threshold to high allows medium actions without approval', () => {
      setApprovalThreshold('high');
      expect(assessRisk('vault.store').requiresApproval).toBe(false);
      expect(assessRisk('message.send').requiresApproval).toBe(true);
    });

    it('setting threshold to low requires approval for everything', () => {
      setApprovalThreshold('low');
      expect(assessRisk('vault.read').requiresApproval).toBe(true);
    });

    it('resetApprovalThreshold restores default', () => {
      setApprovalThreshold('critical');
      resetApprovalThreshold();
      expect(getApprovalThreshold()).toBe('medium');
    });
  });

  describe('proposal lifecycle', () => {
    it('createProposal returns a pending proposal', () => {
      const proposal = createProposal('send_email', 'email.send', 'Send email to Alice', 'user');
      expect(proposal.status).toBe('pending');
      expect(proposal.id).toMatch(/^prop-/);
      expect(proposal.riskLevel).toBe('high');
      expect(proposal.action).toBe('send_email');
    });

    it('approveProposal changes status to approved', () => {
      const proposal = createProposal('send_msg', 'message.send', 'Send message', 'user');
      const result = approveProposal(proposal.id);
      expect(result).toBe(true);
      expect(getProposal(proposal.id)!.status).toBe('approved');
    });

    it('rejectProposal changes status to rejected', () => {
      const proposal = createProposal('delete', 'vault.delete', 'Delete item', 'user');
      const result = rejectProposal(proposal.id);
      expect(result).toBe(true);
      expect(getProposal(proposal.id)!.status).toBe('rejected');
    });

    it('cannot approve already-rejected proposal', () => {
      const proposal = createProposal('a', 'email.send', 'd', 'u');
      rejectProposal(proposal.id);
      expect(approveProposal(proposal.id)).toBe(false);
    });

    it('cannot reject already-approved proposal', () => {
      const proposal = createProposal('a', 'email.send', 'd', 'u');
      approveProposal(proposal.id);
      expect(rejectProposal(proposal.id)).toBe(false);
    });

    it('cannot approve non-existent proposal', () => {
      expect(approveProposal('prop-nonexistent')).toBe(false);
    });
  });

  describe('expiration (30-min TTL)', () => {
    it('approval fails after expiration', () => {
      const proposal = createProposal('a', 'email.send', 'd', 'u');
      // Simulate 31 minutes passing
      const futureTime = Date.now() + 31 * 60 * 1000;
      expect(approveProposal(proposal.id, futureTime)).toBe(false);
      expect(getProposal(proposal.id)!.status).toBe('expired');
    });

    it('isApproved returns false after expiration even if approved', () => {
      const proposal = createProposal('a', 'email.send', 'd', 'u');
      approveProposal(proposal.id);
      expect(isApproved(proposal.id)).toBe(true);

      // Simulate 31 minutes passing
      const futureTime = Date.now() + 31 * 60 * 1000;
      expect(isApproved(proposal.id, futureTime)).toBe(false);
    });

    it('listPendingProposals expires stale proposals', () => {
      createProposal('a', 'email.send', 'd', 'u');
      // Right now it should be pending
      expect(listPendingProposals()).toHaveLength(1);
    });
  });

  describe('isApproved gate', () => {
    it('returns true for approved proposal within TTL', () => {
      const proposal = createProposal('a', 'email.send', 'd', 'u');
      approveProposal(proposal.id);
      expect(isApproved(proposal.id)).toBe(true);
    });

    it('returns false for pending proposal', () => {
      const proposal = createProposal('a', 'email.send', 'd', 'u');
      expect(isApproved(proposal.id)).toBe(false);
    });

    it('returns false for rejected proposal', () => {
      const proposal = createProposal('a', 'email.send', 'd', 'u');
      rejectProposal(proposal.id);
      expect(isApproved(proposal.id)).toBe(false);
    });

    it('returns false for unknown proposal', () => {
      expect(isApproved('prop-nope')).toBe(false);
    });
  });

  describe('intent audit trail', () => {
    it('records proposal creation', () => {
      createProposal('send', 'email.send', 'Send email', 'user');
      const trail = getAuditTrail();
      expect(trail).toHaveLength(1);
      expect(trail[0].status).toBe('pending');
      expect(trail[0].action).toBe('send');
    });

    it('records approval', () => {
      const p = createProposal('send', 'email.send', 'd', 'u');
      approveProposal(p.id);
      const trail = getAuditTrail();
      expect(trail).toHaveLength(2);
      expect(trail[1].status).toBe('approved');
    });

    it('records rejection', () => {
      const p = createProposal('send', 'email.send', 'd', 'u');
      rejectProposal(p.id);
      expect(getAuditTrail()[1].status).toBe('rejected');
    });

    it('records expiration', () => {
      const p = createProposal('send', 'email.send', 'd', 'u');
      const futureTime = Date.now() + 31 * 60 * 1000;
      approveProposal(p.id, futureTime); // triggers expiration
      expect(getAuditTrail()[1].status).toBe('expired');
    });

    it('trail preserves chronological order', () => {
      const p1 = createProposal('action1', 'email.send', 'd', 'u');
      const p2 = createProposal('action2', 'vault.delete', 'd', 'u');
      approveProposal(p1.id);
      rejectProposal(p2.id);

      const trail = getAuditTrail();
      expect(trail).toHaveLength(4); // 2 creates + 1 approve + 1 reject
      expect(trail[0].action).toBe('action1');
      expect(trail[1].action).toBe('action2');
      expect(trail[2].status).toBe('approved');
      expect(trail[3].status).toBe('rejected');
    });
  });

  describe('proposal metadata', () => {
    it('stores target information', () => {
      const p = createProposal('send', 'email.send', 'Send to Alice', 'user', 'did:plc:alice');
      expect(p.target).toBe('did:plc:alice');
    });

    it('stores initiator', () => {
      const p = createProposal('send', 'email.send', 'desc', 'brain-agent');
      expect(p.initiator).toBe('brain-agent');
    });

    it('stores timestamps', () => {
      const before = Date.now();
      const p = createProposal('send', 'email.send', 'desc', 'user');
      expect(p.createdAt).toBeGreaterThanOrEqual(before);
      expect(p.expiresAt).toBeGreaterThan(p.createdAt);
      expect(p.expiresAt - p.createdAt).toBe(30 * 60 * 1000); // 30 min TTL
    });

    it('resolvedAt set on approval', () => {
      const p = createProposal('send', 'email.send', 'desc', 'user');
      expect(p.resolvedAt).toBeUndefined();
      approveProposal(p.id);
      expect(getProposal(p.id)!.resolvedAt).toBeDefined();
    });
  });

  describe('resetActionRiskState', () => {
    it('clears all proposals and audit trail', () => {
      createProposal('a', 'email.send', 'd', 'u');
      createProposal('b', 'vault.delete', 'd', 'u');
      resetActionRiskState();
      expect(listPendingProposals()).toHaveLength(0);
      expect(getAuditTrail()).toHaveLength(0);
    });
  });
});
