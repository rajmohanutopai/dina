import {
  AgentGatingPolicyConflictError,
  isAgentGatingProfile,
  type AgentGatingPolicy,
  type AgentGatingPolicyRepository,
  type SetAgentGatingPolicyInput,
} from './gating_policy';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

const COLS =
  'agent_did, profile, policy_version, selected_by_owner_did, created_at, updated_at, revoked_at';

function rowToPolicy(row: DBRow): AgentGatingPolicy | null {
  const profile = row.profile;
  const version = Number(row.policy_version);
  if (
    typeof row.agent_did !== 'string' ||
    !isAgentGatingProfile(profile) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof row.selected_by_owner_did !== 'string'
  ) {
    return null;
  }
  return {
    agentDid: row.agent_did,
    profile,
    policyVersion: version,
    selectedByOwnerDid: row.selected_by_owner_did,
    createdAtMs: Number(row.created_at),
    updatedAtMs: Number(row.updated_at),
    revokedAtMs: row.revoked_at == null ? null : Number(row.revoked_at),
  };
}

/** Durable, optimistic-concurrency-checked policy repository. */
export class SQLiteAgentGatingPolicyRepository implements AgentGatingPolicyRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  get(agentDid: string): AgentGatingPolicy | null {
    const row = this.db.query(
      `SELECT ${COLS} FROM agent_gating_policies WHERE agent_did = ? LIMIT 1`,
      [agentDid],
    )[0];
    return row ? rowToPolicy(row) : null;
  }

  list(): AgentGatingPolicy[] {
    const out: AgentGatingPolicy[] = [];
    for (const row of this.db.query(`SELECT ${COLS} FROM agent_gating_policies`, [])) {
      const policy = rowToPolicy(row);
      if (policy !== null) out.push(policy);
    }
    return out.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  set(input: SetAgentGatingPolicyInput): AgentGatingPolicy {
    if (!input.agentDid.startsWith('did:') || !input.selectedByOwnerDid.startsWith('did:')) {
      throw new Error('agent gating policy requires valid DIDs');
    }
    const now = input.nowMs ?? Date.now();
    let result: AgentGatingPolicy | null = null;
    this.db.transaction(() => {
      const existing = this.get(input.agentDid);
      if (existing === null) {
        if (input.expectedVersion !== null) throw new AgentGatingPolicyConflictError();
        result = {
          agentDid: input.agentDid,
          profile: input.profile,
          policyVersion: 1,
          selectedByOwnerDid: input.selectedByOwnerDid,
          createdAtMs: now,
          updatedAtMs: now,
          revokedAtMs: null,
        };
        this.db.execute(
          `INSERT INTO agent_gating_policies (${COLS}) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          [
            result.agentDid,
            result.profile,
            result.policyVersion,
            result.selectedByOwnerDid,
            result.createdAtMs,
            result.updatedAtMs,
          ],
        );
        return;
      }
      if (input.expectedVersion !== existing.policyVersion) {
        throw new AgentGatingPolicyConflictError();
      }
      result = {
        ...existing,
        profile: input.profile,
        policyVersion: existing.policyVersion + 1,
        selectedByOwnerDid: input.selectedByOwnerDid,
        updatedAtMs: now,
        revokedAtMs: null,
      };
      const affected = this.db.run(
        `UPDATE agent_gating_policies
         SET profile = ?, policy_version = ?, selected_by_owner_did = ?,
             updated_at = ?, revoked_at = NULL
         WHERE agent_did = ? AND policy_version = ?`,
        [
          result.profile,
          result.policyVersion,
          result.selectedByOwnerDid,
          result.updatedAtMs,
          result.agentDid,
          existing.policyVersion,
        ],
      );
      if (affected !== 1) throw new AgentGatingPolicyConflictError();
    });
    if (result === null) throw new Error('agent gating policy write failed');
    return result;
  }

  revoke(
    agentDid: string,
    expectedVersion: number,
    ownerDid: string,
    nowMs: number = Date.now(),
  ): boolean {
    let changed = false;
    this.db.transaction(() => {
      const existing = this.get(agentDid);
      if (
        existing === null ||
        existing.policyVersion !== expectedVersion ||
        existing.revokedAtMs !== null
      ) {
        return;
      }
      changed =
        this.db.run(
          `UPDATE agent_gating_policies
           SET policy_version = ?, selected_by_owner_did = ?, updated_at = ?, revoked_at = ?
           WHERE agent_did = ? AND policy_version = ? AND revoked_at IS NULL`,
          [existing.policyVersion + 1, ownerDid, nowMs, nowMs, agentDid, expectedVersion],
        ) === 1;
    });
    return changed;
  }
}
