/**
 * Owner-only connected-agent gating policy surface.
 *
 * The authenticated agent never writes this route. Core binds every mutation
 * to the node owner and an optimistic policy version, then invalidates
 * transient permits through an injected composition-root hook.
 */

import {
  AgentGatingPolicyConflictError,
  getAgentGatingPolicyRepository,
  isAgentGatingProfile,
} from '../../agent/gating_policy';
import { appendAudit } from '../../audit/service';
import { getDeviceByDID } from '../../devices/registry';

import { ownerDidForRequest } from './owner_guard';

import type { CoreResponse, CoreRouter } from '../router';

export type AgentGatingPolicyChanged = (agentDid: string) => void;

function response(status: number, body: unknown): CoreResponse {
  return { status, body };
}

function projectPolicy(policy: {
  agentDid: string;
  profile: string;
  policyVersion: number;
  selectedByOwnerDid: string;
  createdAtMs: number;
  updatedAtMs: number;
  revokedAtMs: number | null;
}): Record<string, unknown> {
  return {
    agent_did: policy.agentDid,
    profile: policy.profile,
    policy_version: policy.policyVersion,
    selected_by_owner_did: policy.selectedByOwnerDid,
    created_at: policy.createdAtMs,
    updated_at: policy.updatedAtMs,
    revoked_at: policy.revokedAtMs,
  };
}

export function registerAgentGatingPolicyRoutes(
  router: CoreRouter,
  ownerCapability?: string,
  onChanged: AgentGatingPolicyChanged = () => {
    /* no transient permit store on this composition root */
  },
): void {
  router.get('/v1/owner/agent-policies', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const repo = getAgentGatingPolicyRepository();
    if (repo === null) return response(503, { error: 'policy_repository_unavailable' });
    return response(200, {
      policies: repo
        .list()
        .filter((policy) => policy.selectedByOwnerDid === owner)
        .map(projectPolicy),
    });
  });

  router.put('/v1/owner/agent-policies/:agentDid', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const repo = getAgentGatingPolicyRepository();
    if (repo === null) return response(503, { error: 'policy_repository_unavailable' });

    const agentDid = req.params.agentDid;
    const device = getDeviceByDID(agentDid);
    if (device === null || device.revoked || device.role !== 'agent' || device.scope !== 'coding') {
      return response(404, { error: 'coding_agent_not_found' });
    }
    const body =
      req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    if (!isAgentGatingProfile(body.profile)) {
      return response(400, { error: 'invalid_profile' });
    }
    const expectedVersion =
      body.expected_version === null
        ? null
        : typeof body.expected_version === 'number' &&
            Number.isSafeInteger(body.expected_version) &&
            body.expected_version >= 1
          ? body.expected_version
          : undefined;
    if (expectedVersion === undefined) {
      return response(400, { error: 'expected_version_required' });
    }

    try {
      const policy = repo.set({
        agentDid,
        profile: body.profile,
        selectedByOwnerDid: owner,
        expectedVersion,
      });
      onChanged(agentDid);
      appendAudit(
        owner,
        'agent_gating_policy_changed',
        'connected_agent',
        JSON.stringify({
          profile: policy.profile,
          policy_version: policy.policyVersion,
        }),
      );
      return response(expectedVersion === null ? 201 : 200, projectPolicy(policy));
    } catch (error) {
      if (error instanceof AgentGatingPolicyConflictError) {
        return response(409, { error: 'policy_version_conflict' });
      }
      throw error;
    }
  });

  router.delete('/v1/owner/agent-policies/:agentDid', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const repo = getAgentGatingPolicyRepository();
    if (repo === null) return response(503, { error: 'policy_repository_unavailable' });
    const body =
      req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    if (
      typeof body.expected_version !== 'number' ||
      !Number.isSafeInteger(body.expected_version) ||
      body.expected_version < 1
    ) {
      return response(400, { error: 'expected_version_required' });
    }
    if (!repo.revoke(req.params.agentDid, body.expected_version, owner)) {
      return response(409, { error: 'policy_version_conflict' });
    }
    onChanged(req.params.agentDid);
    appendAudit(
      owner,
      'agent_gating_policy_revoked',
      'connected_agent',
      JSON.stringify({ policy_version: body.expected_version }),
    );
    return response(204, null);
  });
}
