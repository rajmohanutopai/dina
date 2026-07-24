/**
 * Durable agent persona-grant repository (issues.txt §2).
 *
 * Contract run against the real `NodeSQLiteAdapter` and the in-memory
 * mirror (parity), plus a close+reopen restart proving a grant survives
 * an app kill. The binding tests are the security core: a grant is
 * usable only by its exact agent DID, only for its persona, only in a
 * covered mode, and only before it expires / is revoked.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemoryAgentGrantRepository,
  SQLiteAgentGrantRepository,
  type AgentGrantRepository,
  type AgentPersonaGrantInsert,
} from '../../src/agent/grant_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

function sqliteHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-grants-'));
  const dbPath = path.join(dir, 'identity.sqlite');
  const passphraseHex = randomBytes(32).toString('hex');
  const openOne = () => {
    const a = new NodeSQLiteAdapter({
      path: dbPath,
      passphraseHex,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(a, IDENTITY_MIGRATIONS);
    return a;
  };
  let adapter = openOne();
  return {
    repo: new SQLiteAgentGrantRepository(adapter),
    reopen: () => {
      adapter.close();
      adapter = openOne();
      return new SQLiteAgentGrantRepository(adapter);
    },
    cleanup: () => {
      try {
        adapter.close();
      } catch {
        /* idempotent */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function grant(over: Partial<AgentPersonaGrantInsert> = {}): AgentPersonaGrantInsert {
  return {
    id: over.id ?? `g-${randomBytes(4).toString('hex')}`,
    agentDID: over.agentDID ?? 'did:key:agentA',
    persona: over.persona ?? 'health',
    mode: over.mode ?? 'read',
    scopeJson: over.scopeJson ?? '{"scope":"my meds"}',
    approvalTaskId: over.approvalTaskId ?? 'task-1',
    expiresAt: over.expiresAt ?? 10_000,
    createdAt: over.createdAt ?? 1_000,
    sessionId: over.sessionId,
    active: over.active,
  };
}

const factories: {
  name: string;
  make: () => { repo: AgentGrantRepository; cleanup: () => void };
}[] = [
  {
    name: 'InMemory',
    make: () => ({ repo: new InMemoryAgentGrantRepository(), cleanup: () => {} }),
  },
  {
    name: 'SQLite',
    make: () => {
      const h = sqliteHarness();
      return { repo: h.repo, cleanup: h.cleanup };
    },
  },
];

