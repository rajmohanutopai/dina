/**
 * ActionRiskPolicy — Draft-Don't-Send invariant and risk gating.
 *
 * Enforces that Dina NEVER autonomously executes high-risk actions.
 * All actions are classified into risk tiers:
 *
 *   low    — read-only, no external effects (search vault, read contact)
 *   medium — internal state changes (store memory, create reminder)
 *   high   — external effects (send email, post message, share data)
 *   critical — irreversible external (delete data, make purchase, revoke access)
 *
 * For medium+ actions, the system produces a PROPOSAL (draft) that
 * requires explicit user approval before execution.
 *
 * Intent audit trail: every proposed and executed action is logged.
 *
 * Source: brain/src/service/guardian.py — Draft-Don't-Send, ActionRiskPolicy
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ActionProposal {
  /** Unique proposal ID for tracking. */
  id: string;
  /** What the agent wants to do. */
  action: string;
  /** Which category of action. */
  actionType: string;
  /** Risk level classification. */
  riskLevel: RiskLevel;
  /** Human-readable description of what will happen. */
  description: string;
  /** Who/what initiated this action. */
  initiator: string;
  /** Target of the action (DID, email, etc.). */
  target?: string;
  /** Approval status. */
  status: ProposalStatus;
  /** When the proposal was created. */
  createdAt: number;
  /** When the proposal expires (30 min TTL). */
  expiresAt: number;
  /** When the proposal was resolved (approved/rejected). */
  resolvedAt?: number;
}

export interface RiskAssessment {
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  reason: string;
}

// ---------------------------------------------------------------
// Action type → risk level mapping
// ---------------------------------------------------------------

const ACTION_RISK_MAP: Record<string, RiskLevel> = {
  // Low: read-only, no side effects
  'vault.read': 'low',
  'vault.search': 'low',
  'contact.lookup': 'low',
  'reminder.check': 'low',
  'persona.list': 'low',

  // Medium: internal state changes
  'vault.store': 'medium',
  'reminder.create': 'medium',
  'reminder.complete': 'medium',
  'reminder.snooze': 'medium',
  'contact.update_notes': 'medium',

  // High: external effects
  'message.send': 'high',
  'email.send': 'high',
  'email.reply': 'high',
  'd2d.send': 'high',
  'contact.share_data': 'high',
  'export.create': 'high',

  // Critical: irreversible
  'vault.delete': 'critical',
  'contact.block': 'critical',
  'contact.delete': 'critical',
  'device.revoke': 'critical',
  'persona.delete': 'critical',
};

/** Default risk level for unknown action types. */
const DEFAULT_RISK_LEVEL: RiskLevel = 'high';

/** Proposal TTL: 30 minutes (matching Go). */
const PROPOSAL_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------
// Risk level ordering (for comparison)
// ---------------------------------------------------------------

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ---------------------------------------------------------------
// Configurable approval threshold
// ---------------------------------------------------------------

let approvalThreshold: RiskLevel = 'medium';

/**
 * Set the minimum risk level that requires approval.
 * Default: 'medium' (anything that changes state needs approval).
 */
export function setApprovalThreshold(level: RiskLevel): void {
  approvalThreshold = level;
}

/** Get the current approval threshold. */
export function getApprovalThreshold(): RiskLevel {
  return approvalThreshold;
}

/** Reset to default (for testing). */
export function resetApprovalThreshold(): void {
  approvalThreshold = 'medium';
}

// ---------------------------------------------------------------
// Proposal store
// ---------------------------------------------------------------

const proposals = new Map<string, ActionProposal>();

/** Intent audit trail: every action proposed or executed. */
const auditTrail: Array<{
  proposalId: string;
  action: string;
  riskLevel: RiskLevel;
  status: ProposalStatus;
  timestamp: number;
}> = [];

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Assess the risk level of an action.
 *
 * Returns the risk classification and whether approval is required.
 */
