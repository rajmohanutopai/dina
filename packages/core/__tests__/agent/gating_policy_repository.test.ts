import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { AgentGatingPolicyConflictError } from '../../src/agent/gating_policy';
import { SQLiteAgentGatingPolicyRepository } from '../../src/agent/gating_policy_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

function openRepository(): {
  repo: SQLiteAgentGatingPolicyRepository;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-agent-policy-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    repo: new SQLiteAgentGatingPolicyRepository(adapter),
    cleanup: () => {
      adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('SQLiteAgentGatingPolicyRepository', () => {
  it('creates, versions, lists and revokes one agent policy', () => {
    const { repo, cleanup } = openRepository();
    try {
      const created = repo.set({
        agentDid: 'did:key:agent',
        profile: 'network_protection',
        selectedByOwnerDid: 'did:plc:owner',
        expectedVersion: null,
        nowMs: 10,
      });
      expect(created).toMatchObject({
        profile: 'network_protection',
        policyVersion: 1,
        revokedAtMs: null,
      });

      const updated = repo.set({
        agentDid: 'did:key:agent',
        profile: 'sensitive_boundaries',
        selectedByOwnerDid: 'did:plc:owner',
        expectedVersion: 1,
        nowMs: 20,
      });
      expect(updated).toMatchObject({
        profile: 'sensitive_boundaries',
        policyVersion: 2,
      });
      expect(repo.list()).toHaveLength(1);
      expect(repo.revoke('did:key:agent', 2, 'did:plc:owner', 30)).toBe(true);
      expect(repo.get('did:key:agent')).toMatchObject({
        policyVersion: 3,
        revokedAtMs: 30,
      });
    } finally {
      cleanup();
    }
  });

  it('rejects stale create/update versions', () => {
    const { repo, cleanup } = openRepository();
    try {
      repo.set({
        agentDid: 'did:key:agent',
        profile: 'full_supervision',
        selectedByOwnerDid: 'did:plc:owner',
        expectedVersion: null,
      });
      expect(() =>
        repo.set({
          agentDid: 'did:key:agent',
          profile: 'network_protection',
          selectedByOwnerDid: 'did:plc:owner',
          expectedVersion: null,
        }),
      ).toThrow(AgentGatingPolicyConflictError);
      expect(() =>
        repo.set({
          agentDid: 'did:key:agent',
          profile: 'network_protection',
          selectedByOwnerDid: 'did:plc:owner',
          expectedVersion: 99,
        }),
      ).toThrow(AgentGatingPolicyConflictError);
    } finally {
      cleanup();
    }
  });
});
