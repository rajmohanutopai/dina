/**
 * SQLiteServiceDecisionRepository — the owner-private contact-service decision
 * log store (CONTACT_SERVICES_ARCHITECTURE.md §2/§10, migration v16). Pins
 * record + newest-first list + limit against a real SQLCipher identity DB.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyMigrations, IDENTITY_MIGRATIONS } from '@dina/core';
import { SQLiteServiceDecisionRepository } from '@dina/core/storage';
import { NodeSQLiteAdapter } from '@dina/storage-node';

let adapter: NodeSQLiteAdapter;
let dbDir = '';
let repo: SQLiteServiceDecisionRepository;

beforeAll(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-csd-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dbDir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  repo = new SQLiteServiceDecisionRepository(adapter);
});

afterAll(() => {
  try {
    adapter.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

beforeEach(() => {
  adapter.execute('DELETE FROM contact_service_decisions');
});

describe('SQLiteServiceDecisionRepository', () => {
  it('records a decision and reads it back', () => {
    repo.record({
      requesterDid: 'did:plc:alonso',
      capability: 'availability_coordination',
      decision: 'auto_declined',
      reason: 'closeness=unknown',
      createdAt: 1000,
    });
    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requesterDid: 'did:plc:alonso',
      capability: 'availability_coordination',
      decision: 'auto_declined',
      reason: 'closeness=unknown',
      createdAt: 1000,
    });
    expect(typeof rows[0].id).toBe('number');
  });

  it('lists newest-first by created_at', () => {
    repo.record({ requesterDid: 'did:plc:a', capability: 'x', decision: 'granted', createdAt: 100 });
    repo.record({ requesterDid: 'did:plc:b', capability: 'x', decision: 'granted', createdAt: 300 });
    repo.record({ requesterDid: 'did:plc:c', capability: 'x', decision: 'granted', createdAt: 200 });
    const rows = repo.list();
    expect(rows.map((r) => r.requesterDid)).toEqual(['did:plc:b', 'did:plc:c', 'did:plc:a']);
  });

  it('honours the limit (newest kept)', () => {
    for (let i = 0; i < 5; i++) {
      repo.record({ requesterDid: `did:plc:${i}`, capability: 'x', decision: 'granted', createdAt: i });
    }
    const rows = repo.list(2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.requesterDid)).toEqual(['did:plc:4', 'did:plc:3']);
  });

  it('defaults reason to empty string when omitted', () => {
    repo.record({ requesterDid: 'did:plc:a', capability: 'x', decision: 'error', createdAt: 1 });
    expect(repo.list()[0].reason).toBe('');
  });

  it('rejects an empty requesterDid (would orphan the log row)', () => {
    expect(() =>
      repo.record({ requesterDid: '', capability: 'x', decision: 'granted', createdAt: 1 }),
    ).toThrow(/requesterDid is required/);
  });

  it('prunes the tail beyond the retention cap (newest kept)', () => {
    // A noisy contact must not be able to grow the log unbounded. With a cap of
    // 3, the oldest rows are pruned on insert and only the newest 3 survive.
    const capped = new SQLiteServiceDecisionRepository(adapter, 3);
    for (let i = 0; i < 6; i++) {
      capped.record({ requesterDid: `did:plc:${i}`, capability: 'x', decision: 'granted', createdAt: i });
    }
    const rows = capped.list(100);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.requesterDid)).toEqual(['did:plc:5', 'did:plc:4', 'did:plc:3']);
  });
});