export function assessRisk(actionType: string): RiskAssessment {
  const riskLevel = ACTION_RISK_MAP[actionType] ?? DEFAULT_RISK_LEVEL;
  const requiresApproval = RISK_ORDER[riskLevel] >= RISK_ORDER[approvalThreshold];

  return {
    riskLevel,
    requiresApproval,
    reason: requiresApproval
      ? `Action "${actionType}" is ${riskLevel}-risk and requires user approval`
      : `Action "${actionType}" is ${riskLevel}-risk and can proceed automatically`,
  };
}

/**
 * Create a proposal for a risky action (Draft-Don't-Send).
 *
 * The proposal is stored with a 30-minute TTL. The user must explicitly
 * approve or reject it before execution.
 *
 * Returns the proposal ID for tracking.
 */
export function createProposal(
  action: string,
  actionType: string,
  description: string,
  initiator: string,
  target?: string,
): ActionProposal {
  const risk = assessRisk(actionType);
  const now = Date.now();

  const proposal: ActionProposal = {
    id: `prop-${bytesToHex(randomBytes(8))}`,
    action,
    actionType,
    riskLevel: risk.riskLevel,
    description,
    initiator,
    target,
    status: 'pending',
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
  };

  proposals.set(proposal.id, proposal);
  recordAudit(proposal.id, action, risk.riskLevel, 'pending');

  return proposal;
}

/**
 * Approve a pending proposal — allows execution.
 *
 * Returns true if approved, false if not found/expired/already resolved.
 */
export function approveProposal(proposalId: string, now?: number): boolean {
  const proposal = proposals.get(proposalId);
  if (!proposal) return false;

  const currentTime = now ?? Date.now();
  if (proposal.status !== 'pending') return false;
  if (currentTime > proposal.expiresAt) {
    proposal.status = 'expired';
    recordAudit(proposalId, proposal.action, proposal.riskLevel, 'expired');
    return false;
  }

  proposal.status = 'approved';
  proposal.resolvedAt = currentTime;
  recordAudit(proposalId, proposal.action, proposal.riskLevel, 'approved');
  return true;
}

/**
 * Reject a pending proposal — blocks execution.
 */
export function rejectProposal(proposalId: string, now?: number): boolean {
  const proposal = proposals.get(proposalId);
  if (!proposal || proposal.status !== 'pending') return false;

  proposal.status = 'rejected';
  proposal.resolvedAt = now ?? Date.now();
  recordAudit(proposalId, proposal.action, proposal.riskLevel, 'rejected');
  return true;
}

/**
 * Check if a proposal is approved and not expired.
 *
 * This is the gate: execution code calls this before proceeding.
 */
export function isApproved(proposalId: string, now?: number): boolean {
  const proposal = proposals.get(proposalId);
  if (!proposal) return false;
  if (proposal.status !== 'approved') return false;

  const currentTime = now ?? Date.now();
  if (currentTime > proposal.expiresAt) {
    proposal.status = 'expired';
    recordAudit(proposalId, proposal.action, proposal.riskLevel, 'expired');
    return false;
  }

  return true;
}

/** Get a proposal by ID. */
export function getProposal(proposalId: string): ActionProposal | null {
  return proposals.get(proposalId) ?? null;
}

/** List all pending proposals (non-expired). Read-only — does not mutate state. */
export function listPendingProposals(now?: number): ActionProposal[] {
  const currentTime = now ?? Date.now();
  const pending: ActionProposal[] = [];

  for (const p of proposals.values()) {
    if (p.status === 'pending' && currentTime <= p.expiresAt) {
      pending.push(p);
    }
  }

  return pending;
}

/** Get the intent audit trail. */
export function getAuditTrail(): typeof auditTrail {
  return [...auditTrail];
}

/** Reset all state (for testing). */
export function resetActionRiskState(): void {
  proposals.clear();
  auditTrail.length = 0;
  approvalThreshold = 'medium';
}

// ---------------------------------------------------------------
// Internal
// ---------------------------------------------------------------

function recordAudit(
  proposalId: string,
  action: string,
  riskLevel: RiskLevel,
  status: ProposalStatus,
): void {
  auditTrail.push({
    proposalId,
    action,
    riskLevel,
    status,
    timestamp: Date.now(),
  });
}
