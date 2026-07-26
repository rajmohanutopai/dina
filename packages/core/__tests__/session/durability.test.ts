/**
 * Item D (Codex review — session SQLite durability).
 *
 * Drives the SessionRegistry against a REAL identity SQLite store to prove the
 * durable half: a session persists, survives a "restart" (a fresh registry
 * reconciling from the same store), keeps its DID binding, and a lease that
 * lapsed while Core was "down" is reaped on boot. Also pins the
 * cryptographically-random id shape and the tombstone-not-reloaded behaviour.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { SessionRegistry, DEFAULT_LEASE_MS } from '../../src/session/registry';
import { SQLiteSessionRepository } from '../../src/session/repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const PASSHEX = randomBytes(32).toString('hex');

function openId(): { adapter: NodeSQLiteAdapter; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-sess-'));
  const p = path.join(dir, 'identity.sqlite');
  const adapter = new NodeSQLiteAdapter({
    path: p,
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    adapter,
    cleanup: (): void => {
      try {
        adapter.close();
      } catch {
        /* */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const AGENT = 'did:key:z6MkSessionAgent';

describe('session durability (Item D)', () => {
  it('a started session persists and a fresh registry reconciles + validates it', () => {
    const { adapter, cleanup } = openId();
    try {
      const repo = new SQLiteSessionRepository(adapter);
      // "Before restart": start a session.
      const before = new SessionRegistry(undefined, undefined, repo);
      const s = before.start({ agentDid: AGENT, hostSessionId: 'host-1' });
      expect(repo.loadActive().map((r) => r.sessionId)).toContain(s.sessionId);

      // "After restart": a brand-new registry over the SAME store reconciles.
      const after = new SessionRegistry(undefined, undefined, repo);
      expect(after.reconcile()).toBe(0); // nothing lapsed
      const v = after.validate(s.sessionId, AGENT);
      expect(v.ok).toBe(true);
      // …and the DID binding survives — a foreign DID is still rejected.
      expect(after.validate(s.sessionId, 'did:key:zOther').ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('reuses the reconciled session for the same (agentDid, hostSessionId) after restart', () => {
    const { adapter, cleanup } = openId();
    try {
      const repo = new SQLiteSessionRepository(adapter);
      const before = new SessionRegistry(undefined, undefined, repo);
      const s1 = before.start({ agentDid: AGENT, hostSessionId: 'host-1' });

      const after = new SessionRegistry(undefined, undefined, repo);
      after.reconcile();
      // A reconnect after restart must reuse the SAME Core session (F-04), not
      // mint a second one.
      const s2 = after.start({ agentDid: AGENT, hostSessionId: 'host-1' });
      expect(s2.sessionId).toBe(s1.sessionId);
    } finally {
      cleanup();
    }
  });

  it('persists a non-owner authority origin across restart', () => {
    const { adapter, cleanup } = openId();
    try {
      const repo = new SQLiteSessionRepository(adapter);
      const before = new SessionRegistry(undefined, undefined, repo);
      const session = before.start({ agentDid: AGENT, hostSessionId: 'host-origin' });
      expect(
        before.bindNonOwnerAuthorityOrigin(session.sessionId, AGENT, {
          kind: 'delegated_task',
          ownerDid: 'did:plc:owner',
          requesterDid: 'did:key:delegator',
          ingress: 'workflow',
          correlationId: 'task-42',
          authenticatedAtMs: 1234,
        }).ok,
      ).toBe(true);

      const after = new SessionRegistry(undefined, undefined, repo);
      after.reconcile();
      expect(after.get(session.sessionId)?.authorityOrigin).toMatchObject({
        kind: 'delegated_task',
        correlationId: 'task-42',
      });
    } finally {
      cleanup();
    }
  });

  it('reaps a session whose lease lapsed while Core was down', () => {
    const { adapter, cleanup } = openId();
    try {
      const repo = new SQLiteSessionRepository(adapter);
      let clock = 1_000_000;
      const before = new SessionRegistry(() => clock, undefined, repo);
      const s = before.start({ agentDid: AGENT, hostSessionId: 'host-1' });

      // Time jumps past the lease during the "downtime".
      clock += DEFAULT_LEASE_MS + 1;
      const after = new SessionRegistry(() => clock, undefined, repo);
      expect(after.reconcile()).toBe(1); // the lapsed session is reaped
      expect(after.validate(s.sessionId, AGENT).ok).toBe(false);
      // The reap tombstone is durable — a further restart doesn't resurrect it.
      const third = new SessionRegistry(() => clock, undefined, repo);
      third.reconcile();
      expect(third.validate(s.sessionId, AGENT)).toEqual({ ok: false, reason: 'not_found' });
    } finally {
      cleanup();
    }
  });

  it('an explicitly-ended session is a durable tombstone (not reloaded on boot)', () => {
    const { adapter, cleanup } = openId();
    try {
      const repo = new SQLiteSessionRepository(adapter);
      const before = new SessionRegistry(undefined, undefined, repo);
      const s = before.start({ agentDid: AGENT, hostSessionId: 'host-1' });
      expect(before.end(s.sessionId, AGENT).ok).toBe(true);
      // Ended rows are tombstones — loadActive (ended_at IS NULL) excludes them.
      expect(repo.loadActive()).toHaveLength(0);
      const after = new SessionRegistry(undefined, undefined, repo);
      after.reconcile();
      expect(after.validate(s.sessionId, AGENT)).toEqual({ ok: false, reason: 'not_found' });
    } finally {
      cleanup();
    }
  });

  it('mints cryptographically-random ids (128-bit hex, no counter/host leakage)', () => {
    const reg = new SessionRegistry();
    const a = reg.start({ agentDid: AGENT, hostSessionId: 'sensitive-host-id' });
    const b = reg.start({ agentDid: AGENT, hostSessionId: 'sensitive-host-id-2' });
    expect(a.sessionId).toMatch(/^sess-[0-9a-f]{32}$/);
    expect(b.sessionId).not.toBe(a.sessionId);
    // The host session id must not leak into the session id.
    expect(a.sessionId).not.toContain('sensitive');
  });
});