describe.each(factories)('agent grant contract — $name', ({ make }) => {
  let repo: AgentGrantRepository;
  let cleanup: () => void;
  beforeEach(() => ({ repo, cleanup } = make()));
  afterEach(() => cleanup());

  it('finds an active grant for the exact agent + persona + mode', () => {
    repo.insert(grant({ id: 'g1' }));
    const found = repo.findActiveGrant('did:key:agentA', 'health', 'read', null, 5_000);
    expect(found?.id).toBe('g1');
  });

  it('a grant is bound to its agent DID — another DID cannot use it', () => {
    repo.insert(grant({ id: 'g1', agentDID: 'did:key:agentA' }));
    expect(repo.findActiveGrant('did:key:agentB', 'health', 'read', null, 5_000)).toBeNull();
  });

  it('a grant is bound to its persona — approval for one does not unlock another', () => {
    repo.insert(grant({ id: 'g1', persona: 'work' }));
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', null, 5_000)).toBeNull();
  });

  it('a grant is bound to its SESSION — a fresh session re-prompts (dina_details §3.6)', () => {
    repo.insert(grant({ id: 'gA', sessionId: 'sess-A' }));
    // Same session → found.
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', 'sess-A', 5_000)?.id).toBe(
      'gA',
    );
    // Different session → NOT found: an approval does NOT carry across sessions.
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', 'sess-B', 5_000)).toBeNull();
    // Session-less lookup → NOT found either: null is its own bucket.
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', null, 5_000)).toBeNull();
  });

  it('a session-less grant is matched only by a session-less lookup', () => {
    repo.insert(grant({ id: 'g0', sessionId: null }));
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', null, 5_000)?.id).toBe('g0');
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', 'sess-A', 5_000)).toBeNull();
  });

  it('a read request is satisfied by a write grant, but not vice-versa', () => {
    repo.insert(grant({ id: 'gw', mode: 'write' }));
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', null, 5_000)?.id).toBe('gw');
    repo.remove('gw');
    repo.insert(grant({ id: 'gr', mode: 'read' }));
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'write', null, 5_000)).toBeNull();
  });

  it('an expired grant blocks access', () => {
    repo.insert(grant({ id: 'g1', expiresAt: 4_000 }));
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', null, 3_000)?.id).toBe('g1');
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', null, 5_000)).toBeNull(); // past expiry
  });

  it('PLG-28 #1: a RESERVED grant (active:false) is invisible to the gate until activated', () => {
    repo.insert(grant({ id: 'g1', active: false }));
    // Reserved → NOT findActive-visible and NOT in the active listing.
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', null, 5_000)).toBeNull();
    expect(repo.listActiveForAgent('did:key:agentA', 5_000)).toHaveLength(0);
    // Activate → now the gate sees it.
    expect(repo.activate('g1')).toBe(true);
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', null, 5_000)?.id).toBe('g1');
    // Idempotent: re-activating an already-active grant returns false (nothing to flip).
    expect(repo.activate('g1')).toBe(false);
    // activate refuses an unknown grant, and a REVOKED reserved grant.
    expect(repo.activate('nope')).toBe(false);
    repo.insert(grant({ id: 'g2', active: false }));
    repo.revoke('g2', 6_000);
    expect(repo.activate('g2')).toBe(false);
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', null, 5_000)?.id).toBe('g1');
  });

  it('revoke tombstones a grant (idempotent); revoked grants never match', () => {
    repo.insert(grant({ id: 'g1' }));
    expect(repo.revoke('g1', 6_000)).toBe(true);
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', null, 7_000)).toBeNull();
    expect(repo.revoke('g1', 6_500)).toBe(false); // already revoked
    expect(repo.revoke('missing', 6_500)).toBe(false);
  });

  it('revokeForAgent revokes every active grant for an agent only', () => {
    repo.insert(grant({ id: 'a1', agentDID: 'did:key:agentA', persona: 'health' }));
    repo.insert(grant({ id: 'a2', agentDID: 'did:key:agentA', persona: 'work' }));
    repo.insert(grant({ id: 'b1', agentDID: 'did:key:agentB', persona: 'health' }));
    expect(repo.revokeForAgent('did:key:agentA', 8_000)).toBe(2);
    expect(repo.listActiveForAgent('did:key:agentA', 8_500)).toHaveLength(0);
    expect(repo.findActiveGrant('did:key:agentB', 'health', 'read', null, 8_500)?.id).toBe('b1'); // untouched
  });

  it('revokeForSession revokes only the exact agent + session grants', () => {
    repo.insert(grant({ id: 'a-s1-health', agentDID: 'did:key:agentA', sessionId: 'sess-1' }));
    repo.insert(
      grant({
        id: 'a-s1-work',
        agentDID: 'did:key:agentA',
        sessionId: 'sess-1',
        persona: 'work',
      }),
    );
    repo.insert(grant({ id: 'a-s2', agentDID: 'did:key:agentA', sessionId: 'sess-2' }));
    repo.insert(grant({ id: 'b-s1', agentDID: 'did:key:agentB', sessionId: 'sess-1' }));

    expect(repo.revokeForSession('did:key:agentA', 'sess-1', 8_000)).toBe(2);
    expect(
      repo.findActiveGrant('did:key:agentA', 'health', 'read', 'sess-1', 8_500),
    ).toBeNull();
    expect(repo.findActiveGrant('did:key:agentA', 'health', 'read', 'sess-2', 8_500)?.id).toBe(
      'a-s2',
    );
    expect(repo.findActiveGrant('did:key:agentB', 'health', 'read', 'sess-1', 8_500)?.id).toBe(
      'b-s1',
    );
  });
});

describe('SQLiteAgentGrantRepository — durability across restart', () => {
  it('an approved grant survives adapter close + reopen', () => {
    const h = sqliteHarness();
    try {
      h.repo.insert(grant({ id: 'survivor', expiresAt: 1_000_000 }));
      const reopened = h.reopen();
      const found = reopened.findActiveGrant('did:key:agentA', 'health', 'read', null, 500_000);
      expect(found?.id).toBe('survivor'); // agent can resume after restart
    } finally {
      h.cleanup();
    }
  });
});
